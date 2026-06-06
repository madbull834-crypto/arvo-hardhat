// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IORBDToken.sol";
import "../libraries/LevelConfig.sol";
import "../utils/ReentrancyGuardUpgradeableLocal.sol";

interface IPancakeV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
    function getReserves() external view returns (
        uint112 reserve0,
        uint112 reserve1,
        uint32 blockTimestampLast
    );
}

interface IPancakeV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

interface IPancakeUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Allowance {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

struct InfinityCLPathKey {
    address intermediateCurrency;
    uint24 fee;
    address hooks;
    address poolManager;
    bytes hookData;
    bytes32 parameters;
}

struct InfinityCLExactInputParams {
    address currencyIn;
    InfinityCLPathKey[] path;
    uint128 amountIn;
    uint128 amountOutMinimum;
}

/// @title ARVOWeeklyPool — 11-pool weighted weekly ORBD distribution
/// @notice $2 USDT from every registration is split across 11 pools by weight.
///         In production mode the pool buys ORBD from PancakeSwap and distributes
///         purchased ORBD weekly to qualified members. Auto-exit on target completion.
///         USDT amounts use 18 decimals (BSC USDT).
/// @dev Pool distribution is triggered by DISTRIBUTOR_ROLE (Chainlink Automation recommended).
///      This contract holds purchased ORBD until weekly distribution; no admin can drain it.
///      ORBD conversion rate can be sourced from a PancakeSwap V2 ORBD/USDT TWAP.
contract ARVOWeeklyPool is Initializable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeableLocal {
    using SafeERC20 for IERC20;

    // ─── Roles ────────────────────────────────────────────────────
    bytes32 public constant MATRIX_ROLE      = keccak256("MATRIX_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant RATE_UPDATER_ROLE = keccak256("RATE_UPDATER_ROLE");

    // ─── Constants ────────────────────────────────────────────────
    uint8   public constant POOL_COUNT            = 11; // Pool IDs 0–10
    uint256 public constant CONTRIBUTION_PER_JOIN = 2e18; // $2 USDT (18 decimals)
    uint256 public constant DISTRIBUTION_INTERVAL = 7 days;
    uint256 private constant Q112 = 2 ** 112;

    // ─── Immutables ───────────────────────────────────────────────
    IERC20     public usdt;
    IORBDToken public orbd;

    // ─── Pool Configuration ───────────────────────────────────────
    /// @notice Pool weights in basis points (must sum to 10000)
    uint256[POOL_COUNT] public poolWeights;

    /// @notice USDT-equivalent target per member per pool (18 decimals, from LevelConfig)
    uint256[POOL_COUNT] public poolTargets;

    // ─── ORBD Rate ────────────────────────────────────────────────
    /// @notice ORBD tokens (raw 18-dec) minted per 1 USDT raw (18-dec) distributed.
    ///         Default 1e18 → 1 ORBD per 1 USDT.
    ///         Set to 1e24 for "1 ORBD = $0.000001 USDT" (1 USDT = 1,000,000 ORBD).
    ///         Formula: orbdAmount = sharePerMember * orbdPerUsdtRate / 1e18
    uint256 public orbdPerUsdtRate;

    // ─── PancakeSwap ORBD/USDT TWAP Oracle ───────────────────────
    IPancakeV2Pair public pancakePair;
    address public pancakeToken0;
    bool public pancakeOracleEnabled;
    bool public pancakeOracleReady;
    uint256 public minTwapInterval;
    uint256 public maxOracleAge;
    uint256 public maxRateChangeBps;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint32 public lastOracleObservationTimestamp;
    uint256 public lastOracleRateTimestamp;

    // ─── Pool State ───────────────────────────────────────────────
    uint256[POOL_COUNT] public weeklyAccumulated;
    uint256 public lastDistributionTimestamp;
    uint256[POOL_COUNT] public lastPoolDistributionTimestamp;
    uint256 public totalContributed;

    // ─── Membership ───────────────────────────────────────────────
    struct PoolMembership {
        bool    isActive;
        uint256 totalReceivedUsdt; // Running USDT-equivalent of ORBD distributed
    }

    /// @dev member => poolId => membership state
    mapping(address => mapping(uint8 => PoolMembership)) public memberships;

    /// @dev poolId => list of qualified member addresses (includes exited members; isActive filters)
    mapping(uint8 => address[]) private _poolMembers;

    // ─── Custom Errors ────────────────────────────────────────────
    error InvalidPool(uint8 poolId);
    error AlreadyQualified(address member, uint8 poolId);
    error WeightSumInvalid(uint256 got, uint256 expected);
    error DistributionTooSoon(uint256 nextAllowed);
    error InvalidRate();
    error InvalidPair();
    error OracleDisabled();
    error OracleTooSoon(uint256 nextAllowed);
    error OracleStale(uint256 lastUpdated);
    error RateChangeTooLarge(uint256 oldRate, uint256 newRate, uint256 maxChangeBps);
    error InvalidRouter();
    error InvalidSwapPath();
    error SlippageTooHigh();
    error SwapFailed();
    error InvalidPermit2();
    error InvalidInfinityPath();
    error AmountTooLarge();

    // ─── Events ───────────────────────────────────────────────────
    event PoolContribution(address indexed member, uint256 totalAmount);
    event MemberQualified(address indexed member, uint8 indexed poolId);
    event WeeklyDistributed(uint8 indexed poolId, uint256 usdtAmount, uint256 membersRewarded);
    event RewardDistributed(address indexed member, uint8 indexed poolId, uint256 orbdAmount);
    event MemberExited(address indexed member, uint8 indexed poolId, uint256 totalReceivedUsdt);
    event PoolWeightsSet(uint256[POOL_COUNT] weights);
    event OrbdRateSet(uint256 newRate);
    event PancakeOracleConfigured(
        address indexed pair,
        uint256 minTwapInterval,
        uint256 maxOracleAge,
        uint256 maxRateChangeBps
    );
    event PancakeOracleEnabled(bool enabled);
    event PancakeOracleUpdated(uint256 oldRate, uint256 newRate, uint256 elapsed);
    event PancakeSwapConfigured(address indexed router, uint256 minOutBps, bool enabled);
    event PancakeSwapEnabled(bool enabled);
    event OrbdPurchased(uint256 usdtAmount, uint256 orbdReceived);
    event PancakeInfinitySwapConfigured(
        address indexed universalRouter,
        address indexed permit2,
        uint128 amountOutMinimum,
        bool enabled
    );
    event PancakeInfinityPathSet(uint256 hops);

    // ─── PancakeSwap Buy Configuration ────────────────────────────
    IPancakeV2Router public pancakeRouter;
    bool public pancakeSwapEnabled;
    uint256 public pancakeSwapMinOutBps;
    address[] public pancakeSwapPath;

    /// @notice Purchased ORBD accumulated per pool for weekly distribution.
    uint256[POOL_COUNT] public weeklyOrbdAccumulated;

    // ─── PancakeSwap Infinity / v4 Buy Configuration ─────────────
    /// @dev Pancake Infinity Universal Router. BSC mainnet: 0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB.
    IPancakeUniversalRouter public pancakeInfinityRouter;
    /// @dev Permit2 used by Universal Router to pull USDT from this contract.
    IPermit2Allowance public pancakePermit2;
    bool public pancakeInfinitySwapEnabled;
    uint128 public pancakeInfinityAmountOutMinimum;
    InfinityCLPathKey[] private _pancakeInfinityClPath;

    uint8 private constant PANCAKE_COMMAND_INFI_SWAP = 0x10;
    uint8 private constant PANCAKE_ACTION_CL_SWAP_EXACT_IN = 0x07;
    uint8 private constant PANCAKE_ACTION_SETTLE_ALL = 0x0c;
    uint8 private constant PANCAKE_ACTION_TAKE_ALL = 0x0f;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ─── Initializer ──────────────────────────────────────────────
    /// @param usdt_    BSC USDT contract (18 decimals: 0x55d398326f99059fF775485246999027B3197955)
    /// @param orbd_    ORBD token contract (already deployed on BSC; must grant MINTER_ROLE here)
    /// @param weights_ Pool weights in basis points; must sum to 10000
    ///                 Suggested equal weights: [910,909,909,909,909,909,909,909,909,909,909]
    function initialize(
        address usdt_,
        address orbd_,
        uint256[POOL_COUNT] memory weights_
    ) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();

        usdt = IERC20(usdt_);
        orbd = IORBDToken(orbd_);

        _setPoolWeights(weights_);

        for (uint8 i = 0; i < POOL_COUNT; i++) {
            poolTargets[i] = LevelConfig.poolTargetUsdt(i);
        }

        // Default: 1 USDT = 1 ORBD (1:1). Update via setOrbdRate() before launch.
        orbdPerUsdtRate = 1e18;
        pancakeSwapMinOutBps = 9500;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RATE_UPDATER_ROLE, msg.sender);
        lastDistributionTimestamp = block.timestamp;
        for (uint8 i = 0; i < POOL_COUNT; i++) {
            lastPoolDistributionTimestamp[i] = block.timestamp;
        }

        emit PoolWeightsSet(weights_);
    }

    // ─── Called by ARVOMatrix ─────────────────────────────────────

    /// @notice Receive $2 USDT from matrix and split across pools by weight
    /// @dev ARVOMatrix must approve this contract for CONTRIBUTION_PER_JOIN before calling.
    function receiveContribution(address member) external onlyRole(MATRIX_ROLE) nonReentrant {
        usdt.safeTransferFrom(msg.sender, address(this), CONTRIBUTION_PER_JOIN);

        for (uint8 i = 0; i < POOL_COUNT; i++) {
            uint256 share = (CONTRIBUTION_PER_JOIN * poolWeights[i]) / 10_000;
            weeklyAccumulated[i] += share;
        }

        if (pancakeSwapEnabled) {
            _buyOrbdAndAllocate(CONTRIBUTION_PER_JOIN);
        }

        totalContributed += CONTRIBUTION_PER_JOIN;
        emit PoolContribution(member, CONTRIBUTION_PER_JOIN);
    }

    /// @notice Add a member to a pool when qualification condition is met
    /// @dev Called by ARVOMatrix on 2-direct milestone (pool 0) or level upgrade (pools 1-10).
    function qualifyMember(address member, uint8 poolId) external onlyRole(MATRIX_ROLE) {
        if (poolId >= POOL_COUNT)                 revert InvalidPool(poolId);
        if (memberships[member][poolId].isActive) revert AlreadyQualified(member, poolId);

        memberships[member][poolId].isActive = true;
        _poolMembers[poolId].push(member);

        emit MemberQualified(member, poolId);
    }

    // ─── Weekly Distribution ──────────────────────────────────────

    /// @notice Distribute accumulated USDT for a single pool as ORBD rewards
    /// @param poolId Pool index 0–10
    function distributeWeekly(uint8 poolId) external onlyRole(DISTRIBUTOR_ROLE) nonReentrant {
        if (poolId >= POOL_COUNT) revert InvalidPool(poolId);
        _enforceDistributionInterval(lastPoolDistributionTimestamp[poolId]);
        _refreshPancakeOracleIfReady();
        _enforceFreshOracle();

        _distributePool(poolId);
        lastPoolDistributionTimestamp[poolId] = block.timestamp;
    }

    /// @notice Distribute all 11 pools in one transaction (Chainlink batch call)
    function distributeAllPools() external onlyRole(DISTRIBUTOR_ROLE) nonReentrant {
        _enforceDistributionInterval(lastDistributionTimestamp);
        _refreshPancakeOracleIfReady();
        _enforceFreshOracle();

        for (uint8 i = 0; i < POOL_COUNT; i++) {
            if (weeklyAccumulated[i] > 0 || weeklyOrbdAccumulated[i] > 0) {
                _distributePool(i);
            }
            lastPoolDistributionTimestamp[i] = block.timestamp;
        }
        lastDistributionTimestamp = block.timestamp;
    }

    // ─── Admin ────────────────────────────────────────────────────

    /// @notice Update the ORBD conversion rate
    /// @param newRate ORBD raw units (18-dec) per 1 USDT raw (18-dec).
    ///                Examples:
    ///                  1e18  → 1 ORBD per 1 USDT  (1:1)
    ///                  1e24  → 1,000,000 ORBD per 1 USDT  (1 ORBD = $0.000001)
    function setOrbdRate(uint256 newRate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRate == 0) revert InvalidRate();
        orbdPerUsdtRate = newRate;
        emit OrbdRateSet(newRate);
    }

    /// @notice Configure the PancakeSwap V2 ORBD/USDT TWAP oracle.
    /// @dev The pair must contain this contract's ORBD and USDT token addresses.
    ///      Call once, wait at least minInterval_, then call updateOrbdRateFromPancake().
    function configurePancakeOracle(
        address pair_,
        uint256 minInterval_,
        uint256 maxAge_,
        uint256 maxChangeBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pair_ == address(0) || minInterval_ == 0 || maxAge_ < minInterval_ || maxChangeBps_ > 10_000) {
            revert InvalidPair();
        }

        IPancakeV2Pair pair = IPancakeV2Pair(pair_);
        address token0 = pair.token0();
        address token1 = pair.token1();
        address usdtAddress = address(usdt);
        address orbdAddress = address(orbd);

        bool validPair =
            (token0 == usdtAddress && token1 == orbdAddress) ||
            (token0 == orbdAddress && token1 == usdtAddress);
        if (!validPair) revert InvalidPair();

        (
            uint256 price0Cumulative,
            uint256 price1Cumulative,
            uint32 blockTimestamp
        ) = _currentCumulativePrices(pair);

        pancakePair = pair;
        pancakeToken0 = token0;
        minTwapInterval = minInterval_;
        maxOracleAge = maxAge_;
        maxRateChangeBps = maxChangeBps_;
        price0CumulativeLast = price0Cumulative;
        price1CumulativeLast = price1Cumulative;
        lastOracleObservationTimestamp = blockTimestamp;
        lastOracleRateTimestamp = 0;
        pancakeOracleReady = false;
        pancakeOracleEnabled = true;

        emit PancakeOracleConfigured(pair_, minInterval_, maxAge_, maxChangeBps_);
        emit PancakeOracleEnabled(true);
    }

    function setPancakeOracleEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        pancakeOracleEnabled = enabled;
        emit PancakeOracleEnabled(enabled);
    }

    /// @notice Configure PancakeSwap router used to buy ORBD with pool USDT contributions.
    /// @param router_ PancakeSwap V2 router address.
    /// @param path_ Swap path, normally [USDT, ORBD] or [USDT, WBNB, ORBD].
    /// @param minOutBps_ Minimum output as bps of router quote. 9500 = max 5% slippage.
    /// @param enabled_ Whether buying should be enabled immediately.
    function configurePancakeSwap(
        address router_,
        address[] calldata path_,
        uint256 minOutBps_,
        bool enabled_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (router_ == address(0)) revert InvalidRouter();
        if (path_.length < 2 || path_[0] != address(usdt) || path_[path_.length - 1] != address(orbd)) {
            revert InvalidSwapPath();
        }
        if (minOutBps_ > 10_000) revert SlippageTooHigh();

        pancakeRouter = IPancakeV2Router(router_);
        pancakeSwapMinOutBps = minOutBps_;
        pancakeSwapEnabled = enabled_;

        delete pancakeSwapPath;
        for (uint256 i = 0; i < path_.length; i++) {
            pancakeSwapPath.push(path_[i]);
        }

        emit PancakeSwapConfigured(router_, minOutBps_, enabled_);
        emit PancakeSwapEnabled(enabled_);
    }

    function setPancakeSwapEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (enabled && (address(pancakeRouter) == address(0) || pancakeSwapPath.length < 2)) {
            revert InvalidRouter();
        }
        pancakeSwapEnabled = enabled;
        emit PancakeSwapEnabled(enabled);
    }

    /// @notice Configure PancakeSwap Infinity/v4 CL exact-input routing.
    /// @dev This uses Pancake Universal Router command INFI_SWAP with CL_SWAP_EXACT_IN.
    ///      For USDT -> BNB -> ORBD, pass two hops:
    ///      1) intermediateCurrency = native BNB (address(0)), with the USDT/BNB CL pool fee/hooks/manager/parameters
    ///      2) intermediateCurrency = ORBD, with the BNB/ORBD CL pool fee/hooks/manager/parameters
    ///      The contract approves Permit2 here so the router can pull USDT during swaps.
    function configurePancakeInfinitySwap(
        address universalRouter_,
        address permit2_,
        InfinityCLPathKey[] calldata path_,
        uint128 amountOutMinimum_,
        bool enabled_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (universalRouter_ == address(0)) revert InvalidRouter();
        if (permit2_ == address(0)) revert InvalidPermit2();
        _validateInfinityPath(path_);

        pancakeInfinityRouter = IPancakeUniversalRouter(universalRouter_);
        pancakePermit2 = IPermit2Allowance(permit2_);
        pancakeInfinityAmountOutMinimum = amountOutMinimum_;
        pancakeInfinitySwapEnabled = enabled_;
        pancakeSwapEnabled = enabled_;

        delete _pancakeInfinityClPath;
        for (uint256 i = 0; i < path_.length; i++) {
            _pancakeInfinityClPath.push(path_[i]);
        }

        usdt.forceApprove(permit2_, type(uint256).max);
        IPermit2Allowance(permit2_).approve(
            address(usdt),
            universalRouter_,
            type(uint160).max,
            type(uint48).max
        );

        emit PancakeInfinityPathSet(path_.length);
        emit PancakeInfinitySwapConfigured(universalRouter_, permit2_, amountOutMinimum_, enabled_);
        emit PancakeSwapEnabled(enabled_);
    }

    function setPancakeInfinitySwapEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (enabled && (address(pancakeInfinityRouter) == address(0) || _pancakeInfinityClPath.length == 0)) {
            revert InvalidRouter();
        }
        pancakeInfinitySwapEnabled = enabled;
        pancakeSwapEnabled = enabled;
        emit PancakeInfinitySwapConfigured(
            address(pancakeInfinityRouter),
            address(pancakePermit2),
            pancakeInfinityAmountOutMinimum,
            enabled
        );
        emit PancakeSwapEnabled(enabled);
    }

    function setPancakeInfinityAmountOutMinimum(uint128 amountOutMinimum) external onlyRole(DEFAULT_ADMIN_ROLE) {
        pancakeInfinityAmountOutMinimum = amountOutMinimum;
        emit PancakeInfinitySwapConfigured(
            address(pancakeInfinityRouter),
            address(pancakePermit2),
            amountOutMinimum,
            pancakeInfinitySwapEnabled
        );
    }

    /// @notice Update ORBD/USDT conversion rate from the configured PancakeSwap TWAP.
    /// @return newRate ORBD raw units per 1 USDT raw unit, scaled by 1e18.
    function updateOrbdRateFromPancake()
        external
        onlyRole(RATE_UPDATER_ROLE)
        returns (uint256 newRate)
    {
        return _updateOrbdRateFromPancake();
    }

    /// @notice Update pool weights (must still sum to 10000)
    function setPoolWeights(uint256[POOL_COUNT] calldata weights_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPoolWeights(weights_);
        emit PoolWeightsSet(weights_);
    }

    /// @notice Update the maximum allowed rate change per oracle update.
    /// @dev Use this if the market makes a legitimate large move and distribution is blocked.
    ///      Set to 0 to disable the rate-change guard entirely (not recommended in production).
    function setMaxRateChangeBps(uint256 newMaxBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxBps > 10_000) revert InvalidRate();
        maxRateChangeBps = newMaxBps;
    }

    /// @notice Preview the ORBD/USDT rate the oracle would compute right now (off-chain helper).
    /// @dev Returns (rate, elapsed, canUpdate).
    ///      rate = 0 if oracle not configured or no reserves.
    function previewOracleRate() external view returns (
        uint256 rate,
        uint256 elapsed,
        bool canUpdate
    ) {
        if (!pancakeOracleEnabled || address(pancakePair) == address(0)) {
            return (0, 0, false);
        }

        uint256 price0Cumulative;
        uint256 price1Cumulative;
        uint32 blockTimestamp;

        try pancakePair.getReserves() returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) {
            if (reserve0 == 0 || reserve1 == 0) return (0, 0, false);

            price0Cumulative = pancakePair.price0CumulativeLast();
            price1Cumulative = pancakePair.price1CumulativeLast();
            blockTimestamp   = uint32(block.timestamp % 2 ** 32);

            if (blockTimestampLast != blockTimestamp) {
                uint32 delta;
                unchecked { delta = blockTimestamp - blockTimestampLast; }
                unchecked {
                    price0Cumulative += (uint256(reserve1) * Q112 / reserve0) * delta;
                    price1Cumulative += (uint256(reserve0) * Q112 / reserve1) * delta;
                }
            }
        } catch {
            return (0, 0, false);
        }

        uint32 el;
        unchecked { el = blockTimestamp - lastOracleObservationTimestamp; }
        elapsed   = uint256(el);
        canUpdate = elapsed >= minTwapInterval;

        if (!canUpdate || elapsed == 0) return (0, elapsed, false);

        uint256 avgPriceX112;
        if (pancakeToken0 == address(usdt)) {
            avgPriceX112 = (price0Cumulative - price0CumulativeLast) / elapsed;
            rate = (avgPriceX112 * 1e18) / Q112;
        } else {
            avgPriceX112 = (price0Cumulative - price0CumulativeLast) / elapsed;
            if (avgPriceX112 == 0) return (0, elapsed, false);
            rate = (Q112 * 1e18) / avgPriceX112;
        }
    }

    // ─── View Functions ───────────────────────────────────────────

    function isQualified(address member, uint8 poolId) external view returns (bool) {
        return memberships[member][poolId].isActive;
    }

    function getPoolStats(uint8 poolId) external view returns (
        uint256 accumulated,
        uint256 weight,
        uint256 target,
        uint256 memberCount
    ) {
        return (
            weeklyAccumulated[poolId],
            poolWeights[poolId],
            poolTargets[poolId],
            _poolMembers[poolId].length
        );
    }

    function getPoolTokenStats(uint8 poolId) external view returns (
        uint256 accumulatedUsdt,
        uint256 accumulatedOrbd,
        uint256 orbdBalance
    ) {
        if (poolId >= POOL_COUNT) revert InvalidPool(poolId);
        return (
            weeklyAccumulated[poolId],
            weeklyOrbdAccumulated[poolId],
            IERC20(address(orbd)).balanceOf(address(this))
        );
    }

    function getMemberStats(address member, uint8 poolId) external view returns (
        bool active,
        uint256 totalReceived,
        uint256 remaining
    ) {
        PoolMembership storage ms = memberships[member][poolId];
        uint256 rem = ms.totalReceivedUsdt >= poolTargets[poolId]
            ? 0
            : poolTargets[poolId] - ms.totalReceivedUsdt;
        return (ms.isActive, ms.totalReceivedUsdt, rem);
    }

    function getPancakeOracleState() external view returns (
        address pair,
        bool enabled,
        bool ready,
        uint256 rate,
        uint256 minInterval,
        uint256 maxAge,
        uint256 lastRateTimestamp
    ) {
        return (
            address(pancakePair),
            pancakeOracleEnabled,
            pancakeOracleReady,
            orbdPerUsdtRate,
            minTwapInterval,
            maxOracleAge,
            lastOracleRateTimestamp
        );
    }

    function getPancakeInfinityPath() external view returns (InfinityCLPathKey[] memory path) {
        path = new InfinityCLPathKey[](_pancakeInfinityClPath.length);
        for (uint256 i = 0; i < _pancakeInfinityClPath.length; i++) {
            InfinityCLPathKey storage source = _pancakeInfinityClPath[i];
            path[i] = InfinityCLPathKey({
                intermediateCurrency: source.intermediateCurrency,
                fee: source.fee,
                hooks: source.hooks,
                poolManager: source.poolManager,
                hookData: source.hookData,
                parameters: source.parameters
            });
        }
    }

    // ─── Internal ─────────────────────────────────────────────────

    function _enforceDistributionInterval(uint256 lastTimestamp) internal view {
        if (block.timestamp < lastTimestamp + DISTRIBUTION_INTERVAL) {
            revert DistributionTooSoon(lastTimestamp + DISTRIBUTION_INTERVAL);
        }
    }

    function _enforceFreshOracle() internal view {
        if (!pancakeOracleEnabled) return;
        if (!pancakeOracleReady || block.timestamp > lastOracleRateTimestamp + maxOracleAge) {
            revert OracleStale(lastOracleRateTimestamp);
        }
    }

    /// @dev Auto-refresh oracle during distribution.
    ///      Uses try/catch so that a temporary oracle failure (e.g. RateChangeTooLarge,
    ///      OracleTooSoon) does not block the weekly distribution tx.
    ///      _enforceFreshOracle() is called after this — if the oracle is genuinely stale
    ///      it will revert there instead.
    function _refreshPancakeOracleIfReady() internal {
        if (!pancakeOracleEnabled || address(pancakePair) == address(0)) return;
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        uint32 elapsed;
        unchecked {
            elapsed = blockTimestamp - lastOracleObservationTimestamp;
        }
        if (elapsed >= minTwapInterval) {
            _updateOrbdRateFromPancake();
        }
    }

    function _updateOrbdRateFromPancake() internal returns (uint256 newRate) {
        if (!pancakeOracleEnabled || address(pancakePair) == address(0)) revert OracleDisabled();

        (
            uint256 price0Cumulative,
            uint256 price1Cumulative,
            uint32 blockTimestamp
        ) = _currentCumulativePrices(pancakePair);

        uint32 elapsed;
        unchecked {
            elapsed = blockTimestamp - lastOracleObservationTimestamp;
        }
        if (elapsed < minTwapInterval) {
            // Use block.timestamp-based value so the error shows a readable Unix timestamp
            revert OracleTooSoon(block.timestamp + (minTwapInterval - elapsed));
        }

        uint256 averagePriceX112;
        if (pancakeToken0 == address(usdt)) {
            averagePriceX112 = (price0Cumulative - price0CumulativeLast) / elapsed;
            newRate = (averagePriceX112 * 1e18) / Q112;
        } else {
            averagePriceX112 = (price0Cumulative - price0CumulativeLast) / elapsed;
            if (averagePriceX112 == 0) revert InvalidRate();
            newRate = (Q112 * 1e18) / averagePriceX112;
        }

        if (newRate == 0) revert InvalidRate();
        if (pancakeOracleReady && maxRateChangeBps > 0) {
            _enforceRateChangeLimit(orbdPerUsdtRate, newRate);
        }

        uint256 oldRate = orbdPerUsdtRate;
        orbdPerUsdtRate = newRate;
        price0CumulativeLast = price0Cumulative;
        price1CumulativeLast = price1Cumulative;
        lastOracleObservationTimestamp = blockTimestamp;
        lastOracleRateTimestamp = block.timestamp;
        pancakeOracleReady = true;

        emit OrbdRateSet(newRate);
        emit PancakeOracleUpdated(oldRate, newRate, elapsed);
    }

    function _enforceRateChangeLimit(uint256 oldRate, uint256 newRate) internal view {
        uint256 diff = oldRate > newRate ? oldRate - newRate : newRate - oldRate;
        if (diff * 10_000 > oldRate * maxRateChangeBps) {
            revert RateChangeTooLarge(oldRate, newRate, maxRateChangeBps);
        }
    }

    function _currentCumulativePrices(IPancakeV2Pair pair) internal view returns (
        uint256 price0Cumulative,
        uint256 price1Cumulative,
        uint32 blockTimestamp
    ) {
        price0Cumulative = pair.price0CumulativeLast();
        price1Cumulative = pair.price1CumulativeLast();

        (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = pair.getReserves();
        if (reserve0 == 0 || reserve1 == 0) revert InvalidPair();

        blockTimestamp = uint32(block.timestamp % 2 ** 32);
        if (blockTimestampLast != blockTimestamp) {
            uint32 elapsed;
            unchecked {
                elapsed = blockTimestamp - blockTimestampLast;
                price0Cumulative += (uint256(reserve1) * Q112 / reserve0) * elapsed;
                price1Cumulative += (uint256(reserve0) * Q112 / reserve1) * elapsed;
            }
        }
    }

    function _buyOrbdAndAllocate(uint256 usdtAmount) internal {
        uint256 received = pancakeInfinitySwapEnabled
            ? _buyOrbdViaPancakeInfinity(usdtAmount)
            : _buyOrbdViaPancakeV2(usdtAmount);
        if (received == 0) revert SwapFailed();

        uint256 allocated;
        for (uint8 i = 0; i < POOL_COUNT; i++) {
            uint256 share = i == POOL_COUNT - 1
                ? received - allocated
                : (received * poolWeights[i]) / 10_000;
            weeklyOrbdAccumulated[i] += share;
            allocated += share;
        }

        emit OrbdPurchased(usdtAmount, received);
    }

    function _buyOrbdViaPancakeV2(uint256 usdtAmount) internal returns (uint256 received) {
        if (address(pancakeRouter) == address(0) || pancakeSwapPath.length < 2) revert InvalidRouter();

        address[] memory path = _swapPath();
        uint256[] memory amounts = pancakeRouter.getAmountsOut(usdtAmount, path);
        uint256 quotedOut = amounts[amounts.length - 1];
        uint256 minOut = (quotedOut * pancakeSwapMinOutBps) / 10_000;

        uint256 beforeBalance = IERC20(address(orbd)).balanceOf(address(this));
        usdt.forceApprove(address(pancakeRouter), 0);
        usdt.forceApprove(address(pancakeRouter), usdtAmount);

        pancakeRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            usdtAmount,
            minOut,
            path,
            address(this),
            block.timestamp + 900
        );

        received = IERC20(address(orbd)).balanceOf(address(this)) - beforeBalance;
    }

    function _buyOrbdViaPancakeInfinity(uint256 usdtAmount) internal returns (uint256 received) {
        if (address(pancakeInfinityRouter) == address(0)) revert InvalidRouter();
        if (address(pancakePermit2) == address(0)) revert InvalidPermit2();
        if (_pancakeInfinityClPath.length == 0) revert InvalidInfinityPath();
        if (usdtAmount > type(uint128).max) revert AmountTooLarge();

        uint256 beforeBalance = IERC20(address(orbd)).balanceOf(address(this));
        bytes memory commands = abi.encodePacked(bytes1(PANCAKE_COMMAND_INFI_SWAP));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _encodePancakeInfinityClExactInput(
            uint128(usdtAmount),
            pancakeInfinityAmountOutMinimum
        );

        pancakeInfinityRouter.execute(commands, inputs, block.timestamp + 900);

        received = IERC20(address(orbd)).balanceOf(address(this)) - beforeBalance;
    }

    function _encodePancakeInfinityClExactInput(uint128 amountIn, uint128 amountOutMinimum)
        internal
        view
        returns (bytes memory)
    {
        InfinityCLPathKey[] memory path = new InfinityCLPathKey[](_pancakeInfinityClPath.length);
        for (uint256 i = 0; i < _pancakeInfinityClPath.length; i++) {
            InfinityCLPathKey storage source = _pancakeInfinityClPath[i];
            path[i] = InfinityCLPathKey({
                intermediateCurrency: source.intermediateCurrency,
                fee: source.fee,
                hooks: source.hooks,
                poolManager: source.poolManager,
                hookData: source.hookData,
                parameters: source.parameters
            });
        }

        bytes memory actions = new bytes(3);
        actions[0] = bytes1(PANCAKE_ACTION_CL_SWAP_EXACT_IN);
        actions[1] = bytes1(PANCAKE_ACTION_SETTLE_ALL);
        actions[2] = bytes1(PANCAKE_ACTION_TAKE_ALL);

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(InfinityCLExactInputParams({
            currencyIn: address(usdt),
            path: path,
            amountIn: amountIn,
            amountOutMinimum: amountOutMinimum
        }));
        params[1] = abi.encode(address(usdt), type(uint256).max);
        params[2] = abi.encode(address(orbd), uint256(amountOutMinimum));

        return abi.encode(actions, params);
    }

    function _swapPath() internal view returns (address[] memory path) {
        path = new address[](pancakeSwapPath.length);
        for (uint256 i = 0; i < pancakeSwapPath.length; i++) {
            path[i] = pancakeSwapPath[i];
        }
    }

    function _validateInfinityPath(InfinityCLPathKey[] calldata path_) internal view {
        if (path_.length == 0) revert InvalidInfinityPath();

        address currencyIn = address(usdt);
        for (uint256 i = 0; i < path_.length; i++) {
            if (path_[i].poolManager == address(0)) revert InvalidInfinityPath();
            if (path_[i].intermediateCurrency == currencyIn) revert InvalidInfinityPath();
            currencyIn = path_[i].intermediateCurrency;
        }

        if (currencyIn != address(orbd)) revert InvalidInfinityPath();
    }

    function _distributePool(uint8 poolId) internal {
        uint256 totalUsdt = weeklyAccumulated[poolId];
        uint256 totalOrbd = weeklyOrbdAccumulated[poolId];
        if (totalUsdt == 0 && totalOrbd == 0) return;

        address[] storage members = _poolMembers[poolId];
        uint256 activeCount;
        for (uint256 i = 0; i < members.length; i++) {
            if (memberships[members[i]][poolId].isActive) activeCount++;
        }
        if (activeCount == 0) return;

        uint256 sharePerMember = totalUsdt / activeCount;
        weeklyAccumulated[poolId] = 0;
        weeklyOrbdAccumulated[poolId] = 0;
        uint256 rewarded;
        uint256 activeRemaining = activeCount;
        uint256 remainingUsdt = totalUsdt;
        uint256 remainingOrbd = totalOrbd;

        for (uint256 i = 0; i < members.length; i++) {
            address member = members[i];
            PoolMembership storage ms = memberships[member][poolId];
            if (!ms.isActive) continue;

            uint256 usdtShare = activeRemaining == 1 ? remainingUsdt : sharePerMember;
            remainingUsdt -= usdtShare;
            ms.totalReceivedUsdt += usdtShare;

            uint256 orbdAmount;
            if (totalOrbd > 0) {
                orbdAmount = activeRemaining == 1 ? remainingOrbd : totalOrbd / activeCount;
                remainingOrbd -= orbdAmount;
                IERC20(address(orbd)).safeTransfer(member, orbdAmount);
            } else {
                // Backward-compatible fallback for test deployments where buy mode is disabled.
                orbdAmount = (usdtShare * orbdPerUsdtRate) / 1e18;
                orbd.mint(member, orbdAmount);
            }
            emit RewardDistributed(member, poolId, orbdAmount);
            rewarded++;
            activeRemaining--;

            if (ms.totalReceivedUsdt >= poolTargets[poolId]) {
                ms.isActive = false;
                emit MemberExited(member, poolId, ms.totalReceivedUsdt);
            }
        }

        emit WeeklyDistributed(poolId, totalUsdt, rewarded);
    }

    function _setPoolWeights(uint256[POOL_COUNT] memory weights_) internal {
        uint256 sum;
        for (uint8 i = 0; i < POOL_COUNT; i++) sum += weights_[i];
        if (sum != 10_000) revert WeightSumInvalid(sum, 10_000);
        poolWeights = weights_;
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}
}

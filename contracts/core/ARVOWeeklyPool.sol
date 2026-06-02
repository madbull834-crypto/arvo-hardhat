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

/// @title ARVOWeeklyPool — 11-pool weighted weekly ORBD distribution
/// @notice $2 USDT from every registration is split across 11 pools by weight.
///         Qualified members receive ORBD tokens weekly. Auto-exit on target completion.
///         USDT amounts use 18 decimals (BSC USDT).
/// @dev Pool distribution is triggered by DISTRIBUTOR_ROLE (Chainlink Automation recommended).
///      This contract holds USDT until weekly distribution; no admin can drain it.
///      ORBD conversion rate is governance-settable via setOrbdRate().
contract ARVOWeeklyPool is Initializable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeableLocal {
    using SafeERC20 for IERC20;

    // ─── Roles ────────────────────────────────────────────────────
    bytes32 public constant MATRIX_ROLE      = keccak256("MATRIX_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    // ─── Constants ────────────────────────────────────────────────
    uint8   public constant POOL_COUNT            = 11; // Pool IDs 0–10
    uint256 public constant CONTRIBUTION_PER_JOIN = 2e18; // $2 USDT (18 decimals)
    uint256 public constant DISTRIBUTION_INTERVAL = 7 days;

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

    // ─── Events ───────────────────────────────────────────────────
    event PoolContribution(address indexed member, uint256 totalAmount);
    event MemberQualified(address indexed member, uint8 indexed poolId);
    event WeeklyDistributed(uint8 indexed poolId, uint256 usdtAmount, uint256 membersRewarded);
    event RewardDistributed(address indexed member, uint8 indexed poolId, uint256 orbdAmount);
    event MemberExited(address indexed member, uint8 indexed poolId, uint256 totalReceivedUsdt);
    event PoolWeightsSet(uint256[POOL_COUNT] weights);
    event OrbdRateSet(uint256 newRate);

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

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
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

        _distributePool(poolId);
        lastPoolDistributionTimestamp[poolId] = block.timestamp;
    }

    /// @notice Distribute all 11 pools in one transaction (Chainlink batch call)
    function distributeAllPools() external onlyRole(DISTRIBUTOR_ROLE) nonReentrant {
        _enforceDistributionInterval(lastDistributionTimestamp);

        for (uint8 i = 0; i < POOL_COUNT; i++) {
            if (weeklyAccumulated[i] > 0) {
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

    /// @notice Update pool weights (must still sum to 10000)
    function setPoolWeights(uint256[POOL_COUNT] calldata weights_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPoolWeights(weights_);
        emit PoolWeightsSet(weights_);
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

    // ─── Internal ─────────────────────────────────────────────────

    function _enforceDistributionInterval(uint256 lastTimestamp) internal view {
        if (block.timestamp < lastTimestamp + DISTRIBUTION_INTERVAL) {
            revert DistributionTooSoon(lastTimestamp + DISTRIBUTION_INTERVAL);
        }
    }

    function _distributePool(uint8 poolId) internal {
        uint256 totalUsdt = weeklyAccumulated[poolId];
        if (totalUsdt == 0) return;

        address[] storage members = _poolMembers[poolId];
        uint256 activeCount;
        for (uint256 i = 0; i < members.length; i++) {
            if (memberships[members[i]][poolId].isActive) activeCount++;
        }
        if (activeCount == 0) return;

        uint256 sharePerMember = totalUsdt / activeCount;
        weeklyAccumulated[poolId] = 0;
        uint256 rewarded;

        for (uint256 i = 0; i < members.length; i++) {
            address member = members[i];
            PoolMembership storage ms = memberships[member][poolId];
            if (!ms.isActive) continue;

            ms.totalReceivedUsdt += sharePerMember;

            // Mint ORBD proportional to USDT share using governance-set rate.
            // orbdAmount = sharePerMember * orbdPerUsdtRate / 1e18
            uint256 orbdAmount = (sharePerMember * orbdPerUsdtRate) / 1e18;
            orbd.mint(member, orbdAmount);
            emit RewardDistributed(member, poolId, orbdAmount);
            rewarded++;

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

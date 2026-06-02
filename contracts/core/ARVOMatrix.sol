// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IARVOWeeklyPool.sol";
import "../libraries/LevelConfig.sol";
import "../utils/ReentrancyGuardUpgradeableLocal.sol";

/// @title ARVOMatrix — Core ARVO binary matrix with 12-level auto-upgrade income system
/// @notice Immutable MLM contract. Registrations pay $10 USDT (18 decimals — BSC USDT).
///         $5 → direct referrer, $2.5 → matrix auto-upgrade fund, $2 → weekly pool, $0.5 → admins.
///         Members become eligible for level earnings after 2 direct referrals.
///         First 2 eligible sub-member positions per level trigger the next level upgrade.
///         From 3rd sub-member onward, income is fully withdrawable.
///         At Level 12 (MAX_LEVEL) all income is claimable immediately — no upgrade to fund.
///         Auto-upgrade funds are paid to the nearest qualified upline for the upgraded level.
///         Skipped income (from unqualified nodes) is credited to genesis as treasury.
/// @dev No admin can pause withdrawals. Pause is emergency-only for registrations.
///      Binary tree uses BFS auto-placement (top-to-bottom, left-to-right) per sponsor subtree.
contract ARVOMatrix is Initializable, ReentrancyGuardUpgradeableLocal, PausableUpgradeable, OwnableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────
    // All USDT amounts use 18 decimals (BSC USDT: 0x55d398326f99059fF775485246999027B3197955)
    uint256 public constant JOIN_FEE          = 10e18;   // $10 USDT
    uint256 public constant DIRECT_REFERRAL   = 5e18;    // $5  USDT (50%)
    uint256 public constant AUTO_UPGRADE_FUND = 25e17;   // $2.5 USDT (25%)
    uint256 public constant POOL_SHARE        = 2e18;    // $2  USDT (20%)
    uint256 public constant ADMIN_SHARE       = 5e17;    // $0.5 USDT (5%)
    uint256 public constant LEVEL_SHARE       = AUTO_UPGRADE_FUND;
    uint8   public constant MAX_LEVEL         = 12;

    // ─── Immutables ───────────────────────────────────────────────
    IERC20           public usdt;
    IARVOWeeklyPool  public pool;
    address          public genesisAddress;
    address          public skipAdmin1;
    address          public skipAdmin2;

    // ─── User Data ────────────────────────────────────────────────
    struct User {
        bool      isRegistered;
        address   referrer;
        address   parent;
        address[2] children;              // [0]=left, [1]=right
        uint8     currentLevel;
        uint256   directCount;
        uint256   claimableUsdt;
        // Per-level: how many sub-members have contributed income
        uint256[MAX_LEVEL + 1] levelSubCount;
        // Per-level: USDT locked for next upgrade (from first 2 sub-members, levels 1-11 only)
        uint256[MAX_LEVEL + 1] lockedFunds;
    }

    struct MigrationUser {
        address account;
        address referrer;
        address parent;
        address leftChild;
        address rightChild;
        uint8   currentLevel;
        uint256 directCount;
        uint256 claimableUsdt;
        uint256[MAX_LEVEL + 1] levelSubCount;
        uint256[MAX_LEVEL + 1] lockedFunds;
    }

    struct DashboardView {
        bool    isRegistered;
        address referrer;
        address parent;
        address leftChild;
        address rightChild;
        uint8   currentLevel;
        uint256 directCount;
        uint256 claimableUsdt;
        uint256 directIncome;
        uint256 levelIncome;
        uint256 skippedIncome;
        uint256 withdrawn;
    }

    mapping(address => User) public users;
    uint256 public totalMembers;
    bool public migrationClosed;

    // ─── BFS Placement Queue ──────────────────────────────────────
    address[] private _queue;
    uint256   private _queueHead;
    mapping(address => address[]) private _subtreeQueue;
    mapping(address => uint256) private _subtreeQueueHead;

    // ─── UI / Reporting Data ─────────────────────────────────────
    mapping(address => address[]) private _directReferrals;
    mapping(address => uint256) public totalDirectIncome;
    mapping(address => uint256) public totalLevelIncome;
    mapping(address => uint256) public totalSkippedIncome;
    mapping(address => uint256) public totalWithdrawn;

    // ─── Custom Errors ────────────────────────────────────────────
    error AlreadyRegistered();
    error InvalidReferrer();
    error SelfReferral();
    error NothingToWithdraw();
    error NotRegistered();
    error InvalidAdmin();
    error InvalidMigrationInput();
    error MigrationAlreadyRegistered(address user);
    error MigrationUserZero();
    error InvalidLevel(uint8 level);
    error MigrationClosed();

    // ─── Events ───────────────────────────────────────────────────
    event UserRegistered(
        address indexed user,
        address indexed referrer,
        address indexed parent,
        uint8   side,
        uint256 timestamp
    );
    event DirectReferralPaid(
        address indexed referrer,
        address indexed from,
        uint256 amount
    );
    event AutoUpgradeFundReserved(
        address indexed from,
        uint256 amount
    );
    event UpgradeFundPaid(
        address indexed upgradedUser,
        address indexed receiver,
        uint8 indexed toLevel,
        uint256 amount
    );
    event AdminSharePaid(
        address indexed from,
        address indexed admin1,
        address indexed admin2,
        uint256 amount
    );
    event LevelIncomePaid(
        address indexed beneficiary,
        address indexed from,
        uint8   level,
        uint256 amount,
        bool    isWithdrawable
    );
    event LevelUpgrade(
        address indexed user,
        uint8   fromLevel,
        uint8   toLevel,
        uint256 cost
    );
    event Withdrawal(address indexed user, uint256 amount);
    event PoolQualified(address indexed user, uint8 poolId);
    event SkippedIncomePaid(
        address indexed skippedUser,
        address indexed from,
        uint8   level,
        uint256 amount,
        address indexed treasury
    );
    event UsersMigrated(uint256 count, uint256 totalMembers);
    event PlacementQueueMigrated(uint256 queueLength, uint256 queueHead);
    event MigrationClosedForever();
    event UserAccountingMigrated(address indexed user);
    event DirectReferralsMigrated(address indexed referrer, uint256 count, bool replaced);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ─── Initializer ──────────────────────────────────────────────
    /// @param usdt_       BSC USDT address (18 decimals: 0x55d398326f99059fF775485246999027B3197955)
    /// @param pool_       ARVOWeeklyPool contract address
    /// @param genesis_    Root address seeding the binary tree (also acts as treasury for skipped income)
    /// @param skipAdmin1_ First admin address (receives half of 5% admin share)
    /// @param skipAdmin2_ Second admin address (receives other half of 5% admin share)
    function initialize(
        address usdt_,
        address pool_,
        address genesis_,
        address skipAdmin1_,
        address skipAdmin2_
    ) external initializer {
        if (usdt_      == address(0)) revert InvalidAdmin();
        if (pool_      == address(0)) revert InvalidAdmin();
        if (genesis_   == address(0)) revert InvalidAdmin();
        if (skipAdmin1_ == address(0) || skipAdmin2_ == address(0) || skipAdmin1_ == skipAdmin2_)
            revert InvalidAdmin();

        __ReentrancyGuard_init();
        __Pausable_init();
        __Ownable_init(msg.sender);

        usdt           = IERC20(usdt_);
        pool           = IARVOWeeklyPool(pool_);
        genesisAddress = genesis_;
        skipAdmin1     = skipAdmin1_;
        skipAdmin2     = skipAdmin2_;

        // Bootstrap genesis as the root node (fully upgraded, no referrer)
        User storage g = users[genesis_];
        g.isRegistered  = true;
        g.currentLevel  = MAX_LEVEL;
        _subtreeQueue[genesis_].push(genesis_);
        totalMembers = 1;
    }

    // ─── Core: Register ───────────────────────────────────────────

    /// @notice Register as a new ARVO member
    /// @param referrer Address of your direct sponsor (must be registered)
    function register(address referrer) external nonReentrant whenNotPaused {
        if (users[msg.sender].isRegistered) revert AlreadyRegistered();
        if (referrer == msg.sender)         revert SelfReferral();
        if (!users[referrer].isRegistered)  revert InvalidReferrer();

        // Pull $10 USDT from caller
        usdt.safeTransferFrom(msg.sender, address(this), JOIN_FEE);

        // ── 1. Direct Referral: $5 → referrer (instant) ──────────
        usdt.safeTransfer(referrer, DIRECT_REFERRAL);
        users[referrer].directCount++;
        _directReferrals[referrer].push(msg.sender);
        totalDirectIncome[referrer] += DIRECT_REFERRAL;
        emit DirectReferralPaid(referrer, msg.sender, DIRECT_REFERRAL);

        // ── 2. Auto-upgrade fund: $2.5 retained for upgrade payouts
        emit AutoUpgradeFundReserved(msg.sender, AUTO_UPGRADE_FUND);

        // ── 3. Pool Contribution: $2 → ARVOWeeklyPool ────────────
        usdt.forceApprove(address(pool), POOL_SHARE);
        pool.receiveContribution(msg.sender);

        // ── 4. Admin Share: $0.5 → admins, split 50/50 ────────────
        _payAdminShare(msg.sender);

        // ── 5. BFS Tree Placement (within sponsor's subtree) ──────
        (address parent, uint8 side) = _placeInSponsorTree(referrer, msg.sender);

        // ── 6. Initialize new user ────────────────────────────────
        User storage u = users[msg.sender];
        u.isRegistered = true;
        u.referrer     = referrer;
        u.parent       = parent;
        u.currentLevel = 1;
        totalMembers++;

        emit UserRegistered(msg.sender, referrer, parent, side, block.timestamp);

        // ── 7. Track level progression up the binary tree ─────────
        _distributeLevelIncome(msg.sender, parent, 1);

        // ── 8. Check 2-direct qualification for Pool 0 ───────────
        if (users[referrer].directCount == 2) {
            pool.qualifyMember(referrer, 0);
            emit PoolQualified(referrer, 0);
        }
    }

    // ─── Core: Withdraw ───────────────────────────────────────────

    /// @notice Withdraw all claimable USDT earnings
    function withdraw() external nonReentrant {
        uint256 amount = users[msg.sender].claimableUsdt;
        if (amount == 0) revert NothingToWithdraw();
        users[msg.sender].claimableUsdt = 0;
        totalWithdrawn[msg.sender] += amount;
        usdt.safeTransfer(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
    }

    // ─── Emergency Pause (registration only) ─────────────────────
    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Migration ────────────────────────────────────────────────

    /// @notice Batch-import existing user records during migration.
    /// @dev Import users first, then call migratePlacementQueue() with BFS queue order.
    ///      The constructor-created genesis record may be overwritten once with legacy data.
    function migrateUsers(MigrationUser[] calldata migratedUsers) external onlyOwner {
        if (migrationClosed) revert MigrationClosed();
        if (migratedUsers.length == 0) revert InvalidMigrationInput();

        for (uint256 i = 0; i < migratedUsers.length; i++) {
            MigrationUser calldata input = migratedUsers[i];
            _migrateUser(input);
        }

        emit UsersMigrated(migratedUsers.length, totalMembers);
    }

    /// @notice Gas-light migration for old datasets that only need sponsor, level, and directs.
    /// @dev userList must be in legacy BFS order so auto-placement recreates the old tree.
    ///      Existing users are skipped, matching the legacy migration behavior.
    function migrateSimpleUsers(
        address[] calldata userList,
        address[] calldata referrers,
        uint8[] calldata levels,
        uint256[] calldata directs
    ) external onlyOwner {
        if (migrationClosed) revert MigrationClosed();

        uint256 length = userList.length;
        if (
            length == 0 ||
            referrers.length != length ||
            levels.length != length ||
            directs.length != length
        ) revert InvalidMigrationInput();

        uint256 imported;
        for (uint256 i = 0; i < length;) {
            address account = userList[i];
            if (account == address(0)) revert MigrationUserZero();

            if (!users[account].isRegistered) {
                uint8 level = levels[i];
                if (level == 0 || level > MAX_LEVEL) revert InvalidLevel(level);
                if (account == referrers[i]) revert InvalidMigrationInput();

                (address parent,) = _placeInSponsorTree(referrers[i], account);

                User storage u = users[account];
                u.isRegistered = true;
                u.referrer = referrers[i];
                u.parent = parent;
                u.currentLevel = level;
                u.directCount = directs[i];
                if (referrers[i] != address(0)) {
                    _directReferrals[referrers[i]].push(account);
                }

                totalMembers++;
                imported++;
            }

            unchecked { i++; }
        }

        emit UsersMigrated(imported, totalMembers);
    }

    /// @notice Replace the auto-placement queue with the legacy BFS queue order.
    /// @dev queueOrder should be ordered top-to-bottom and left-to-right.
    ///      queueHead should point to the first member that still has an open child slot.
    function migratePlacementQueue(
        address[] calldata queueOrder,
        uint256 queueHead
    ) external onlyOwner {
        if (migrationClosed) revert MigrationClosed();
        if (queueOrder.length == 0 || queueHead >= queueOrder.length) {
            revert InvalidMigrationInput();
        }

        delete _queue;
        for (uint256 i = 0; i < queueOrder.length; i++) {
            address account = queueOrder[i];
            if (account == address(0) || !users[account].isRegistered) {
                revert InvalidMigrationInput();
            }
            _queue.push(account);

            // Non-genesis users: rebuild children links and subtree queues.
            // _registerInAncestorQueues initialises the user's own queue internally —
            // do NOT push account here first or the user would appear twice in their queue.
            if (account != genesisAddress && users[account].parent != address(0)) {
                User storage parentUser = users[users[account].parent];
                if (
                    parentUser.children[0] != account &&
                    parentUser.children[1] != account
                ) {
                    if (parentUser.children[0] == address(0)) {
                        parentUser.children[0] = account;
                    } else if (parentUser.children[1] == address(0)) {
                        parentUser.children[1] = account;
                    }
                }
                _registerInAncestorQueues(account, users[account].parent);
            }
        }

        _queueHead = queueHead;
        emit PlacementQueueMigrated(queueOrder.length, queueHead);
    }

    /// @notice Permanently closes all migration functions.
    function closeMigration() external onlyOwner {
        migrationClosed = true;
        emit MigrationClosedForever();
    }

    /// @notice Import read-only accounting totals for legacy users.
    /// @dev Does not change balances, placement, fees, or withdrawable claimableUsdt.
    /// @param replace When true, sets values (replaces any existing). When false, adds to existing.
    ///                Use replace=true for a clean initial import (before any live activity).
    ///                Use replace=false when a user already has on-chain activity that must be preserved.
    function migrateUserAccounting(
        address[] calldata accounts,
        uint256[] calldata directIncome,
        uint256[] calldata levelIncome,
        uint256[] calldata skippedIncome,
        uint256[] calldata withdrawn,
        bool replace
    ) external onlyOwner {
        if (migrationClosed) revert MigrationClosed();
        if (
            accounts.length == 0 ||
            directIncome.length != accounts.length ||
            levelIncome.length != accounts.length ||
            skippedIncome.length != accounts.length ||
            withdrawn.length != accounts.length
        ) revert InvalidMigrationInput();

        for (uint256 i = 0; i < accounts.length;) {
            address account = accounts[i];
            if (account == address(0)) revert MigrationUserZero();

            if (replace) {
                totalDirectIncome[account]  = directIncome[i];
                totalLevelIncome[account]   = levelIncome[i];
                totalSkippedIncome[account] = skippedIncome[i];
                totalWithdrawn[account]     = withdrawn[i];
            } else {
                totalDirectIncome[account]  += directIncome[i];
                totalLevelIncome[account]   += levelIncome[i];
                totalSkippedIncome[account] += skippedIncome[i];
                totalWithdrawn[account]     += withdrawn[i];
            }

            emit UserAccountingMigrated(account);

            unchecked { i++; }
        }
    }

    /// @notice Import direct-referral lists for legacy users.
    /// @dev Read-only UI index. Does not change directCount or payment logic.
    function migrateDirectReferrals(
        address referrer,
        address[] calldata referrals,
        bool replace
    ) external onlyOwner {
        if (migrationClosed) revert MigrationClosed();
        if (referrer == address(0)) revert MigrationUserZero();
        if (replace) {
            delete _directReferrals[referrer];
        }

        for (uint256 i = 0; i < referrals.length;) {
            address referral = referrals[i];
            if (referral == address(0)) revert MigrationUserZero();
            _directReferrals[referrer].push(referral);
            unchecked { i++; }
        }

        emit DirectReferralsMigrated(referrer, referrals.length, replace);
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyOwner
    {}

    // ─── Internal: BFS Placement ──────────────────────────────────

    /// @dev Places a user into the sponsor's own downline using BFS left-to-right order.
    ///      Every placed member is added to each ancestor's queue so later spillover
    ///      under any ancestor still sees a complete subtree without walking it on-chain.
    function _placeInSponsorTree(address sponsor, address newUser) internal returns (address parent, uint8 side) {
        address[] storage queue = _subtreeQueue[sponsor];
        if (queue.length == 0) {
            queue.push(sponsor);
        }

        uint256 head = _subtreeQueueHead[sponsor];
        while (true) {
            if (head >= queue.length) revert InvalidReferrer();

            parent = queue[head];
            User storage p = users[parent];
            if (p.children[0] == address(0)) {
                p.children[0] = newUser;
                side = 0;
                break;
            }

            if (p.children[1] == address(0)) {
                p.children[1] = newUser;
                side = 1;
                head++;
                break;
            }

            head++;
        }

        _subtreeQueueHead[sponsor] = head;
        _registerInAncestorQueues(newUser, parent);
    }

    function _registerInAncestorQueues(address newUser, address parent) internal {
        _subtreeQueue[newUser].push(newUser);

        address current = parent;
        for (uint8 depth = 0; current != address(0) && depth < MAX_LEVEL; depth++) {
            _subtreeQueue[current].push(newUser);
            current = users[current].parent;
        }
    }

    function _migrateUser(MigrationUser calldata input) internal {
        if (input.account == address(0)) revert MigrationUserZero();
        if (input.currentLevel == 0 || input.currentLevel > MAX_LEVEL) {
            revert InvalidLevel(input.currentLevel);
        }
        if (
            input.account == input.referrer ||
            input.account == input.parent ||
            input.account == input.leftChild ||
            input.account == input.rightChild ||
            (input.leftChild != address(0) && input.leftChild == input.rightChild)
        ) revert InvalidMigrationInput();

        bool isGenesis = input.account == genesisAddress;
        if (users[input.account].isRegistered && !isGenesis) {
            revert MigrationAlreadyRegistered(input.account);
        }

        User storage u = users[input.account];
        bool wasRegistered = u.isRegistered;

        u.isRegistered = true;
        u.referrer = input.referrer;
        u.parent = input.parent;
        u.children[0] = input.leftChild;
        u.children[1] = input.rightChild;
        u.currentLevel = input.currentLevel;
        u.directCount = input.directCount;
        u.claimableUsdt = input.claimableUsdt;

        for (uint8 level = 0; level <= MAX_LEVEL; level++) {
            u.levelSubCount[level] = input.levelSubCount[level];
            u.lockedFunds[level] = input.lockedFunds[level];
        }

        if (!wasRegistered) {
            if (input.referrer != address(0)) {
                _directReferrals[input.referrer].push(input.account);
            }
            totalMembers++;
        }
    }

    // ─── Internal: Level Income Distribution ──────────────────────

    /// @dev Walk up the tree distributing level income at each level.
    ///
    ///      Per the ARVO Matrix business rules:
    ///        • Levels 1–11: first 2 sub-members → locked for auto-upgrade; 3rd+ → claimable.
    ///        • Level 12 (MAX_LEVEL): all sub-members → claimable (no further upgrade to fund).
    ///        • Beneficiary must have currentLevel >= level to earn; otherwise income is
    ///          credited to genesis treasury and propagation continues upward.
    ///        • 2-direct requirement gates claimable profit for positions 3+; skipped income
    ///          also flows to genesis treasury.
    function _distributeLevelIncome(
        address from,
        address beneficiary,
        uint8 level
    ) internal {
        if (beneficiary == address(0) || level > MAX_LEVEL) return;

        User storage b = users[beneficiary];
        uint256 income = LevelConfig.incomePerMember(level);

        // Beneficiary has not yet unlocked this level → credit genesis treasury and continue up
        if (b.currentLevel < level) {
            _creditSkippedIncome(beneficiary, from, level, income);
            _distributeLevelIncome(from, b.parent, uint8(level + 1));
            return;
        }

        b.levelSubCount[level]++;

        // At levels 1–11: first 2 sub-members fund the next-level upgrade.
        // At level 12 there is no next level, so all positions are immediately claimable.
        bool shouldLock = (b.levelSubCount[level] <= 2) && (level < MAX_LEVEL);

        if (shouldLock) {
            b.lockedFunds[level] += income;
            totalLevelIncome[beneficiary] += income;
            emit LevelIncomePaid(beneficiary, from, level, income, false);

            uint256 needed = LevelConfig.upgradeCost(level);
            if (b.lockedFunds[level] >= needed) {
                _autoUpgrade(beneficiary, level);
            }
        } else if (_isEarningEnabled(beneficiary)) {
            b.claimableUsdt += income;
            totalLevelIncome[beneficiary] += income;
            emit LevelIncomePaid(beneficiary, from, level, income, true);
        } else {
            _creditSkippedIncome(beneficiary, from, level, income);
        }

        _distributeLevelIncome(from, b.parent, uint8(level + 1));
    }

    // ─── Internal: Auto Upgrade ───────────────────────────────────

    /// @dev Spend locked funds to advance user to the next level and pay nearest qualified upline.
    function _autoUpgrade(address user, uint8 fromLevel) internal {
        uint8   toLevel = fromLevel + 1;
        uint256 cost    = LevelConfig.upgradeCost(fromLevel);

        User storage u = users[user];
        u.lockedFunds[fromLevel] -= cost;
        if (u.currentLevel < toLevel) {
            u.currentLevel = toLevel;
        }

        address receiver = _qualifiedUpline(user, toLevel);

        uint256 available = usdt.balanceOf(address(this));
        if (available >= cost) {
            usdt.safeTransfer(receiver, cost);
        } else {
            // Fallback: credit claimable balance; USDT physically stays in contract.
            users[receiver].claimableUsdt += cost;
        }
        totalLevelIncome[receiver] += cost;

        emit LevelUpgrade(user, fromLevel, toLevel, cost);
        emit UpgradeFundPaid(user, receiver, toLevel, cost);

        // Qualify for ORBD pool if applicable
        uint8 poolId = LevelConfig.poolIdForLevel(toLevel);
        if (poolId != type(uint8).max) {
            pool.qualifyMember(user, poolId);
            emit PoolQualified(user, poolId);
        }
    }

    function _isEarningEnabled(address user) internal view returns (bool) {
        return users[user].directCount >= 2;
    }

    function _qualifiedUpline(address user, uint8 targetLevel) internal view returns (address) {
        address current = users[user].parent;
        while (current != address(0)) {
            User storage upline = users[current];
            if (
                upline.isRegistered &&
                upline.currentLevel >= targetLevel &&
                (_isEarningEnabled(current) || current == genesisAddress)
            ) {
                return current;
            }
            current = upline.parent;
        }
        return genesisAddress;
    }

    function _payAdminShare(address from) internal {
        uint256 admin1Share = ADMIN_SHARE / 2;
        uint256 admin2Share = ADMIN_SHARE - admin1Share;

        usdt.safeTransfer(skipAdmin1, admin1Share);
        usdt.safeTransfer(skipAdmin2, admin2Share);

        emit AdminSharePaid(from, skipAdmin1, skipAdmin2, ADMIN_SHARE);
    }

    /// @dev Income that cannot be attributed to a qualified beneficiary is credited to genesis
    ///      as treasury (claimable via withdraw). Propagation is handled by the caller.
    function _creditSkippedIncome(
        address skippedUser,
        address from,
        uint8 level,
        uint256 amount
    ) internal {
        totalSkippedIncome[skippedUser] += amount;
        users[genesisAddress].claimableUsdt += amount;
        totalLevelIncome[genesisAddress] += amount;

        emit SkippedIncomePaid(skippedUser, from, level, amount, genesisAddress);
    }

    // ─── View Functions ───────────────────────────────────────────

    function getUserInfo(address user) external view returns (
        bool    isRegistered,
        address referrer,
        uint8   currentLevel,
        uint256 directCount,
        uint256 claimableUsdt
    ) {
        User storage u = users[user];
        return (u.isRegistered, u.referrer, u.currentLevel, u.directCount, u.claimableUsdt);
    }

    function getUserDashboard(address user) external view returns (DashboardView memory dashboard) {
        User storage u = users[user];
        dashboard = DashboardView({
            isRegistered:  u.isRegistered,
            referrer:      u.referrer,
            parent:        u.parent,
            leftChild:     u.children[0],
            rightChild:    u.children[1],
            currentLevel:  u.currentLevel,
            directCount:   u.directCount,
            claimableUsdt: u.claimableUsdt,
            directIncome:  totalDirectIncome[user],
            levelIncome:   totalLevelIncome[user],
            skippedIncome: totalSkippedIncome[user],
            withdrawn:     totalWithdrawn[user]
        });
    }

    function getIncomeTotals(address user) external view returns (
        uint256 directIncome,
        uint256 levelIncome,
        uint256 skippedIncome,
        uint256 withdrawn
    ) {
        return (
            totalDirectIncome[user],
            totalLevelIncome[user],
            totalSkippedIncome[user],
            totalWithdrawn[user]
        );
    }

    function getDirectReferrals(address user) external view returns (address[] memory) {
        return _directReferrals[user];
    }

    function getDirectReferralCount(address user) external view returns (uint256) {
        return _directReferrals[user].length;
    }

    function getDirectReferralsPage(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory referrals) {
        uint256 length = _directReferrals[user].length;
        if (offset >= length || limit == 0) {
            return new address[](0);
        }

        uint256 end = offset + limit;
        if (end > length) end = length;

        referrals = new address[](end - offset);
        for (uint256 i = offset; i < end;) {
            referrals[i - offset] = _directReferrals[user][i];
            unchecked { i++; }
        }
    }

    function isEarningEnabled(address user) external view returns (bool) {
        return _isEarningEnabled(user);
    }

    function getTreeInfo(address user) external view returns (
        address parent,
        address leftChild,
        address rightChild
    ) {
        User storage u = users[user];
        return (u.parent, u.children[0], u.children[1]);
    }

    function getUserChildren(address user) external view returns (
        address leftChild,
        address rightChild
    ) {
        User storage u = users[user];
        return (u.children[0], u.children[1]);
    }

    /// @notice Return downline members in BFS order for UI reads.
    /// @dev Intended for off-chain calls. maxMembers is capped to protect RPC nodes.
    function getTeamAddresses(
        address root,
        uint256 maxDepth,
        uint256 maxMembers
    ) external view returns (address[] memory members) {
        if (maxMembers > 200) maxMembers = 200;
        if (maxDepth > 20) maxDepth = 20;
        if (root == address(0) || maxMembers == 0) {
            return new address[](0);
        }

        address[] memory queue  = new address[](maxMembers + 1);
        uint256[] memory depths = new uint256[](maxMembers + 1);
        address[] memory found  = new address[](maxMembers);
        uint256 head;
        uint256 tail  = 1;
        uint256 count;
        queue[0] = root;

        while (head < tail && count < maxMembers) {
            address current = queue[head];
            uint256 depth   = depths[head];
            head++;

            if (depth >= maxDepth) continue;

            User storage u = users[current];
            for (uint8 side = 0; side < 2 && count < maxMembers; side++) {
                address child = u.children[side];
                if (child == address(0)) continue;

                found[count] = child;
                count++;

                if (tail < queue.length) {
                    queue[tail]  = child;
                    depths[tail] = depth + 1;
                    tail++;
                }
            }
        }

        members = new address[](count);
        for (uint256 i = 0; i < count;) {
            members[i] = found[i];
            unchecked { i++; }
        }
    }

    function getLevelStats(address user, uint8 level) external view returns (
        uint256 subCount,
        uint256 locked
    ) {
        return (users[user].levelSubCount[level], users[user].lockedFunds[level]);
    }

    function getQueueHead() external view returns (uint256) {
        return _queueHead;
    }

    function getQueueLength() external view returns (uint256) {
        return _queue.length;
    }
}

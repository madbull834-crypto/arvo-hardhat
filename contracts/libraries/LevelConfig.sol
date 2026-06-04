// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LevelConfig — Pure library for ARVO level constants
/// @notice All level prices and income values are hardcoded and immutable.
///         All USDT amounts use 18 decimals to match BSC USDT (0x55d398326f99059fF775485246999027B3197955).
library LevelConfig {
    uint8 internal constant MAX_LEVEL = 12;

    /// @notice USDT upgrade cost to advance FROM a given level to the next (18 decimals)
    /// @dev upgradeCost(1) = $5 funds the L1→L2 upgrade. Level 12 has no further upgrade.
    function upgradeCost(uint8 level) internal pure returns (uint256) {
        if (level == 1)  return 5e18;
        if (level == 2)  return 10e18;
        if (level == 3)  return 20e18;
        if (level == 4)  return 40e18;
        if (level == 5)  return 80e18;
        if (level == 6)  return 160e18;
        if (level == 7)  return 320e18;
        if (level == 8)  return 640e18;
        if (level == 9)  return 1_280e18;
        if (level == 10) return 2_560e18;
        if (level == 11) return 5_120e18;
        return 0; // Level 12 — no further upgrade
    }

    /// @notice USDT contributed by each qualifying sub-member at every matrix level (18 decimals)
    /// @dev Upgrade costs increase by level, but each contributing user always adds $2.5.
    ///      Required positions therefore grow naturally: $5/2.5=2, $10/2.5=4, $20/2.5=8, etc.
    function incomePerMember(uint8 level) internal pure returns (uint256) {
        if (level >= 1 && level <= MAX_LEVEL) return 25e17; // $2.5 USDT
        return 0;
    }

    /// @notice ORBD pool USDT-equivalent target per member per pool (18 decimals)
    /// @dev Pool 0 = 2-direct milestone ($5). Pools 1-10 = level upgrades L3-L12.
    function poolTargetUsdt(uint8 poolId) internal pure returns (uint256) {
        if (poolId == 0)  return 5e18;
        if (poolId == 1)  return 10e18;
        if (poolId == 2)  return 20e18;
        if (poolId == 3)  return 40e18;
        if (poolId == 4)  return 80e18;
        if (poolId == 5)  return 160e18;
        if (poolId == 6)  return 320e18;
        if (poolId == 7)  return 640e18;
        if (poolId == 8)  return 1_280e18;
        if (poolId == 9)  return 2_560e18;
        if (poolId == 10) return 5_120e18;
        return 0;
    }

    /// @notice Returns which poolId unlocks when a member reaches a given level
    /// @dev Returns type(uint8).max if no pool is triggered at this level.
    ///      Pool 0 is triggered separately by 2-direct milestone, not by level upgrade.
    ///      Levels 3-12 trigger pools 1-10.
    function poolIdForLevel(uint8 level) internal pure returns (uint8) {
        if (level >= 3 && level <= 12) return level - 2;
        return type(uint8).max;
    }
}

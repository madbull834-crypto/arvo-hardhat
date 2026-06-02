// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IARVOWeeklyPool — Interface for the weekly ORBD pool system
interface IARVOWeeklyPool {
    /// @notice Called by ARVOMatrix on every new registration to contribute $2
    function receiveContribution(address member) external;

    /// @notice Qualify a member for a specific pool by poolId
    function qualifyMember(address member, uint8 poolId) external;

    /// @notice Check if a member is active in a pool
    function isQualified(address member, uint8 poolId) external view returns (bool);
}

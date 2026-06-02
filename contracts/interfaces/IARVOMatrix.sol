// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IARVOMatrix — Interface for the ARVO core matrix contract
interface IARVOMatrix {
    function register(address referrer) external;
    function withdraw() external;
    function getUserInfo(address user) external view returns (
        bool isRegistered,
        address referrer,
        uint8 currentLevel,
        uint256 directCount,
        uint256 claimableUsdt
    );
    function getTreeInfo(address user) external view returns (
        address parent,
        address leftChild,
        address rightChild
    );
    function totalMembers() external view returns (uint256);
}

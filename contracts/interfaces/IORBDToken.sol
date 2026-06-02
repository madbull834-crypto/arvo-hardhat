// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IORBDToken — Interface for ORBD reward token
interface IORBDToken {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

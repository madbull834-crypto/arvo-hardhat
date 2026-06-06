// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

contract MockPermit2 {
    mapping(address => mapping(address => mapping(address => uint160))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowance[msg.sender][token][spender] = amount;
    }
}

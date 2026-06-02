// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDT — Test-only USDT with 18 decimals (matches BSC USDT: 0x55d398326f99059fF775485246999027B3197955)
/// @dev Freely mintable for testing. DO NOT deploy to mainnet.
contract MockUSDT is ERC20 {
    constructor() ERC20("Tether USD", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @notice Mint any amount to any address — test use only
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

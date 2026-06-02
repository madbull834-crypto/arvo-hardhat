// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title MockORBDToken — Test/Testnet-only ORBD with unrestricted minting
/// @notice Mirrors IORBDToken interface so ARVOWeeklyPool can call mint() without MINTER_ROLE.
/// @dev DO NOT deploy to mainnet.
contract MockORBDToken is ERC20, ERC20Burnable {
    constructor() ERC20("ORBD Coin (Test)", "tORBD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev ERC20Burnable exposes burnFrom; IORBDToken expects burn(from, amount).
    ///      This test token allows unrestricted burns to mirror unrestricted minting.
    function burn(address from, uint256 amount) public {
        _burn(from, amount);
    }
}

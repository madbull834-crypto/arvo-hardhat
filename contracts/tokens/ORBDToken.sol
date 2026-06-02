// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20CappedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title ORBDToken — Reward token for ARVO Weekly Pool System
/// @notice BEP-20 token minted exclusively by the ARVOWeeklyPool contract
/// @dev Uses ERC20Capped to enforce a hard supply ceiling.
///      Deployer must grant MINTER_ROLE to ARVOWeeklyPool after deployment.
contract ORBDToken is Initializable, ERC20Upgradeable, ERC20BurnableUpgradeable, ERC20CappedUpgradeable, AccessControlUpgradeable, UUPSUpgradeable {

    // ─── Roles ────────────────────────────────────────────────────
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    // ─── Custom Errors ────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();

    // ─── Events ───────────────────────────────────────────────────
    event TokensMinted(address indexed to, uint256 amount, address indexed minter);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ─── Initializer ──────────────────────────────────────────────
    /// @param maxSupply_ Hard cap on total ORBD supply (18 decimals)
    ///                   TODO: Confirm with team — not specified in PDF
    function initialize(uint256 maxSupply_) external initializer {
        __ERC20_init("ORBD Coin", "ORBD");
        __ERC20Burnable_init();
        __ERC20Capped_init(maxSupply_);
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ─── Minting ──────────────────────────────────────────────────
    /// @notice Mint ORBD tokens to a recipient
    /// @dev Only callable by ARVOWeeklyPool (MINTER_ROLE)
    /// @param to     Recipient address
    /// @param amount Amount of ORBD in 18-decimal precision
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0)      revert ZeroAmount();
        _mint(to, amount);
        emit TokensMinted(to, amount, msg.sender);
    }

    // ─── Overrides ────────────────────────────────────────────────
    /// @dev Required by ERC20Capped to resolve multiple inheritance
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20Upgradeable, ERC20CappedUpgradeable)
    {
        super._update(from, to, value);
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}
}

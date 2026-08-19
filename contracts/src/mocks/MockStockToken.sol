// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IUiMultiplier} from "../interfaces/IStockOracle.sol";

/// @notice Test/dev Stock Token: configurable decimals, settable ERC-8056 style uiMultiplier(), settable
/// `paused()` / `oraclePaused()` status views and EIP-2612 permit (like Robinhood Chain Stock Tokens), open mint/burn.
/// `setMultiplierReverts(true)` makes uiMultiplier() revert (oracle must then report ok = false).
contract MockStockToken is ERC20, ERC20Permit, IUiMultiplier {
    uint8 private immutable _decimals;
    uint256 private _uiMultiplier = 1e18;
    bool public multiplierReverts;
    bool public paused;
    bool public oraclePaused;

    error MultiplierUnavailable();

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function uiMultiplier() external view returns (uint256) {
        if (multiplierReverts) revert MultiplierUnavailable();
        return _uiMultiplier;
    }

    function setUiMultiplier(uint256 m) external {
        _uiMultiplier = m;
    }

    function setMultiplierReverts(bool r) external {
        multiplierReverts = r;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

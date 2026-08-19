// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Test/dev stand-in for USDG: 6 decimals, EIP-2612 permit, open mint.
contract MockUSDG is ERC20, ERC20Permit {
    constructor() ERC20("Global Dollar (mock)", "USDG") ERC20Permit("Global Dollar (mock)") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

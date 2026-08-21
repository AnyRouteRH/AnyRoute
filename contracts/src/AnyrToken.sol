// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title AnyrToken
/// @notice $ANYR, the Anyroute token. Fixed supply of 1,000,000,000 ANYR (18 decimals) minted once
/// in the constructor, split 80/10/5/5 across four recipients. No mint, no owner, no pause.
contract AnyrToken is ERC20, ERC20Permit {
    /// @notice Total (and maximum) supply: 1,000,000,000 ANYR.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @param recipients Allocation recipients: [0] 80%, [1] 10%, [2] 5%, [3] 5%. None may be zero.
    constructor(address[4] memory recipients) ERC20("Anyroute", "ANYR") ERC20Permit("Anyroute") {
        _mint(recipients[0], (TOTAL_SUPPLY * 80) / 100);
        _mint(recipients[1], (TOTAL_SUPPLY * 10) / 100);
        _mint(recipients[2], (TOTAL_SUPPLY * 5) / 100);
        _mint(recipients[3], (TOTAL_SUPPLY * 5) / 100);
    }
}

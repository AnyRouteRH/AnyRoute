// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal ICredits test double: only `credit` (pulls USDG from msg.sender and records it).
contract MockCredits {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    mapping(bytes32 keyHash => uint256) public credited;
    uint256 public creditCalls;
    bool public shouldRevert;

    event Credited(bytes32 indexed keyHash, address indexed source, uint256 amount);

    error MockCreditsReverted();

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function setShouldRevert(bool r) external {
        shouldRevert = r;
    }

    function credit(bytes32 keyHash, uint256 amount) external {
        if (shouldRevert) revert MockCreditsReverted();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        credited[keyHash] += amount;
        creditCalls += 1;
        emit Credited(keyHash, msg.sender, amount);
    }
}

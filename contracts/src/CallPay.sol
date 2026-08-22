// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ICallPay} from "./interfaces/ICallPay.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @title CallPay
/// @notice Per-call USDG payments for callers without an API key (HTTP 402 flow). Each router quote
/// nonce can be paid exactly once; USDG goes to the treasury (directly for pay/payWithPermit, via this
/// contract for payWithAuthorization, which never leaves a balance behind).
contract CallPay is ICallPay, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Payment {
        address payer;
        uint256 amount;
    }

    IERC20 private immutable _usdg;

    /// @inheritdoc ICallPay
    address public treasury;

    /// @inheritdoc ICallPay
    mapping(bytes32 nonce => Payment) public paid;

    error ZeroAddress();

    /// @param usdg_ The USDG token (6 decimals).
    /// @param treasury_ Receiver of all payments.
    /// @param owner_ Owner (timelock) allowed to change the treasury.
    constructor(IERC20 usdg_, address treasury_, address owner_) Ownable(owner_) {
        if (address(usdg_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        _usdg = usdg_;
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @inheritdoc ICallPay
    function usdg() external view returns (address) {
        return address(_usdg);
    }
}

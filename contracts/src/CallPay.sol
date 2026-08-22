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

    /// @inheritdoc ICallPay
    function pay(bytes32 nonce, uint256 amount, uint256 expiry) external nonReentrant {
        _pay(nonce, amount, expiry);
    }

    /// @inheritdoc ICallPay
    /// @dev The permit is wrapped in try/catch so a front-run permit cannot brick the payment.
    function payWithPermit(
        bytes32 nonce,
        uint256 amount,
        uint256 expiry,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        try IERC20Permit(address(_usdg)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _pay(nonce, amount, expiry);
    }

    /// @inheritdoc ICallPay
    /// @dev The quote nonce doubles as the EIP-3009 authorization nonce and receiveWithAuthorization
    /// requires msg.sender == to (this contract), so the signed authorization is bound to this quote and
    /// can only ever move funds into this contract (then to the treasury), whoever submits it.
    function payWithAuthorization(
        bytes32 nonce,
        uint256 amount,
        uint256 expiry,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata signature
    ) external nonReentrant {
        _checkQuote(nonce, amount, expiry);
        if (from == address(0)) revert ZeroAddress();
        paid[nonce] = Payment({payer: from, amount: amount});
        emit Paid(nonce, from, amount);
        IERC3009(address(_usdg)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, signature
        );
        _usdg.safeTransfer(treasury, amount);
    }

    /// @notice Set the treasury that receives payments.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _pay(bytes32 nonce, uint256 amount, uint256 expiry) private {
        _checkQuote(nonce, amount, expiry);
        paid[nonce] = Payment({payer: msg.sender, amount: amount});
        emit Paid(nonce, msg.sender, amount);
        _usdg.safeTransferFrom(msg.sender, treasury, amount);
    }

    function _checkQuote(bytes32 nonce, uint256 amount, uint256 expiry) private view {
        if (paid[nonce].payer != address(0)) revert NonceUsed();
        if (amount == 0) revert InvalidAmount();
        if (block.timestamp > expiry) revert Expired();
    }
}

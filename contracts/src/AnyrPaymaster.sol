// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {UserOperationLib} from "account-abstraction/core/UserOperationLib.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @title AnyrPaymaster
/// @notice ERC-4337 v0.7 verifying paymaster for Anyroute. The router service (verifying signer) signs each
/// sponsored UserOperation off-chain; on-chain, every sender is additionally limited to `dailyCap` wei of gas
/// cost per day (defence in depth against a compromised signer or a runaway client).
/// @dev paymasterAndData = paymaster(20) | pmVerificationGasLimit(16) | pmPostOpGasLimit(16)
///      | abi.encode(uint48 validUntil, uint48 validAfter)(64) | signature(64 or 65).
/// The signed hash (see `getHash`) covers every UserOperation field except the signature and the paymaster
/// signature itself, plus chainid, this paymaster, validUntil and validAfter; it is signed as an EIP-191
/// personal message (`toEthSignedMessageHash`).
///
/// Cap accounting: `maxCost` is reserved at validation, and replaced in `postOp` by an estimate of the final
/// charge: min(maxCost, actualGasCost + (postOpGasLimit + 10% of the callGas+postOp gas limits) * fee), which
/// upper-bounds what the EntryPoint charges after postOp (postOp gas and its unused-gas penalty).
///
/// ERC-7562 compliance: TIMESTAMP is a forbidden opcode during validation, so the day bucket is derived from the
/// *signed* `validUntil` (bucket = validUntil / 1 days, never moving backwards per sender) instead of
/// `block.timestamp`. The signed window must satisfy 0 < validUntil - validAfter <= MAX_VALIDITY_WINDOW, and the
/// EntryPoint enforces validAfter <= now <= validUntil, so an op executed on UTC day D is charged to bucket D or D+1.
/// Hence a sender gets <= 2 x dailyCap per UTC day and <= (N + 1) x dailyCap over N consecutive days, even if the
/// signer misbehaves. The cap is per sender: a compromised signer can still spend across many senders, bounded by
/// the paymaster's EntryPoint deposit. The paymaster reads its own storage and returns a context, so it must be
/// staked (`addStake`) to be accepted by public bundlers.
contract AnyrPaymaster is BasePaymaster, Ownable2Step {
    using UserOperationLib for PackedUserOperation;

    uint256 private constant VALID_TIMESTAMP_OFFSET = PAYMASTER_DATA_OFFSET;
    uint256 private constant SIGNATURE_OFFSET = VALID_TIMESTAMP_OFFSET + 64;

    /// @notice Max signed validity window (validUntil - validAfter).
    uint48 public constant MAX_VALIDITY_WINDOW = 1 days;
    /// @notice Extra gas assumed for EntryPoint bookkeeping after postOp when estimating the final charge.
    uint256 public constant POSTOP_OVERHEAD_GAS = 10_000;

    /// @notice Off-chain signer (router service) authorising sponsorship.
    address public verifyingSigner;
    /// @notice Max gas cost (wei) sponsored per sender per day bucket.
    uint256 public dailyCap;

    /// @notice Per-sender usage in the current day bucket.
    struct Usage {
        uint64 day; // validUntil / 1 days of the bucket
        uint192 spent; // wei (reservations + reconciled charges)
    }

    mapping(address sender => Usage) public usage;

    event VerifyingSignerSet(address indexed signer);
    event DailyCapSet(uint256 cap);
    event Sponsored(address indexed sender, uint64 indexed day, uint256 charged, uint256 maxCost);
}

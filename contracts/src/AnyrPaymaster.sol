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

    error ZeroAddress();
    error InvalidSignatureLength();
    error InvalidValidityWindow();
    error DailyCapExceeded(address sender, uint256 spent, uint256 maxCost, uint256 cap);

    /// @param entryPoint_ EntryPoint v0.7 (0x0000000071727De22E5E9d8BAf0edAc6f37da032 on RHC).
    /// @param signer_ Router service signer.
    /// @param dailyCap_ Per-sender daily sponsorship cap in wei.
    /// @param owner_ Owner (can set signer / cap, manage deposit and stake).
    constructor(IEntryPoint entryPoint_, address signer_, uint256 dailyCap_, address owner_)
        BasePaymaster(entryPoint_)
    {
        if (signer_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        verifyingSigner = signer_;
        dailyCap = dailyCap_;
        _transferOwnership(owner_);
        emit VerifyingSignerSet(signer_);
        emit DailyCapSet(dailyCap_);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function setVerifyingSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        verifyingSigner = signer_;
        emit VerifyingSignerSet(signer_);
    }

    function setDailyCap(uint256 cap) external onlyOwner {
        dailyCap = cap;
        emit DailyCapSet(cap);
    }

    /// @notice Two-step ownership transfer (Ownable2Step): the new owner must call `acceptOwnership`.
    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) {
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Hash the router service signs (then EIP-191 personal-message prefixed).
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                userOp.getSender(),
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(
                    bytes32(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET])
                ),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    function parsePaymasterAndData(bytes calldata paymasterAndData)
        public
        pure
        returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
    {
        (validUntil, validAfter) =
            abi.decode(paymasterAndData[VALID_TIMESTAMP_OFFSET:SIGNATURE_OFFSET], (uint48, uint48));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    /// @notice Remaining sponsorship for `sender` in today's bucket (off-chain helper; uses block.timestamp).
    function remaining(address sender) external view returns (uint256) {
        Usage memory u = usage[sender];
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 spent = u.day >= today ? u.spent : 0;
        return spent >= dailyCap ? 0 : dailyCap - spent;
    }

    // ---------------------------------------------------------------------------------------------
    // Paymaster hooks
    // ---------------------------------------------------------------------------------------------

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        (uint48 validUntil, uint48 validAfter, bytes calldata signature) =
            parsePaymasterAndData(userOp.paymasterAndData);
        if (signature.length != 64 && signature.length != 65) revert InvalidSignatureLength();
        if (!_signedByVerifier(getHash(userOp, validUntil, validAfter), signature)) {
            // do not revert: lets bundlers estimate gas with a dummy signature
            return ("", _packValidationData(true, validUntil, validAfter));
        }
        if (validUntil <= validAfter || validUntil - validAfter > MAX_VALIDITY_WINDOW) {
            revert InvalidValidityWindow();
        }

        context = _reserve(userOp, validUntil, maxCost);
        validationData = _packValidationData(false, validUntil, validAfter);
    }

    function _signedByVerifier(bytes32 hash, bytes calldata signature) internal view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(hash), signature);
        return err == ECDSA.RecoverError.NoError && recovered == verifyingSigner;
    }

    /// @dev Reserve `maxCost` in the sender's day bucket (derived from the signed validUntil; never moves backwards).
    function _reserve(PackedUserOperation calldata userOp, uint48 validUntil, uint256 maxCost)
        internal
        returns (bytes memory context)
    {
        address sender = userOp.getSender();
        Usage memory u = usage[sender];
        uint64 day = uint64(validUntil / 1 days);
        if (day < u.day) day = u.day;
        uint256 spent = day == u.day ? u.spent : 0;
        if (spent + maxCost > dailyCap) revert DailyCapExceeded(sender, spent, maxCost, dailyCap);
        usage[sender] = Usage({day: day, spent: SafeCast.toUint192(spent + maxCost)});

        uint256 postOpGas = userOp.unpackPostOpGasLimit();
        uint256 extraGas = postOpGas + (userOp.unpackCallGasLimit() + postOpGas) / 10 + POSTOP_OVERHEAD_GAS;
        context = abi.encode(sender, day, maxCost, extraGas);
    }

    function _postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        internal
        override
    {
        (address sender, uint64 day, uint256 maxCost, uint256 extraGas) =
            abi.decode(context, (address, uint64, uint256, uint256));
        uint256 charged = actualGasCost + extraGas * actualUserOpFeePerGas;
        if (charged > maxCost) charged = maxCost;

        Usage storage u = usage[sender];
        if (u.day == day) {
            uint256 spent = u.spent;
            // replace the maxCost reservation by the estimated charge
            spent = spent > maxCost ? spent - maxCost : 0;
            // cannot overflow: spent + charged <= previous u.spent (charged <= maxCost)
            u.spent = SafeCast.toUint192(spent + charged);
        }
        emit Sponsored(sender, day, charged, maxCost);
    }
}

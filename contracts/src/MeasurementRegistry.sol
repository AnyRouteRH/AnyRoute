// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IMeasurementRegistry} from "./interfaces/IMeasurementRegistry.sol";

/// @title MeasurementRegistry
/// @notice Registry of the image, compose file and model digests a provider may run on attested hardware.
/// A single owner-set attestor registers measurements after verifying the hardware quote off-chain; the
/// registry stores the keccak256 of the quote proof and the transparency-log entry that published the
/// measurement. It never verifies a quote itself: trusting a record means trusting the attestor that
/// wrote it, which anyone can audit by re-checking the quote proof against the stored hash.
/// @dev Roles follow ReceiptAnchor: an Ownable2Step owner (timelock) sets the attestor. The attestor
/// registers; the attestor or the owner may revoke, so a compromised or misbehaving attestor can always
/// be contained by the owner.
contract MeasurementRegistry is IMeasurementRegistry, Ownable2Step {
    /// @notice Address allowed to register and revoke measurements.
    address public attestor;

    /// @inheritdoc IMeasurementRegistry
    mapping(bytes32 providerId => mapping(bytes32 imageDigest => Measurement)) public measurements;

    /// @inheritdoc IMeasurementRegistry
    mapping(bytes32 providerId => mapping(bytes32 imageDigest => bytes32)) public quoteProofHashes;

    modifier onlyAttestor() {
        if (msg.sender != attestor) revert NotAttestor();
        _;
    }

    /// @param owner_ Owner (timelock).
    /// @param attestor_ Address that registers measurements after off-chain quote verification.
    constructor(address owner_, address attestor_) Ownable(owner_) {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
        emit AttestorSet(attestor_);
    }

    /// @inheritdoc IMeasurementRegistry
    /// @dev `m.attestedAt` and `m.revoked` are ignored: the registry stamps block.timestamp and starts
    /// unrevoked. The quote proof is not stored, only its hash, which the event also carries.
    function register(bytes32 providerId, Measurement calldata m, bytes calldata quoteProof)
        external
        onlyAttestor
    {
        if (providerId == bytes32(0)) revert InvalidProvider();
        if (
            m.imageDigest == bytes32(0) || m.composeHash == bytes32(0) || m.modelDigest == bytes32(0)
                || m.rekorEntry == bytes32(0)
        ) revert InvalidMeasurement();
        if (quoteProof.length == 0) revert EmptyQuoteProof();
        if (measurements[providerId][m.imageDigest].attestedAt != 0) revert AlreadyRegistered();

        bytes32 proofHash = keccak256(quoteProof);
        measurements[providerId][m.imageDigest] = Measurement({
            imageDigest: m.imageDigest,
            composeHash: m.composeHash,
            modelDigest: m.modelDigest,
            rekorEntry: m.rekorEntry,
            attestedAt: uint64(block.timestamp),
            revoked: false
        });
        quoteProofHashes[providerId][m.imageDigest] = proofHash;
        emit Attested(providerId, m.imageDigest, m.modelDigest, m.composeHash, m.rekorEntry, proofHash);
    }

    /// @inheritdoc IMeasurementRegistry
    function revoke(bytes32 providerId, bytes32 imageDigest) external {
        if (msg.sender != attestor && msg.sender != owner()) revert NotAttestor();
        Measurement storage m = measurements[providerId][imageDigest];
        if (m.attestedAt == 0) revert UnknownMeasurement();
        if (m.revoked) revert AlreadyRevoked();
        m.revoked = true;
        emit Revoked(providerId, imageDigest, msg.sender);
    }

    /// @notice Set the attestor.
    function setAttestor(address attestor_) external onlyOwner {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
        emit AttestorSet(attestor_);
    }

    /// @inheritdoc IMeasurementRegistry
    function isAttested(bytes32 providerId, bytes32 imageDigest, bytes32 modelDigest)
        external
        view
        returns (bool)
    {
        Measurement storage m = measurements[providerId][imageDigest];
        return m.attestedAt != 0 && !m.revoked && m.modelDigest == modelDigest;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice On-chain registry of the software measurements a provider's confidential-compute endpoint
/// is allowed to run: the container image, the compose file and the served model weights.
/// A designated attestor verifies the hardware quote OFF-chain and registers the result here. The
/// registry stores the hash of the quote proof (not the proof) so that anyone holding the proof can
/// check it matches what the attestor registered. The contract does not verify quotes itself.
interface IMeasurementRegistry {
    /// @param imageDigest Digest of the container image (for example the sha256 of an OCI manifest).
    /// @param composeHash Hash of the compose file that launches the image.
    /// @param modelDigest Digest of the served model weights.
    /// @param rekorEntry Identifier of the public transparency-log entry that publishes this measurement
    /// (the 32-byte entry hash of a Rekor UUID).
    /// @param attestedAt Set by the registry to block.timestamp when registered; any value passed to
    /// register() is ignored.
    /// @param revoked Set by revoke(); a value passed to register() is ignored.
    struct Measurement {
        bytes32 imageDigest;
        bytes32 composeHash;
        bytes32 modelDigest;
        bytes32 rekorEntry;
        uint64 attestedAt;
        bool revoked;
    }

    event Attested(
        bytes32 indexed providerId,
        bytes32 imageDigest,
        bytes32 modelDigest,
        bytes32 composeHash,
        bytes32 rekorEntry,
        bytes32 quoteProofHash
    );
    event Revoked(bytes32 indexed providerId, bytes32 indexed imageDigest, address indexed by);
    event AttestorSet(address indexed attestor);

    error NotAttestor();
    error ZeroAddress();
    error InvalidProvider();
    error InvalidMeasurement();
    error EmptyQuoteProof();
    error AlreadyRegistered();
    error UnknownMeasurement();
    error AlreadyRevoked();

    /// @notice Record a measurement the attestor verified off-chain. One record per (providerId, imageDigest);
    /// a record is never overwritten, not even after revocation.
    /// @dev Only the attestor. All four digests must be non-zero and `quoteProof` must be non-empty.
    function register(bytes32 providerId, Measurement calldata m, bytes calldata quoteProof) external;

    /// @notice Revoke a provider's image. The attestor or the owner may revoke; revocation is final.
    function revoke(bytes32 providerId, bytes32 imageDigest) external;

    /// @notice True when the provider has a registered, non-revoked measurement for exactly this image
    /// digest and model digest.
    function isAttested(bytes32 providerId, bytes32 imageDigest, bytes32 modelDigest)
        external
        view
        returns (bool);

    /// @notice The stored record (all zeros when nothing is registered).
    function measurements(bytes32 providerId, bytes32 imageDigest)
        external
        view
        returns (
            bytes32 imageDigest_,
            bytes32 composeHash,
            bytes32 modelDigest,
            bytes32 rekorEntry,
            uint64 attestedAt,
            bool revoked
        );

    /// @notice keccak256 of the quote proof the attestor registered (zero when nothing is registered).
    function quoteProofHashes(bytes32 providerId, bytes32 imageDigest) external view returns (bytes32);

    function attestor() external view returns (address);
}

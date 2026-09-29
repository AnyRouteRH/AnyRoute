// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Hourly merkle roots of signed generation receipts, plus the registry of the
/// Ed25519 receipt-signing public keys (rotated weekly) so anyone can verify a receipt
/// signature and its inclusion without trusting the router.
/// Leaf = keccak256(bytes.concat(keccak256(receiptCanonicalBytes || signatureBytes))).
/// Tree = OpenZeppelin MerkleProof (sorted pairs, keccak256).
interface IReceiptAnchor {
    event Anchored(uint256 indexed index, bytes32 root, uint64 fromTs, uint64 toTs, uint32 count);
    event SigningKeyRegistered(bytes8 indexed keyId, bytes32 ed25519PublicKey, uint64 validFrom);
    event SigningKeyRevoked(bytes8 indexed keyId, uint64 revokedAt);
    event AnchorerSet(address indexed anchorer);
    /// @notice A root of receipts served by one provider under one attestation. `attestationRef` is an
    /// opaque 32-byte reference (for example the hash of the attestation report or its registry record);
    /// the anchor does not check it against any registry.
    event AttestedAnchored(
        uint256 indexed index, bytes32 indexed providerId, bytes32 root, bytes32 attestationRef
    );

    error NotAnchorer();
    error OutOfOrder();
    error EmptyRoot();
    error UnknownKey();
    error EmptyProvider();
    error EmptyAttestationRef();

    /// @notice Publish a root with a nonempty, half-open batch interval [fromTs, toTs).
    /// @dev Count and time bounds are informational. Consumers must deduplicate receipt IDs/leaves.
    function anchor(bytes32 root, uint64 fromTs, uint64 toTs, uint32 count) external returns (uint256 index);
    function verify(bytes32 leaf, bytes32[] calldata proof, uint256 index) external view returns (bool);
    function registerSigningKey(bytes8 keyId, bytes32 ed25519PublicKey, uint64 validFrom) external;
    function revokeSigningKey(bytes8 keyId) external;

    /// @notice Publish a root of receipts served by `providerId` under `attestationRef`. Attested anchors
    /// have their own append-only index space and are independent of the windowed anchors above.
    function anchorAttested(bytes32 providerId, bytes32 root, bytes32 attestationRef)
        external
        returns (uint256 index);
    /// @notice Merkle inclusion against an attested anchor (same leaf and tree rules as `verify`).
    function verifyAttested(bytes32 leaf, bytes32[] calldata proof, uint256 index)
        external
        view
        returns (bool);
    function attestedAnchorCount() external view returns (uint256);
    /// @dev Returns zeros (never reverts) for an unknown index.
    function attestedAnchors(uint256 index)
        external
        view
        returns (bytes32 providerId, bytes32 root, bytes32 attestationRef, uint64 anchoredAt);

    function anchorCount() external view returns (uint256);
    function anchors(uint256 index) external view returns (bytes32 root, uint64 fromTs, uint64 toTs, uint32 count);
    function signingKeys(bytes8 keyId) external view returns (bytes32 publicKey, uint64 validFrom, uint64 revokedAt);
}

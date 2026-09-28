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

    error NotAnchorer();
    error OutOfOrder();
    error EmptyRoot();
    error UnknownKey();

    /// @notice Publish a root with a nonempty, half-open batch interval [fromTs, toTs).
    /// @dev Count and time bounds are informational. Consumers must deduplicate receipt IDs/leaves.
    function anchor(bytes32 root, uint64 fromTs, uint64 toTs, uint32 count) external returns (uint256 index);
    function verify(bytes32 leaf, bytes32[] calldata proof, uint256 index) external view returns (bool);
    function registerSigningKey(bytes8 keyId, bytes32 ed25519PublicKey, uint64 validFrom) external;
    function revokeSigningKey(bytes8 keyId) external;

    function anchorCount() external view returns (uint256);
    function anchors(uint256 index) external view returns (bytes32 root, uint64 fromTs, uint64 toTs, uint32 count);
    function signingKeys(bytes8 keyId) external view returns (bytes32 publicKey, uint64 validFrom, uint64 revokedAt);
}

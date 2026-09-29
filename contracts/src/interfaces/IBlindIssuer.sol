// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Public record of the blind-token issuer: one commitment per epoch over the issuer keys of every
/// denomination, aggregate issuance counts, and revocations.
///
/// The router issues Privacy Pass tokens (RFC 9578 type 0x0002, blind RSA per RFC 9474). Each epoch (a week)
/// has one 2048-bit RSA key per denomination; a key is named by its token_key_id, the SHA-256 of its
/// SubjectPublicKeyInfo. Committing those ids here before the epoch starts lets anyone check that the keys the
/// router publishes are the keys it committed to, and that it never served different clients different keys.
///
/// commitment = keccak256(abi.encode(uint64 epoch, uint32[] denominations, bytes32[] keyIds)), denominations
/// strictly ascending, keyIds[i] the token_key_id for denominations[i].
///
/// Nothing here mentions a buyer, a payment or a token: only how many tokens of a denomination an epoch's key
/// has signed. A blind signature cannot be tied to the request it answered, so counts are all there is to record.
interface IBlindIssuer {
    event EpochCommitted(uint64 indexed epoch, bytes32 commitment, uint32[] denominations, bytes32[] keyIds);
    event TokensIssued(uint64 indexed epoch, uint32 indexed denomination, uint32 count);
    event EpochRevoked(uint64 indexed epoch, uint64 revokedAt, bytes32 reason);
    event IssuerSet(address indexed issuer);

    error NotIssuer();
    error NotIssuerOrOwner();
    error EpochAlreadyCommitted();
    error UnknownEpoch();
    error EpochIsRevoked();
    error AlreadyRevoked();
    error InvalidKeys();
    error KeyIdReused();
    error UnknownDenomination();
    error ZeroCount();

    /// @notice Commit the issuer keys of one epoch. Once, and never changed: an epoch is revoked, not rewritten.
    function commitEpoch(uint64 epoch, uint32[] calldata denominations, bytes32[] calldata keyIds) external;
    /// @notice Record that an epoch's key for a denomination signed `count` more tokens (an aggregate, no buyer).
    function recordIssuance(uint64 epoch, uint32 denomination, uint32 count) external;
    /// @notice Stop trusting an epoch's keys (a compromise or a mis-issue). Callable by the issuer or the owner.
    function revokeEpoch(uint64 epoch, bytes32 reason) external;

    function commitmentOf(uint64 epoch) external view returns (bytes32);
    function keyIdOf(uint64 epoch, uint32 denomination) external view returns (bytes32);
    function issuedCount(uint64 epoch, uint32 denomination) external view returns (uint64);
    function revokedAt(uint64 epoch) external view returns (uint64);
    /// @notice The epoch a token_key_id was committed for, and whether that epoch is revoked. `found` is false for an unknown id.
    function keyInfo(bytes32 keyId) external view returns (bool found, uint64 epoch, bool revoked);
    /// @notice Recompute a commitment from its parts and compare it with the stored one.
    function verifyCommitment(uint64 epoch, uint32[] calldata denominations, bytes32[] calldata keyIds)
        external
        view
        returns (bool);
}

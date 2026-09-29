// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IBlindIssuer} from "./interfaces/IBlindIssuer.sol";

/// @title BlindIssuer
/// @notice Per-epoch commitments to the blind-token issuer's public keys, aggregate issuance counts, and
/// revocation. See IBlindIssuer for what is committed and what is deliberately not recorded.
/// @dev There is no custody here. Tokens are bought with router credits off chain, so a revoked epoch is
/// signalled by `EpochRevoked` and `revokedAt`; how holders are made whole is the router's policy, not this
/// contract's.
contract BlindIssuer is IBlindIssuer, Ownable2Step {
    struct Epoch {
        bytes32 commitment;
        uint64 committedAt;
        uint64 revokedAt;
    }

    struct KeyRef {
        bool found;
        uint64 epoch;
    }

    /// @notice Most denominations one epoch may commit (the router uses three).
    uint256 public constant MAX_DENOMINATIONS = 8;

    /// @notice Address allowed to commit epochs and record issuance (the router's issuer role).
    address public issuer;

    mapping(uint64 epoch => Epoch) private _epochs;
    mapping(uint64 epoch => mapping(uint32 denomination => bytes32)) private _keyIds;
    mapping(uint64 epoch => mapping(uint32 denomination => uint64)) private _issued;
    /// @dev The epoch each key id was committed for.
    mapping(bytes32 keyId => KeyRef) private _keyRefs;

    error ZeroAddress();

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    /// @param owner_ Owner (timelock); may replace the issuer and revoke an epoch.
    /// @param issuer_ The router's issuer role.
    constructor(address owner_, address issuer_) Ownable(owner_) {
        if (issuer_ == address(0)) revert ZeroAddress();
        issuer = issuer_;
        emit IssuerSet(issuer_);
    }

    /// @inheritdoc IBlindIssuer
    function commitEpoch(uint64 epoch, uint32[] calldata denominations, bytes32[] calldata keyIds)
        external
        onlyIssuer
    {
        Epoch storage e = _epochs[epoch];
        if (e.committedAt != 0) revert EpochAlreadyCommitted();
        uint256 n = denominations.length;
        if (n == 0 || n > MAX_DENOMINATIONS || n != keyIds.length) revert InvalidKeys();
        uint32 previous;
        for (uint256 i; i < n; ++i) {
            uint32 d = denominations[i];
            bytes32 id = keyIds[i];
            if (d == 0 || d <= previous || id == bytes32(0)) revert InvalidKeys(); // strictly ascending, nonzero
            if (_keyRefs[id].found) revert KeyIdReused(); // a key belongs to exactly one epoch and denomination
            previous = d;
            _keyIds[epoch][d] = id;
            _keyRefs[id] = KeyRef({found: true, epoch: epoch});
        }
        bytes32 commitment = _commitment(epoch, denominations, keyIds);
        e.commitment = commitment;
        e.committedAt = uint64(block.timestamp);
        emit EpochCommitted(epoch, commitment, denominations, keyIds);
    }

    /// @inheritdoc IBlindIssuer
    function recordIssuance(uint64 epoch, uint32 denomination, uint32 count) external onlyIssuer {
        Epoch storage e = _epochs[epoch];
        if (e.committedAt == 0) revert UnknownEpoch();
        if (e.revokedAt != 0) revert EpochIsRevoked();
        if (_keyIds[epoch][denomination] == bytes32(0)) revert UnknownDenomination();
        if (count == 0) revert ZeroCount();
        _issued[epoch][denomination] += count;
        emit TokensIssued(epoch, denomination, count);
    }

    /// @inheritdoc IBlindIssuer
    function revokeEpoch(uint64 epoch, bytes32 reason) external {
        if (msg.sender != issuer && msg.sender != owner()) revert NotIssuerOrOwner();
        Epoch storage e = _epochs[epoch];
        if (e.committedAt == 0) revert UnknownEpoch();
        if (e.revokedAt != 0) revert AlreadyRevoked();
        uint64 nowTs = uint64(block.timestamp);
        e.revokedAt = nowTs;
        emit EpochRevoked(epoch, nowTs, reason);
    }

    /// @notice Replace the issuer role.
    function setIssuer(address issuer_) external onlyOwner {
        if (issuer_ == address(0)) revert ZeroAddress();
        issuer = issuer_;
        emit IssuerSet(issuer_);
    }

    /// @inheritdoc IBlindIssuer
    function commitmentOf(uint64 epoch) external view returns (bytes32) {
        return _epochs[epoch].commitment;
    }

    /// @inheritdoc IBlindIssuer
    function keyIdOf(uint64 epoch, uint32 denomination) external view returns (bytes32) {
        return _keyIds[epoch][denomination];
    }

    /// @inheritdoc IBlindIssuer
    function issuedCount(uint64 epoch, uint32 denomination) external view returns (uint64) {
        return _issued[epoch][denomination];
    }

    /// @inheritdoc IBlindIssuer
    function revokedAt(uint64 epoch) external view returns (uint64) {
        return _epochs[epoch].revokedAt;
    }

    /// @notice When an epoch was committed (0 when it was not).
    function committedAt(uint64 epoch) external view returns (uint64) {
        return _epochs[epoch].committedAt;
    }

    /// @inheritdoc IBlindIssuer
    function keyInfo(bytes32 keyId) external view returns (bool found, uint64 epoch, bool revoked) {
        KeyRef memory ref = _keyRefs[keyId];
        if (!ref.found) return (false, 0, false);
        return (true, ref.epoch, _epochs[ref.epoch].revokedAt != 0);
    }

    /// @inheritdoc IBlindIssuer
    function verifyCommitment(uint64 epoch, uint32[] calldata denominations, bytes32[] calldata keyIds)
        external
        view
        returns (bool)
    {
        bytes32 stored = _epochs[epoch].commitment;
        return stored != bytes32(0) && stored == _commitment(epoch, denominations, keyIds);
    }

    function _commitment(uint64 epoch, uint32[] calldata denominations, bytes32[] calldata keyIds)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(epoch, denominations, keyIds));
    }
}

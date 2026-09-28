// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IReceiptAnchor} from "./interfaces/IReceiptAnchor.sol";

/// @title ReceiptAnchor
/// @notice Append-only log of merkle roots over signed generation receipts, with non-overlapping,
/// time-ordered windows, plus the registry of Ed25519 receipt-signing keys.
contract ReceiptAnchor is IReceiptAnchor, Ownable2Step {
    struct Anchor {
        bytes32 root;
        uint64 fromTs;
        uint64 toTs;
        uint32 count;
    }

    struct SigningKey {
        bytes32 publicKey;
        uint64 validFrom;
        uint64 revokedAt;
    }

    /// @notice Address allowed to anchor roots and rotate signing keys.
    address public anchorer;

    Anchor[] private _anchors;

    /// @inheritdoc IReceiptAnchor
    mapping(bytes8 keyId => SigningKey) public signingKeys;

    error ZeroAddress();
    error InvalidWindow();
    error InvalidKey();
    error KeyExists();
    error AlreadyRevoked();

    modifier onlyOwnerOrAnchorer() {
        if (msg.sender != anchorer && msg.sender != owner()) revert NotAnchorer();
        _;
    }

    /// @param owner_ Owner (timelock).
    /// @param anchorer_ Automated anchorer.
    constructor(address owner_, address anchorer_) Ownable(owner_) {
        if (anchorer_ == address(0)) revert ZeroAddress();
        anchorer = anchorer_;
        emit AnchorerSet(anchorer_);
    }

    /// @inheritdoc IReceiptAnchor
    /// @dev Batch windows are half-open [fromTs, toTs). Adjacent boundaries are disjoint.
    /// The window and count are metadata: inclusion verifies a leaf, not its timestamp or uniqueness.
    function anchor(bytes32 root, uint64 fromTs, uint64 toTs, uint32 count) external returns (uint256 index) {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (root == bytes32(0)) revert EmptyRoot();
        if (fromTs >= toTs || toTs > block.timestamp) revert InvalidWindow();
        index = _anchors.length;
        if (index != 0 && fromTs < _anchors[index - 1].toTs) revert OutOfOrder();
        _anchors.push(Anchor({root: root, fromTs: fromTs, toTs: toTs, count: count}));
        emit Anchored(index, root, fromTs, toTs, count);
    }

    /// @inheritdoc IReceiptAnchor
    /// @dev Returns false (never reverts) for an unknown index.
    function verify(bytes32 leaf, bytes32[] calldata proof, uint256 index) external view returns (bool) {
        if (index >= _anchors.length) return false;
        return MerkleProof.verifyCalldata(proof, _anchors[index].root, leaf);
    }

    /// @inheritdoc IReceiptAnchor
    /// @dev Keys are immutable once registered (no overwrite), so receipts stay verifiable forever.
    function registerSigningKey(bytes8 keyId, bytes32 ed25519PublicKey, uint64 validFrom)
        external
        onlyOwnerOrAnchorer
    {
        if (keyId == bytes8(0) || ed25519PublicKey == bytes32(0)) revert InvalidKey();
        if (signingKeys[keyId].publicKey != bytes32(0)) revert KeyExists();
        signingKeys[keyId] = SigningKey({publicKey: ed25519PublicKey, validFrom: validFrom, revokedAt: 0});
        emit SigningKeyRegistered(keyId, ed25519PublicKey, validFrom);
    }

    /// @inheritdoc IReceiptAnchor
    function revokeSigningKey(bytes8 keyId) external onlyOwnerOrAnchorer {
        SigningKey storage k = signingKeys[keyId];
        if (k.publicKey == bytes32(0)) revert UnknownKey();
        if (k.revokedAt != 0) revert AlreadyRevoked();
        uint64 nowTs = uint64(block.timestamp);
        k.revokedAt = nowTs;
        emit SigningKeyRevoked(keyId, nowTs);
    }

    /// @notice Set the anchorer.
    function setAnchorer(address anchorer_) external onlyOwner {
        if (anchorer_ == address(0)) revert ZeroAddress();
        anchorer = anchorer_;
        emit AnchorerSet(anchorer_);
    }

    /// @inheritdoc IReceiptAnchor
    function anchorCount() external view returns (uint256) {
        return _anchors.length;
    }

    /// @inheritdoc IReceiptAnchor
    /// @dev Returns zeros (never reverts) for an unknown index; a real anchor never has a zero root.
    function anchors(uint256 index) external view returns (bytes32 root, uint64 fromTs, uint64 toTs, uint32 count) {
        if (index >= _anchors.length) return (bytes32(0), 0, 0, 0);
        Anchor storage a = _anchors[index];
        return (a.root, a.fromTs, a.toTs, a.count);
    }
}

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
    /// @dev Windows are [fromTs, toTs]; a window may start exactly where the previous one ended.
    function anchor(bytes32 root, uint64 fromTs, uint64 toTs, uint32 count) external returns (uint256 index) {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (root == bytes32(0)) revert EmptyRoot();
        if (fromTs > toTs || toTs > block.timestamp) revert InvalidWindow();
        index = _anchors.length;
        if (index != 0 && fromTs < _anchors[index - 1].toTs) revert OutOfOrder();
        _anchors.push(Anchor({root: root, fromTs: fromTs, toTs: toTs, count: count}));
        emit Anchored(index, root, fromTs, toTs, count);
    }
}

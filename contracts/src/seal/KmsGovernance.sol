// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title KmsGovernance
/// @notice Governance for the threshold KMS: which guest OS images and app compose hashes may obtain keys,
/// which KMS enclave measurements may join the KMS, the registered KMS root public key, and the key epoch.
/// KMS nodes read this contract before releasing keys; verifiers check key chains against `kmsInfo()`.
/// @dev Owner is the multisig Safe (through the timelock in production), with Ownable2Step handover.
/// Every change emits an event. Bumping the epoch (monthly and on every TCB advisory) rotates derived
/// sealing keys; nodes on images removed from the allowlist cannot obtain the new epoch's keys.
contract KmsGovernance is Ownable2Step {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice Length of a compressed secp256k1 public key.
    uint256 public constant K256_PUBKEY_LENGTH = 33;

    EnumerableSet.Bytes32Set private _osImages;
    EnumerableSet.Bytes32Set private _composeHashes;
    EnumerableSet.Bytes32Set private _kmsMrs;

    /// @notice Compressed secp256k1 KMS root public key; empty until registered.
    bytes public k256Pubkey;
    /// @notice Hash of the DKG ceremony transcript that produced the current root.
    bytes32 public rootTranscriptHash;
    /// @notice Number of root registrations so far (0 = none).
    uint32 public rootVersion;
    /// @notice Current key epoch. Starts at 1.
    uint64 public epoch = 1;
    /// @notice Block timestamp at which the current epoch started.
    uint64 public epochStartedAt;

    /// @notice A guest OS image hash was allowed (`allowed`) or removed.
    event OsImageSet(bytes32 indexed osImageHash, bool allowed);
    /// @notice An app compose hash was allowed (`allowed`) or removed.
    event ComposeHashSet(bytes32 indexed composeHash, bool allowed);
    /// @notice A KMS enclave measurement was allowed (`allowed`) or removed.
    event KmsMrSet(bytes32 indexed mr, bool allowed);
    /// @notice The KMS root public key was registered or rotated.
    event KmsRootSet(uint32 indexed rootVersion, bytes k256Pubkey, bytes32 transcriptHash);
    /// @notice The key epoch advanced.
    event EpochBumped(uint64 indexed epoch, string reason);

    /// @notice The value is zero.
    error ZeroValue();
    /// @notice The value is already in the set.
    error AlreadyAllowed();
    /// @notice The value is not in the set.
    error NotAllowed();
    /// @notice The public key is not a compressed secp256k1 key.
    error InvalidPubkey();
    /// @notice The reason string is empty.
    error EmptyReason();

    /// @param owner_ Owner (the Safe, or the timelock it controls).
    constructor(address owner_) Ownable(owner_) {
        epochStartedAt = uint64(block.timestamp);
        emit EpochBumped(1, "genesis");
    }

    // ---------------------------------------------------------------------------------------------
    // Allowlists
    // ---------------------------------------------------------------------------------------------

    /// @notice Allow a guest OS image hash.
    function addOsImage(bytes32 osImageHash) external onlyOwner {
        _add(_osImages, osImageHash);
        emit OsImageSet(osImageHash, true);
    }

    /// @notice Remove a guest OS image hash.
    function removeOsImage(bytes32 osImageHash) external onlyOwner {
        _remove(_osImages, osImageHash);
        emit OsImageSet(osImageHash, false);
    }

    /// @notice Allow an app compose hash.
    function addComposeHash(bytes32 composeHash) external onlyOwner {
        _add(_composeHashes, composeHash);
        emit ComposeHashSet(composeHash, true);
    }

    /// @notice Remove an app compose hash.
    function removeComposeHash(bytes32 composeHash) external onlyOwner {
        _remove(_composeHashes, composeHash);
        emit ComposeHashSet(composeHash, false);
    }

    /// @notice Allow a KMS enclave measurement.
    function addKmsMr(bytes32 mr) external onlyOwner {
        _add(_kmsMrs, mr);
        emit KmsMrSet(mr, true);
    }

    /// @notice Remove a KMS enclave measurement.
    function removeKmsMr(bytes32 mr) external onlyOwner {
        _remove(_kmsMrs, mr);
        emit KmsMrSet(mr, false);
    }

    // ---------------------------------------------------------------------------------------------
    // Root key and epochs
    // ---------------------------------------------------------------------------------------------

    /// @notice Register (or rotate) the KMS root public key produced by the DKG ceremony.
    /// @param k256Pubkey_ Compressed secp256k1 key (33 bytes, prefix 0x02 or 0x03).
    /// @param transcriptHash Hash of the ceremony transcript. Non-zero.
    function setKmsRoot(bytes calldata k256Pubkey_, bytes32 transcriptHash) external onlyOwner {
        if (k256Pubkey_.length != K256_PUBKEY_LENGTH || (k256Pubkey_[0] != 0x02 && k256Pubkey_[0] != 0x03)) {
            revert InvalidPubkey();
        }
        if (transcriptHash == bytes32(0)) revert ZeroValue();
        k256Pubkey = k256Pubkey_;
        rootTranscriptHash = transcriptHash;
        uint32 v = ++rootVersion;
        emit KmsRootSet(v, k256Pubkey_, transcriptHash);
    }

    /// @notice Advance the key epoch.
    /// @param reason Non-empty reason, e.g. "monthly" or an advisory id.
    /// @return newEpoch The new epoch.
    function bumpEpoch(string calldata reason) external onlyOwner returns (uint64 newEpoch) {
        if (bytes(reason).length == 0) revert EmptyReason();
        newEpoch = ++epoch;
        epochStartedAt = uint64(block.timestamp);
        emit EpochBumped(newEpoch, reason);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Whether an app with this OS image and compose hash may obtain keys.
    function isAppAllowed(bytes32 osImageHash, bytes32 composeHash) external view returns (bool) {
        return _osImages.contains(osImageHash) && _composeHashes.contains(composeHash);
    }

    /// @notice Whether a guest OS image hash is allowed.
    function isOsImageAllowed(bytes32 osImageHash) external view returns (bool) {
        return _osImages.contains(osImageHash);
    }

    /// @notice Whether an app compose hash is allowed.
    function isComposeHashAllowed(bytes32 composeHash) external view returns (bool) {
        return _composeHashes.contains(composeHash);
    }

    /// @notice Whether a KMS enclave measurement may join the KMS.
    function isKmsAllowed(bytes32 mr) external view returns (bool) {
        return _kmsMrs.contains(mr);
    }

    /// @notice Every allowed guest OS image hash (unordered).
    function allowedOsImages() external view returns (bytes32[] memory) {
        return _osImages.values();
    }

    /// @notice Every allowed app compose hash (unordered).
    function allowedComposeHashes() external view returns (bytes32[] memory) {
        return _composeHashes.values();
    }

    /// @notice Every allowed KMS enclave measurement (unordered).
    function kmsAllowedMrs() external view returns (bytes32[] memory) {
        return _kmsMrs.values();
    }

    /// @notice The KMS root key, its registration count and the current epoch.
    function kmsInfo() external view returns (bytes memory k256Pubkey_, uint32 rootVersion_, uint64 epoch_) {
        return (k256Pubkey, rootVersion, epoch);
    }

    function _add(EnumerableSet.Bytes32Set storage set, bytes32 value) private {
        if (value == bytes32(0)) revert ZeroValue();
        if (!set.add(value)) revert AlreadyAllowed();
    }

    function _remove(EnumerableSet.Bytes32Set storage set, bytes32 value) private {
        if (!set.remove(value)) revert NotAllowed();
    }
}

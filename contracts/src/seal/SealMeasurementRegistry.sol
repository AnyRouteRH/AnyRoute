// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title SealMeasurementRegistry
/// @notice On-chain index of SEAL manifests: the measurements an attested serving image is expected to
/// produce (guest OS image, TDX MRTD and RTMR0-2, compose hash), the transparency-log entry that published
/// the signed manifest, the attestation policy version it was built against, and its validity window.
/// Verifiers check that a quote's compose hash belongs to a published, unrevoked manifest that is valid at
/// the time they verify.
/// @dev This is the SEAL manifest registry. It is deliberately separate from the v1 `MeasurementRegistry`
/// (per-provider image/model digests used by `ProviderBond` and the router), which keeps its behaviour.
///
/// The DSSE envelope signature is never verified on-chain: the registry stores its keccak256 so anyone can
/// check that the envelope fetched from the log is the one the publisher committed to. Trusting a record
/// means trusting the publisher that wrote it, which is auditable against the log entry.
///
/// TDX registers are 48 bytes; each `mrtd` / `rtmr[i]` field holds keccak256 of the raw 48-byte register
/// value as written in the manifest.
///
/// Roles: an Ownable2Step owner (timelock) sets the publisher and the guardian. The publisher publishes;
/// the publisher or the guardian may revoke. Records are write-once and revocation is permanent.
contract SealMeasurementRegistry is Ownable2Step {
    /// @notice Expected measurements of one attested serving image.
    /// @param imageDigest sha256 digest of the serving image (the manifest subject). Primary key.
    /// @param osImageHash Hash of the reproducibly built guest OS image.
    /// @param mrtd keccak256 of the 48-byte TDX MRTD.
    /// @param rtmr keccak256 of the 48-byte TDX RTMR0, RTMR1 and RTMR2.
    /// @param composeHash Hash of the app compose file, which pins every container digest.
    /// @param rekorEntry Reference to the transparency-log entry that published the DSSE envelope.
    /// @param policyVersion Attestation policy version (PolicyRegistry) the manifest was built against.
    /// @param validFrom First second (inclusive) at which the manifest is valid.
    /// @param validUntil First second at which the manifest is no longer valid (exclusive).
    struct Manifest {
        bytes32 imageDigest;
        bytes32 osImageHash;
        bytes32 mrtd;
        bytes32[3] rtmr;
        bytes32 composeHash;
        bytes32 rekorEntry;
        uint32 policyVersion;
        uint64 validFrom;
        uint64 validUntil;
    }

    /// @notice A published manifest and its lifecycle.
    /// @param manifest The manifest as published.
    /// @param dsseSigHash keccak256 of the DSSE envelope signature supplied at publication.
    /// @param publishedAt Block timestamp of publication.
    /// @param revokedAt Block timestamp of revocation, 0 while unrevoked.
    struct Record {
        Manifest manifest;
        bytes32 dsseSigHash;
        uint64 publishedAt;
        uint64 revokedAt;
    }

    /// @notice Address allowed to publish manifests (the measurement service).
    address public publisher;
    /// @notice Address allowed to revoke manifests besides the publisher (incident response).
    address public guardian;
    /// @notice Number of manifests ever published.
    uint256 public manifestCount;

    mapping(bytes32 imageDigest => Record) private _records;

    /// @notice A manifest was published.
    /// @param imageDigest Serving image digest (primary key).
    /// @param composeHash Compose hash the manifest allows.
    /// @param policyVersion Attestation policy version the manifest was built against.
    /// @param osImageHash Guest OS image hash.
    /// @param validFrom Start of the validity window (inclusive).
    /// @param validUntil End of the validity window (exclusive).
    /// @param rekorEntry Transparency-log entry reference.
    /// @param dsseSigHash keccak256 of the DSSE envelope signature.
    event ManifestPublished(
        bytes32 indexed imageDigest,
        bytes32 composeHash,
        uint32 policyVersion,
        bytes32 osImageHash,
        uint64 validFrom,
        uint64 validUntil,
        bytes32 rekorEntry,
        bytes32 dsseSigHash
    );
    /// @notice A manifest was permanently revoked.
    /// @param imageDigest Serving image digest.
    /// @param advisory Human-readable reason, typically a security advisory id.
    event ManifestRevoked(bytes32 indexed imageDigest, string advisory);
    /// @notice The publisher changed.
    event PublisherSet(address indexed publisher);
    /// @notice The guardian changed.
    event GuardianSet(address indexed guardian);

    /// @notice Caller is not the publisher.
    error NotPublisher();
    /// @notice Caller is neither the publisher nor the guardian.
    error NotPublisherOrGuardian();
    /// @notice A required address is zero.
    error ZeroAddress();
    /// @notice A required manifest field is zero.
    error InvalidManifest();
    /// @notice validUntil is not after validFrom.
    error InvalidWindow();
    /// @notice The DSSE signature is empty.
    error EmptySignature();
    /// @notice A manifest for this image digest already exists (records are write-once).
    error AlreadyPublished();
    /// @notice No manifest exists for this image digest.
    error UnknownManifest();
    /// @notice The manifest is already revoked.
    error AlreadyRevoked();
    /// @notice The advisory string is empty.
    error EmptyAdvisory();

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert NotPublisher();
        _;
    }

    modifier onlyPublisherOrGuardian() {
        if (msg.sender != publisher && msg.sender != guardian) revert NotPublisherOrGuardian();
        _;
    }

    /// @param owner_ Owner (timelock).
    /// @param publisher_ Measurement service that publishes manifests.
    /// @param guardian_ Incident-response address that may revoke.
    constructor(address owner_, address publisher_, address guardian_) Ownable(owner_) {
        if (publisher_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        publisher = publisher_;
        guardian = guardian_;
        emit PublisherSet(publisher_);
        emit GuardianSet(guardian_);
    }

    /// @notice Publish a manifest. Every measurement field must be non-zero, the window non-empty and the
    /// image digest unused (including by a revoked manifest: revocation is permanent).
    /// @param m The manifest.
    /// @param dsseSig DSSE envelope signature over the in-toto statement. Only its keccak256 is kept.
    function publish(Manifest calldata m, bytes calldata dsseSig) external onlyPublisher {
        if (
            m.imageDigest == bytes32(0) || m.osImageHash == bytes32(0) || m.mrtd == bytes32(0)
                || m.rtmr[0] == bytes32(0) || m.rtmr[1] == bytes32(0) || m.rtmr[2] == bytes32(0)
                || m.composeHash == bytes32(0) || m.rekorEntry == bytes32(0) || m.policyVersion == 0
        ) revert InvalidManifest();
        if (m.validUntil <= m.validFrom) revert InvalidWindow();
        if (dsseSig.length == 0) revert EmptySignature();
        Record storage r = _records[m.imageDigest];
        if (r.publishedAt != 0) revert AlreadyPublished();

        bytes32 sigHash = keccak256(dsseSig);
        r.manifest = m;
        r.dsseSigHash = sigHash;
        r.publishedAt = uint64(block.timestamp);
        ++manifestCount;
        emit ManifestPublished(
            m.imageDigest,
            m.composeHash,
            m.policyVersion,
            m.osImageHash,
            m.validFrom,
            m.validUntil,
            m.rekorEntry,
            sigHash
        );
    }

    /// @notice Permanently revoke a manifest. There is no un-revoke and the digest cannot be republished.
    /// @param imageDigest Serving image digest.
    /// @param advisory Reason, typically a security advisory id. Must be non-empty.
    function revoke(bytes32 imageDigest, string calldata advisory) external onlyPublisherOrGuardian {
        if (bytes(advisory).length == 0) revert EmptyAdvisory();
        Record storage r = _records[imageDigest];
        if (r.publishedAt == 0) revert UnknownManifest();
        if (r.revokedAt != 0) revert AlreadyRevoked();
        r.revokedAt = uint64(block.timestamp);
        emit ManifestRevoked(imageDigest, advisory);
    }

    /// @notice Set the publisher.
    function setPublisher(address publisher_) external onlyOwner {
        if (publisher_ == address(0)) revert ZeroAddress();
        publisher = publisher_;
        emit PublisherSet(publisher_);
    }

    /// @notice Set the guardian.
    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Whether `composeHash` is allowed for `imageDigest` at time `at`.
    /// @dev True iff the manifest exists, is not revoked, matches `composeHash` and
    /// `validFrom <= at < validUntil`. A revoked manifest is invalid at every `at`, including times before
    /// the revocation; use `recordOf(...).revokedAt` for history.
    function isValid(bytes32 imageDigest, bytes32 composeHash, uint64 at) external view returns (bool) {
        Record storage r = _records[imageDigest];
        Manifest storage m = r.manifest;
        return r.publishedAt != 0 && r.revokedAt == 0 && m.composeHash == composeHash && at >= m.validFrom
            && at < m.validUntil;
    }

    /// @notice Whether the manifest for `imageDigest` has been revoked.
    function isRevoked(bytes32 imageDigest) external view returns (bool) {
        return _records[imageDigest].revokedAt != 0;
    }

    /// @notice The published manifest for `imageDigest` (all zero if unknown).
    function manifestOf(bytes32 imageDigest) external view returns (Manifest memory) {
        return _records[imageDigest].manifest;
    }

    /// @notice The full record for `imageDigest` (all zero if unknown).
    function recordOf(bytes32 imageDigest) external view returns (Record memory) {
        return _records[imageDigest];
    }
}

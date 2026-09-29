// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PolicyRegistry
/// @notice Versioned attestation policies. Each version commits to the canonical policy document
/// (hash of its JCS-canonical JSON) and mirrors the fields verifiers gate on: which DCAP TCB statuses are
/// accepted, how long an OutOfDate TCB stays acceptable after an advisory, which GPU reference-measurement
/// allowlist applies and the minimum GPU driver. SDKs pin a minimum version and ask `isAccepted`.
/// @dev Versions are 1..latestVersion, assigned on publish and never reused. A version is accepted from
/// its publication until it is deprecated plus a grace window; deprecation is permanent. The Revoked TCB
/// status can never be accepted.
///
/// Roles: an Ownable2Step owner (timelock) sets the publisher and the guardian. The publisher publishes;
/// the publisher or the guardian may deprecate.
contract PolicyRegistry is Ownable2Step {
    /// @notice DCAP TCB status bit positions in `Policy.acceptedTcbStatuses`.
    uint16 public constant TCB_UP_TO_DATE = 1 << 0;
    uint16 public constant TCB_SW_HARDENING_NEEDED = 1 << 1;
    uint16 public constant TCB_CONFIGURATION_NEEDED = 1 << 2;
    uint16 public constant TCB_CONFIGURATION_AND_SW_HARDENING_NEEDED = 1 << 3;
    uint16 public constant TCB_OUT_OF_DATE = 1 << 4;
    uint16 public constant TCB_OUT_OF_DATE_CONFIGURATION_NEEDED = 1 << 5;
    /// @notice Revoked TCB. Never accepted: a policy that sets this bit is rejected.
    uint16 public constant TCB_REVOKED = 1 << 6;
    /// @notice Every defined status bit.
    uint16 public constant TCB_ALL = (1 << 7) - 1;

    /// @notice Longest OutOfDate advisory grace a policy may declare.
    uint32 public constant MAX_ADVISORY_GRACE = 90 days;
    /// @notice Longest grace a deprecated version may keep being accepted.
    uint32 public constant MAX_DEPRECATION_GRACE = 90 days;

    /// @notice One attestation policy version.
    /// @param policyHash Hash of the canonical attestation policy document.
    /// @param acceptedTcbStatuses Bitmask of accepted DCAP TCB statuses (TCB_* constants).
    /// @param advisoryGrace Seconds an OutOfDate TCB stays acceptable after the advisory that caused it.
    /// @param gpuRimAllowlistHash Hash of the GPU reference integrity manifest allowlist.
    /// @param minDriver Minimum GPU driver, packed as (major << 16) | (minor << 8) | patch.
    /// @param publishedAt Block timestamp of publication.
    /// @param deprecatedAt Block timestamp of deprecation, 0 while current.
    /// @param acceptedUntil End (exclusive) of acceptance once deprecated, 0 while current.
    struct Policy {
        bytes32 policyHash;
        uint16 acceptedTcbStatuses;
        uint32 advisoryGrace;
        bytes32 gpuRimAllowlistHash;
        uint32 minDriver;
        uint64 publishedAt;
        uint64 deprecatedAt;
        uint64 acceptedUntil;
    }

    /// @notice Address allowed to publish policies (the measurement service).
    address public publisher;
    /// @notice Address allowed to deprecate besides the publisher (incident response).
    address public guardian;
    /// @notice Highest published version; 0 before the first publish.
    uint32 public latestVersion;

    mapping(uint32 version => Policy) private _policies;

    /// @notice A policy version was published.
    event PolicyPublished(
        uint32 indexed version,
        bytes32 policyHash,
        uint16 acceptedTcbStatuses,
        uint32 advisoryGrace,
        bytes32 gpuRimAllowlistHash,
        uint32 minDriver
    );
    /// @notice A policy version was deprecated; it stays accepted until `acceptedUntil`.
    event PolicyDeprecated(uint32 indexed version, uint64 acceptedUntil, string reason);
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
    /// @notice A required policy field is zero or out of range.
    error InvalidPolicy();
    /// @notice The status mask accepts the Revoked TCB status.
    error RevokedTcbAccepted();
    /// @notice A grace window exceeds its maximum.
    error GraceTooLong();
    /// @notice The version has not been published.
    error UnknownVersion();
    /// @notice The version is already deprecated.
    error AlreadyDeprecated();
    /// @notice The reason string is empty.
    error EmptyReason();

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert NotPublisher();
        _;
    }

    modifier onlyPublisherOrGuardian() {
        if (msg.sender != publisher && msg.sender != guardian) revert NotPublisherOrGuardian();
        _;
    }

    /// @param owner_ Owner (timelock).
    /// @param publisher_ Measurement service that publishes policies.
    /// @param guardian_ Incident-response address that may deprecate.
    constructor(address owner_, address publisher_, address guardian_) Ownable(owner_) {
        if (publisher_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        publisher = publisher_;
        guardian = guardian_;
        emit PublisherSet(publisher_);
        emit GuardianSet(guardian_);
    }

    /// @notice Publish the next policy version.
    /// @param policyHash Hash of the canonical policy document. Non-zero.
    /// @param acceptedTcbStatuses Accepted TCB statuses; must include at least one defined bit, no
    /// undefined bits and never TCB_REVOKED.
    /// @param advisoryGrace OutOfDate grace in seconds, at most MAX_ADVISORY_GRACE.
    /// @param gpuRimAllowlistHash Hash of the GPU RIM allowlist. Non-zero.
    /// @param minDriver Minimum driver, (major << 16) | (minor << 8) | patch. Non-zero.
    /// @return version The new version number.
    function publish(
        bytes32 policyHash,
        uint16 acceptedTcbStatuses,
        uint32 advisoryGrace,
        bytes32 gpuRimAllowlistHash,
        uint32 minDriver
    ) external onlyPublisher returns (uint32 version) {
        if (acceptedTcbStatuses & TCB_REVOKED != 0) revert RevokedTcbAccepted();
        if (
            policyHash == bytes32(0) || gpuRimAllowlistHash == bytes32(0) || minDriver == 0
                || acceptedTcbStatuses == 0 || acceptedTcbStatuses & ~TCB_ALL != 0
        ) revert InvalidPolicy();
        if (advisoryGrace > MAX_ADVISORY_GRACE) revert GraceTooLong();
        version = ++latestVersion;
        _policies[version] = Policy({
            policyHash: policyHash,
            acceptedTcbStatuses: acceptedTcbStatuses,
            advisoryGrace: advisoryGrace,
            gpuRimAllowlistHash: gpuRimAllowlistHash,
            minDriver: minDriver,
            publishedAt: uint64(block.timestamp),
            deprecatedAt: 0,
            acceptedUntil: 0
        });
        emit PolicyPublished(
            version, policyHash, acceptedTcbStatuses, advisoryGrace, gpuRimAllowlistHash, minDriver
        );
    }

    /// @notice Permanently deprecate a version. It stays accepted for `grace` more seconds.
    /// @param version Published version.
    /// @param grace Seconds of continued acceptance, at most MAX_DEPRECATION_GRACE (0 = immediately).
    /// @param reason Non-empty reason, typically an advisory id.
    function deprecate(uint32 version, uint32 grace, string calldata reason)
        external
        onlyPublisherOrGuardian
    {
        if (bytes(reason).length == 0) revert EmptyReason();
        if (grace > MAX_DEPRECATION_GRACE) revert GraceTooLong();
        Policy storage p = _policies[version];
        if (p.publishedAt == 0) revert UnknownVersion();
        if (p.deprecatedAt != 0) revert AlreadyDeprecated();
        uint64 until = uint64(block.timestamp) + grace;
        p.deprecatedAt = uint64(block.timestamp);
        p.acceptedUntil = until;
        emit PolicyDeprecated(version, until, reason);
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

    /// @notice Whether `version` is accepted at time `at`.
    /// @dev True iff published, `at >= publishedAt` and, once deprecated, `at < acceptedUntil`.
    function isAccepted(uint32 version, uint64 at) external view returns (bool) {
        Policy storage p = _policies[version];
        if (p.publishedAt == 0 || at < p.publishedAt) return false;
        return p.deprecatedAt == 0 || at < p.acceptedUntil;
    }

    /// @notice Whether `version` accepts every TCB status bit in `statuses`.
    function acceptsTcb(uint32 version, uint16 statuses) external view returns (bool) {
        Policy storage p = _policies[version];
        return p.publishedAt != 0 && statuses != 0 && p.acceptedTcbStatuses & statuses == statuses;
    }

    /// @notice The policy for `version` (all zero if unknown).
    function policyOf(uint32 version) external view returns (Policy memory) {
        return _policies[version];
    }

    /// @notice Pack a driver version for `minDriver`, e.g. 595.71.5 -> (595 << 16) | (71 << 8) | 5.
    function packDriver(uint16 major, uint8 minor, uint8 patch) external pure returns (uint32) {
        return (uint32(major) << 16) | (uint32(minor) << 8) | uint32(patch);
    }
}

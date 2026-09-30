// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title SkillRegistry
/// @notice On-chain record of the agent skills the Secured Skills Hub has scanned and published. A skill is keyed by its
/// content hash (sha256 of the canonical tar of its files), so any client that downloads a skill can hash it and ask
/// `isTrusted` or `isInstallable` without trusting the hub's API. The trust level is the hub's static scan result:
/// scanned, not guaranteed.
/// @dev A hash is published once. Revocation is permanent: a revoked hash can never be published again, and a revoked skill
/// is never trusted or installable. The publisher may move a live skill's trust level after a rescan.
///
/// Roles: an Ownable2Step owner (timelock) sets the publisher and the guardian. The publisher publishes, updates trust
/// levels and revokes; the guardian may revoke (incident response).
contract SkillRegistry is Ownable2Step {
    /// @notice Trust levels, matching the hub's scan levels.
    uint8 public constant TRUSTED = 1;
    uint8 public constant CAUTION = 2;
    uint8 public constant DANGEROUS = 3;
    /// @notice Longest metadata URI accepted.
    uint256 public constant MAX_URI_LENGTH = 512;

    /// @notice One published skill.
    /// @param author Address paid for the skill (the author's payout address).
    /// @param priceUSDG Install price in USDG base units (6 decimals); 0 for a free skill.
    /// @param trustLevel TRUSTED, CAUTION or DANGEROUS.
    /// @param publishedAt Block timestamp of publication.
    /// @param revokedAt Block timestamp of revocation, 0 while live.
    /// @param uri Where the manifest and scan report are served.
    struct Skill {
        address author;
        uint96 priceUSDG;
        uint8 trustLevel;
        uint64 publishedAt;
        uint64 revokedAt;
        string uri;
    }

    /// @notice Address allowed to publish (the hub's publishing service).
    address public publisher;
    /// @notice Address allowed to revoke besides the publisher.
    address public guardian;
    /// @notice Number of skills ever published.
    uint256 public skillCount;

    mapping(bytes32 skillHash => Skill) private _skills;

    /// @notice A skill was published.
    event SkillPublished(bytes32 indexed skillHash, address indexed author, uint256 priceUSDG, uint8 trustLevel, string uri);
    /// @notice A live skill's trust level changed after a rescan.
    event TrustLevelUpdated(bytes32 indexed skillHash, uint8 previous, uint8 trustLevel);
    /// @notice A skill was revoked, permanently.
    event SkillRevoked(bytes32 indexed skillHash, address indexed by, string reason);
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
    /// @notice The skill hash is zero.
    error ZeroHash();
    /// @notice The trust level is not TRUSTED, CAUTION or DANGEROUS.
    error InvalidTrustLevel();
    /// @notice The URI is empty or longer than MAX_URI_LENGTH.
    error InvalidUri();
    /// @notice The price does not fit in 96 bits.
    error PriceTooHigh();
    /// @notice The hash was already published (revoked hashes stay taken).
    error AlreadyPublished();
    /// @notice The hash has not been published.
    error UnknownSkill();
    /// @notice The skill is already revoked.
    error AlreadyRevoked();
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
    /// @param publisher_ Hub publishing service.
    /// @param guardian_ Incident-response address that may revoke.
    constructor(address owner_, address publisher_, address guardian_) Ownable(owner_) {
        if (publisher_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        publisher = publisher_;
        guardian = guardian_;
        emit PublisherSet(publisher_);
        emit GuardianSet(guardian_);
    }

    /// @notice Publish a scanned skill.
    /// @param skillHash sha256 of the skill's canonical tar. Non-zero, never published before.
    /// @param author Payout address of the author. Non-zero.
    /// @param priceUSDG Install price in USDG base units; 0 for free.
    /// @param trustLevel TRUSTED, CAUTION or DANGEROUS (a dangerous skill is recorded so clients can refuse it).
    /// @param uri Manifest and scan report location, 1..MAX_URI_LENGTH bytes.
    function publish(bytes32 skillHash, address author, uint256 priceUSDG, uint8 trustLevel, string calldata uri)
        external
        onlyPublisher
    {
        if (skillHash == bytes32(0)) revert ZeroHash();
        if (author == address(0)) revert ZeroAddress();
        if (trustLevel < TRUSTED || trustLevel > DANGEROUS) revert InvalidTrustLevel();
        if (bytes(uri).length == 0 || bytes(uri).length > MAX_URI_LENGTH) revert InvalidUri();
        if (priceUSDG > type(uint96).max) revert PriceTooHigh();
        if (_skills[skillHash].publishedAt != 0) revert AlreadyPublished();
        _skills[skillHash] = Skill({
            author: author,
            priceUSDG: uint96(priceUSDG),
            trustLevel: trustLevel,
            publishedAt: uint64(block.timestamp),
            revokedAt: 0,
            uri: uri
        });
        ++skillCount;
        emit SkillPublished(skillHash, author, priceUSDG, trustLevel, uri);
    }

    /// @notice Move a live skill's trust level after a rescan.
    function setTrustLevel(bytes32 skillHash, uint8 trustLevel) external onlyPublisher {
        if (trustLevel < TRUSTED || trustLevel > DANGEROUS) revert InvalidTrustLevel();
        Skill storage s = _skills[skillHash];
        if (s.publishedAt == 0) revert UnknownSkill();
        if (s.revokedAt != 0) revert AlreadyRevoked();
        uint8 previous = s.trustLevel;
        s.trustLevel = trustLevel;
        emit TrustLevelUpdated(skillHash, previous, trustLevel);
    }

    /// @notice Permanently revoke a skill.
    /// @param skillHash A published, live skill.
    /// @param reason Non-empty reason (an advisory id or a short explanation).
    function revoke(bytes32 skillHash, string calldata reason) external onlyPublisherOrGuardian {
        if (bytes(reason).length == 0) revert EmptyReason();
        Skill storage s = _skills[skillHash];
        if (s.publishedAt == 0) revert UnknownSkill();
        if (s.revokedAt != 0) revert AlreadyRevoked();
        s.revokedAt = uint64(block.timestamp);
        emit SkillRevoked(skillHash, msg.sender, reason);
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

    /// @notice True iff the skill is published, not revoked and scanned TRUSTED.
    function isTrusted(bytes32 skillHash) external view returns (bool) {
        Skill storage s = _skills[skillHash];
        return s.publishedAt != 0 && s.revokedAt == 0 && s.trustLevel == TRUSTED;
    }

    /// @notice True iff the skill is published, not revoked and scanned TRUSTED or CAUTION.
    function isInstallable(bytes32 skillHash) external view returns (bool) {
        Skill storage s = _skills[skillHash];
        return s.publishedAt != 0 && s.revokedAt == 0 && s.trustLevel != DANGEROUS;
    }

    /// @notice The record for `skillHash` (all zero if unknown).
    function skillOf(bytes32 skillHash) external view returns (Skill memory) {
        return _skills[skillHash];
    }
}

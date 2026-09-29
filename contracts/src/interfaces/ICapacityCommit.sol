// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICapacitySource} from "./IAPIU.sol";

/// @notice Providers post a capacity commitment (tokens per day for a number of days) backed by a USDG bond.
/// They may mint APIU against it, up to the committed capacity times the discount fixed when the commitment
/// was posted. A keeper records delivered token-units from anchored receipt roots. After the term and a
/// reporting grace period the commitment is finalized: the bond is cut in proportion to the shortfall, and the
/// cut goes to the slash recipient. The remaining bond is released once the supply the commitment backed has
/// been redeemed, so total supply never exceeds the open committed capacity.
interface ICapacityCommit is ICapacitySource {
    enum Status {
        None,
        Open,
        Finalized,
        Closed
    }

    struct Commit {
        address provider;
        Status status;
        uint16 discountBps;
        uint32 durationDays;
        uint64 startTs;
        uint64 endTs;
        bytes32 providerId;
        uint128 tokensPerDay;
        uint128 deliveredUnits;
        uint128 bond;
        uint128 slashed;
        uint256 capApiu;
        uint256 mintedApiu;
    }

    event Posted(
        uint256 indexed commitId,
        bytes32 indexed providerId,
        address indexed provider,
        uint128 tokensPerDay,
        uint32 durationDays,
        uint256 bond,
        uint256 capApiu,
        uint16 discountBps,
        uint64 startTs,
        uint64 endTs
    );
    event Minted(uint256 indexed commitId, address indexed to, uint256 amount, uint256 totalMinted);
    event DeliveryRecorded(
        uint256 indexed commitId,
        uint256 indexed anchorIndex,
        bytes32 anchorRoot,
        uint256 tokenUnits,
        uint256 totalDelivered,
        bytes32 evidenceRoot
    );
    event Finalized(
        uint256 indexed commitId, uint256 deliveredUnits, uint256 shortfallUnits, uint256 slashed
    );
    event Closed(uint256 indexed commitId, address indexed provider, uint256 bondReleased);
    event KeeperSet(address indexed keeper);
    event SlashRecipientSet(address indexed recipient);
    event DiscountSet(uint16 discountBps);
    event BondRateSet(uint256 bondPerMillionUnits);
    event ReportGraceSet(uint64 reportGrace);
    event MintingPausedSet(bool paused);
    event ProviderBondSet(address indexed providerBond);

    error ZeroAddress();
    error NotKeeper();
    error NotProvider();
    error InvalidProvider();
    error ProviderNotAuthorized();
    error InvalidCommit();
    error InvalidBond();
    error BondTooLow(uint256 required);
    error BondTransferMismatch();
    error InvalidAmount();
    error InvalidDiscount();
    error InvalidGrace();
    error UnknownCommit();
    error NotOpen(uint256 commitId);
    error NotFinalized(uint256 commitId);
    error CommitExpired();
    error MintingPaused();
    error ExceedsCommitCapacity();
    error LengthMismatch();
    error AnchorMismatch();
    error AnchorOutsideTerm(uint256 commitId);
    error AlreadyRecorded(uint256 commitId, uint256 anchorIndex);
    error ReportingClosed(uint256 commitId);
    error NotReady();
    error SupplyExceedsOpenCapacity();

    function post(bytes32 providerId, uint128 tokensPerDay, uint32 durationDays, uint256 bond)
        external
        returns (uint256 commitId);
    function mint(uint256 commitId, address to, uint256 amount) external;
    function recordDelivery(
        uint256 anchorIndex,
        bytes32 anchorRoot,
        bytes32 evidenceRoot,
        uint256[] calldata commitIds,
        uint256[] calldata tokenUnits
    ) external;
    function finalize(uint256 commitId) external;
    function close(uint256 commitId) external;

    function commitOf(uint256 commitId) external view returns (Commit memory);
    function commitCount() external view returns (uint256);
    function totalUnitsOf(uint256 commitId) external view returns (uint256);
    function mintableOf(uint256 commitId) external view returns (uint256);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IReceiptAnchor} from "./interfaces/IReceiptAnchor.sol";
import {IProviderBond} from "./interfaces/IProviderBond.sol";
import {IAPIU, ICapacitySource} from "./interfaces/IAPIU.sol";
import {ICapacityCommit} from "./interfaces/ICapacityCommit.sol";

/// @title CapacityCommit
/// @notice Capacity commitments backed by a USDG bond, and the only place APIU is minted.
///
/// A provider posts {providerId, tokensPerDay, durationDays, bond}; the bond is pulled with transferFrom.
/// The commitment covers `tokensPerDay * durationDays` token-units and lets the provider mint at most
/// `units * 1e12 * discountBps / 10_000` APIU base units (1 APIU = 1,000,000 token-units). The discount is
/// fixed per commitment when it is posted, so later changes never touch an existing cap.
///
/// Delivery is recorded by an owner-set keeper from receipt roots already anchored in ReceiptAnchor: each
/// report names an anchor index and its root, and this contract checks that the anchor exists, that its
/// window overlaps the term, and that the pair (commitment, anchor) is counted once. The token-unit counts
/// themselves are the keeper's report; the chain does not re-verify individual receipts. The optional
/// evidence root in the event lets anyone rebuild the keeper's tally from the public receipts.
///
/// After the term plus `reportGrace`, anyone can finalize: the bond is cut in proportion to the shortfall
/// (`bond * shortfall / total`) and the cut is sent to `slashRecipient` (a treasury or refund pool). The
/// rest of the bond is released by `close`, which is only allowed while total APIU supply stays within the
/// capacity that remains open, so a commitment's bond stays locked until the units it backed were redeemed
/// (or bought back and redeemed by the provider). That keeps `totalSupply <= openCapacityApiu()` at all times.
contract CapacityCommit is ICapacityCommit, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant UNITS_PER_APIU = 1_000_000;
    /// @notice APIU base units (18 decimals) per token-unit: 1e18 / 1e6.
    uint256 public constant APIU_WEI_PER_UNIT = 1e12;
    uint256 public constant BPS = 10_000;
    uint32 public constant MAX_DURATION_DAYS = 365;
    uint64 public constant MIN_REPORT_GRACE = 1 hours;
    uint64 public constant MAX_REPORT_GRACE = 30 days;

    /// @notice The USDG token (6 decimals) bonds are posted in.
    IERC20 public immutable usdg;
    /// @notice The prepaid inference unit minted against commitments.
    IAPIU public immutable apiu;
    /// @notice The log of anchored receipt roots deliveries are recorded against.
    IReceiptAnchor public immutable receiptAnchor;

    /// @notice Optional provider registry check (ProviderBond). Address zero turns the check off.
    IProviderBond public providerBond;
    /// @notice Records delivered token-units from anchored receipt roots.
    address public keeper;
    /// @notice Receives the slashed part of a bond (a treasury or refund pool).
    address public slashRecipient;
    /// @notice Discount applied to capacity for commitments posted from now on, in basis points (1..10,000).
    uint16 public discountBps;
    /// @notice USDG base units of bond required per 1,000,000 committed token-units.
    uint256 public bondPerMillionUnits;
    /// @notice Seconds after a term ends during which the keeper can still record deliveries.
    uint64 public reportGrace;
    /// @notice Stops new mints; existing supply, delivery records and settlement are unaffected.
    bool public mintingPaused;

    /// @notice Commitments ever posted; ids are 1..commitCount.
    uint256 public commitCount;
    /// @inheritdoc ICapacitySource
    uint256 public override openCapacityApiu;

    mapping(uint256 commitId => Commit) private _commits;
    /// @notice Whether the anchor at `anchorIndex` has already been counted for the commitment.
    mapping(uint256 commitId => mapping(uint256 anchorIndex => bool)) public deliveryRecorded;

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    /// @param usdg_ The USDG token.
    /// @param apiu_ The APIU token; this contract must be set as its minter.
    /// @param receiptAnchor_ The ReceiptAnchor log.
    /// @param owner_ Owner (timelock).
    /// @param keeper_ Delivery keeper.
    /// @param slashRecipient_ Receiver of slashed bond.
    /// @param discountBps_ Initial capacity discount in basis points (1..10,000).
    /// @param bondPerMillionUnits_ Initial bond rate (USDG base units per 1,000,000 token-units).
    /// @param reportGrace_ Initial reporting grace period in seconds.
    constructor(
        IERC20 usdg_,
        IAPIU apiu_,
        IReceiptAnchor receiptAnchor_,
        address owner_,
        address keeper_,
        address slashRecipient_,
        uint16 discountBps_,
        uint256 bondPerMillionUnits_,
        uint64 reportGrace_
    ) Ownable(owner_) {
        if (
            address(usdg_) == address(0) || address(apiu_) == address(0)
                || address(receiptAnchor_) == address(0) || keeper_ == address(0)
                || slashRecipient_ == address(0)
        ) revert ZeroAddress();
        if (discountBps_ == 0 || discountBps_ > BPS) revert InvalidDiscount();
        if (reportGrace_ < MIN_REPORT_GRACE || reportGrace_ > MAX_REPORT_GRACE) revert InvalidGrace();
        usdg = usdg_;
        apiu = apiu_;
        receiptAnchor = receiptAnchor_;
        keeper = keeper_;
        slashRecipient = slashRecipient_;
        discountBps = discountBps_;
        bondPerMillionUnits = bondPerMillionUnits_;
        reportGrace = reportGrace_;
        emit KeeperSet(keeper_);
        emit SlashRecipientSet(slashRecipient_);
        emit DiscountSet(discountBps_);
        emit BondRateSet(bondPerMillionUnits_);
        emit ReportGraceSet(reportGrace_);
    }

    // ---------------------------------------------------------------------------------------------
    // Provider
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ICapacityCommit
    /// @dev The term starts now. With a provider registry configured, the caller must be the operator of
    /// `providerId` there and the provider must not be delisted. The bond must cover the configured rate.
    function post(bytes32 providerId, uint128 tokensPerDay, uint32 durationDays, uint256 bond)
        external
        nonReentrant
        returns (uint256 commitId)
    {
        if (providerId == bytes32(0)) revert InvalidProvider();
        if (tokensPerDay == 0 || durationDays == 0 || durationDays > MAX_DURATION_DAYS) {
            revert InvalidCommit();
        }
        if (bond == 0 || bond > type(uint128).max) revert InvalidBond();
        IProviderBond registry = providerBond;
        if (address(registry) != address(0)) {
            if (registry.operatorOf(providerId) != msg.sender || registry.isDelisted(providerId)) {
                revert ProviderNotAuthorized();
            }
        }
        uint256 units = uint256(tokensPerDay) * durationDays;
        // Delivery accounting stores uint128: reject commitments that cannot be represented.
        if (units > type(uint128).max) revert InvalidCommit();
        uint256 required = Math.mulDiv(units, bondPerMillionUnits, UNITS_PER_APIU, Math.Rounding.Ceil);
        if (bond < required) revert BondTooLow(required);

        uint16 discount = discountBps;
        uint256 cap = units * APIU_WEI_PER_UNIT * discount / BPS;
        uint64 startTs = uint64(block.timestamp);
        uint64 endTs = startTs + uint64(durationDays) * 1 days;

        commitId = ++commitCount;
        _commits[commitId] = Commit({
            provider: msg.sender,
            status: Status.Open,
            discountBps: discount,
            durationDays: durationDays,
            startTs: startTs,
            endTs: endTs,
            providerId: providerId,
            tokensPerDay: tokensPerDay,
            deliveredUnits: 0,
            bond: uint128(bond),
            slashed: 0,
            capApiu: cap,
            mintedApiu: 0
        });
        openCapacityApiu += cap;
        emit Posted(
            commitId, providerId, msg.sender, tokensPerDay, durationDays, bond, cap, discount, startTs, endTs
        );

        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), bond);
        if (usdg.balanceOf(address(this)) - before != bond) revert BondTransferMismatch();
    }

    /// @inheritdoc ICapacityCommit
    /// @dev Only the posting provider, only during the term, and never above the commitment's cap. APIU
    /// itself re-checks that total supply stays within `openCapacityApiu`.
    function mint(uint256 commitId, address to, uint256 amount) external nonReentrant {
        Commit storage c = _open(commitId);
        if (msg.sender != c.provider) revert NotProvider();
        if (mintingPaused) revert MintingPaused();
        if (block.timestamp >= c.endTs) revert CommitExpired();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        uint256 minted = c.mintedApiu + amount;
        if (minted > c.capApiu) revert ExceedsCommitCapacity();
        c.mintedApiu = minted;
        emit Minted(commitId, to, amount, minted);
        apiu.mint(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Keeper
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ICapacityCommit
    /// @dev One call covers one anchored receipt root and any number of commitments. `anchorRoot` must equal
    /// the root ReceiptAnchor holds at `anchorIndex`. A commitment counts each anchor once; its delivered
    /// total is clamped to the committed total. The whole call reverts on the first invalid entry.
    function recordDelivery(
        uint256 anchorIndex,
        bytes32 anchorRoot,
        bytes32 evidenceRoot,
        uint256[] calldata commitIds,
        uint256[] calldata tokenUnits
    ) external onlyKeeper {
        if (commitIds.length == 0 || commitIds.length != tokenUnits.length) {
            revert LengthMismatch();
        }
        (bytes32 root, uint64 fromTs, uint64 toTs,) = receiptAnchor.anchors(anchorIndex);
        if (root == bytes32(0) || root != anchorRoot) revert AnchorMismatch();
        for (uint256 i; i < commitIds.length; ++i) {
            uint256 delivered = _record(commitIds[i], anchorIndex, fromTs, toTs, tokenUnits[i]);
            emit DeliveryRecorded(commitIds[i], anchorIndex, root, tokenUnits[i], delivered, evidenceRoot);
        }
    }

    function _record(uint256 id, uint256 anchorIndex, uint64 fromTs, uint64 toTs, uint256 units)
        private
        returns (uint256 delivered)
    {
        Commit storage c = _commits[id];
        if (c.status != Status.Open) revert NotOpen(id);
        if (block.timestamp >= uint256(c.endTs) + reportGrace) revert ReportingClosed(id);
        if (toTs <= c.startTs || fromTs >= c.endTs) revert AnchorOutsideTerm(id);
        if (deliveryRecorded[id][anchorIndex]) revert AlreadyRecorded(id, anchorIndex);
        deliveryRecorded[id][anchorIndex] = true;
        delivered = uint256(c.deliveredUnits) + Math.min(units, _totalUnits(c) - c.deliveredUnits);
        c.deliveredUnits = uint128(delivered);
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement (permissionless)
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ICapacityCommit
    /// @dev Callable once the term and the reporting grace are over. Cuts `bond * shortfall / total` and
    /// sends it to `slashRecipient`. No shortfall, no cut.
    function finalize(uint256 commitId) external nonReentrant {
        Commit storage c = _open(commitId);
        if (block.timestamp < uint256(c.endTs) + reportGrace) revert NotReady();
        uint256 total = _totalUnits(c);
        uint256 delivered = c.deliveredUnits;
        uint256 shortfall = total - delivered;
        uint256 cut = shortfall == 0 ? 0 : Math.mulDiv(c.bond, shortfall, total);
        c.status = Status.Finalized;
        c.slashed = uint128(cut);
        emit Finalized(commitId, delivered, shortfall, cut);
        if (cut != 0) usdg.safeTransfer(slashRecipient, cut);
    }

    /// @inheritdoc ICapacityCommit
    /// @dev Releases the remaining bond to the provider and takes the commitment's capacity out of the open
    /// total. Reverts while the supply would then exceed the capacity that stays open: redeem (or buy back
    /// and redeem) units first. Anyone may call it; the funds only ever go to the provider.
    function close(uint256 commitId) external nonReentrant {
        Commit storage c = _commits[commitId];
        if (c.status == Status.None) revert UnknownCommit();
        if (c.status != Status.Finalized) revert NotFinalized(commitId);
        uint256 remaining = openCapacityApiu - c.capApiu;
        if (IERC20(address(apiu)).totalSupply() > remaining) revert SupplyExceedsOpenCapacity();
        openCapacityApiu = remaining;
        c.status = Status.Closed;
        uint256 release = uint256(c.bond) - c.slashed;
        emit Closed(commitId, c.provider, release);
        if (release != 0) usdg.safeTransfer(c.provider, release);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setSlashRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        slashRecipient = recipient;
        emit SlashRecipientSet(recipient);
    }

    /// @notice Discount for commitments posted after this call. Existing caps are not changed.
    function setDiscountBps(uint16 discountBps_) external onlyOwner {
        if (discountBps_ == 0 || discountBps_ > BPS) revert InvalidDiscount();
        discountBps = discountBps_;
        emit DiscountSet(discountBps_);
    }

    /// @notice Bond rate for commitments posted after this call.
    function setBondPerMillionUnits(uint256 rate) external onlyOwner {
        bondPerMillionUnits = rate;
        emit BondRateSet(rate);
    }

    function setReportGrace(uint64 grace) external onlyOwner {
        if (grace < MIN_REPORT_GRACE || grace > MAX_REPORT_GRACE) revert InvalidGrace();
        reportGrace = grace;
        emit ReportGraceSet(grace);
    }

    function setMintingPaused(bool paused) external onlyOwner {
        mintingPaused = paused;
        emit MintingPausedSet(paused);
    }

    /// @notice Set (or clear, with address zero) the provider registry consulted by `post`.
    function setProviderBond(IProviderBond providerBond_) external onlyOwner {
        providerBond = providerBond_;
        emit ProviderBondSet(address(providerBond_));
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ICapacityCommit
    function commitOf(uint256 commitId) external view returns (Commit memory) {
        return _commits[commitId];
    }

    /// @inheritdoc ICapacityCommit
    function totalUnitsOf(uint256 commitId) external view returns (uint256) {
        return _totalUnits(_commits[commitId]);
    }

    /// @inheritdoc ICapacityCommit
    /// @dev What the provider can still mint now (zero when not open, expired or paused).
    function mintableOf(uint256 commitId) external view returns (uint256) {
        Commit storage c = _commits[commitId];
        if (c.status != Status.Open || block.timestamp >= c.endTs || mintingPaused) return 0;
        return c.capApiu - c.mintedApiu;
    }

    function _open(uint256 commitId) private view returns (Commit storage c) {
        c = _commits[commitId];
        if (c.status == Status.None) revert UnknownCommit();
        if (c.status != Status.Open) revert NotOpen(commitId);
    }

    function _totalUnits(Commit storage c) private view returns (uint256) {
        return uint256(c.tokensPerDay) * c.durationDays;
    }
}

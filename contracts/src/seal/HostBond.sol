// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title HostBond
/// @notice SEAL hosts post a USDG bond (at least `minBond`, 5,000 USDG by default) before they are listed.
/// The slasher multisig proposes slashes for measurement drift, shadow re-execution mismatch, empty
/// responses or uptime below target, each with an evidence root. A slash executes only after the 72h
/// dispute window and an independent owner approval of the exact dispute state. Slashed USDG goes to the
/// refund pool. Unbonding takes a 14-day cooldown, stays slashable while waiting and is blocked while any
/// slash is pending.
/// @dev Same control flow and role separation as `ProviderBond` (slasher proposes and executes, owner
/// independently approves, one dispute per slash invalidates approval, approval generations revoked on
/// role changes), keyed by host id and with the SEAL slash reasons. `ProviderBond` is left untouched: its
/// minimum is a constant and its functions are not virtual, so it cannot be extended without changing
/// its deployed behaviour. Routing eligibility should use `isBonded()`.
contract HostBond is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Why a host is slashed. Append only: never reorder or insert above the last entry.
    enum Reason {
        /// The host served measurements that differ from its published manifest.
        MeasurementDrift,
        /// Shadow re-execution produced a different output than the host.
        ShadowMismatch,
        /// The host returned successful but empty responses.
        EmptyResponses,
        /// Uptime fell below the 95% target.
        Uptime
    }

    enum Status {
        None,
        Pending,
        Cancelled,
        Executed
    }

    struct Host {
        address operator;
        bool delisted;
        uint256 bond;
        uint256 pendingSlashes;
    }

    struct UnbondRequest {
        uint256 amount;
        uint64 availableAt;
    }

    struct Slash {
        bytes32 hostId;
        uint256 amount;
        bytes32 evidenceRoot;
        bytes32 disputeHash;
        uint64 executableAt;
        Reason reason;
        bool delist;
        Status status;
    }

    /// @notice Default and lowest allowed `minBond`: 5,000 USDG (6 decimals).
    uint256 public constant MIN_BOND_FLOOR = 5_000e6;
    /// @notice Highest allowed `minBond`: 100,000 USDG.
    uint256 public constant MIN_BOND_CEILING = 100_000e6;
    /// @notice Time between a slash proposal and its earliest execution.
    uint64 public constant DISPUTE_WINDOW = 72 hours;
    /// @notice Time between an unbond request and its earliest withdrawal.
    uint64 public constant UNBOND_COOLDOWN = 14 days;
    /// @notice Uptime target below which a host may be slashed for `Reason.Uptime`, in basis points.
    uint16 public constant UPTIME_TARGET_BPS = 9_500;

    /// @notice The USDG token (6 decimals).
    IERC20 public immutable usdg;

    /// @notice Minimum bond a host must hold to bond and to stay eligible.
    uint256 public minBond = MIN_BOND_FLOOR;
    /// @notice Slasher multisig.
    address public slasher;
    /// @notice Receiver of slashed USDG.
    address public refundPool;
    /// @notice Number of slashes ever proposed; slash ids are 1..slashCount.
    uint256 public slashCount;
    /// @notice Current approval generation; bumping it voids every outstanding approval.
    uint256 public approvalGeneration = 1;

    mapping(bytes32 hostId => Host) private _hosts;
    /// @notice The pending unbond request of a host (amount, availableAt).
    mapping(bytes32 hostId => UnbondRequest) public unbondRequest;
    /// @notice Full slash record by id.
    mapping(uint256 slashId => Slash) public slashes;
    /// @notice Approval generation recorded for a slash (valid iff equal to `approvalGeneration`).
    mapping(uint256 slashId => uint256 generation) public slashApproval;

    /// @notice A host bonded or topped up. The first bond registers `operator`.
    event Bonded(bytes32 indexed hostId, address indexed operator, uint256 amount, uint256 total);
    /// @notice The operator asked to unbond `amount`, withdrawable from `availableAt`.
    event UnbondRequested(bytes32 indexed hostId, uint256 amount, uint64 availableAt);
    /// @notice The operator cancelled its unbond request.
    event UnbondCancelled(bytes32 indexed hostId);
    /// @notice Unbonded USDG was paid out.
    event Unbonded(bytes32 indexed hostId, address indexed to, uint256 amount);
    /// @notice The slasher proposed a slash.
    event SlashProposed(
        uint256 indexed slashId,
        bytes32 indexed hostId,
        Reason reason,
        uint256 amount,
        bytes32 evidenceRoot,
        uint64 executableAt
    );
    /// @notice The host operator disputed a slash.
    event SlashDisputed(uint256 indexed slashId, bytes32 disputeHash);
    /// @notice The owner approved a slash against the given dispute state.
    event SlashApproved(uint256 indexed slashId, bytes32 disputeHash);
    /// @notice Every outstanding approval was voided.
    event SlashApprovalsRevoked();
    /// @notice A pending slash was cancelled.
    event SlashCancelled(uint256 indexed slashId);
    /// @notice A slash executed; `amount` went to the refund pool.
    event SlashExecuted(uint256 indexed slashId, bytes32 indexed hostId, uint256 amount, bool delisted);
    /// @notice The host was delisted and can no longer bond.
    event Delisted(bytes32 indexed hostId);
    /// @notice The minimum bond changed.
    event MinBondSet(uint256 minBond);
    /// @notice The slasher changed.
    event SlasherSet(address indexed slasher);
    /// @notice The refund pool changed.
    event RefundPoolSet(address indexed pool);

    /// @notice A required address is zero.
    error ZeroAddress();
    /// @notice The amount is zero or exceeds the bond.
    error InvalidAmount();
    /// @notice The host id is zero.
    error InvalidHost();
    /// @notice The evidence root is zero.
    error InvalidEvidence();
    /// @notice The resulting bond would be below `minBond`.
    error BelowMinimum();
    /// @notice `minBond` outside [MIN_BOND_FLOOR, MIN_BOND_CEILING].
    error MinBondOutOfBounds();
    /// @notice Caller is not the host operator.
    error NotOperator();
    /// @notice Caller is not the slasher (or the owner, where allowed).
    error NotSlasher();
    /// @notice A slash is pending for the host.
    error SlashPending();
    /// @notice The cooldown or dispute window has not elapsed.
    error NotReady();
    /// @notice The slash id does not exist.
    error UnknownSlash();
    /// @notice The slash is already cancelled or executed.
    error AlreadyFinal();
    /// @notice There is no unbond request.
    error NothingToUnbond();
    /// @notice The host is delisted.
    error HostDelisted();
    /// @notice The owner must be distinct from the slasher.
    error IndependentOwnerRequired();
    /// @notice The slash has no current owner approval.
    error ApprovalRequired();
    /// @notice The dispute hash is empty, repeated or does not match.
    error InvalidDispute();

    modifier onlySlasher() {
        if (msg.sender != slasher) revert NotSlasher();
        _;
    }

    modifier onlyOperator(bytes32 hostId) {
        if (msg.sender != _hosts[hostId].operator) revert NotOperator();
        _;
    }

    /// @param usdg_ The USDG token.
    /// @param owner_ Owner (timelock); must differ from the slasher.
    /// @param slasher_ Slasher multisig.
    /// @param refundPool_ Receiver of slashed USDG.
    constructor(IERC20 usdg_, address owner_, address slasher_, address refundPool_) Ownable(owner_) {
        if (address(usdg_) == address(0) || slasher_ == address(0) || refundPool_ == address(0)) {
            revert ZeroAddress();
        }
        if (owner_ == slasher_) revert IndependentOwnerRequired();
        usdg = usdg_;
        slasher = slasher_;
        refundPool = refundPool_;
        emit SlasherSet(slasher_);
        emit RefundPoolSet(refundPool_);
        emit MinBondSet(MIN_BOND_FLOOR);
    }

    // ---------------------------------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------------------------------

    /// @notice Post or top up a host bond. The first bond registers msg.sender as the operator; after
    /// that only the operator may top up. The resulting bond must be at least `minBond`.
    /// @param hostId Host id (as configured on the host). Non-zero.
    /// @param amount USDG to add (6 decimals). Non-zero.
    function bond(bytes32 hostId, uint256 amount) external nonReentrant {
        if (hostId == bytes32(0)) revert InvalidHost();
        if (amount == 0) revert InvalidAmount();
        Host storage h = _hosts[hostId];
        if (h.delisted) revert HostDelisted();
        if (h.operator == address(0)) {
            h.operator = msg.sender;
        } else if (msg.sender != h.operator) {
            revert NotOperator();
        }
        uint256 total = h.bond + amount;
        if (total < minBond) revert BelowMinimum();
        h.bond = total;
        emit Bonded(hostId, msg.sender, amount, total);
        usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Ask to unbond `amount` after UNBOND_COOLDOWN. Replaces any previous request. The remaining
    /// bond must be 0 (full exit) or at least `minBond`. The amount stays bonded and slashable until paid.
    function requestUnbond(bytes32 hostId, uint256 amount) external onlyOperator(hostId) {
        Host storage h = _hosts[hostId];
        if (h.pendingSlashes != 0) revert SlashPending();
        if (amount == 0 || amount > h.bond) revert InvalidAmount();
        uint256 remaining = h.bond - amount;
        if (remaining != 0 && remaining < minBond) revert BelowMinimum();
        uint64 availableAt = uint64(block.timestamp) + UNBOND_COOLDOWN;
        unbondRequest[hostId] = UnbondRequest({amount: amount, availableAt: availableAt});
        emit UnbondRequested(hostId, amount, availableAt);
    }

    /// @notice Cancel the pending unbond request.
    function cancelUnbond(bytes32 hostId) external onlyOperator(hostId) {
        if (unbondRequest[hostId].amount == 0) revert NothingToUnbond();
        delete unbondRequest[hostId];
        emit UnbondCancelled(hostId);
    }

    /// @notice Pay out a matured unbond request to `to`. Pays min(requested, current bond), since slashes
    /// may have reduced the bond meanwhile. Blocked while a slash is pending.
    function unbond(bytes32 hostId, address to) external nonReentrant onlyOperator(hostId) {
        if (to == address(0)) revert ZeroAddress();
        UnbondRequest memory req = unbondRequest[hostId];
        if (req.amount == 0) revert NothingToUnbond();
        if (block.timestamp < req.availableAt) revert NotReady();
        Host storage h = _hosts[hostId];
        if (h.pendingSlashes != 0) revert SlashPending();
        uint256 amount = req.amount < h.bond ? req.amount : h.bond;
        if (amount == 0) revert NothingToUnbond();
        delete unbondRequest[hostId];
        h.bond -= amount;
        emit Unbonded(hostId, to, amount);
        usdg.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Slashing
    // ---------------------------------------------------------------------------------------------

    /// @notice Propose a slash. Executable after DISPUTE_WINDOW with owner approval.
    /// @param hostId Host to slash.
    /// @param reason Slash reason.
    /// @param amount USDG to slash; non-zero and at most the current bond.
    /// @param evidenceRoot Merkle root of the evidence bundle. Non-zero.
    /// @param delist Whether execution also delists the host.
    /// @return slashId The new slash id.
    function proposeSlash(bytes32 hostId, Reason reason, uint256 amount, bytes32 evidenceRoot, bool delist)
        external
        onlySlasher
        returns (uint256 slashId)
    {
        Host storage h = _hosts[hostId];
        if (amount == 0 || amount > h.bond) revert InvalidAmount();
        if (evidenceRoot == bytes32(0)) revert InvalidEvidence();
        slashId = ++slashCount;
        uint64 executableAt = uint64(block.timestamp) + DISPUTE_WINDOW;
        slashes[slashId] = Slash({
            hostId: hostId,
            amount: amount,
            evidenceRoot: evidenceRoot,
            disputeHash: bytes32(0),
            executableAt: executableAt,
            reason: reason,
            delist: delist,
            status: Status.Pending
        });
        ++h.pendingSlashes;
        emit SlashProposed(slashId, hostId, reason, amount, evidenceRoot, executableAt);
    }

    /// @notice Record the host's one dispute of a pending slash. Voids any prior approval, so the owner
    /// must re-approve against this exact dispute hash.
    function disputeSlash(uint256 slashId, bytes32 disputeHash) external {
        Slash storage s = _pendingSlash(slashId);
        if (msg.sender != _hosts[s.hostId].operator) revert NotOperator();
        if (disputeHash == bytes32(0) || s.disputeHash != bytes32(0)) revert InvalidDispute();
        delete slashApproval[slashId];
        s.disputeHash = disputeHash;
        emit SlashDisputed(slashId, disputeHash);
    }

    /// @notice Reject a pending slash. Callable by the slasher or the owner.
    function cancelSlash(uint256 slashId) external {
        if (msg.sender != slasher && msg.sender != owner()) revert NotSlasher();
        Slash storage s = _pendingSlash(slashId);
        s.status = Status.Cancelled;
        --_hosts[s.hostId].pendingSlashes;
        emit SlashCancelled(slashId);
    }

    /// @notice Execute an approved slash after its dispute window. Transfers min(amount, current bond) to
    /// the refund pool and delists the host if the proposal said so.
    function executeSlash(uint256 slashId) external onlySlasher nonReentrant {
        Slash storage s = _pendingSlash(slashId);
        if (block.timestamp < s.executableAt) revert NotReady();
        if (slashApproval[slashId] != approvalGeneration) revert ApprovalRequired();
        delete slashApproval[slashId];
        bytes32 hostId = s.hostId;
        Host storage h = _hosts[hostId];
        uint256 amount = s.amount < h.bond ? s.amount : h.bond;
        bool delist = s.delist;

        s.status = Status.Executed;
        h.bond -= amount;
        --h.pendingSlashes;
        if (delist && !h.delisted) {
            h.delisted = true;
            emit Delisted(hostId);
        }
        emit SlashExecuted(slashId, hostId, amount, delist);
        if (amount != 0) usdg.safeTransfer(refundPool, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Approve a pending slash after reviewing the proposal and the exact current dispute.
    /// @param expectedDisputeHash The dispute hash reviewed (bytes32(0) if undisputed).
    function approveSlash(uint256 slashId, bytes32 expectedDisputeHash) external onlyOwner {
        Slash storage s = _pendingSlash(slashId);
        if (s.disputeHash != expectedDisputeHash) revert InvalidDispute();
        slashApproval[slashId] = approvalGeneration;
        emit SlashApproved(slashId, expectedDisputeHash);
    }

    /// @notice Void every outstanding slash approval.
    function revokeSlashApprovals() external onlyOwner {
        _revokeSlashApprovals();
    }

    /// @notice Set the minimum bond within [MIN_BOND_FLOOR, MIN_BOND_CEILING]. Existing hosts below a
    /// raised minimum stay bonded but are no longer eligible (`isBonded`) until they top up.
    function setMinBond(uint256 minBond_) external onlyOwner {
        if (minBond_ < MIN_BOND_FLOOR || minBond_ > MIN_BOND_CEILING) revert MinBondOutOfBounds();
        minBond = minBond_;
        emit MinBondSet(minBond_);
    }

    /// @notice Set the slasher multisig and void outstanding approvals.
    function setSlasher(address slasher_) external onlyOwner {
        if (slasher_ == address(0)) revert ZeroAddress();
        if (slasher_ == owner() || slasher_ == pendingOwner()) revert IndependentOwnerRequired();
        slasher = slasher_;
        _revokeSlashApprovals();
        emit SlasherSet(slasher_);
    }

    /// @notice Set the refund pool and void outstanding approvals.
    function setRefundPool(address refundPool_) external onlyOwner {
        if (refundPool_ == address(0)) revert ZeroAddress();
        refundPool = refundPool_;
        _revokeSlashApprovals();
        emit RefundPoolSet(refundPool_);
    }

    function _revokeSlashApprovals() private {
        ++approvalGeneration;
        emit SlashApprovalsRevoked();
    }

    /// @dev The owner can never be the slasher, and every ownership change voids outstanding approvals.
    function _transferOwnership(address newOwner) internal override {
        if (newOwner == address(0) || newOwner == slasher) revert IndependentOwnerRequired();
        super._transferOwnership(newOwner);
        if (slasher != address(0)) _revokeSlashApprovals();
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Total bond of a host, including any amount queued for unbonding.
    function bondOf(bytes32 hostId) external view returns (uint256) {
        return _hosts[hostId].bond;
    }

    /// @notice Bond not queued for unbonding: bond - min(requested, bond).
    function activeBondOf(bytes32 hostId) public view returns (uint256) {
        uint256 b = _hosts[hostId].bond;
        uint256 queued = unbondRequest[hostId].amount;
        return queued >= b ? 0 : b - queued;
    }

    /// @notice Whether the host may be listed: not delisted and active bond at least `minBond`.
    function isBonded(bytes32 hostId) external view returns (bool) {
        return !_hosts[hostId].delisted && activeBondOf(hostId) >= minBond;
    }

    /// @notice Operator of a host (zero if never bonded).
    function operatorOf(bytes32 hostId) external view returns (address) {
        return _hosts[hostId].operator;
    }

    /// @notice Whether the host is delisted.
    function isDelisted(bytes32 hostId) external view returns (bool) {
        return _hosts[hostId].delisted;
    }

    /// @notice Number of pending slashes against the host.
    function pendingSlashes(bytes32 hostId) external view returns (uint256) {
        return _hosts[hostId].pendingSlashes;
    }

    function _pendingSlash(uint256 slashId) private view returns (Slash storage s) {
        s = slashes[slashId];
        if (s.status == Status.None) revert UnknownSlash();
        if (s.status != Status.Pending) revert AlreadyFinal();
    }
}

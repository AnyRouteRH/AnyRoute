// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IProviderBond} from "./interfaces/IProviderBond.sol";

/// @title ProviderBond
/// @notice Providers post a USDG bond (min 10,000 USDG). The slasher multisig proposes slashes with
/// an evidence merkle root; after a 72h dispute window and independent owner approval it executes them. Slashed USDG
/// goes to the refund pool. Withdrawals take 14 days, stay slashable while waiting and are blocked
/// while any slash is pending.
/// @dev Routing eligibility should use activeBondOf() (bond minus the amount queued for withdrawal).
contract ProviderBond is IProviderBond, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Pending,
        Cancelled,
        Executed
    }

    struct Provider {
        address operator;
        bool delisted;
        uint256 bond;
        uint256 pendingSlashes;
    }

    struct WithdrawRequest {
        uint256 amount;
        uint64 availableAt;
    }

    struct Slash {
        bytes32 providerId;
        uint256 amount;
        bytes32 evidenceRoot;
        bytes32 disputeHash;
        uint64 executableAt;
        Kind kind;
        bool delist;
        Status status;
    }

    /// @inheritdoc IProviderBond
    uint256 public constant MIN_BOND = 10_000e6;
    /// @inheritdoc IProviderBond
    uint64 public constant DISPUTE_WINDOW = 72 hours;
    /// @inheritdoc IProviderBond
    uint64 public constant WITHDRAW_DELAY = 14 days;

    /// @notice The USDG token (6 decimals).
    IERC20 public immutable usdg;

    /// @notice Slasher multisig.
    address public slasher;
    /// @notice Receiver of slashed USDG.
    address public refundPool;
    /// @notice Number of slashes ever proposed; slash ids are 1..slashCount.
    uint256 public slashCount;

    mapping(bytes32 providerId => Provider) private _providers;
    /// @notice The pending withdrawal request of a provider (amount, availableAt).
    mapping(bytes32 providerId => WithdrawRequest) public withdrawRequest;
    /// @notice Full slash record by id.
    mapping(uint256 slashId => Slash) public slashes;

    event WithdrawCancelled(bytes32 indexed providerId);

    uint256 public constant CONTROL_VERSION = 2;
    uint256 public approvalGeneration = 1;
    mapping(uint256 slashId => uint256 generation) public slashApproval;
    error IndependentOwnerRequired();
    error ApprovalRequired();
    error InvalidDispute();
    event SlashApproved(uint256 indexed slashId, bytes32 disputeHash);
    event SlashApprovalsRevoked();

    error ZeroAddress();
    error InvalidAmount();
    error InvalidProvider();

    modifier onlySlasher() {
        if (msg.sender != slasher) revert NotSlasher();
        _;
    }

    modifier onlyOperator(bytes32 providerId) {
        if (msg.sender != _providers[providerId].operator) revert NotOperator();
        _;
    }

    /// @param usdg_ The USDG token.
    /// @param owner_ Owner (timelock).
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
    }

    // ---------------------------------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IProviderBond
    /// @dev The resulting bond must always be >= MIN_BOND. After the first bond only the operator may
    /// top up. Delisted providers cannot bond.
    function bond(bytes32 providerId, uint256 amount) external nonReentrant {
        if (providerId == bytes32(0)) revert InvalidProvider();
        if (amount == 0) revert InvalidAmount();
        Provider storage p = _providers[providerId];
        if (p.delisted) revert ProviderDelisted();
        if (p.operator == address(0)) {
            p.operator = msg.sender;
        } else if (msg.sender != p.operator) {
            revert NotOperator();
        }
        uint256 total = p.bond + amount;
        if (total < MIN_BOND) revert BelowMinimum();
        p.bond = total;
        emit Bonded(providerId, msg.sender, amount, total);
        usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc IProviderBond
    /// @dev Replaces any previous request. The remaining bond must be 0 (full exit) or >= MIN_BOND.
    /// The requested amount stays in the bond (and slashable) until withdrawn.
    function requestWithdraw(bytes32 providerId, uint256 amount) external onlyOperator(providerId) {
        Provider storage p = _providers[providerId];
        if (p.pendingSlashes != 0) revert SlashPending();
        if (amount == 0 || amount > p.bond) revert InvalidAmount();
        uint256 remaining = p.bond - amount;
        if (remaining != 0 && remaining < MIN_BOND) revert BelowMinimum();
        uint64 availableAt = uint64(block.timestamp) + WITHDRAW_DELAY;
        withdrawRequest[providerId] = WithdrawRequest({amount: amount, availableAt: availableAt});
        emit WithdrawRequested(providerId, amount, availableAt);
    }

    /// @notice Cancel the pending withdrawal request.
    function cancelWithdraw(bytes32 providerId) external onlyOperator(providerId) {
        if (withdrawRequest[providerId].amount == 0) revert NothingToWithdraw();
        delete withdrawRequest[providerId];
        emit WithdrawCancelled(providerId);
    }

    /// @inheritdoc IProviderBond
    /// @dev Pays min(requested, current bond), since slashes may have reduced the bond meanwhile.
    function withdraw(bytes32 providerId, address to) external nonReentrant onlyOperator(providerId) {
        if (to == address(0)) revert ZeroAddress();
        WithdrawRequest memory req = withdrawRequest[providerId];
        if (req.amount == 0) revert NothingToWithdraw();
        if (block.timestamp < req.availableAt) revert NotReady();
        Provider storage p = _providers[providerId];
        if (p.pendingSlashes != 0) revert SlashPending();
        uint256 amount = req.amount < p.bond ? req.amount : p.bond;
        if (amount == 0) revert NothingToWithdraw();
        delete withdrawRequest[providerId];
        p.bond -= amount;
        emit Withdrawn(providerId, to, amount);
        usdg.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Slashing
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IProviderBond
    function proposeSlash(bytes32 providerId, Kind kind, uint256 amount, bytes32 evidenceRoot, bool delist)
        external
        onlySlasher
        returns (uint256 slashId)
    {
        Provider storage p = _providers[providerId];
        if (amount == 0 || amount > p.bond) revert InvalidAmount();
        slashId = ++slashCount;
        uint64 executableAt = uint64(block.timestamp) + DISPUTE_WINDOW;
        slashes[slashId] = Slash({
            providerId: providerId,
            amount: amount,
            evidenceRoot: evidenceRoot,
            disputeHash: bytes32(0),
            executableAt: executableAt,
            kind: kind,
            delist: delist,
            status: Status.Pending
        });
        ++p.pendingSlashes;
        emit SlashProposed(slashId, providerId, kind, amount, evidenceRoot, executableAt);
    }

    /// @inheritdoc IProviderBond
    /// @dev A non-empty, one-time dispute invalidates any prior approval. Only independent owner review can restore it.
    function disputeSlash(uint256 slashId, bytes32 disputeHash) external {
        Slash storage s = _pendingSlash(slashId);
        if (msg.sender != _providers[s.providerId].operator) revert NotOperator();
        if (disputeHash == bytes32(0) || s.disputeHash != bytes32(0)) revert InvalidDispute();
        delete slashApproval[slashId];
        s.disputeHash = disputeHash;
        emit SlashDisputed(slashId, disputeHash);
    }

    /// @inheritdoc IProviderBond
    function cancelSlash(uint256 slashId) external {
        if (msg.sender != slasher && msg.sender != owner()) revert NotSlasher();
        Slash storage s = _pendingSlash(slashId);
        s.status = Status.Cancelled;
        --_providers[s.providerId].pendingSlashes;
        emit SlashCancelled(slashId);
    }

    /// @inheritdoc IProviderBond
    /// @dev Transfers min(amount, current bond) to the refund pool.
    function executeSlash(uint256 slashId) external onlySlasher nonReentrant {
        Slash storage s = _pendingSlash(slashId);
        if (block.timestamp < s.executableAt) revert NotReady();
        if (slashApproval[slashId] != approvalGeneration) revert ApprovalRequired();
        delete slashApproval[slashId];
        bytes32 providerId = s.providerId;
        Provider storage p = _providers[providerId];
        uint256 amount = s.amount < p.bond ? s.amount : p.bond;
        bool delist = s.delist;

        s.status = Status.Executed;
        p.bond -= amount;
        --p.pendingSlashes;
        if (delist && !p.delisted) {
            p.delisted = true;
            emit Delisted(providerId);
        }
        emit SlashExecuted(slashId, providerId, amount, delist);
        if (amount != 0) usdg.safeTransfer(refundPool, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Approve the immutable proposal and the exact current dispute evidence after review.
    /// Never grant this authority to the worker or a Safe it controls.
    function approveSlash(uint256 slashId, bytes32 expectedDisputeHash) external onlyOwner {
        Slash storage s = _pendingSlash(slashId);
        if (s.disputeHash != expectedDisputeHash) revert InvalidDispute();
        slashApproval[slashId] = approvalGeneration;
        emit SlashApproved(slashId, expectedDisputeHash);
    }

    function revokeSlashApprovals() external onlyOwner {
        _revokeSlashApprovals();
    }

    function _revokeSlashApprovals() private {
        ++approvalGeneration;
        emit SlashApprovalsRevoked();
    }

    function _transferOwnership(address newOwner) internal override {
        if (newOwner == address(0) || newOwner == slasher) revert IndependentOwnerRequired();
        super._transferOwnership(newOwner);
        if (slasher != address(0)) _revokeSlashApprovals();
    }

    /// @notice Set the slasher multisig and revoke outstanding approvals.
    function setSlasher(address slasher_) external onlyOwner {
        if (slasher_ == address(0)) revert ZeroAddress();
        if (slasher_ == owner() || slasher_ == pendingOwner()) revert IndependentOwnerRequired();
        slasher = slasher_;
        _revokeSlashApprovals();
        emit SlasherSet(slasher_);
    }

    /// @notice Set the refund pool.
    function setRefundPool(address refundPool_) external onlyOwner {
        if (refundPool_ == address(0)) revert ZeroAddress();
        refundPool = refundPool_;
        _revokeSlashApprovals();
        emit RefundPoolSet(refundPool_);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IProviderBond
    function bondOf(bytes32 providerId) external view returns (uint256) {
        return _providers[providerId].bond;
    }

    /// @notice Bond not queued for withdrawal: bond - min(requested, bond).
    function activeBondOf(bytes32 providerId) external view returns (uint256) {
        uint256 b = _providers[providerId].bond;
        uint256 queued = withdrawRequest[providerId].amount;
        return queued >= b ? 0 : b - queued;
    }

    /// @inheritdoc IProviderBond
    function operatorOf(bytes32 providerId) external view returns (address) {
        return _providers[providerId].operator;
    }

    /// @inheritdoc IProviderBond
    function isDelisted(bytes32 providerId) external view returns (bool) {
        return _providers[providerId].delisted;
    }

    /// @inheritdoc IProviderBond
    function pendingSlashes(bytes32 providerId) external view returns (uint256) {
        return _providers[providerId].pendingSlashes;
    }

    function _pendingSlash(uint256 slashId) private view returns (Slash storage s) {
        s = slashes[slashId];
        if (s.status == Status.None) revert UnknownSlash();
        if (s.status != Status.Pending) revert AlreadyFinal();
    }
}

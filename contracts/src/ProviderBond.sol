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
/// an evidence merkle root; after a 72h dispute window it executes (or cancels) them. Slashed USDG
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
}

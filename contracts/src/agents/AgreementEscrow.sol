// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Milestone escrow in token base units. No administrator, withdrawal hook or upgrade path.
/// @dev ERC-8183-shaped lifecycle; this is not a claim of ERC-8183 interface compatibility.
contract AgreementEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        Funded,
        Delivered,
        Disputed,
        Settled
    }

    struct Agreement {
        address payer;
        address payee;
        bytes32 termsHash;
        uint256 deadline;
        address disputeOracle;
        uint256 milestoneCount;
    }

    struct Milestone {
        uint256 amount;
        bytes32 deliverableHash;
        bytes32 evidenceHash;
        uint256 submittedAt;
        uint256 disputedAt;
        Status status;
    }

    IERC20 public immutable usdg;
    uint256 public immutable reviewWindow;
    uint256 public immutable DISPUTE_TIMEOUT;
    uint256 public constant MAX_MILESTONES = 64;
    uint256 public agreementCount;
    mapping(uint256 => Agreement) public agreements;
    mapping(uint256 => mapping(uint256 => Milestone)) public milestones;

    event AgreementCreated(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        bytes32 termsHash,
        uint256 deadline,
        address disputeOracle,
        uint256 total
    );
    event MilestoneFunded(uint256 indexed id, uint256 indexed milestone, uint256 amount);
    event DeliverySubmitted(
        uint256 indexed id, uint256 indexed milestone, bytes32 deliverableHash, uint256 reviewUntil
    );
    event DisputeOpened(
        uint256 indexed id, uint256 indexed milestone, address indexed party, bytes32 evidenceHash
    );
    event Released(uint256 indexed id, uint256 indexed milestone, bool afterTimeout);
    event DeadlineRefunded(uint256 indexed id, uint256 indexed milestone);
    event Ruled(uint256 indexed id, uint256 indexed milestone, uint16 payeeBps);
    event StaleDisputeResolved(
        uint256 indexed id, uint256 indexed milestone, uint256 payeeAmount, uint256 payerAmount
    );
    event Settled(uint256 indexed id, uint256 indexed milestone, uint256 payeeAmount, uint256 payerAmount);

    error InvalidAgreement();
    error InvalidMilestone();
    error InvalidInput();
    error Unauthorized();
    error WrongStatus();
    error WrongTime();
    error UnsupportedToken();

    constructor(IERC20 token, uint256 window, uint256 disputeTimeout) {
        if (
            address(token).code.length == 0 || window == 0 || window > 30 days || disputeTimeout < 7 days
                || disputeTimeout > 180 days
        ) revert InvalidInput();
        usdg = token;
        reviewWindow = window;
        DISPUTE_TIMEOUT = disputeTimeout;
    }

    function createAgreement(
        address payee,
        bytes32 termsHash,
        uint256[] calldata amounts,
        uint256 deadline,
        address disputeOracle
    ) external nonReentrant returns (uint256 id) {
        if (
            payee == address(0) || payee == msg.sender || payee == address(this) || termsHash == bytes32(0)
                || deadline <= block.timestamp
                || deadline > type(uint256).max - reviewWindow - DISPUTE_TIMEOUT
                || disputeOracle.code.length == 0 || amounts.length == 0 || amounts.length > MAX_MILESTONES
        ) {
            revert InvalidInput();
        }
        id = ++agreementCount;
        agreements[id] = Agreement(msg.sender, payee, termsHash, deadline, disputeOracle, amounts.length);
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            if (amounts[i] == 0) revert InvalidInput();
            total += amounts[i];
            milestones[id][i].amount = amounts[i];
            emit MilestoneFunded(id, i, amounts[i]);
        }
        uint256 beforeBalance = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), total);
        // Reject fee-on-transfer funding rather than borrowing another agreement's balance.
        if (usdg.balanceOf(address(this)) - beforeBalance != total) revert UnsupportedToken();
        emit AgreementCreated(id, msg.sender, payee, termsHash, deadline, disputeOracle, total);
    }

    function submitDelivery(uint256 id, uint256 milestone, bytes32 deliverableHash) external nonReentrant {
        (Agreement storage a, Milestone storage m) = _get(id, milestone);
        if (msg.sender != a.payee) revert Unauthorized();
        if (m.status != Status.Funded) revert WrongStatus();
        if (block.timestamp > a.deadline) revert WrongTime();
        if (deliverableHash == bytes32(0)) revert InvalidInput();
        m.status = Status.Delivered;
        m.deliverableHash = deliverableHash;
        m.submittedAt = block.timestamp;
        emit DeliverySubmitted(id, milestone, deliverableHash, block.timestamp + reviewWindow);
    }

    function release(uint256 id, uint256 milestone) external nonReentrant {
        (Agreement storage a, Milestone storage m) = _get(id, milestone);
        if (msg.sender != a.payer) revert Unauthorized();
        if (m.status != Status.Delivered) revert WrongStatus();
        emit Released(id, milestone, false);
        _settle(id, milestone, a, m, 10_000);
    }

    function claimAfterTimeout(uint256 id, uint256 milestone) external nonReentrant {
        (Agreement storage a, Milestone storage m) = _get(id, milestone);
        if (msg.sender != a.payee) revert Unauthorized();
        if (m.status != Status.Delivered) revert WrongStatus();
        if (block.timestamp <= m.submittedAt + reviewWindow) revert WrongTime();
        emit Released(id, milestone, true);
        _settle(id, milestone, a, m, 10_000);
    }

    /// @notice Refund one undelivered milestone; delivered/disputed milestones keep their own lifecycle.
    function refundAfterDeadline(uint256 id, uint256 milestone) external nonReentrant {
        (Agreement storage a, Milestone storage m) = _get(id, milestone);
        if (msg.sender != a.payer) revert Unauthorized();
        if (m.status != Status.Funded) revert WrongStatus();
        if (block.timestamp <= a.deadline) revert WrongTime();
        emit DeadlineRefunded(id, milestone);
        _settle(id, milestone, a, m, 0);
    }

    function openDispute(uint256 id, uint256 milestone, bytes32 evidenceHash) external nonReentrant {
        (Agreement storage a, Milestone storage m) = _get(id, milestone);
        if (msg.sender != a.payer && msg.sender != a.payee) revert Unauthorized();
        if (m.status != Status.Delivered) revert WrongStatus();
        if (block.timestamp > m.submittedAt + reviewWindow) revert WrongTime();
        if (evidenceHash == bytes32(0)) revert InvalidInput();
        m.status = Status.Disputed;
        m.evidenceHash = evidenceHash;
        m.disputedAt = block.timestamp;
        emit DisputeOpened(id, milestone, msg.sender, evidenceHash);
    }

    /// @notice Neutral expiry split; anyone can recover, and the payee receives any odd base unit.
    function resolveStaleDispute(uint256 id, uint256 milestone) external nonReentrant {
        (Agreement storage a, Milestone storage m) = _get(id, milestone);
        if (m.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp < m.disputedAt + DISPUTE_TIMEOUT) revert WrongTime();
        uint256 payerAmount = m.amount / 2;
        uint256 payeeAmount = m.amount - payerAmount;
        emit StaleDisputeResolved(id, milestone, payeeAmount, payerAmount);
        _settleAmounts(id, milestone, a, m, payeeAmount);
    }

    /// @notice 0 refunds payer, 10000 pays payee, other values split; rounding dust goes to payer.
    function rule(uint256 id, uint256 milestone, uint16 payeeBps) external nonReentrant {
        (Agreement storage a, Milestone storage m) = _get(id, milestone);
        if (msg.sender != a.disputeOracle) revert Unauthorized();
        if (m.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp >= m.disputedAt + DISPUTE_TIMEOUT) revert WrongTime();
        if (payeeBps > 10_000) revert InvalidInput();
        emit Ruled(id, milestone, payeeBps);
        _settle(id, milestone, a, m, payeeBps);
    }

    /// @notice Signing binds the actual immutable terms, delivered hash and opening evidence.
    function disputeContext(uint256 id, uint256 milestone) external view returns (bytes32) {
        (Agreement storage a, Milestone storage m) = _get(id, milestone);
        if (m.status != Status.Disputed || msg.sender != a.disputeOracle) revert WrongStatus();
        if (block.timestamp >= m.disputedAt + DISPUTE_TIMEOUT) revert WrongTime();
        return
            keccak256(abi.encode(a.payer, a.payee, a.termsHash, m.amount, m.deliverableHash, m.evidenceHash));
    }

    function _get(uint256 id, uint256 milestone)
        private
        view
        returns (Agreement storage a, Milestone storage m)
    {
        a = agreements[id];
        if (a.payer == address(0)) revert InvalidAgreement();
        if (milestone >= a.milestoneCount) revert InvalidMilestone();
        m = milestones[id][milestone];
    }

    function _settle(uint256 id, uint256 milestone, Agreement storage a, Milestone storage m, uint16 bps)
        private
    {
        _settleAmounts(id, milestone, a, m, Math.mulDiv(m.amount, bps, 10_000));
    }

    function _settleAmounts(
        uint256 id,
        uint256 milestone,
        Agreement storage a,
        Milestone storage m,
        uint256 payeeAmount
    ) private {
        uint256 payerAmount = m.amount - payeeAmount;
        m.status = Status.Settled;
        emit Settled(id, milestone, payeeAmount, payerAmount);
        if (payeeAmount != 0) usdg.safeTransfer(a.payee, payeeAmount);
        if (payerAmount != 0) usdg.safeTransfer(a.payer, payerAmount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {ICredits} from "./interfaces/ICredits.sol";

/// @title Credits
/// @notice Prepaid USDG balances keyed by an API key's hash (0% fee). The router debits usage
/// off-chain; settlement posts a commitment to every key's cumulative spend so withdrawals are
/// bounded by the independently approved ledger snapshot (not an on-chain proof of usage).
/// @dev Spent tree. Leaves are spentLeaf(keyHash, cumulativeSpent), sorted strictly ascending by keyHash
/// and hashed pairwise in position order (keccak256(left || right), the pair is not sorted); the odd
/// last node of a level is promoted unchanged. The posted root binds the leaf count,
/// spentCommitment(treeRoot, leafCount), and bytes32(0) is the empty tree, which is also the genesis
/// root before settlement posts anything. Positions -1 and leafCount are virtual sentinels below and
/// above every key hash, so the contract enforces them instead of trusting them to be in the tree.
///
/// Completeness is enforced, not trusted. In any committed tree, positions -1..leafCount start below
/// and end above every key hash, so a key hash with no leaf lies strictly between two adjacent
/// positions. finalizeWithdrawalAbsent accepts that non-inclusion proof as cumulativeSpent = 0 for the
/// latest root, so a root that omits a funded key cannot block its exit; the omitted spend is
/// settlement's loss. This holds for any root whose leaves are available, sorted or not. In a sorted
/// tree each key has exactly one provable spend. An unsorted or duplicated tree can give a key several;
/// its holder can finalize with the lowest (settlement's loss), and a third party finalizing with a
/// higher one only delays the rest, which stays withdrawable against a later root.
///
/// Settlement duties that remain trusted (the independent approver checks them before approving):
///  - A key's cumulativeSpent MUST never exceed deposited - withdrawn for that key, counting
///    withdrawals made with an absence proof; usage beyond that is settlement's loss. Sweep approvals
///    stay within covered settled usage, so spend an absence exit released is never swept.
///  - Once WithdrawalRequested is observed, the router MUST stop serving the key (or reserve the
///    pending amount) until the withdrawal is finalized or cancelled.
///  - The leaves of every posted root MUST stay available (settlement and the approver both hold
///    them): anyone holding them can build the inclusion or absence proof for any key.
contract Credits is ICredits, Ownable2Step, ReentrancyGuardTransient, EIP712 {
    using SafeERC20 for IERC20;

    struct SpentRoot {
        bytes32 root;
        uint64 asOf;
        uint256 totalSpent;
    }

    struct Pending {
        uint256 amount;
        address to;
        uint64 requestedAt;
    }

    /// @notice EIP-712 typehash of the withdrawal / cancellation request signed by the key address.
    bytes32 public constant WITHDRAW_REQUEST_TYPEHASH = keccak256(
        "WithdrawRequest(bytes32 keyHash,uint256 amount,address to,uint256 nonce,uint256 deadline)"
    );

    /// @notice After this delay a pending withdrawal may finalize against the latest root even if that
    /// root predates the request (liveness escape if settlement stops posting).
    uint64 public constant ESCAPE_DELAY = 7 days;

    IERC20 private immutable _usdg;

    /// @notice Address allowed to post spent roots and sweep spent USDG.
    address public settlement;
    /// @notice Addresses allowed to call credit() (e.g. PayWithStock).
    mapping(address creditor => bool allowed) public isCreditor;

    /// @inheritdoc ICredits
    mapping(bytes32 keyHash => uint256) public deposited;
    /// @inheritdoc ICredits
    mapping(bytes32 keyHash => uint256) public withdrawn;
    /// @inheritdoc ICredits
    mapping(bytes32 keyHash => uint256) public nonces;
    /// @inheritdoc ICredits
    mapping(uint256 epoch => SpentRoot) public spentRoot;
    /// @inheritdoc ICredits
    mapping(bytes32 keyHash => Pending) public pendingWithdrawal;
    /// @inheritdoc ICredits
    uint256 public latestEpoch;
    /// @inheritdoc ICredits
    uint256 public totalSwept;

    /// @notice Version 2 requires independent owner authorization of roots and transfers.
    uint256 public constant CONTROL_VERSION = 2;
    /// @notice Version 2: sorted positional spent tree, leaf-count commitment and absence proofs.
    uint256 public constant SPENT_TREE_VERSION = 2;
    bytes32 public rootApproval;
    bytes32 public sweepApproval;

    error IndependentOwnerRequired();
    error ApprovalRequired();
    error StaleApproval();
    event RootApproved(uint256 indexed epoch, bytes32 root, uint64 asOf, uint256 totalSpent);
    event SweepApproved(uint256 indexed alreadySwept, address indexed to, uint256 amount);
    event ApprovalsRevoked();

    error ZeroAddress();
    error RootInFuture();
    error SpentDecreased();

    modifier onlySettlement() {
        if (msg.sender != settlement) revert NotSettlement();
        _;
    }

    /// @param usdg_ The USDG token (6 decimals).
    /// @param owner_ Owner (timelock) allowed to change settlement and creditors.
    /// @param settlement_ Settlement address that posts roots and sweeps.
    constructor(IERC20 usdg_, address owner_, address settlement_)
        Ownable(owner_)
        EIP712("Anyroute Credits", "1")
    {
        if (address(usdg_) == address(0) || settlement_ == address(0)) revert ZeroAddress();
        if (owner_ == settlement_) revert IndependentOwnerRequired();
        _usdg = usdg_;
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    // ---------------------------------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ICredits
    function usdg() external view returns (address) {
        return address(_usdg);
    }

    /// @inheritdoc ICredits
    function deposit(bytes32 keyHash, uint256 amount) external nonReentrant {
        _deposit(keyHash, amount);
    }

    /// @inheritdoc ICredits
    /// @dev The permit is wrapped in try/catch so a front-run permit cannot brick the deposit; if the
    /// permit fails and no allowance exists, the transferFrom reverts instead.
    function depositWithPermit(
        bytes32 keyHash,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        try IERC20Permit(address(_usdg)).permit(msg.sender, address(this), amount, deadline, v, r, s) {}
            catch {}
        _deposit(keyHash, amount);
    }

    /// @inheritdoc ICredits
    function credit(bytes32 keyHash, uint256 amount) external nonReentrant {
        if (!isCreditor[msg.sender]) revert NotCreditor();
        if (amount == 0) revert InvalidAmount();
        deposited[keyHash] += amount;
        emit Credited(keyHash, msg.sender, amount);
        _usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ICredits
    function postSpentRoot(bytes32 root, uint64 asOf, uint256 totalSpent) external onlySettlement {
        uint256 epoch = latestEpoch;
        SpentRoot storage prev = spentRoot[epoch];
        if (asOf <= prev.asOf) revert StaleRoot();
        if (asOf > block.timestamp) revert RootInFuture();
        if (totalSpent < prev.totalSpent) revert SpentDecreased();
        if (!isRootApproved(root, asOf, totalSpent)) revert ApprovalRequired();
        delete rootApproval;
        unchecked {
            ++epoch;
        }
        spentRoot[epoch] = SpentRoot({root: root, asOf: asOf, totalSpent: totalSpent});
        latestEpoch = epoch;
        emit SpentRootPosted(epoch, root, asOf, totalSpent);
    }

    /// @inheritdoc ICredits
    function sweep(address to, uint256 amount) external onlySettlement nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (to == address(0)) revert ZeroAddress();
        uint256 swept = totalSwept + amount;
        if (swept > spentRoot[latestEpoch].totalSpent) revert SweepExceedsSpent();
        if (sweepApproval != keccak256(abi.encode(totalSwept, to, amount))) revert ApprovalRequired();
        delete sweepApproval;
        totalSwept = swept;
        emit Swept(to, amount);
        _usdg.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Withdrawals
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ICredits
    /// @dev Anyone may relay the signed request. The signature is checked with SignatureChecker so
    /// ERC-1271 smart accounts are supported as key addresses.
    function requestWithdrawal(
        address keyAddress,
        uint256 amount,
        address to,
        uint256 deadline,
        bytes calldata sig
    ) external {
        if (amount == 0) revert InvalidAmount();
        if (to == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert Expired();
        bytes32 keyHash = keyHashOf(keyAddress);
        if (pendingWithdrawal[keyHash].amount != 0) revert WithdrawalPending();

        _useSignature(keyAddress, keyHash, amount, to, deadline, sig);

        uint64 requestedAt = uint64(block.timestamp);
        pendingWithdrawal[keyHash] = Pending({amount: amount, to: to, requestedAt: requestedAt});
        emit WithdrawalRequested(keyHash, to, amount, requestedAt);
    }

    /// @inheritdoc ICredits
    function cancelWithdrawal(address keyAddress, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 keyHash = keyHashOf(keyAddress);
        if (pendingWithdrawal[keyHash].amount == 0) revert NoPendingWithdrawal();

        _useSignature(keyAddress, keyHash, 0, address(0), deadline, sig);

        delete pendingWithdrawal[keyHash];
        emit WithdrawalCancelled(keyHash);
    }

    /// @inheritdoc ICredits
    /// @dev Permissionless: funds always go to the `to` fixed at request time. The payout may be 0
    /// (e.g. everything was spent); the pending request is cleared either way.
    function finalizeWithdrawal(
        bytes32 keyHash,
        uint256 cumulativeSpent,
        uint256 index,
        uint256 leafCount,
        bytes32[] calldata proof
    ) external nonReentrant {
        Pending memory p = _pendingOf(keyHash);
        bytes32 root = _finalizableRoot(p.requestedAt);
        if (!verifySpentInclusion(root, keyHash, cumulativeSpent, index, leafCount, proof)) {
            revert InvalidProof();
        }
        _payOut(keyHash, p, cumulativeSpent);
    }

    /// @inheritdoc ICredits
    /// @dev Permissionless, like finalizeWithdrawal. The key's spend in the latest root is 0, so it is
    /// paid min(requested, deposited - withdrawn); spend the root left out is settlement's loss.
    function finalizeWithdrawalAbsent(
        bytes32 keyHash,
        uint256 leafCount,
        uint256 gap,
        SpentLeafProof calldata below,
        SpentLeafProof calldata above
    ) external nonReentrant {
        Pending memory p = _pendingOf(keyHash);
        bytes32 root = _finalizableRoot(p.requestedAt);
        if (!_brackets(keyHash, leafCount, gap, below.keyHash, above.keyHash)) revert NotBracketed();
        if (!_neighboursProven(root, leafCount, gap, below, above)) revert InvalidProof();
        emit AbsenceProven(keyHash, latestEpoch);
        _payOut(keyHash, p, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Authorize exactly the next snapshot after independently checking its complete ledger.
    /// The owner must be separately controlled (production: timelock governed by an independent Safe).
    function approveSpentRoot(uint256 epoch, bytes32 root, uint64 asOf, uint256 totalSpent)
        external
        onlyOwner
    {
        if (epoch != latestEpoch + 1) revert StaleApproval();
        rootApproval = keccak256(abi.encode(epoch, root, asOf, totalSpent));
        emit RootApproved(epoch, root, asOf, totalSpent);
    }

    function isRootApproved(bytes32 root, uint64 asOf, uint256 totalSpent) public view returns (bool) {
        return rootApproval == keccak256(abi.encode(latestEpoch + 1, root, asOf, totalSpent));
    }

    /// @notice One transfer, exact destination and amount, bound to the current sweep counter.
    /// Approval does not waive the cumulative spent limit. Re-approval replaces any unspent approval.
    function approveSweep(uint256 alreadySwept, address to, uint256 amount) external onlyOwner {
        if (alreadySwept != totalSwept) revert StaleApproval();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        sweepApproval = keccak256(abi.encode(alreadySwept, to, amount));
        emit SweepApproved(alreadySwept, to, amount);
    }

    function revokeApprovals() external onlyOwner {
        _clearApprovals();
    }

    function _clearApprovals() private {
        delete rootApproval;
        delete sweepApproval;
        emit ApprovalsRevoked();
    }

    function _transferOwnership(address newOwner) internal override {
        if (newOwner == address(0) || newOwner == settlement) revert IndependentOwnerRequired();
        super._transferOwnership(newOwner);
        // Constructor dispatch runs before settlement is assigned; there are no approvals yet.
        if (settlement != address(0)) _clearApprovals();
    }

    /// @notice Set the settlement address and invalidate outstanding approvals.
    function setSettlement(address settlement_) external onlyOwner {
        if (settlement_ == address(0)) revert ZeroAddress();
        if (settlement_ == owner() || settlement_ == pendingOwner()) revert IndependentOwnerRequired();
        settlement = settlement_;
        _clearApprovals();
        emit SettlementSet(settlement_);
    }

    /// @notice Allow or disallow an address to call credit().
    function setCreditor(address creditor, bool allowed) external onlyOwner {
        if (creditor == address(0)) revert ZeroAddress();
        isCreditor[creditor] = allowed;
        emit CreditorSet(creditor, allowed);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice keyHash for a key address: keccak256(abi.encodePacked(keyAddress)).
    function keyHashOf(address keyAddress) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(keyAddress));
    }

    /// @notice Merkle leaf for (keyHash, cumulativeSpent): keccak256(bytes.concat(keccak256(abi.encode(..)))).
    function spentLeaf(bytes32 keyHash, uint256 cumulativeSpent) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(keyHash, cumulativeSpent))));
    }

    /// @notice deposited - cumulativeSpent - withdrawn for a key, floored at 0.
    function availableFor(bytes32 keyHash, uint256 cumulativeSpent) external view returns (uint256) {
        return _available(keyHash, cumulativeSpent);
    }

    /// @notice The posted root of a spent tree: bytes32(0) for no leaves, else
    /// keccak256(abi.encode(treeRoot, leafCount)).
    function spentCommitment(bytes32 treeRoot, uint256 leafCount) public pure returns (bytes32) {
        return leafCount == 0 ? bytes32(0) : keccak256(abi.encode(treeRoot, leafCount));
    }

    /// @notice Whether `root` commits to a tree of `leafCount` leaves holding (keyHash, cumulativeSpent)
    /// at position `index`. `proof` lists the siblings bottom-up; a promoted odd node consumes none.
    function verifySpentInclusion(
        bytes32 root,
        bytes32 keyHash,
        uint256 cumulativeSpent,
        uint256 index,
        uint256 leafCount,
        bytes32[] calldata proof
    ) public pure returns (bool) {
        (bool ok, bytes32 treeRoot) = _treeRoot(spentLeaf(keyHash, cumulativeSpent), index, leafCount, proof);
        return ok && spentCommitment(treeRoot, leafCount) == root;
    }

    /// @notice Whether `root` commits to a tree of `leafCount` leaves in which `keyHash` lies strictly
    /// between the leaves at positions gap - 1 (`below`) and gap (`above`). Positions -1 and leafCount
    /// are the sentinels; the argument standing for a sentinel is ignored.
    function verifySpentAbsence(
        bytes32 root,
        bytes32 keyHash,
        uint256 leafCount,
        uint256 gap,
        SpentLeafProof calldata below,
        SpentLeafProof calldata above
    ) external pure returns (bool) {
        return _brackets(keyHash, leafCount, gap, below.keyHash, above.keyHash)
            && _neighboursProven(root, leafCount, gap, below, above);
    }

    /// @notice The EIP-712 domain separator.
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice EIP-712 digest a key address signs for a WithdrawRequest (amount = 0, to = 0 for cancel).
    function withdrawDigest(bytes32 keyHash, uint256 amount, address to, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(WITHDRAW_REQUEST_TYPEHASH, keyHash, amount, to, nonce, deadline))
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _deposit(bytes32 keyHash, uint256 amount) private {
        if (amount == 0) revert InvalidAmount();
        deposited[keyHash] += amount;
        emit Deposited(keyHash, msg.sender, amount);
        _usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    function _useSignature(
        address keyAddress,
        bytes32 keyHash,
        uint256 amount,
        address to,
        uint256 deadline,
        bytes calldata sig
    ) private {
        uint256 nonce = nonces[keyHash];
        bytes32 digest = withdrawDigest(keyHash, amount, to, nonce, deadline);
        if (!SignatureChecker.isValidSignatureNowCalldata(keyAddress, digest, sig)) revert BadSignature();
        nonces[keyHash] = nonce + 1;
    }

    function _pendingOf(bytes32 keyHash) private view returns (Pending memory p) {
        p = pendingWithdrawal[keyHash];
        if (p.amount == 0) revert NoPendingWithdrawal();
    }

    /// @dev The latest root, once it is at least as new as the request or the escape delay has passed.
    function _finalizableRoot(uint64 requestedAt) private view returns (bytes32) {
        SpentRoot storage r = spentRoot[latestEpoch];
        if (r.asOf < requestedAt && block.timestamp < uint256(requestedAt) + ESCAPE_DELAY) {
            revert RootTooOld();
        }
        return r.root;
    }

    function _payOut(bytes32 keyHash, Pending memory p, uint256 cumulativeSpent) private {
        uint256 pay = _available(keyHash, cumulativeSpent);
        if (p.amount < pay) pay = p.amount;

        delete pendingWithdrawal[keyHash];
        if (pay != 0) withdrawn[keyHash] += pay;
        emit Withdrawn(keyHash, p.to, pay);
        if (pay != 0) _usdg.safeTransfer(p.to, pay);
    }

    /// @dev keyHash lies strictly between the keys at positions gap - 1 and gap. The sentinels at -1 and
    /// leafCount sit below and above every key hash.
    function _brackets(bytes32 keyHash, uint256 leafCount, uint256 gap, bytes32 belowKey, bytes32 aboveKey)
        private
        pure
        returns (bool)
    {
        if (gap > leafCount) return false;
        if (gap != 0 && belowKey >= keyHash) return false;
        if (gap != leafCount && aboveKey <= keyHash) return false;
        return true;
    }

    /// @dev The real (non-sentinel) neighbours sit at positions gap - 1 and gap of the tree `root` commits to.
    function _neighboursProven(
        bytes32 root,
        uint256 leafCount,
        uint256 gap,
        SpentLeafProof calldata below,
        SpentLeafProof calldata above
    ) private pure returns (bool) {
        if (leafCount == 0) return root == bytes32(0);
        bytes32 treeRoot;
        bool ok;
        if (gap != 0) {
            (ok, treeRoot) =
                _treeRoot(spentLeaf(below.keyHash, below.cumulativeSpent), gap - 1, leafCount, below.proof);
            if (!ok) return false;
        }
        if (gap != leafCount) {
            (bool aboveOk, bytes32 aboveRoot) =
                _treeRoot(spentLeaf(above.keyHash, above.cumulativeSpent), gap, leafCount, above.proof);
            if (!aboveOk || (gap != 0 && aboveRoot != treeRoot)) return false;
            treeRoot = aboveRoot;
        }
        return spentCommitment(treeRoot, leafCount) == root;
    }

    /// @dev Root of a positional tree of `leafCount` leaves, from the leaf at `index` and its siblings
    /// bottom-up. The odd last node of a level is promoted and consumes no sibling. `ok` is false for an
    /// index outside the tree or a proof of the wrong length.
    function _treeRoot(bytes32 leaf, uint256 index, uint256 leafCount, bytes32[] calldata proof)
        private
        pure
        returns (bool ok, bytes32 node)
    {
        if (index >= leafCount) return (false, bytes32(0));
        node = leaf;
        uint256 used;
        uint256 width = leafCount;
        unchecked {
            while (width > 1) {
                if (index & 1 == 1) {
                    if (used == proof.length) return (false, bytes32(0));
                    node = Hashes.efficientKeccak256(proof[used++], node);
                } else if (index + 1 < width) {
                    if (used == proof.length) return (false, bytes32(0));
                    node = Hashes.efficientKeccak256(node, proof[used++]);
                }
                index >>= 1;
                width = (width >> 1) + (width & 1);
            }
        }
        ok = used == proof.length;
    }

    function _available(bytes32 keyHash, uint256 cumulativeSpent) private view returns (uint256) {
        uint256 dep = deposited[keyHash];
        uint256 used = withdrawn[keyHash];
        if (dep <= used) return 0;
        uint256 rest = dep - used;
        return rest > cumulativeSpent ? rest - cumulativeSpent : 0;
    }
}

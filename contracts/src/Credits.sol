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
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ICredits} from "./interfaces/ICredits.sol";

/// @title Credits
/// @notice Prepaid USDG balances keyed by an API key's hash (0% fee). The router debits usage
/// off-chain; settlement posts merkle roots of every key's cumulative spend so withdrawals are
/// provably bounded and sweeps can never exceed what was actually spent.
/// @dev Trust model / operational requirements for settlement:
///  - Every root MUST contain a leaf for every key with a non-zero deposit (cumulativeSpent may be 0),
///    otherwise that key cannot finalize a withdrawal against that root.
///  - A key's cumulativeSpent MUST never exceed deposited - withdrawn for that key.
///  - Once WithdrawalRequested is observed, the router MUST stop serving the key (or reserve the
///    pending amount) until the withdrawal is finalized or cancelled.
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
    bytes32 public constant WITHDRAW_REQUEST_TYPEHASH =
        keccak256("WithdrawRequest(bytes32 keyHash,uint256 amount,address to,uint256 nonce,uint256 deadline)");

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
    function depositWithPermit(bytes32 keyHash, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        try IERC20Permit(address(_usdg)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
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
    function requestWithdrawal(address keyAddress, uint256 amount, address to, uint256 deadline, bytes calldata sig)
        external
    {
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
    function finalizeWithdrawal(bytes32 keyHash, uint256 cumulativeSpent, bytes32[] calldata proof)
        external
        nonReentrant
    {
        Pending memory p = pendingWithdrawal[keyHash];
        if (p.amount == 0) revert NoPendingWithdrawal();

        SpentRoot storage r = spentRoot[latestEpoch];
        if (r.asOf < p.requestedAt && block.timestamp < uint256(p.requestedAt) + ESCAPE_DELAY) {
            revert RootTooOld();
        }
        if (!MerkleProof.verifyCalldata(proof, r.root, spentLeaf(keyHash, cumulativeSpent))) revert InvalidProof();

        uint256 pay = _available(keyHash, cumulativeSpent);
        if (p.amount < pay) pay = p.amount;

        delete pendingWithdrawal[keyHash];
        if (pay != 0) withdrawn[keyHash] += pay;
        emit Withdrawn(keyHash, p.to, pay);
        if (pay != 0) _usdg.safeTransfer(p.to, pay);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Set the settlement address.
    function setSettlement(address settlement_) external onlyOwner {
        if (settlement_ == address(0)) revert ZeroAddress();
        settlement = settlement_;
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
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_REQUEST_TYPEHASH, keyHash, amount, to, nonce, deadline)));
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

    function _available(bytes32 keyHash, uint256 cumulativeSpent) private view returns (uint256) {
        uint256 dep = deposited[keyHash];
        uint256 used = withdrawn[keyHash];
        if (dep <= used) return 0;
        uint256 rest = dep - used;
        return rest > cumulativeSpent ? rest - cumulativeSpent : 0;
    }
}

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
}

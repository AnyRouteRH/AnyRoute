// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Prepaid USDG balances keyed by an API key's hash. 0% fee.
/// A key's on-chain identity is an address derived from the API key secret
/// (see src/chain/keys.ts): keyHash = keccak256(abi.encodePacked(keyAddress)).
/// The router debits usage off-chain; settlement posts hourly roots of a tree of
/// every key's cumulative spend, sorted by keyHash. Independent owner approval is required; the chain
/// does not prove usage. A key absent from the latest root proves it and withdraws with spend 0.
interface ICredits {
    /// @notice A leaf of the spent tree with its sibling path (bottom-up), used as an absence neighbour.
    struct SpentLeafProof {
        bytes32 keyHash;
        uint256 cumulativeSpent;
        bytes32[] proof;
    }

    event Deposited(bytes32 indexed keyHash, address indexed from, uint256 amount);
    event Credited(bytes32 indexed keyHash, address indexed source, uint256 amount);
    event SpentRootPosted(uint256 indexed epoch, bytes32 root, uint64 asOf, uint256 totalSpent);
    event WithdrawalRequested(
        bytes32 indexed keyHash, address indexed to, uint256 amount, uint64 requestedAt
    );
    event WithdrawalCancelled(bytes32 indexed keyHash);
    event Withdrawn(bytes32 indexed keyHash, address indexed to, uint256 amount);
    /// @notice The root of `epoch` has no leaf for `keyHash`; its withdrawal was finalized with spend 0.
    event AbsenceProven(bytes32 indexed keyHash, uint256 indexed epoch);
    event Swept(address indexed to, uint256 amount);
    event CreditorSet(address indexed creditor, bool allowed);
    event SettlementSet(address indexed settlement);

    error InvalidAmount();
    error NotCreditor();
    error NotSettlement();
    error StaleRoot();
    error BadSignature();
    error Expired();
    error NoPendingWithdrawal();
    error WithdrawalPending();
    error RootTooOld();
    error InvalidProof();
    error NotBracketed();
    error SweepExceedsSpent();

    function usdg() external view returns (address);

    /// @notice Add prepaid balance to a key. Pulls `amount` USDG from msg.sender.
    function deposit(bytes32 keyHash, uint256 amount) external;

    /// @notice deposit() using an EIP-2612 permit when the token supports it.
    function depositWithPermit(
        bytes32 keyHash,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Credit a key from an allowed creditor (PayWithStock). Pulls `amount` USDG from msg.sender.
    function credit(bytes32 keyHash, uint256 amount) external;

    /// @notice Settlement posts the root of the (keyHash, cumulativeSpent) tree as of `asOf`, plus the
    /// cumulative total spent across all keys (bounds sweep()). `asOf` strictly increases.
    /// Requires an exact next-epoch authorization from the independently controlled owner.
    /// Leaf = keccak256(bytes.concat(keccak256(abi.encode(keyHash, cumulativeSpent)))), leaves sorted
    /// strictly by keyHash, nodes keccak256(left || right) with an odd last node promoted, and
    /// root = leafCount == 0 ? bytes32(0) : keccak256(abi.encode(treeRoot, leafCount)).
    function postSpentRoot(bytes32 root, uint64 asOf, uint256 totalSpent) external;

    /// @notice Step 1: request a withdrawal, signed (EIP-712 WithdrawRequest) by the key's derived address.
    /// WithdrawRequest(bytes32 keyHash,uint256 amount,address to,uint256 nonce,uint256 deadline)
    function requestWithdrawal(
        address keyAddress,
        uint256 amount,
        address to,
        uint256 deadline,
        bytes calldata sig
    ) external;

    /// @notice Step 2: finalize using a spent root posted at or after the request (or the latest root once
    /// ESCAPE_DELAY has passed without a newer one). Pays min(requested, deposited - cumulativeSpent - withdrawn).
    /// Proves the key's leaf at `index` of the `leafCount`-leaf tree the latest root commits to.
    function finalizeWithdrawal(
        bytes32 keyHash,
        uint256 cumulativeSpent,
        uint256 index,
        uint256 leafCount,
        bytes32[] calldata proof
    ) external;

    /// @notice Step 2 for a key with no leaf in the latest root (same timing rules): its spend for that
    /// root is 0, so it is paid min(requested, deposited - withdrawn). `below` and `above` are the
    /// adjacent leaves at positions gap - 1 and gap with below.keyHash < keyHash < above.keyHash; position
    /// -1 (gap == 0) and position leafCount (gap == leafCount) are sentinels whose argument is ignored.
    function finalizeWithdrawalAbsent(
        bytes32 keyHash,
        uint256 leafCount,
        uint256 gap,
        SpentLeafProof calldata below,
        SpentLeafProof calldata above
    ) external;

    /// @notice Cancel a pending withdrawal (signed by the key address, same EIP-712 domain, amount = 0).
    function cancelWithdrawal(address keyAddress, uint256 deadline, bytes calldata sig) external;

    /// @notice Settlement moves spent USDG out to pay providers/creators/margin. Bounded by latest totalSpent
    /// and a one-time owner approval of the exact destination, amount and current totalSwept counter.
    function sweep(address to, uint256 amount) external;

    function deposited(bytes32 keyHash) external view returns (uint256);
    function withdrawn(bytes32 keyHash) external view returns (uint256);
    function nonces(bytes32 keyHash) external view returns (uint256);
    function latestEpoch() external view returns (uint256);
    function spentRoot(uint256 epoch) external view returns (bytes32 root, uint64 asOf, uint256 totalSpent);
    function totalSwept() external view returns (uint256);
    function pendingWithdrawal(bytes32 keyHash)
        external
        view
        returns (uint256 amount, address to, uint64 requestedAt);
}

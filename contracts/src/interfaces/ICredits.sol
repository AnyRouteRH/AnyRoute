// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Prepaid USDG balances keyed by an API key's hash. 0% fee.
/// A key's on-chain identity is an address derived from the API key secret
/// (see src/chain/keys.ts): keyHash = keccak256(abi.encodePacked(keyAddress)).
/// The router debits usage off-chain; settlement posts hourly merkle roots of
/// every key's cumulative spend so withdrawals are provably bounded.
interface ICredits {
    event Deposited(bytes32 indexed keyHash, address indexed from, uint256 amount);
    event Credited(bytes32 indexed keyHash, address indexed source, uint256 amount);
    event SpentRootPosted(uint256 indexed epoch, bytes32 root, uint64 asOf, uint256 totalSpent);
    event WithdrawalRequested(bytes32 indexed keyHash, address indexed to, uint256 amount, uint64 requestedAt);
    event WithdrawalCancelled(bytes32 indexed keyHash);
    event Withdrawn(bytes32 indexed keyHash, address indexed to, uint256 amount);
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
    error SweepExceedsSpent();

    function usdg() external view returns (address);

    /// @notice Add prepaid balance to a key. Pulls `amount` USDG from msg.sender.
    function deposit(bytes32 keyHash, uint256 amount) external;

    /// @notice deposit() using an EIP-2612 permit when the token supports it.
    function depositWithPermit(bytes32 keyHash, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;

    /// @notice Credit a key from an allowed creditor (PayWithStock). Pulls `amount` USDG from msg.sender.
    function credit(bytes32 keyHash, uint256 amount) external;

    /// @notice Settlement posts the merkle root of (keyHash, cumulativeSpent) leaves as of `asOf`,
    /// plus the cumulative total spent across all keys (bounds sweep()). `asOf` strictly increases.
    /// Leaf = keccak256(bytes.concat(keccak256(abi.encode(keyHash, cumulativeSpent)))).
    function postSpentRoot(bytes32 root, uint64 asOf, uint256 totalSpent) external;

    /// @notice Step 1: request a withdrawal, signed (EIP-712 WithdrawRequest) by the key's derived address.
    /// WithdrawRequest(bytes32 keyHash,uint256 amount,address to,uint256 nonce,uint256 deadline)
    function requestWithdrawal(address keyAddress, uint256 amount, address to, uint256 deadline, bytes calldata sig)
        external;

    /// @notice Step 2: finalize using a spent root posted at or after the request (or the latest root once
    /// ESCAPE_DELAY has passed without a newer one). Pays min(requested, deposited - cumulativeSpent - withdrawn).
    function finalizeWithdrawal(bytes32 keyHash, uint256 cumulativeSpent, bytes32[] calldata proof) external;

    /// @notice Cancel a pending withdrawal (signed by the key address, same EIP-712 domain, amount = 0).
    function cancelWithdrawal(address keyAddress, uint256 deadline, bytes calldata sig) external;

    /// @notice Settlement moves spent USDG out to pay providers/creators/margin. Bounded by latest totalSpent.
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

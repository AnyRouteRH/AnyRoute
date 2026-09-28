// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Providers post a USDG bond (min 10,000). The slasher multisig proposes slashes with an
/// evidence merkle root; execution requires a 72h dispute window and independent owner approval. Withdrawals take 14 days and are
/// blocked while a slash is pending. Slashed USDG goes to the refund pool that repays callers.
interface IProviderBond {
    enum Kind {
        Empty200,
        QuantFraud,
        Uptime,
        ParamDrop,
        Other
    }

    event Bonded(bytes32 indexed providerId, address indexed operator, uint256 amount, uint256 total);
    event WithdrawRequested(bytes32 indexed providerId, uint256 amount, uint64 availableAt);
    event Withdrawn(bytes32 indexed providerId, address indexed to, uint256 amount);
    event SlashProposed(
        uint256 indexed slashId,
        bytes32 indexed providerId,
        Kind kind,
        uint256 amount,
        bytes32 evidenceRoot,
        uint64 executableAt
    );
    event SlashDisputed(uint256 indexed slashId, bytes32 disputeHash);
    event SlashCancelled(uint256 indexed slashId);
    event SlashExecuted(uint256 indexed slashId, bytes32 indexed providerId, uint256 amount, bool delisted);
    event Delisted(bytes32 indexed providerId);
    event RefundPoolSet(address indexed pool);
    event SlasherSet(address indexed slasher);

    error BelowMinimum();
    error NotOperator();
    error NotSlasher();
    error SlashPending();
    error NotReady();
    error UnknownSlash();
    error AlreadyFinal();
    error NothingToWithdraw();
    error ProviderDelisted();

    function MIN_BOND() external view returns (uint256);
    function DISPUTE_WINDOW() external view returns (uint64);
    function WITHDRAW_DELAY() external view returns (uint64);

    /// @notice First bond registers msg.sender as the provider's operator.
    function bond(bytes32 providerId, uint256 amount) external;
    function requestWithdraw(bytes32 providerId, uint256 amount) external;
    function withdraw(bytes32 providerId, address to) external;

    function proposeSlash(bytes32 providerId, Kind kind, uint256 amount, bytes32 evidenceRoot, bool delist)
        external
        returns (uint256 slashId);
    /// @notice Record one non-empty dispute, invalidating all prior approval of this penalty.
    function disputeSlash(uint256 slashId, bytes32 disputeHash) external;
    /// @notice The slasher or independent owner may reject a pending penalty.
    function cancelSlash(uint256 slashId) external;
    function executeSlash(uint256 slashId) external;

    function bondOf(bytes32 providerId) external view returns (uint256);
    function operatorOf(bytes32 providerId) external view returns (address);
    function isDelisted(bytes32 providerId) external view returns (bool);
    function pendingSlashes(bytes32 providerId) external view returns (uint256);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Per-call USDG payments for callers without an API key (HTTP 402 flow).
/// The router quotes {price_usdg, nonce, expiry}; the caller pays here (usually from a
/// 4337 account sponsored by AnyrPaymaster) and retries with X-Payment: <txHash>.
interface ICallPay {
    event Paid(bytes32 indexed nonce, address indexed payer, uint256 amount);
    event TreasurySet(address indexed treasury);

    error NonceUsed();
    error InvalidAmount();
    error Expired();

    function usdg() external view returns (address);
    function treasury() external view returns (address);

    /// @notice Pay `amount` USDG for the quote identified by `nonce`, before `expiry` (unix seconds).
    function pay(bytes32 nonce, uint256 amount, uint256 expiry) external;

    /// @notice pay() using an EIP-2612 permit when the token supports it.
    function payWithPermit(bytes32 nonce, uint256 amount, uint256 expiry, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;

    /// @notice pay() funded by an EIP-3009 receiveWithAuthorization signed by `from` (to = this contract),
    /// using the quote `nonce` as the authorization nonce so the signature is bound to the quote.
    /// Anyone (e.g. the router's relayer) may submit it; the payer recorded is `from`.
    function payWithAuthorization(
        bytes32 nonce,
        uint256 amount,
        uint256 expiry,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata signature
    ) external;

    function paid(bytes32 nonce) external view returns (address payer, uint256 amount);
}

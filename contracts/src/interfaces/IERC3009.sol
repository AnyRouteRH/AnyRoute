// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal EIP-3009 surface used by CallPay (USDG on Robinhood Chain supports it).
/// receiveWithAuthorization requires msg.sender == to, so a signed authorization cannot be
/// front-run into a different recipient.
interface IERC3009 {
    /// @notice Receive a transfer with a signed authorization from the payer (`bytes` signature form:
    /// 65-byte ECDSA for EOAs, ERC-1271 for smart accounts).
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

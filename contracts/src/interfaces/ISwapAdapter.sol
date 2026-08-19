// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Exact-output swap into USDG. The caller must have transferred `amountInMax` of
/// `tokenIn` to the adapter first. The adapter sends exactly `amountOut` of `tokenOut` to
/// `recipient`, returns unused `tokenIn` to `refundTo`, and returns the amount actually spent.
/// MUST revert if the swap cannot be filled within `amountInMax`.
interface ISwapAdapter {
    function swapExactOut(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        address recipient,
        address refundTo
    ) external returns (uint256 amountIn);
}

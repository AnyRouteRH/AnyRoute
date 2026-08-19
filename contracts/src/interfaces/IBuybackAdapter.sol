// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Exact-input swap used by AnyrStaking buybacks (USDG -> ANYR). The caller must have
/// transferred `amountIn` of `tokenIn` to the adapter first. Sends at least `minOut` of
/// `tokenOut` to `recipient` or reverts. Returns the amount received.
interface IBuybackAdapter {
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut);
}

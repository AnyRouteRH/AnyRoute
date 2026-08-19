// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice ERC-8056 style multiplier exposed by Stock Tokens (splits / corporate actions).
/// Shares represented by `raw` base units = raw * uiMultiplier() / 1e18 (scaled to token decimals).
interface IUiMultiplier {
    function uiMultiplier() external view returns (uint256);
}

/// @notice Fair value of one whole Stock Token in USD, 18 decimals:
/// Chainlink share price x uiMultiplier(). `ok` is false when the feed is stale, paused,
/// the L2 sequencer is down, or the answer is non-positive. Callers must require ok.
interface IStockOracle {
    function fairPrice(address token) external view returns (uint256 price18, bool ok);
}

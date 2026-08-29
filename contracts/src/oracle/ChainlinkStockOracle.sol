// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStockOracle, IUiMultiplier} from "../interfaces/IStockOracle.sol";

/// @notice Minimal Chainlink AggregatorV3 interface (inlined; no @chainlink dependency).
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Optional pause views exposed by Robinhood Chain Stock Tokens.
interface IStockTokenStatus {
    function paused() external view returns (bool);
    function oraclePaused() external view returns (bool);
}

/// @title ChainlinkStockOracle
/// @notice Fair value of one whole Stock Token in USD (18 decimals): Chainlink price, optionally x uiMultiplier().
/// @dev `fairPrice` never reverts: every failure mode (unknown token, guardian pause, token `paused()` /
/// `oraclePaused()`, bad/stale round, sequencer down or in its grace period, reverting/malformed feed or token)
/// yields `ok = false`. External reads use raw `staticcall` + length checks so that even EOAs or malformed return
/// data cannot make it revert.
///
/// Robinhood Chain deployment notes:
///  - Chainlink's Robinhood Stock Token feeds (8 decimals, 86400s heartbeat, 24/5 market hours) ALREADY include the
///    token's uiMultiplier, so those tokens must be configured with `applyUiMultiplier = false`. Use `true` only
///    for feeds that quote the raw share price.
///  - Feeds do not update on weekends/holidays; `maxStaleness` is per token (e.g. 302400s = 3.5 days) and nothing
///    here assumes a heartbeat.
///  - There is no L2 sequencer uptime feed on RHC: leave `sequencerUptimeFeed` unset (address(0) skips the check).
///  - Tokens exposing `paused()` / `oraclePaused()` returning true yield ok = false; tokens without these views
///    (call reverts / returns nothing) are unaffected.
/// Owner is expected to be a 24h timelock; the guardian can pause a token instantly, only the owner unpauses.
contract ChainlinkStockOracle is IStockOracle, Ownable2Step {
    /// @notice Per-token feed configuration.
    struct FeedConfig {
        AggregatorV3Interface feed; // price feed (USD)
        uint8 feedDecimals; // cached feed.decimals()
        uint32 maxStaleness; // seconds; round is stale when updatedAt + maxStaleness < block.timestamp
        bool paused; // guardian/owner kill switch
        bool applyMultiplier; // multiply by IUiMultiplier(token).uiMultiplier() / 1e18
    }

    /// @notice Feeds with more decimals than this are rejected at configuration time.
    uint8 public constant MAX_FEED_DECIMALS = 36;

    mapping(address token => FeedConfig) internal _configs;

    /// @notice Optional Chainlink L2 sequencer uptime feed (answer 0 = up, 1 = down). Zero disables the check.
    AggregatorV3Interface public sequencerUptimeFeed;
    /// @notice Seconds that must elapse after the sequencer comes back up before prices are trusted.
    uint32 public sequencerGracePeriod;
    /// @notice May pause tokens instantly (bypassing the owner timelock). Cannot unpause.
    address public guardian;

    event FeedSet(
        address indexed token,
        address indexed feed,
        uint8 feedDecimals,
        uint32 maxStaleness,
        bool applyUiMultiplier
    );
    event FeedRemoved(address indexed token);
    event UiMultiplierEnabled(address indexed token, bool enabled);
    event SequencerFeedSet(address indexed feed, uint32 gracePeriod);
    event GuardianSet(address indexed guardian);
    event TokenPaused(address indexed token, address indexed by);
    event TokenUnpaused(address indexed token);
}

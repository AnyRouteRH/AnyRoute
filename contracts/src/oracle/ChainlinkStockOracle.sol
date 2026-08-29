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

    error ZeroAddress();
    error InvalidFeed();
    error InvalidStaleness();
    error UnknownToken();
    error NotGuardian();

    constructor(address owner_) Ownable(owner_) {}

    // ---------------------------------------------------------------------------------------------
    // Owner configuration
    // ---------------------------------------------------------------------------------------------

    /// @notice Configure (or replace) the price feed for `token`. Keeps the guardian pause flag.
    /// @param maxStaleness Max age of the latest round in seconds (must be > 0; cover weekends for 24/5 feeds).
    /// @param applyUiMultiplier Multiply the feed price by `uiMultiplier()`. Must be FALSE for Chainlink's Robinhood
    /// Stock Token feeds, which already include the multiplier.
    function setFeed(address token, AggregatorV3Interface feed, uint32 maxStaleness, bool applyUiMultiplier)
        external
        onlyOwner
    {
        if (token == address(0) || address(feed) == address(0)) revert ZeroAddress();
        if (maxStaleness == 0) revert InvalidStaleness();
        uint8 dec = feed.decimals();
        if (dec > MAX_FEED_DECIMALS) revert InvalidFeed();
        FeedConfig storage c = _configs[token];
        c.feed = feed;
        c.feedDecimals = dec;
        c.maxStaleness = maxStaleness;
        c.applyMultiplier = applyUiMultiplier;
        emit FeedSet(token, address(feed), dec, maxStaleness, applyUiMultiplier);
    }

    /// @notice Remove a token's configuration entirely (fairPrice then returns ok = false).
    function removeFeed(address token) external onlyOwner {
        if (address(_configs[token].feed) == address(0)) revert UnknownToken();
        delete _configs[token];
        emit FeedRemoved(token);
    }

    /// @notice Toggle whether `uiMultiplier()` is applied for `token`.
    function setUiMultiplierEnabled(address token, bool enabled) external onlyOwner {
        if (address(_configs[token].feed) == address(0)) revert UnknownToken();
        _configs[token].applyMultiplier = enabled;
        emit UiMultiplierEnabled(token, enabled);
    }

    /// @notice Set the L2 sequencer uptime feed and grace period. `feed = 0` disables the check.
    function setSequencerFeed(AggregatorV3Interface feed, uint32 gracePeriod) external onlyOwner {
        sequencerUptimeFeed = feed;
        sequencerGracePeriod = gracePeriod;
        emit SequencerFeedSet(address(feed), gracePeriod);
    }

    /// @notice Set the guardian allowed to pause tokens instantly (zero disables the role).
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Pause a token's price (fairPrice returns ok = false). Callable by the guardian or the owner.
    function pause(address token) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        if (address(_configs[token].feed) == address(0)) revert UnknownToken();
        _configs[token].paused = true;
        emit TokenPaused(token, msg.sender);
    }

    /// @notice Unpause a token. Owner (timelock) only.
    function unpause(address token) external onlyOwner {
        if (address(_configs[token].feed) == address(0)) revert UnknownToken();
        _configs[token].paused = false;
        emit TokenUnpaused(token);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Raw configuration for `token`.
    function configOf(address token) external view returns (FeedConfig memory) {
        return _configs[token];
    }

    /// @inheritdoc IStockOracle
    function fairPrice(address token) external view returns (uint256 price18, bool ok) {
        FeedConfig memory c = _configs[token];
        if (address(c.feed) == address(0) || c.paused) return (0, false);
        if (!_sequencerOk() || _tokenHalted(token)) return (0, false);

        (ok, price18) = _feedPrice18(c);
        if (!ok) return (0, false);

        if (c.applyMultiplier) {
            (bool mOk, uint256 m) = _staticUint(token, IUiMultiplier.uiMultiplier.selector);
            if (!mOk || m == 0) return (0, false);
            (uint256 high,) = Math.mul512(price18, m);
            if (high >= 1e18) return (0, false); // result would overflow uint256
            price18 = Math.mulDiv(price18, m, 1e18);
        }

        if (price18 == 0) return (0, false);
        return (price18, true);
    }

    /// @notice True when no sequencer feed is set, or the sequencer is up and past its grace period.
    function isSequencerUp() external view returns (bool) {
        return _sequencerOk();
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _sequencerOk() internal view returns (bool) {
        address feed = address(sequencerUptimeFeed);
        if (feed == address(0)) return true;
        (bool success,, int256 answer, uint256 startedAt,,) = _latestRound(feed);
        // answer: 0 = up, 1 = down. startedAt == 0 means the round is not valid (Arbitrum pattern).
        if (!success || answer != 0 || startedAt == 0) return false;
        if (startedAt > block.timestamp) return false;
        return block.timestamp - startedAt > sequencerGracePeriod;
    }

    /// @dev Latest valid round scaled to 18 decimals, or ok = false (bad answer, stale, incomplete round).
    function _feedPrice18(FeedConfig memory c) internal view returns (bool ok, uint256 price18) {
        (bool success, uint256 roundId, int256 answer,, uint256 updatedAt, uint256 answeredInRound) =
            _latestRound(address(c.feed));
        if (!success || answer <= 0 || updatedAt == 0) return (false, 0);
        // stale when updatedAt + maxStaleness < now (written overflow-free); future timestamps are invalid
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > c.maxStaleness) return (false, 0);
        if (answeredInRound < roundId) return (false, 0);

        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 a = uint256(answer); // answer > 0 checked above
        if (c.feedDecimals <= 18) {
            (ok, price18) = Math.tryMul(a, 10 ** (18 - uint256(c.feedDecimals)));
        } else {
            (ok, price18) = (true, a / 10 ** (uint256(c.feedDecimals) - 18));
        }
    }

    /// @dev True when the token reports `paused()` or `oraclePaused()`. Missing / reverting views are ignored.
    function _tokenHalted(address token) internal view returns (bool) {
        (bool ok, uint256 v) = _staticUint(token, IStockTokenStatus.paused.selector);
        if (ok && v != 0) return true;
        (ok, v) = _staticUint(token, IStockTokenStatus.oraclePaused.selector);
        return ok && v != 0;
    }

    /// @dev latestRoundData via staticcall; decodes all words as full-width types so decoding can never revert.
    function _latestRound(address feed)
        internal
        view
        returns (
            bool success,
            uint256 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint256 answeredInRound
        )
    {
        (bool callOk, bytes memory ret) = feed.staticcall(
            abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector)
        );
        if (!callOk || ret.length < 160) return (false, 0, 0, 0, 0, 0);
        (roundId, answer, startedAt, updatedAt, answeredInRound) =
            abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
        success = true;
    }

    function _staticUint(address target, bytes4 selector) internal view returns (bool, uint256) {
        (bool callOk, bytes memory ret) = target.staticcall(abi.encodeWithSelector(selector));
        if (!callOk || ret.length < 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AggregatorV3Interface} from "../oracle/ChainlinkStockOracle.sol";

/// @notice Chainlink AggregatorV3 mock. Price mode: `setAnswer` starts a fresh round at block.timestamp.
/// Sequencer-uptime mode: `setSequencerStatus(up, since)` sets answer 0 (up) / 1 (down) with startedAt = since.
/// `setRoundData` sets every field verbatim; `setShouldRevert` makes reads revert.
contract MockAggregator is AggregatorV3Interface {
    uint8 public immutable decimals;
    string public description;
    uint256 public constant version = 4;

    uint80 internal _roundId;
    int256 internal _answer;
    uint256 internal _startedAt;
    uint256 internal _updatedAt;
    uint80 internal _answeredInRound;
    bool public shouldRevert;

    error MockAggregatorReverted();

    constructor(uint8 decimals_, int256 initialAnswer, string memory description_) {
        decimals = decimals_;
        description = description_;
        _roundId = 1;
        _answer = initialAnswer;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
        _answeredInRound = 1;
    }

    // ---- price mode ----

    function setAnswer(int256 answer) external {
        _roundId += 1;
        _answer = answer;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
        _answeredInRound = _roundId;
    }

    function setUpdatedAt(uint256 updatedAt) external {
        _updatedAt = updatedAt;
    }

    function setRoundData(
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) external {
        _roundId = roundId;
        _answer = answer;
        _startedAt = startedAt;
        _updatedAt = updatedAt;
        _answeredInRound = answeredInRound;
    }

    function setShouldRevert(bool r) external {
        shouldRevert = r;
    }

    // ---- sequencer-uptime mode ----

    /// @param up true => answer 0 (sequencer up), false => answer 1 (down)
    /// @param since timestamp at which the status last changed (Chainlink `startedAt`)
    function setSequencerStatus(bool up, uint256 since) external {
        _roundId += 1;
        _answer = up ? int256(0) : int256(1);
        _startedAt = since;
        _updatedAt = block.timestamp;
        _answeredInRound = _roundId;
    }

    // ---- AggregatorV3Interface ----

    function getRoundData(uint80) external view returns (uint80, int256, uint256, uint256, uint80) {
        return _latest();
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return _latest();
    }

    function _latest() internal view returns (uint80, int256, uint256, uint256, uint80) {
        if (shouldRevert) revert MockAggregatorReverted();
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }
}

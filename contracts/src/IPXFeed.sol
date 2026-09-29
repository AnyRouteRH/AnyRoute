// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "./oracle/ChainlinkStockOracle.sol";

/// @title IPXFeed
/// @notice One Anyroute inference price index (IPX) for one model class, exposed as a Chainlink
/// AggregatorV3Interface feed: the volume-weighted USDG price per 1,000,000 tokens, with 8 decimals.
/// Deploy one instance per class (for example IPX-OPEN-70B); `description` and `classId` name it.
///
/// A keeper posts (answer, receiptRoot, volumeUsdg) once per hour. `receiptRoot` is the merkle root over
/// the receipt leaves the answer was computed from, so anyone can rebuild the sample from the public
/// receipts; the chain stores it and does not check it. `volumeUsdg` is the class volume in USDG base
/// units (6 decimals) over the trailing 24 hours. An update whose volume is below `thinThresholdUsdg` is flagged THIN, and
/// consumers are expected to treat a THIN feed as unusable for anything that needs a deep market.
/// `roundId` starts at 1 and increases by one per update.
contract IPXFeed is AggregatorV3Interface, Ownable2Step {
    struct Round {
        int256 answer;
        uint64 startedAt;
        uint64 updatedAt;
        bool thin;
        uint128 volumeUsdg;
        bytes32 receiptRoot;
    }

    /// @notice USDG per 1,000,000 tokens, scaled by 1e8.
    uint8 public constant decimals = 8;
    uint256 public constant version = 1;
    uint64 public constant MIN_STALENESS = 1 hours;
    uint64 public constant MAX_STALENESS = 30 days;

    /// @notice Human-readable feed name, for example "ANYR-IPX/IPX-OPEN-70B".
    string public description;
    /// @notice keccak256 of the class name.
    bytes32 public immutable classId;

    /// @notice Posts updates.
    address public keeper;
    /// @notice Trailing-24h volume (USDG base units, 6 decimals) below which an update is flagged THIN.
    uint256 public thinThresholdUsdg;
    /// @notice Seconds after which the latest update counts as stale.
    uint64 public maxStaleness;
    /// @notice Id of the latest round; 0 before the first update.
    uint80 public latestRound;

    mapping(uint80 roundId => Round) private _rounds;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event NewRound(uint256 indexed roundId, address indexed startedBy, uint256 startedAt);
    /// @notice Extra detail of each round: the receipt root behind the answer and the THIN flag.
    event IPXUpdated(
        uint80 indexed roundId, int256 answer, bytes32 receiptRoot, uint256 volumeUsdg, bool thin
    );
    event KeeperSet(address indexed keeper);
    event ThinThresholdSet(uint256 thinThresholdUsdg);
    event MaxStalenessSet(uint64 maxStaleness);

    error ZeroAddress();
    error NotKeeper();
    error InvalidAnswer();
    error EmptyRoot();
    error VolumeTooLarge();
    error InvalidStaleness();
    error NoData();

    /// @param owner_ Owner (timelock).
    /// @param keeper_ Update keeper.
    /// @param classId_ keccak256 of the class name.
    /// @param description_ Feed name.
    /// @param thinThresholdUsdg_ THIN threshold in USDG base units per trailing 24h.
    /// @param maxStaleness_ Staleness bound in seconds.
    constructor(
        address owner_,
        address keeper_,
        bytes32 classId_,
        string memory description_,
        uint256 thinThresholdUsdg_,
        uint64 maxStaleness_
    ) Ownable(owner_) {
        if (keeper_ == address(0)) revert ZeroAddress();
        if (maxStaleness_ < MIN_STALENESS || maxStaleness_ > MAX_STALENESS) revert InvalidStaleness();
        classId = classId_;
        description = description_;
        keeper = keeper_;
        thinThresholdUsdg = thinThresholdUsdg_;
        maxStaleness = maxStaleness_;
        emit KeeperSet(keeper_);
        emit ThinThresholdSet(thinThresholdUsdg_);
        emit MaxStalenessSet(maxStaleness_);
    }

    // ---------------------------------------------------------------------------------------------
    // Keeper
    // ---------------------------------------------------------------------------------------------

    /// @notice Post a new round.
    /// @param answer USDG per 1,000,000 tokens, 8 decimals; must be positive.
    /// @param receiptRoot Merkle root over the receipt leaves behind the answer; must be nonzero.
    /// @param volumeUsdg Class volume in USDG base units (6 decimals) over the trailing 24 hours.
    function update(int256 answer, bytes32 receiptRoot, uint256 volumeUsdg)
        external
        returns (uint80 roundId)
    {
        if (msg.sender != keeper) revert NotKeeper();
        if (answer <= 0) revert InvalidAnswer();
        if (receiptRoot == bytes32(0)) revert EmptyRoot();
        if (volumeUsdg > type(uint128).max) revert VolumeTooLarge();
        roundId = ++latestRound;
        bool thin = volumeUsdg < thinThresholdUsdg;
        _rounds[roundId] = Round({
            answer: answer,
            startedAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            thin: thin,
            volumeUsdg: uint128(volumeUsdg),
            receiptRoot: receiptRoot
        });
        emit NewRound(roundId, msg.sender, block.timestamp);
        emit AnswerUpdated(answer, roundId, block.timestamp);
        emit IPXUpdated(roundId, answer, receiptRoot, volumeUsdg, thin);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @notice Applies to updates posted after this call.
    function setThinThresholdUsdg(uint256 threshold) external onlyOwner {
        thinThresholdUsdg = threshold;
        emit ThinThresholdSet(threshold);
    }

    function setMaxStaleness(uint64 seconds_) external onlyOwner {
        if (seconds_ < MIN_STALENESS || seconds_ > MAX_STALENESS) revert InvalidStaleness();
        maxStaleness = seconds_;
        emit MaxStalenessSet(seconds_);
    }

    // ---------------------------------------------------------------------------------------------
    // AggregatorV3Interface
    // ---------------------------------------------------------------------------------------------

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round storage r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoData();
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint80 id = latestRound;
        Round storage r = _rounds[id];
        if (r.updatedAt == 0) revert NoData();
        return (id, r.answer, r.startedAt, r.updatedAt, id);
    }

    // ---------------------------------------------------------------------------------------------
    // Extras: receipt root, volume, THIN flag, staleness
    // ---------------------------------------------------------------------------------------------

    /// @notice The stored detail of a round: receipt root, trailing-24h volume and THIN flag.
    function roundInfo(uint80 roundId)
        external
        view
        returns (bytes32 receiptRoot, uint256 volumeUsdg, bool thin, uint256 updatedAt)
    {
        Round storage r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoData();
        return (r.receiptRoot, r.volumeUsdg, r.thin, r.updatedAt);
    }

    /// @notice The latest round with its extras in one call.
    function latestRoundExtended()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 updatedAt,
            bytes32 receiptRoot,
            uint256 volumeUsdg,
            bool thin,
            bool stale
        )
    {
        roundId = latestRound;
        Round storage r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoData();
        return
            (roundId, r.answer, r.updatedAt, r.receiptRoot, r.volumeUsdg, r.thin, _isStale(r, maxStaleness));
    }

    /// @notice True when the latest update was flagged THIN, or when there is no update yet.
    function isThin() external view returns (bool) {
        Round storage r = _rounds[latestRound];
        return r.updatedAt == 0 || r.thin;
    }

    /// @notice Seconds since the latest update; the maximum uint256 when there is none.
    function age() external view returns (uint256) {
        Round storage r = _rounds[latestRound];
        if (r.updatedAt == 0) return type(uint256).max;
        return block.timestamp - r.updatedAt;
    }

    /// @notice True when there is no update or the latest one is older than `maxStaleness`.
    function isStale() external view returns (bool) {
        return _isStale(_rounds[latestRound], maxStaleness);
    }

    /// @notice Like `isStale()` with the caller's own bound in seconds.
    function isStale(uint256 maxAge) external view returns (bool) {
        return _isStale(_rounds[latestRound], maxAge);
    }

    /// @notice True when there is an update that is neither stale nor THIN.
    function isUsable() external view returns (bool) {
        Round storage r = _rounds[latestRound];
        return r.updatedAt != 0 && !r.thin && !_isStale(r, maxStaleness);
    }

    function _isStale(Round storage r, uint256 maxAge) private view returns (bool) {
        return r.updatedAt == 0 || block.timestamp - r.updatedAt > maxAge;
    }
}

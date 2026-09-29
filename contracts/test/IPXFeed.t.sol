// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPXFeed} from "../src/IPXFeed.sol";
import {AggregatorV3Interface} from "../src/oracle/ChainlinkStockOracle.sol";

contract IPXFeedTest is Test {
    uint64 internal constant T0 = 1_750_000_000;
    uint256 internal constant THIN = 50_000e6; // 50,000 USDG per trailing 24h
    bytes32 internal constant CLASS = keccak256("IPX-OPEN-70B");
    bytes32 internal constant ROOT = keccak256("receipt-root");

    IPXFeed internal feed;
    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal rando = makeAddr("rando");

    function setUp() public {
        vm.warp(T0);
        feed = new IPXFeed(owner, keeper, CLASS, "ANYR-IPX/IPX-OPEN-70B", THIN, 3 hours);
    }

    function _update(int256 answer, uint256 volume) internal returns (uint80) {
        vm.prank(keeper);
        return feed.update(answer, ROOT, volume);
    }

    // --- metadata and the aggregator interface -----------------------------------------------------

    function test_metadata() public view {
        AggregatorV3Interface agg = AggregatorV3Interface(address(feed));
        assertEq(agg.decimals(), 8);
        assertEq(agg.description(), "ANYR-IPX/IPX-OPEN-70B");
        assertEq(agg.version(), 1);
        assertEq(feed.classId(), CLASS);
        assertEq(feed.keeper(), keeper);
        assertEq(feed.owner(), owner);
        assertEq(feed.thinThresholdUsdg(), THIN);
        assertEq(feed.maxStaleness(), 3 hours);
        assertEq(feed.latestRound(), 0);
    }

    function test_noDataBeforeTheFirstUpdate() public {
        vm.expectRevert(IPXFeed.NoData.selector);
        feed.latestRoundData();
        vm.expectRevert(IPXFeed.NoData.selector);
        feed.getRoundData(1);
        vm.expectRevert(IPXFeed.NoData.selector);
        feed.roundInfo(1);
        vm.expectRevert(IPXFeed.NoData.selector);
        feed.latestRoundExtended();
        assertTrue(feed.isThin());
        assertTrue(feed.isStale());
        assertFalse(feed.isUsable());
        assertEq(feed.age(), type(uint256).max);
    }

    function test_update_publishesRound() public {
        vm.expectEmit(true, true, true, true, address(feed));
        emit IPXFeed.IPXUpdated(1, 0.42e8, ROOT, 120_000e6, false);
        uint80 id = _update(0.42e8, 120_000e6);
        assertEq(id, 1);
        (uint80 rid, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answered) =
            AggregatorV3Interface(address(feed)).latestRoundData();
        assertEq(rid, 1);
        assertEq(answer, 0.42e8);
        assertEq(startedAt, T0);
        assertEq(updatedAt, T0);
        assertEq(answered, 1);
        (bytes32 root, uint256 volume, bool thin, uint256 at) = feed.roundInfo(1);
        assertEq(root, ROOT);
        assertEq(volume, 120_000e6);
        assertFalse(thin);
        assertEq(at, T0);
    }

    function test_update_roundIdsIncreaseAndHistoryIsKept() public {
        _update(0.4e8, 100_000e6);
        vm.warp(T0 + 1 hours);
        _update(0.44e8, 100_000e6);
        vm.warp(T0 + 2 hours);
        assertEq(_update(0.43e8, 100_000e6), 3);
        (, int256 a1,, uint256 u1,) = feed.getRoundData(1);
        (, int256 a2,, uint256 u2,) = feed.getRoundData(2);
        (uint80 id3, int256 a3,,,) = feed.latestRoundData();
        assertEq(a1, 0.4e8);
        assertEq(u1, T0);
        assertEq(a2, 0.44e8);
        assertEq(u2, T0 + 1 hours);
        assertEq(id3, 3);
        assertEq(a3, 0.43e8);
        vm.expectRevert(IPXFeed.NoData.selector);
        feed.getRoundData(4);
    }

    function test_update_events() public {
        vm.recordLogs();
        _update(1e8, 100_000e6);
        assertEq(vm.getRecordedLogs().length, 3); // NewRound, AnswerUpdated, IPXUpdated
    }

    function test_update_onlyKeeper() public {
        vm.prank(rando);
        vm.expectRevert(IPXFeed.NotKeeper.selector);
        feed.update(1e8, ROOT, 1);
        vm.prank(owner);
        vm.expectRevert(IPXFeed.NotKeeper.selector);
        feed.update(1e8, ROOT, 1);
    }

    function test_update_rejectsBadInput() public {
        vm.startPrank(keeper);
        vm.expectRevert(IPXFeed.InvalidAnswer.selector);
        feed.update(0, ROOT, 1);
        vm.expectRevert(IPXFeed.InvalidAnswer.selector);
        feed.update(-1, ROOT, 1);
        vm.expectRevert(IPXFeed.EmptyRoot.selector);
        feed.update(1e8, bytes32(0), 1);
        vm.expectRevert(IPXFeed.VolumeTooLarge.selector);
        feed.update(1e8, ROOT, uint256(type(uint128).max) + 1);
        vm.stopPrank();
        assertEq(feed.latestRound(), 0);
    }

    // --- THIN ------------------------------------------------------------------------------------

    function test_thin_belowThreshold() public {
        vm.expectEmit(true, true, true, true, address(feed));
        emit IPXFeed.IPXUpdated(1, 1e8, ROOT, THIN - 1, true);
        _update(1e8, THIN - 1);
        assertTrue(feed.isThin());
        assertFalse(feed.isUsable());
        (,,,,, bool thin,) = feed.latestRoundExtended();
        assertTrue(thin);
    }

    function test_thin_atThresholdIsNotThin() public {
        _update(1e8, THIN);
        assertFalse(feed.isThin());
        assertTrue(feed.isUsable());
    }

    function test_thin_flagFollowsTheLatestUpdate() public {
        _update(1e8, 1);
        assertTrue(feed.isThin());
        vm.warp(T0 + 1 hours);
        _update(1e8, THIN * 2);
        assertFalse(feed.isThin());
        (,, bool thin1,) = feed.roundInfo(1);
        assertTrue(thin1); // the old round keeps its own flag
    }

    function test_thin_thresholdChangeAppliesToNewUpdatesOnly() public {
        _update(1e8, THIN);
        vm.prank(owner);
        feed.setThinThresholdUsdg(THIN * 2);
        assertFalse(feed.isThin()); // stored flag of round 1
        vm.warp(T0 + 1 hours);
        _update(1e8, THIN);
        assertTrue(feed.isThin());
    }

    // --- staleness -------------------------------------------------------------------------------

    function test_staleness() public {
        _update(1e8, THIN);
        assertEq(feed.age(), 0);
        assertFalse(feed.isStale());
        vm.warp(T0 + 3 hours);
        assertFalse(feed.isStale()); // exactly maxStaleness is still fresh
        assertEq(feed.age(), 3 hours);
        vm.warp(T0 + 3 hours + 1);
        assertTrue(feed.isStale());
        assertFalse(feed.isUsable());
        assertTrue(feed.isStale(1 hours));
        assertFalse(feed.isStale(4 hours));
        (,,,,,, bool stale) = feed.latestRoundExtended();
        assertTrue(stale);
        _update(1e8, THIN);
        assertFalse(feed.isStale());
        assertTrue(feed.isUsable());
    }

    function test_setMaxStaleness() public {
        vm.prank(owner);
        feed.setMaxStaleness(1 hours);
        assertEq(feed.maxStaleness(), 1 hours);
        vm.startPrank(owner);
        vm.expectRevert(IPXFeed.InvalidStaleness.selector);
        feed.setMaxStaleness(59 minutes);
        vm.expectRevert(IPXFeed.InvalidStaleness.selector);
        feed.setMaxStaleness(31 days);
        vm.stopPrank();
    }

    // --- admin -----------------------------------------------------------------------------------

    function test_constructor_reverts() public {
        vm.expectRevert(IPXFeed.ZeroAddress.selector);
        new IPXFeed(owner, address(0), CLASS, "x", THIN, 3 hours);
        vm.expectRevert(IPXFeed.InvalidStaleness.selector);
        new IPXFeed(owner, keeper, CLASS, "x", THIN, 30 minutes);
        vm.expectRevert(IPXFeed.InvalidStaleness.selector);
        new IPXFeed(owner, keeper, CLASS, "x", THIN, 31 days);
    }

    function test_admin_onlyOwner() public {
        bytes memory nope = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando);
        vm.startPrank(rando);
        vm.expectRevert(nope);
        feed.setKeeper(rando);
        vm.expectRevert(nope);
        feed.setThinThresholdUsdg(1);
        vm.expectRevert(nope);
        feed.setMaxStaleness(2 hours);
        vm.stopPrank();
    }

    function test_setKeeper() public {
        address k2 = makeAddr("k2");
        vm.prank(owner);
        feed.setKeeper(k2);
        vm.prank(keeper);
        vm.expectRevert(IPXFeed.NotKeeper.selector);
        feed.update(1e8, ROOT, 1);
        vm.prank(k2);
        feed.update(1e8, ROOT, 1);
        vm.prank(owner);
        vm.expectRevert(IPXFeed.ZeroAddress.selector);
        feed.setKeeper(address(0));
    }

    function testFuzz_update_roundTrips(int128 answer, bytes32 root, uint128 volume) public {
        vm.assume(answer > 0 && root != bytes32(0));
        vm.prank(keeper);
        uint80 id = feed.update(answer, root, volume);
        (uint80 rid, int256 a,, uint256 at,) = feed.latestRoundData();
        (bytes32 r, uint256 v, bool thin,) = feed.roundInfo(id);
        assertEq(rid, id);
        assertEq(a, int256(answer));
        assertEq(at, block.timestamp);
        assertEq(r, root);
        assertEq(v, volume);
        assertEq(thin, uint256(volume) < THIN);
    }
}

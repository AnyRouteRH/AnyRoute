// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ChainlinkStockOracle, AggregatorV3Interface} from "../src/oracle/ChainlinkStockOracle.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";

contract ChainlinkStockOracleTest is Test {
    ChainlinkStockOracle oracle;
    MockAggregator feed; // 8 decimals, like Chainlink equity feeds
    MockAggregator seq;
    MockStockToken nvda;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");

    uint32 constant STALENESS = 1 hours;
    uint32 constant GRACE = 1 hours;

    function setUp() public {
        vm.warp(1_750_000_000);
        oracle = new ChainlinkStockOracle(owner);
        feed = new MockAggregator(8, 180e8, "NVDA / USD");
        seq = new MockAggregator(0, 0, "L2 Sequencer Uptime");
        nvda = new MockStockToken("NVIDIA xStock", "NVDAx", 18);

        vm.startPrank(owner);
        oracle.setFeed(address(nvda), feed, STALENESS, true);
        oracle.setGuardian(guardian);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ happy paths

    function test_fairPrice_scalesTo18() public view {
        (uint256 p, bool ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
        assertEq(p, 180e18);
    }

    function test_fairPrice_appliesMultiplier() public {
        nvda.setUiMultiplier(2e18); // e.g. after a 2:1 split, one token represents 2 shares
        (uint256 p, bool ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
        assertEq(p, 360e18);

        nvda.setUiMultiplier(0.5e18);
        (p, ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
        assertEq(p, 90e18);
    }

    function test_fairPrice_multiplierDisabled() public {
        nvda.setUiMultiplier(3e18);
        vm.prank(owner);
        oracle.setUiMultiplierEnabled(address(nvda), false);
        (uint256 p, bool ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
        assertEq(p, 180e18);
        // disabled => even a reverting multiplier does not matter
        nvda.setMultiplierReverts(true);
        (, ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
    }

    function test_fairPrice_feedWithMoreThan18Decimals() public {
        MockAggregator f20 = new MockAggregator(20, 180e20 + 99, "20dec");
        vm.prank(owner);
        oracle.setFeed(address(nvda), f20, STALENESS, true);
        (uint256 p, bool ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
        assertEq(p, 180e18); // truncated
    }

    function testFuzz_fairPrice_scaling(uint8 dec, uint128 answer, uint128 mult) public {
        dec = uint8(bound(dec, 0, 36));
        answer = uint128(bound(answer, 1, type(uint128).max));
        mult = uint128(bound(mult, 1, 1000e18));
        MockAggregator f = new MockAggregator(dec, int256(uint256(answer)), "fuzz");
        vm.prank(owner);
        oracle.setFeed(address(nvda), f, STALENESS, true);
        nvda.setUiMultiplier(mult);

        uint256 scaled = dec <= 18 ? uint256(answer) * 10 ** (18 - dec) : uint256(answer) / 10 ** (dec - 18);
        uint256 expected = Math.mulDiv(scaled, mult, 1e18);
        (uint256 p, bool ok) = oracle.fairPrice(address(nvda));
        if (expected == 0) {
            assertFalse(ok);
            assertEq(p, 0);
        } else {
            assertTrue(ok);
            assertEq(p, expected);
        }
    }

    // ------------------------------------------------------------------ ok = false paths (never revert)

    function test_unknownToken() public {
        (uint256 p, bool ok) = oracle.fairPrice(makeAddr("unknown"));
        assertFalse(ok);
        assertEq(p, 0);
    }

    function test_nonPositiveAnswer() public {
        feed.setAnswer(0);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
        feed.setAnswer(-1);
        (, ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    function testFuzz_staleness(uint32 age) public {
        age = uint32(bound(age, 0, 30 days));
        feed.setAnswer(180e8);
        vm.warp(block.timestamp + age);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertEq(ok, age <= STALENESS); // stale iff updatedAt + maxStaleness < now
    }

    function test_futureUpdatedAtIsInvalid() public {
        feed.setUpdatedAt(block.timestamp + 1);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    function test_zeroUpdatedAtIsInvalid() public {
        feed.setRoundData(5, 180e8, 0, 0, 5);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    function test_answeredInRoundBehind() public {
        feed.setRoundData(10, 180e8, block.timestamp, block.timestamp, 9);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
        feed.setRoundData(10, 180e8, block.timestamp, block.timestamp, 10);
        (, ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
    }

    function test_feedReverts() public {
        feed.setShouldRevert(true);
        (uint256 p, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
        assertEq(p, 0);
    }

    function test_multiplierReverts() public {
        nvda.setMultiplierReverts(true);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    function test_multiplierZero() public {
        nvda.setUiMultiplier(0);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    function test_tokenWithoutCodeDoesNotRevert() public {
        address eoaToken = makeAddr("eoaToken");
        vm.prank(owner);
        oracle.setFeed(eoaToken, feed, STALENESS, true);
        (, bool ok) = oracle.fairPrice(eoaToken); // uiMultiplier() on an EOA: empty return data
        assertFalse(ok);
    }

    function test_feedWithoutCodeDoesNotRevert() public {
        // configure with a real feed, then etch the feed away
        vm.etch(address(feed), "");
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    function test_multiplierOverflowIsNotOk() public {
        MockAggregator big = new MockAggregator(0, int256(uint256(type(uint128).max)), "big");
        vm.prank(owner);
        oracle.setFeed(address(nvda), big, STALENESS, true);
        nvda.setUiMultiplier(type(uint256).max);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    function test_scalingOverflowIsNotOk() public {
        MockAggregator big = new MockAggregator(0, type(int256).max, "big");
        vm.prank(owner);
        oracle.setFeed(address(nvda), big, STALENESS, true);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ sequencer

    function _enableSequencer() internal {
        vm.prank(owner);
        oracle.setSequencerFeed(seq, GRACE);
    }

    function test_sequencerUpPastGrace() public {
        seq.setSequencerStatus(true, block.timestamp - GRACE - 1);
        _enableSequencer();
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
        assertTrue(oracle.isSequencerUp());
    }

    function test_sequencerDown() public {
        seq.setSequencerStatus(false, block.timestamp - 10 days);
        _enableSequencer();
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
        assertFalse(oracle.isSequencerUp());
    }

    function testFuzz_sequencerGrace(uint32 sinceUp) public {
        sinceUp = uint32(bound(sinceUp, 0, 3 * GRACE));
        seq.setSequencerStatus(true, block.timestamp - sinceUp);
        _enableSequencer();
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertEq(ok, sinceUp > GRACE); // startedAt + GRACE must be passed
    }

    function test_sequencerStartedAtZeroIsNotOk() public {
        seq.setSequencerStatus(true, 0);
        _enableSequencer();
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    function test_sequencerFeedReverts() public {
        seq.setSequencerStatus(true, block.timestamp - 10 days);
        seq.setShouldRevert(true);
        _enableSequencer();
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    function test_sequencerDisabled() public {
        seq.setSequencerStatus(false, block.timestamp);
        _enableSequencer();
        vm.prank(owner);
        oracle.setSequencerFeed(AggregatorV3Interface(address(0)), 0);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
    }

    // ------------------------------------------------------------------ pause / guardian

    function test_guardianPausesOnlyOwnerUnpauses() public {
        vm.expectEmit(true, true, false, false);
        emit ChainlinkStockOracle.TokenPaused(address(nvda), guardian);
        vm.prank(guardian);
        oracle.pause(address(nvda));
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        oracle.unpause(address(nvda));

        vm.prank(owner);
        oracle.unpause(address(nvda));
        (, ok) = oracle.fairPrice(address(nvda));
        assertTrue(ok);
    }

    function test_ownerCanPause() public {
        vm.prank(owner);
        oracle.pause(address(nvda));
        assertTrue(oracle.configOf(address(nvda)).paused);
    }

    function test_strangerCannotPause() public {
        vm.prank(alice);
        vm.expectRevert(ChainlinkStockOracle.NotGuardian.selector);
        oracle.pause(address(nvda));
    }

    function test_pauseUnknownTokenReverts() public {
        vm.prank(guardian);
        vm.expectRevert(ChainlinkStockOracle.UnknownToken.selector);
        oracle.pause(alice);
    }

    function test_setFeedKeepsPause() public {
        vm.prank(guardian);
        oracle.pause(address(nvda));
        MockAggregator f2 = new MockAggregator(8, 200e8, "x");
        vm.prank(owner);
        oracle.setFeed(address(nvda), f2, STALENESS, true);
        (, bool ok) = oracle.fairPrice(address(nvda));
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ admin

    function test_onlyOwnerSetters() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setFeed(address(nvda), feed, 1, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setSequencerFeed(seq, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setGuardian(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setUiMultiplierEnabled(address(nvda), false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.removeFeed(address(nvda));
        vm.stopPrank();
    }
}

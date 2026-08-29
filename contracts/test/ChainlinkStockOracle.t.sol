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
}

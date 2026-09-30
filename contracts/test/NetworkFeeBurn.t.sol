// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NetworkFeeBurn, INetworkBuybackConfig} from "../src/NetworkFeeBurn.sol";
import {AnyrToken} from "../src/AnyrToken.sol";
import {AnyrStaking} from "../src/AnyrStaking.sol";
import {IBuybackPriceOracle} from "../src/interfaces/IBuybackPriceOracle.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockBuybackAdapter} from "../src/mocks/MockBuybackAdapter.sol";
contract NetworkFloor is IBuybackPriceOracle {
    uint256 public floor = 1; uint256 public updated; bool public refused;
    function configure(uint256 f, uint256 t, bool r) external { floor = f; updated = t; refused = r; }
    function minimumOutput(address, address, uint256) external view returns (uint256, uint256) { require(!refused, "refused"); return (floor, updated); }
}
contract NetworkFeeBurnTest is Test {
    NetworkFeeBurn burn; AnyrStaking staking; AnyrToken anyr; MockUSDG usdg; MockBuybackAdapter adapter; NetworkFloor oracle;
    address keeper = makeAddr("keeper"); bytes32 id = keccak256("fee-period");
    function setUp() public {
        vm.warp(1800000000);
        anyr = new AnyrToken([address(this), makeAddr("team"), makeAddr("liquidity"), makeAddr("community")]);
        usdg = new MockUSDG(); adapter = new MockBuybackAdapter(10e18, 1e6);
        staking = new AnyrStaking(IERC20(address(anyr)), IERC20(address(usdg)), address(this), keeper, makeAddr("ops"), adapter);
        oracle = new NetworkFloor(); oracle.configure(1, block.timestamp, false); staking.setBuybackPriceOracle(oracle);
        burn = new NetworkFeeBurn(INetworkBuybackConfig(address(staking)));
        usdg.mint(address(burn), 100000e6); anyr.transfer(address(adapter), 1000000e18);
    }
    function test_swapThenBurnAndDuplicateRefusal() public {
        uint256 supply = anyr.totalSupply();
        vm.prank(keeper); burn.swap(id, 10e6, 99e18);
        (uint256 input, uint256 output, bool done) = burn.operations(id); assertEq(input, 10e6); assertEq(output, 100e18); assertFalse(done);
        vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 10e6, 99e18);
        vm.prank(keeper); burn.burn(id); assertEq(anyr.balanceOf(burn.DEAD()), 100e18); assertEq(anyr.totalSupply(), supply);
        vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.burn(id);
    }
    function test_oracleRefusalRollbackAndBalanceDelta() public {
        oracle.configure(1, block.timestamp, true);
        vm.expectRevert(); vm.prank(keeper); burn.swap(id, 10e6, 99e18); assertEq(usdg.balanceOf(address(burn)), 100000e6);
        oracle.configure(1, block.timestamp, false); adapter.setShortfallBps(1000);
        vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 10e6, 99e18); assertEq(usdg.balanceOf(address(burn)), 100000e6);
    }
    function test_dailyCapAndKeeperRestriction() public {
        vm.expectRevert(NetworkFeeBurn.Refused.selector); burn.swap(id, 10e6, 99e18);
        uint256 cap = staking.maxDailyBuyback(); vm.prank(keeper); burn.swap(id, cap, 1);
        vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(keccak256("next"), 1, 1);
        vm.warp(block.timestamp + 1 days); assertEq(burn.remainingToday(), cap);
    }
    function test_staleZeroFutureAndBelowFloorRefused() public {
        oracle.configure(100, block.timestamp, false); vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 1e6, 99);
        oracle.configure(1, block.timestamp - 901, false); vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 1e6, 1);
        oracle.configure(0, block.timestamp, false); vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 1e6, 1);
        oracle.configure(1, block.timestamp + 1, false); vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 1e6, 1);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NetworkFeeBurn} from "../src/NetworkFeeBurn.sol";
import {AnyrToken} from "../src/AnyrToken.sol";
import {IBuybackPriceOracle} from "../src/interfaces/IBuybackPriceOracle.sol";
import {IBuybackAdapter} from "../src/interfaces/IBuybackAdapter.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockBuybackAdapter} from "../src/mocks/MockBuybackAdapter.sol";
contract NetworkFloor is IBuybackPriceOracle {
    uint256 public floor = 1; uint256 public updated; bool public refused;
    function configure(uint256 f, uint256 t, bool r) external { floor = f; updated = t; refused = r; }
    function minimumOutput(address, address, uint256) external view returns (uint256, uint256) { require(!refused, "refused"); return (floor, updated); }
}
/// @dev The adapter is also the authorized keeper: role checks cannot mask a broken mutex.
contract ReentrantNetworkAdapter is IBuybackAdapter {
    IERC20 public usdg;
    IERC20 public anyr;
    IBuybackPriceOracle public buybackPriceOracle;
    NetworkFeeBurn public target;
    bool public attacked;
    constructor(IERC20 input, IERC20 output, IBuybackPriceOracle floor) { usdg = input; anyr = output; buybackPriceOracle = floor; }
    function keeper() external view returns (address) { return address(this); }
    function adapter() external view returns (IBuybackAdapter) { return this; }
    function maxDailyBuyback() external pure returns (uint256) { return 100e6; }
    function configure(NetworkFeeBurn burn_) external { target = burn_; }
    function run(bytes32 operation) external { target.swap(operation, 1e6, 1e18); }
    function swapExactIn(address, address, uint256, uint256, address recipient) external returns (uint256) {
        if (attacked) {
            (bool swapOk, bytes memory swapError) = address(target).call(abi.encodeCall(target.swap, (keccak256("recursive"), 1e6, 1e18)));
            (bool burnOk, bytes memory burnError) = address(target).call(abi.encodeCall(target.burn, (keccak256("prior"))));
            bytes4 mutex = bytes4(keccak256("ReentrancyGuardReentrantCall()"));
            require(!swapOk && bytes4(swapError) == mutex && !burnOk && bytes4(burnError) == mutex, "mutex bypassed");
        }
        attacked = true;
        anyr.transfer(recipient, 1e18);
        return 1e18;
    }
}
contract NetworkFeeBurnTest is Test {
    NetworkFeeBurn burn; AnyrToken anyr; MockUSDG usdg; MockBuybackAdapter adapter; NetworkFloor oracle;
    address keeper = makeAddr("keeper"); bytes32 id = keccak256("fee-period");
    function setUp() public {
        vm.warp(1800000000);
        anyr = new AnyrToken([address(this), makeAddr("team"), makeAddr("liquidity"), makeAddr("community")]);
        usdg = new MockUSDG(); adapter = new MockBuybackAdapter(10e18, 1e6);
        oracle = new NetworkFloor(); oracle.configure(1, block.timestamp, false);
        burn = new NetworkFeeBurn(anyr, usdg, address(this), keeper, adapter, 10_000e6); burn.setBuybackPriceOracle(oracle);
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
        uint256 cap = burn.maxDailyBuyback(); vm.prank(keeper); burn.swap(id, cap, 1);
        vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(keccak256("next"), 1, 1);
        vm.warp(block.timestamp + 1 days); assertEq(burn.remainingToday(), cap);
    }
    function test_staleZeroFutureAndBelowFloorRefused() public {
        oracle.configure(100, block.timestamp, false); vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 1e6, 99);
        oracle.configure(1, block.timestamp - 901, false); vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 1e6, 1);
        oracle.configure(0, block.timestamp, false); vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 1e6, 1);
        oracle.configure(1, block.timestamp + 1, false); vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(id, 1e6, 1);
    }
    function test_ownerOnlySettersEmitAndRejectInvalidAddresses() public {
        vm.expectRevert(); vm.prank(keeper); burn.setAdapter(adapter);
        vm.expectRevert(); vm.prank(keeper); burn.setBuybackPriceOracle(oracle);
        vm.expectRevert(); vm.prank(keeper); burn.setKeeper(keeper);
        vm.expectRevert(); vm.prank(keeper); burn.setMaxDailyBuyback(1);
        vm.expectRevert(NetworkFeeBurn.Refused.selector); burn.setAdapter(IBuybackAdapter(address(0)));
        vm.expectRevert(NetworkFeeBurn.Refused.selector); burn.setKeeper(address(0));
        vm.expectEmit(true, false, false, true); emit NetworkFeeBurn.AdapterSet(address(adapter)); burn.setAdapter(adapter);
        vm.expectEmit(true, false, false, true); emit NetworkFeeBurn.BuybackPriceOracleSet(address(oracle)); burn.setBuybackPriceOracle(oracle);
        vm.expectEmit(true, false, false, true); emit NetworkFeeBurn.KeeperSet(keeper); burn.setKeeper(keeper);
        vm.expectEmit(false, false, false, true); emit NetworkFeeBurn.MaxDailyBuybackSet(10e6); burn.setMaxDailyBuyback(10e6);
    }
    function test_capReductionPreservesUsageAndZeroDisablesSwaps() public {
        vm.prank(keeper); burn.swap(id, 10e6, 99e18);
        burn.setMaxDailyBuyback(5e6); assertEq(burn.remainingToday(), 0); assertEq(burn.used(), 10e6);
        burn.setMaxDailyBuyback(12e6); assertEq(burn.remainingToday(), 2e6);
        burn.setMaxDailyBuyback(0); vm.warp(block.timestamp + 1 days); assertEq(burn.remainingToday(), 0);
        vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(keccak256("next"), 1, 1);
        vm.prank(keeper); burn.burn(id); assertEq(anyr.balanceOf(burn.DEAD()), 100e18);
    }
    function test_missingOracleDisablesSwapsButAllowsCompletedBurn() public {
        vm.prank(keeper); burn.swap(id, 10e6, 99e18);
        burn.setBuybackPriceOracle(IBuybackPriceOracle(address(0)));
        vm.expectRevert(NetworkFeeBurn.Refused.selector); vm.prank(keeper); burn.swap(keccak256("next"), 1, 1);
        vm.prank(keeper); burn.burn(id); assertEq(anyr.balanceOf(burn.DEAD()), 100e18);
    }
    function test_adapterKeeperCannotReenterSwapOrBurn() public {
        ReentrantNetworkAdapter attack = new ReentrantNetworkAdapter(usdg, anyr, oracle);
        NetworkFeeBurn guarded = new NetworkFeeBurn(anyr, usdg, address(this), address(attack), attack, 100e6); guarded.setBuybackPriceOracle(oracle);
        attack.configure(guarded);
        usdg.mint(address(guarded), 10e6); anyr.transfer(address(attack), 10e18);
        attack.run(keccak256("prior")); attack.run(keccak256("second"));
        assertEq(anyr.balanceOf(address(guarded)), 2e18);
        assertEq(anyr.balanceOf(guarded.DEAD()), 0);
        assertEq(usdg.balanceOf(address(guarded)), 8e6);
        assertEq(guarded.used(), 2e6);
    }
}

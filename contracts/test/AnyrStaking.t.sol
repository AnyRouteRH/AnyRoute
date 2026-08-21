// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AnyrStaking} from "../src/AnyrStaking.sol";
import {AnyrToken} from "../src/AnyrToken.sol";
import {IAnyrStaking} from "../src/interfaces/IAnyrStaking.sol";
import {IBuybackAdapter} from "../src/interfaces/IBuybackAdapter.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockBuybackAdapter} from "../src/mocks/MockBuybackAdapter.sol";

/// Adapter that tries to re-enter the staking contract during the swap.
contract ReentrantAdapter is IBuybackAdapter {
    AnyrStaking public staking;
    uint8 public mode; // 0 = claimRewards, 1 = stake, 2 = notifyMargin

    function set(AnyrStaking s, uint8 m) external {
        staking = s;
        mode = m;
    }

    function swapExactIn(address, address, uint256, uint256, address) external returns (uint256) {
        if (mode == 0) staking.claimRewards();
        else if (mode == 1) staking.stake(1, bytes32(0));
        else staking.notifyMargin(1);
        return 0;
    }
}

abstract contract StakingBase is Test {
    uint256 internal constant T0 = 1_750_032_000; // 2025-06-16 00:00:00 UTC
    uint256 internal constant RATE_NUM = 10e18; // 10 ANYR ...
    uint256 internal constant RATE_DEN = 1e6; // ... per 1 USDG

    AnyrToken internal anyr;
    MockUSDG internal usdg;
    MockBuybackAdapter internal adapter;
    AnyrStaking internal staking;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal ops = makeAddr("ops");
    address internal settlement = makeAddr("settlement");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public virtual {
        vm.warp(T0);
        anyr = new AnyrToken([treasury, makeAddr("team"), makeAddr("liq"), makeAddr("community")]);
        usdg = new MockUSDG();
        adapter = new MockBuybackAdapter(RATE_NUM, RATE_DEN);
        staking = new AnyrStaking(IERC20(address(anyr)), IERC20(address(usdg)), owner, keeper, ops, adapter);

        vm.startPrank(treasury);
        assertTrue(anyr.transfer(address(adapter), 100_000_000e18));
        assertTrue(anyr.transfer(alice, 10_000_000e18));
        assertTrue(anyr.transfer(bob, 10_000_000e18));
        assertTrue(anyr.transfer(carol, 10_000_000e18));
        vm.stopPrank();

        address[3] memory stakers = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.prank(stakers[i]);
            anyr.approve(address(staking), type(uint256).max);
        }
        usdg.mint(settlement, 100_000_000e6);
        vm.prank(settlement);
        usdg.approve(address(staking), type(uint256).max);
    }

    function _stake(address who, uint256 amt, bytes32 pid) internal {
        vm.prank(who);
        staking.stake(amt, pid);
    }

    function _notify(uint256 amt) internal {
        vm.prank(settlement);
        staking.notifyMargin(amt);
    }

    function _buyback(uint256 usdgIn) internal returns (uint256) {
        uint256 minOut = adapter.quote(usdgIn);
        vm.prank(keeper);
        return staking.executeBuyback(usdgIn, minOut);
    }
}

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

contract AnyrStakingTest is StakingBase {
    bytes32 internal constant PID = keccak256("provider-a");
    bytes32 internal constant PID2 = keccak256("provider-b");

    // =============================================================================================
    // Constructor / admin
    // =============================================================================================

    function test_constructor() public view {
        assertEq(address(staking.anyr()), address(anyr));
        assertEq(address(staking.usdg()), address(usdg));
        assertEq(staking.owner(), owner);
        assertEq(staking.keeper(), keeper);
        assertEq(staking.opsWallet(), ops);
        assertEq(address(staking.adapter()), address(adapter));
        assertEq(staking.maxDailyBuyback(), 10_000e6);
        assertEq(staking.COOLDOWN(), 7 days);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.buybackBalance(), 0);
    }

    function test_constructor_emits() public {
        vm.expectEmit(true, true, true, true);
        emit IAnyrStaking.KeeperSet(keeper);
        vm.expectEmit(true, true, true, true);
        emit AnyrStaking.OpsWalletSet(ops);
        vm.expectEmit(true, true, true, true);
        emit AnyrStaking.AdapterSet(address(adapter));
        vm.expectEmit(true, true, true, true);
        emit AnyrStaking.MaxDailyBuybackSet(10_000e6);
        new AnyrStaking(IERC20(address(anyr)), IERC20(address(usdg)), owner, keeper, ops, adapter);
    }

    function test_constructor_revertsZeros() public {
        IERC20 a = IERC20(address(anyr));
        IERC20 u = IERC20(address(usdg));
        vm.expectRevert(AnyrStaking.ZeroAddress.selector);
        new AnyrStaking(IERC20(address(0)), u, owner, keeper, ops, adapter);
        vm.expectRevert(AnyrStaking.ZeroAddress.selector);
        new AnyrStaking(a, IERC20(address(0)), owner, keeper, ops, adapter);
        vm.expectRevert(AnyrStaking.ZeroAddress.selector);
        new AnyrStaking(a, u, owner, address(0), ops, adapter);
        vm.expectRevert(AnyrStaking.ZeroAddress.selector);
        new AnyrStaking(a, u, owner, keeper, address(0), adapter);
        vm.expectRevert(AnyrStaking.ZeroAddress.selector);
        new AnyrStaking(a, u, owner, keeper, ops, IBuybackAdapter(address(0)));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new AnyrStaking(a, u, address(0), keeper, ops, adapter);
    }

    function test_setKeeper() public {
        address k2 = makeAddr("k2");
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.KeeperSet(k2);
        vm.prank(owner);
        staking.setKeeper(k2);
        assertEq(staking.keeper(), k2);
        _notify(100e6);
        vm.prank(keeper);
        vm.expectRevert(IAnyrStaking.NotKeeper.selector);
        staking.executeBuyback(1e6, 1);
    }

    function test_setOpsWallet() public {
        address o2 = makeAddr("o2");
        vm.expectEmit(true, true, true, true, address(staking));
        emit AnyrStaking.OpsWalletSet(o2);
        vm.prank(owner);
        staking.setOpsWallet(o2);
        _notify(10e6);
        assertEq(usdg.balanceOf(o2), 5e6);
        assertEq(usdg.balanceOf(ops), 0);
    }

    function test_setAdapter() public {
        MockBuybackAdapter a2 = new MockBuybackAdapter(1e12, 1);
        vm.prank(treasury);
        assertTrue(anyr.transfer(address(a2), 1_000_000e18));
        vm.expectEmit(true, true, true, true, address(staking));
        emit AnyrStaking.AdapterSet(address(a2));
        vm.prank(owner);
        staking.setAdapter(a2);
        _notify(2e6);
        vm.prank(keeper);
        uint256 out = staking.executeBuyback(1e6, 1e18);
        assertEq(out, 1e18);
        assertEq(usdg.balanceOf(address(a2)), 1e6);
    }

    function test_setMaxDailyBuyback() public {
        vm.expectEmit(true, true, true, true, address(staking));
        emit AnyrStaking.MaxDailyBuybackSet(0);
        vm.prank(owner);
        staking.setMaxDailyBuyback(0);
        _notify(10e6);
        vm.prank(keeper);
        vm.expectRevert(IAnyrStaking.BuybackTooLarge.selector);
        staking.executeBuyback(1, 1);
        assertEq(staking.buybackRemainingToday(), 0);
    }

    function test_setters_onlyOwner() public {
        vm.startPrank(keeper);
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper);
        vm.expectRevert(err);
        staking.setKeeper(keeper);
        vm.expectRevert(err);
        staking.setOpsWallet(keeper);
        vm.expectRevert(err);
        staking.setAdapter(adapter);
        vm.expectRevert(err);
        staking.setMaxDailyBuyback(1);
        vm.stopPrank();
    }

    function test_setters_revertZero() public {
        vm.startPrank(owner);
        vm.expectRevert(AnyrStaking.ZeroAddress.selector);
        staking.setKeeper(address(0));
        vm.expectRevert(AnyrStaking.ZeroAddress.selector);
        staking.setOpsWallet(address(0));
        vm.expectRevert(AnyrStaking.ZeroAddress.selector);
        staking.setAdapter(IBuybackAdapter(address(0)));
        vm.stopPrank();
    }

    // =============================================================================================
    // stake
    // =============================================================================================

    function test_stake() public {
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.Staked(alice, 100e18, bytes32(0));
        _stake(alice, 100e18, bytes32(0));
        assertEq(staking.stakedOf(alice), 100e18);
        assertEq(staking.totalStaked(), 100e18);
        assertEq(anyr.balanceOf(address(staking)), 100e18);
        assertEq(anyr.balanceOf(alice), 10_000_000e18 - 100e18);
        assertEq(staking.providerOf(alice), bytes32(0));
    }

    function test_stake_revertsZero() public {
        vm.prank(alice);
        vm.expectRevert(IAnyrStaking.InvalidAmount.selector);
        staking.stake(0, bytes32(0));
    }

    function test_stake_revertsWithoutAllowance() public {
        address dave = makeAddr("dave");
        vm.prank(treasury);
        assertTrue(anyr.transfer(dave, 1e18));
        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(staking), 0, 1e18)
        );
        staking.stake(1e18, bytes32(0));
    }

    function test_stake_providerAttribution() public {
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.Staked(alice, 10e18, PID);
        _stake(alice, 10e18, PID);
        assertEq(staking.providerOf(alice), PID);
        assertEq(staking.providerStake(PID), 10e18);

        // zero id keeps the existing attribution
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.Staked(alice, 5e18, PID);
        _stake(alice, 5e18, bytes32(0));
        assertEq(staking.providerStake(PID), 15e18);

        // same id ok
        _stake(alice, 1e18, PID);
        assertEq(staking.providerStake(PID), 16e18);

        // different id reverts
        vm.prank(alice);
        vm.expectRevert(AnyrStaking.ProviderMismatch.selector);
        staking.stake(1e18, PID2);

        _stake(bob, 4e18, PID);
        assertEq(staking.providerStake(PID), 20e18);
        assertEq(staking.providerStake(PID2), 0);
    }

    function test_stake_existingStakeAttributedOnFirstProvider() public {
        _stake(alice, 10e18, bytes32(0));
        assertEq(staking.providerStake(PID), 0);
        _stake(alice, 1e18, PID);
        assertEq(staking.providerStake(PID), 11e18);
    }

    function test_stake_providerStakeTracksUnstakeRequests() public {
        _stake(alice, 10e18, PID);
        vm.prank(alice);
        staking.requestUnstake(4e18);
        assertEq(staking.providerStake(PID), 6e18);
        vm.prank(alice);
        staking.requestUnstake(6e18);
        assertEq(staking.providerStake(PID), 0);
        // attribution is permanent even at zero stake
        vm.prank(alice);
        vm.expectRevert(AnyrStaking.ProviderMismatch.selector);
        staking.stake(1e18, PID2);
    }

    // =============================================================================================
    // requestUnstake / unstake
    // =============================================================================================

    function test_requestUnstake() public {
        _stake(alice, 10e18, bytes32(0));
        vm.expectEmit(true, true, true, true, address(staking));
        // forge-lint: disable-next-line(unsafe-typecast)
        emit IAnyrStaking.UnstakeRequested(alice, 4e18, uint64(T0 + 7 days));
        vm.prank(alice);
        staking.requestUnstake(4e18);
        assertEq(staking.stakedOf(alice), 6e18);
        assertEq(staking.totalStaked(), 6e18);
        assertEq(staking.totalCooldown(), 4e18);
        (uint256 amt, uint64 at) = staking.pendingUnstake(alice);
        assertEq(amt, 4e18);
        assertEq(at, T0 + 7 days);
        assertEq(anyr.balanceOf(address(staking)), 10e18);
    }

    function test_requestUnstake_reverts() public {
        vm.prank(alice);
        vm.expectRevert(IAnyrStaking.InvalidAmount.selector);
        staking.requestUnstake(1);
        _stake(alice, 10e18, bytes32(0));
        vm.startPrank(alice);
        vm.expectRevert(IAnyrStaking.InvalidAmount.selector);
        staking.requestUnstake(0);
        vm.expectRevert(IAnyrStaking.InvalidAmount.selector);
        staking.requestUnstake(10e18 + 1);
        vm.stopPrank();
    }

    function test_requestUnstake_accumulatesAndResetsCooldown() public {
        _stake(alice, 10e18, bytes32(0));
        vm.prank(alice);
        staking.requestUnstake(4e18);
        vm.warp(T0 + 3 days);
        vm.prank(alice);
        staking.requestUnstake(1e18);
        (uint256 amt, uint64 at) = staking.pendingUnstake(alice);
        assertEq(amt, 5e18);
        assertEq(at, T0 + 3 days + 7 days);
        vm.warp(T0 + 7 days);
        vm.prank(alice);
        vm.expectRevert(IAnyrStaking.CooldownActive.selector);
        staking.unstake();
    }

    function test_unstake() public {
        _stake(alice, 10e18, bytes32(0));
        vm.prank(alice);
        staking.requestUnstake(10e18);

        vm.warp(T0 + 7 days - 1);
        vm.prank(alice);
        vm.expectRevert(IAnyrStaking.CooldownActive.selector);
        staking.unstake();

        vm.warp(T0 + 7 days);
        uint256 before = anyr.balanceOf(alice);
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.Unstaked(alice, 10e18);
        vm.prank(alice);
        staking.unstake();
        assertEq(anyr.balanceOf(alice), before + 10e18);
        assertEq(staking.totalCooldown(), 0);
        (uint256 amt,) = staking.pendingUnstake(alice);
        assertEq(amt, 0);
        assertEq(anyr.balanceOf(address(staking)), 0);

        vm.prank(alice);
        vm.expectRevert(IAnyrStaking.InvalidAmount.selector);
        staking.unstake();
    }

    function test_unstake_revertsWithoutRequest() public {
        _stake(alice, 10e18, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(IAnyrStaking.InvalidAmount.selector);
        staking.unstake();
    }

    function test_requestUnstake_stopsEarningImmediately() public {
        _stake(alice, 10e18, bytes32(0));
        _stake(bob, 10e18, bytes32(0));
        _notify(200e6);
        vm.prank(alice);
        staking.requestUnstake(10e18);
        uint256 out = _buyback(100e6);
        assertEq(staking.earned(alice), 0);
        assertEq(staking.earned(bob), out);
    }

    // =============================================================================================
    // notifyMargin
    // =============================================================================================

    function test_notifyMargin_splits() public {
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.MarginNotified(100e6, 50e6, 50e6);
        _notify(100e6);
        assertEq(staking.buybackBalance(), 50e6);
        assertEq(usdg.balanceOf(ops), 50e6);
        assertEq(usdg.balanceOf(address(staking)), 50e6);
    }

    function test_notifyMargin_oddUnitsGoToBuyback() public {
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.MarginNotified(3, 2, 1);
        _notify(3);
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.MarginNotified(1, 1, 0);
        _notify(1);
        assertEq(staking.buybackBalance(), 3);
        assertEq(usdg.balanceOf(ops), 1);
    }

    function test_notifyMargin_anyoneCanDonate() public {
        usdg.mint(carol, 10e6);
        vm.prank(carol);
        usdg.approve(address(staking), 10e6);
        vm.prank(carol);
        staking.notifyMargin(10e6);
        assertEq(staking.buybackBalance(), 5e6);
    }

    function test_notifyMargin_reverts() public {
        vm.prank(settlement);
        vm.expectRevert(IAnyrStaking.InvalidAmount.selector);
        staking.notifyMargin(0);
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(staking), 0, 1)
        );
        staking.notifyMargin(2);
    }

    function testFuzz_notifyMargin(uint256 amt) public {
        amt = bound(amt, 1, 100_000_000e6);
        _notify(amt);
        assertEq(staking.buybackBalance() + usdg.balanceOf(ops), amt);
        assertEq(usdg.balanceOf(address(staking)), staking.buybackBalance());
        assertEq(staking.buybackBalance(), amt - amt / 2);
    }

    // =============================================================================================
    // executeBuyback
    // =============================================================================================

    function test_executeBuyback_distributes() public {
        _stake(alice, 100e18, bytes32(0));
        _stake(bob, 300e18, bytes32(0));
        _notify(200e6);
        uint256 expected = adapter.quote(80e6);
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.BoughtBack(80e6, expected);
        uint256 out = _buyback(80e6);
        assertEq(out, expected);
        assertEq(out, 800e18);
        assertEq(staking.buybackBalance(), 20e6);
        assertEq(usdg.balanceOf(address(adapter)), 80e6);
        assertEq(usdg.balanceOf(address(staking)), 20e6);
        assertEq(staking.earned(alice), 200e18);
        assertEq(staking.earned(bob), 600e18);
        assertEq(staking.rewardReserve(), 800e18);
        assertEq(anyr.balanceOf(address(staking)), 400e18 + 800e18);
    }

    function test_executeBuyback_reverts() public {
        _notify(100e6);
        vm.prank(alice);
        vm.expectRevert(IAnyrStaking.NotKeeper.selector);
        staking.executeBuyback(1e6, 1);
        vm.startPrank(keeper);
        vm.expectRevert(IAnyrStaking.InvalidAmount.selector);
        staking.executeBuyback(0, 1);
        vm.expectRevert(IAnyrStaking.InvalidAmount.selector);
        staking.executeBuyback(1e6, 0);
        vm.expectRevert(IAnyrStaking.BuybackTooLarge.selector);
        staking.executeBuyback(50e6 + 1, 1);
        vm.stopPrank();
    }

    function test_executeBuyback_dailyCap() public {
        _notify(100_000e6);
        _buyback(6_000e6);
        assertEq(staking.buybackRemainingToday(), 4_000e6);
        vm.prank(keeper);
        vm.expectRevert(IAnyrStaking.BuybackTooLarge.selector);
        staking.executeBuyback(4_000e6 + 1, 1);
        _buyback(4_000e6); // exactly the cap
        assertEq(staking.buybackRemainingToday(), 0);
        vm.prank(keeper);
        vm.expectRevert(IAnyrStaking.BuybackTooLarge.selector);
        staking.executeBuyback(1, 1);

        // last second of the UTC day: still capped
        vm.warp(T0 + 1 days - 1);
        vm.prank(keeper);
        vm.expectRevert(IAnyrStaking.BuybackTooLarge.selector);
        staking.executeBuyback(1, 1);

        // next UTC day resets
        vm.warp(T0 + 1 days);
        assertEq(staking.buybackRemainingToday(), 10_000e6);
        _buyback(10_000e6);
        assertEq(staking.boughtOnDay(), 10_000e6);
        assertEq(staking.buybackDay(), (T0 + 1 days) / 1 days);
    }

    function test_executeBuyback_singleOverCap() public {
        _notify(100_000e6);
        vm.prank(keeper);
        vm.expectRevert(IAnyrStaking.BuybackTooLarge.selector);
        staking.executeBuyback(10_000e6 + 1, 1);
    }

    function test_executeBuyback_insufficientOutputByBalanceDelta() public {
        _stake(alice, 1e18, bytes32(0));
        _notify(100e6);
        adapter.setShortfallBps(100); // adapter lies: reports full quote, delivers 99%
        uint256 minOut = adapter.quote(10e6);
        vm.prank(keeper);
        vm.expectRevert(IAnyrStaking.InsufficientOutput.selector);
        staking.executeBuyback(10e6, minOut);
        assertEq(staking.buybackBalance(), 50e6); // rolled back
    }

    function test_executeBuyback_usesDeliveredNotReported() public {
        _stake(alice, 1e18, bytes32(0));
        _notify(100e6);
        adapter.setShortfallBps(1000); // delivers 90%
        uint256 quoted = adapter.quote(10e6);
        vm.prank(keeper);
        uint256 out = staking.executeBuyback(10e6, quoted / 2);
        assertEq(out, (quoted * 9) / 10);
        assertEq(staking.rewardReserve(), out);
    }

    function test_executeBuyback_adapterSlippageBubbles() public {
        _notify(100e6);
        uint256 minOut = adapter.quote(10e6) + 1;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockBuybackAdapter.Slippage.selector, minOut - 1, minOut));
        staking.executeBuyback(10e6, minOut);
    }

    function test_executeBuyback_noStakersHoldsUndistributed() public {
        _notify(200e6);
        uint256 out1 = _buyback(10e6);
        assertEq(staking.undistributed(), out1);
        assertEq(staking.rewardReserve(), out1);
        assertEq(staking.rewardPerTokenStored(), 0);

        _stake(alice, 1e18, bytes32(0));
        assertEq(staking.earned(alice), 0); // not distributed until the next buyback
        uint256 out2 = _buyback(20e6);
        assertEq(staking.earned(alice), out1 + out2);
        assertEq(staking.undistributed(), 0);
        vm.prank(alice);
        assertEq(staking.claimRewards(), out1 + out2);
    }

    function test_executeBuyback_onlyCooldownStakeHoldsUndistributed() public {
        _stake(alice, 1e18, bytes32(0));
        vm.prank(alice);
        staking.requestUnstake(1e18);
        _notify(20e6);
        uint256 out = _buyback(10e6);
        assertEq(staking.undistributed(), out);
        assertEq(staking.earned(alice), 0);
    }

    function test_executeBuyback_reentrancyBlocked() public {
        ReentrantAdapter bad = new ReentrantAdapter();
        vm.prank(owner);
        staking.setAdapter(bad);
        _notify(100e6);
        for (uint8 m; m < 3; ++m) {
            bad.set(staking, m);
            vm.prank(keeper);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            staking.executeBuyback(1e6, 1);
        }
    }

    // =============================================================================================
    // claimRewards
    // =============================================================================================

    function test_claimRewards_nothing() public {
        vm.recordLogs();
        vm.prank(alice);
        assertEq(staking.claimRewards(), 0);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_claimRewards() public {
        _stake(alice, 100e18, bytes32(0));
        _notify(20e6);
        uint256 out = _buyback(10e6);
        vm.expectEmit(true, true, true, true, address(staking));
        emit IAnyrStaking.RewardPaid(alice, out);
        vm.prank(alice);
        uint256 got = staking.claimRewards();
        assertEq(got, out);
        assertEq(anyr.balanceOf(alice), 10_000_000e18 - 100e18 + out);
        assertEq(staking.earned(alice), 0);
        assertEq(staking.rewardReserve(), 0);
        assertEq(anyr.balanceOf(address(staking)), 100e18);
        vm.prank(alice);
        assertEq(staking.claimRewards(), 0);
    }

    function test_claimRewards_afterFullUnstake() public {
        _stake(alice, 100e18, bytes32(0));
        _notify(20e6);
        uint256 out = _buyback(10e6);
        vm.prank(alice);
        staking.requestUnstake(100e18);
        vm.warp(T0 + 7 days);
        vm.prank(alice);
        staking.unstake();
        assertEq(staking.earned(alice), out);
        vm.prank(alice);
        assertEq(staking.claimRewards(), out);
        assertEq(anyr.balanceOf(address(staking)), 0);
    }

    function test_rewardsNeverPayPrincipal() public {
        _stake(alice, 7e18, bytes32(0));
        _stake(bob, 13e18, bytes32(0));
        _stake(carol, 3e18, bytes32(0));
        _notify(1_000e6);
        _buyback(333_333);
        _buyback(1);
        vm.prank(bob);
        staking.requestUnstake(5e18);
        _buyback(777_777);

        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            staking.claimRewards();
            // after all rewards are claimed, principal is still fully backed
            assertGe(anyr.balanceOf(address(staking)), staking.totalStaked() + staking.totalCooldown());
        }
        assertEq(anyr.balanceOf(address(staking)), staking.totalStaked() + staking.totalCooldown() + staking.rewardReserve());
        // only rounding dust / undistributed remains as reward reserve
        assertLe(staking.rewardReserve(), staking.undistributed() + 10);

        vm.startPrank(alice);
        staking.requestUnstake(7e18);
        vm.stopPrank();
        vm.prank(carol);
        staking.requestUnstake(3e18);
        vm.prank(bob);
        staking.requestUnstake(8e18);
        vm.warp(T0 + 7 days);
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            staking.unstake();
        }
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.totalCooldown(), 0);
        assertEq(anyr.balanceOf(address(staking)), staking.rewardReserve());
    }

    // =============================================================================================
    // Fuzz
    // =============================================================================================

    function testFuzz_rewardsProportional(uint256 a, uint256 b, uint256 usdgIn) public {
        a = bound(a, 1, 10_000_000e18);
        b = bound(b, 1, 10_000_000e18);
        usdgIn = bound(usdgIn, 1, 10_000e6);
        _stake(alice, a, bytes32(0));
        _stake(bob, b, bytes32(0));
        _notify(2 * usdgIn);
        uint256 out = _buyback(usdgIn);
        uint256 ea = staking.earned(alice);
        uint256 eb = staking.earned(bob);
        assertLe(ea + eb + staking.undistributed(), staking.rewardReserve());
        assertEq(staking.rewardReserve(), out);
        // each within 1 wei of the exact pro-rata share of what was allocated
        uint256 allocated = out - staking.undistributed();
        assertApproxEqAbs(ea, (allocated * a) / (a + b), 1);
        assertApproxEqAbs(eb, (allocated * b) / (a + b), 1);
    }

    function testFuzz_multiRoundAccounting(uint256[4] memory stakes, uint256[4] memory buys) public {
        address[3] memory who = [alice, bob, carol];
        _notify(100_000e6);
        for (uint256 r; r < 4; ++r) {
            _stake(who[r % 3], bound(stakes[r], 1, 1_000_000e18), bytes32(0));
            vm.warp(T0 + r * 1 days);
            _buyback(bound(buys[r], 1, 10_000e6));
        }
        uint256 sumEarned = staking.earned(alice) + staking.earned(bob) + staking.earned(carol);
        assertLe(sumEarned + staking.undistributed(), staking.rewardReserve());
        uint256 claimed;
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            claimed += staking.claimRewards();
        }
        assertEq(claimed, sumEarned);
        assertEq(anyr.balanceOf(address(staking)), staking.totalStaked() + staking.rewardReserve());
    }
}

// =================================================================================================
// Invariant: principal and rewards are separately and fully backed
// =================================================================================================

contract StakingHandler is CommonBase, StdCheats, StdUtils {
    AnyrStaking public immutable staking;
    AnyrToken public immutable anyr;
    MockUSDG public immutable usdg;
    MockBuybackAdapter public immutable adapter;
    address public immutable keeper;
    address public immutable anyrSource;
    address[3] public actors;
    bytes32[3] public pids;

    constructor(AnyrStaking s, AnyrToken a, MockUSDG u, MockBuybackAdapter ad, address k, address src) {
        staking = s;
        anyr = a;
        usdg = u;
        adapter = ad;
        keeper = k;
        anyrSource = src;
        actors = [makeAddr("s1"), makeAddr("s2"), makeAddr("s3")];
        pids = [keccak256("p1"), bytes32(0), keccak256("p2")];
        for (uint256 i; i < 3; ++i) {
            vm.prank(actors[i]);
            anyr.approve(address(staking), type(uint256).max);
        }
        usdg.approve(address(staking), type(uint256).max);
    }

    function stake(uint256 seed, uint256 amt) external {
        uint256 i = seed % 3;
        amt = bound(amt, 1, 1_000_000e18);
        vm.prank(anyrSource);
        require(anyr.transfer(actors[i], amt), "transfer");
        vm.prank(actors[i]);
        staking.stake(amt, pids[i]);
    }

    function requestUnstake(uint256 seed, uint256 amt) external {
        uint256 i = seed % 3;
        uint256 bal = staking.stakedOf(actors[i]);
        if (bal == 0) return;
        vm.prank(actors[i]);
        staking.requestUnstake(bound(amt, 1, bal));
    }
}

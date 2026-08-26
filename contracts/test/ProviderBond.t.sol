// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ProviderBond} from "../src/ProviderBond.sol";
import {IProviderBond} from "../src/interfaces/IProviderBond.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

contract ProviderBondTest is Test {
    uint256 internal constant MIN = 10_000e6;
    uint64 internal constant T0 = 1_750_000_000;

    MockUSDG internal usdg;
    ProviderBond internal pb;
    address internal owner = makeAddr("owner");
    address internal slasher = makeAddr("slasher");
    address internal refundPool = makeAddr("refundPool");
    address internal op = makeAddr("operator");
    address internal op2 = makeAddr("operator2");
    address internal rando = makeAddr("rando");
    address internal payout = makeAddr("payout");

    bytes32 internal constant PID = keccak256("provider-a");
    bytes32 internal constant PID2 = keccak256("provider-b");
    bytes32 internal constant EVIDENCE = keccak256("evidence-root");

    function setUp() public {
        vm.warp(T0);
        usdg = new MockUSDG();
        pb = new ProviderBond(IERC20(address(usdg)), owner, slasher, refundPool);
        address[3] memory ops = [op, op2, rando];
        for (uint256 i; i < 3; ++i) {
            usdg.mint(ops[i], 10_000_000e6);
            vm.prank(ops[i]);
            usdg.approve(address(pb), type(uint256).max);
        }
    }

    // --- helpers -------------------------------------------------------------------------------

    function _bond(bytes32 pid, address who, uint256 amt) internal {
        vm.prank(who);
        pb.bond(pid, amt);
    }

    function _propose(uint256 amt, bool delist) internal returns (uint256 id) {
        vm.prank(slasher);
        id = pb.proposeSlash(PID, IProviderBond.Kind.QuantFraud, amt, EVIDENCE, delist);
    }

    function _execute(uint256 id) internal {
        vm.prank(slasher);
        pb.executeSlash(id);
    }

    function _status(uint256 id) internal view returns (ProviderBond.Status s) {
        (,,,,,,, s) = pb.slashes(id);
    }

    // --- constructor ---------------------------------------------------------------------------

    function test_constants() public view {
        assertEq(pb.MIN_BOND(), 10_000e6);
        assertEq(pb.DISPUTE_WINDOW(), 72 hours);
        assertEq(pb.WITHDRAW_DELAY(), 14 days);
    }

    function test_constructor() public view {
        assertEq(address(pb.usdg()), address(usdg));
        assertEq(pb.owner(), owner);
        assertEq(pb.slasher(), slasher);
        assertEq(pb.refundPool(), refundPool);
        assertEq(pb.slashCount(), 0);
    }

    function test_constructor_emits() public {
        vm.expectEmit(true, true, true, true);
        emit IProviderBond.SlasherSet(slasher);
        vm.expectEmit(true, true, true, true);
        emit IProviderBond.RefundPoolSet(refundPool);
        new ProviderBond(IERC20(address(usdg)), owner, slasher, refundPool);
    }

    function test_constructor_revertsZeros() public {
        vm.expectRevert(ProviderBond.ZeroAddress.selector);
        new ProviderBond(IERC20(address(0)), owner, slasher, refundPool);
        vm.expectRevert(ProviderBond.ZeroAddress.selector);
        new ProviderBond(IERC20(address(usdg)), owner, address(0), refundPool);
        vm.expectRevert(ProviderBond.ZeroAddress.selector);
        new ProviderBond(IERC20(address(usdg)), owner, slasher, address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ProviderBond(IERC20(address(usdg)), address(0), slasher, refundPool);
    }

    // --- bond ----------------------------------------------------------------------------------

    function test_bond_firstRegistersOperator() public {
        vm.expectEmit(true, true, true, true, address(pb));
        emit IProviderBond.Bonded(PID, op, MIN, MIN);
        _bond(PID, op, MIN);
        assertEq(pb.operatorOf(PID), op);
        assertEq(pb.bondOf(PID), MIN);
        assertEq(pb.activeBondOf(PID), MIN);
        assertEq(usdg.balanceOf(address(pb)), MIN);
        assertFalse(pb.isDelisted(PID));
        assertEq(pb.pendingSlashes(PID), 0);
    }

    function test_bond_revertsBelowMinimumFirst() public {
        vm.prank(op);
        vm.expectRevert(IProviderBond.BelowMinimum.selector);
        pb.bond(PID, MIN - 1);
        assertEq(pb.operatorOf(PID), address(0));
    }

    function test_bond_revertsZeroProviderId() public {
        vm.prank(op);
        vm.expectRevert(ProviderBond.InvalidProvider.selector);
        pb.bond(bytes32(0), MIN);
    }

    function test_bond_revertsZeroAmount() public {
        vm.prank(op);
        vm.expectRevert(ProviderBond.InvalidAmount.selector);
        pb.bond(PID, 0);
    }

    function test_bond_revertsWithoutAllowance() public {
        address poor = makeAddr("poor");
        usdg.mint(poor, MIN);
        vm.prank(poor);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(pb), 0, MIN)
        );
        pb.bond(PID, MIN);
    }

    function test_bond_topUpByOperator() public {
        _bond(PID, op, MIN);
        vm.expectEmit(true, true, true, true, address(pb));
        emit IProviderBond.Bonded(PID, op, 1, MIN + 1);
        _bond(PID, op, 1);
        assertEq(pb.bondOf(PID), MIN + 1);
    }

    function test_bond_topUpRevertsNotOperator() public {
        _bond(PID, op, MIN);
        vm.prank(op2);
        vm.expectRevert(IProviderBond.NotOperator.selector);
        pb.bond(PID, MIN);
    }

    function test_bond_topUpAfterSlashMustReachMinimum() public {
        _bond(PID, op, MIN);
        uint256 id = _propose(4_000e6, false);
        vm.warp(T0 + 72 hours);
        _execute(id);
        assertEq(pb.bondOf(PID), 6_000e6);
        vm.prank(op);
        vm.expectRevert(IProviderBond.BelowMinimum.selector);
        pb.bond(PID, 3_999e6);
        _bond(PID, op, 4_000e6);
        assertEq(pb.bondOf(PID), MIN);
    }

    function test_bond_revertsDelisted() public {
        _bond(PID, op, MIN);
        uint256 id = _propose(1e6, true);
        vm.warp(T0 + 72 hours);
        _execute(id);
        vm.prank(op);
        vm.expectRevert(IProviderBond.ProviderDelisted.selector);
        pb.bond(PID, MIN);
    }

    function test_bond_independentProviders() public {
        _bond(PID, op, MIN);
        _bond(PID2, op2, 2 * MIN);
        assertEq(pb.operatorOf(PID2), op2);
        assertEq(pb.bondOf(PID), MIN);
        assertEq(pb.bondOf(PID2), 2 * MIN);
    }

    function testFuzz_bond(uint256 first, uint256 topUp) public {
        first = bound(first, MIN, 1_000_000e6);
        topUp = bound(topUp, 1, 1_000_000e6);
        _bond(PID, op, first);
        _bond(PID, op, topUp);
        assertEq(pb.bondOf(PID), first + topUp);
        assertEq(usdg.balanceOf(address(pb)), first + topUp);
    }

    // --- requestWithdraw -----------------------------------------------------------------------

    function test_requestWithdraw_partial() public {
        _bond(PID, op, 3 * MIN);
        vm.expectEmit(true, true, true, true, address(pb));
        emit IProviderBond.WithdrawRequested(PID, MIN, T0 + 14 days);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        (uint256 amt, uint64 at) = pb.withdrawRequest(PID);
        assertEq(amt, MIN);
        assertEq(at, T0 + 14 days);
        assertEq(pb.bondOf(PID), 3 * MIN); // still locked & slashable
        assertEq(pb.activeBondOf(PID), 2 * MIN);
    }

    function test_requestWithdraw_fullExit() public {
        _bond(PID, op, MIN + 5);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN + 5);
        assertEq(pb.activeBondOf(PID), 0);
    }

    function test_requestWithdraw_remainingExactlyMinOk() public {
        _bond(PID, op, MIN + 5);
        vm.prank(op);
        pb.requestWithdraw(PID, 5);
        (uint256 amt,) = pb.withdrawRequest(PID);
        assertEq(amt, 5);
    }

    function test_requestWithdraw_revertsBelowMinimum() public {
        _bond(PID, op, MIN + 5);
        vm.prank(op);
        vm.expectRevert(IProviderBond.BelowMinimum.selector);
        pb.requestWithdraw(PID, 6);
    }

    function test_requestWithdraw_revertsNotOperator() public {
        _bond(PID, op, MIN);
        vm.prank(rando);
        vm.expectRevert(IProviderBond.NotOperator.selector);
        pb.requestWithdraw(PID, MIN);
    }

    function test_requestWithdraw_revertsUnknownProvider() public {
        vm.prank(rando);
        vm.expectRevert(IProviderBond.NotOperator.selector);
        pb.requestWithdraw(PID, 1);
    }

    function test_requestWithdraw_revertsInvalidAmount() public {
        _bond(PID, op, MIN);
        vm.startPrank(op);
        vm.expectRevert(ProviderBond.InvalidAmount.selector);
        pb.requestWithdraw(PID, 0);
        vm.expectRevert(ProviderBond.InvalidAmount.selector);
        pb.requestWithdraw(PID, MIN + 1);
        vm.stopPrank();
    }

    function test_requestWithdraw_revertsSlashPending() public {
        _bond(PID, op, MIN);
        _propose(1, false);
        vm.prank(op);
        vm.expectRevert(IProviderBond.SlashPending.selector);
        pb.requestWithdraw(PID, MIN);
    }

    function test_requestWithdraw_replacesPrevious() public {
        _bond(PID, op, 3 * MIN);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        vm.warp(T0 + 1 days);
        vm.prank(op);
        pb.requestWithdraw(PID, 2 * MIN);
        (uint256 amt, uint64 at) = pb.withdrawRequest(PID);
        assertEq(amt, 2 * MIN);
        assertEq(at, T0 + 1 days + 14 days);
    }

    // --- cancelWithdraw ------------------------------------------------------------------------

    function test_cancelWithdraw() public {
        _bond(PID, op, MIN);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        vm.expectEmit(true, true, true, true, address(pb));
        emit ProviderBond.WithdrawCancelled(PID);
        vm.prank(op);
        pb.cancelWithdraw(PID);
        (uint256 amt, uint64 at) = pb.withdrawRequest(PID);
        assertEq(amt, 0);
        assertEq(at, 0);
        assertEq(pb.activeBondOf(PID), MIN);
    }
}

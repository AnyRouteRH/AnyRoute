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

    function test_cancelWithdraw_reverts() public {
        _bond(PID, op, MIN);
        vm.prank(op);
        vm.expectRevert(IProviderBond.NothingToWithdraw.selector);
        pb.cancelWithdraw(PID);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        vm.prank(rando);
        vm.expectRevert(IProviderBond.NotOperator.selector);
        pb.cancelWithdraw(PID);
    }

    // --- withdraw ------------------------------------------------------------------------------

    function test_withdraw_afterDelay() public {
        _bond(PID, op, 3 * MIN);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);

        vm.warp(T0 + 14 days - 1);
        vm.prank(op);
        vm.expectRevert(IProviderBond.NotReady.selector);
        pb.withdraw(PID, payout);

        vm.warp(T0 + 14 days);
        vm.expectEmit(true, true, true, true, address(pb));
        emit IProviderBond.Withdrawn(PID, payout, MIN);
        vm.prank(op);
        pb.withdraw(PID, payout);
        assertEq(usdg.balanceOf(payout), MIN);
        assertEq(pb.bondOf(PID), 2 * MIN);
        (uint256 amt,) = pb.withdrawRequest(PID);
        assertEq(amt, 0);

        vm.prank(op);
        vm.expectRevert(IProviderBond.NothingToWithdraw.selector);
        pb.withdraw(PID, payout);
    }

    function test_withdraw_fullExitThenRebond() public {
        _bond(PID, op, MIN);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        vm.warp(T0 + 14 days);
        vm.prank(op);
        pb.withdraw(PID, op);
        assertEq(pb.bondOf(PID), 0);
        assertEq(pb.operatorOf(PID), op);
        vm.prank(op2);
        vm.expectRevert(IProviderBond.NotOperator.selector);
        pb.bond(PID, MIN);
        _bond(PID, op, MIN);
        assertEq(pb.bondOf(PID), MIN);
    }

    function test_withdraw_revertsNotOperator() public {
        _bond(PID, op, MIN);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        vm.warp(T0 + 14 days);
        vm.prank(rando);
        vm.expectRevert(IProviderBond.NotOperator.selector);
        pb.withdraw(PID, rando);
    }

    function test_withdraw_revertsZeroTo() public {
        _bond(PID, op, MIN);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        vm.warp(T0 + 14 days);
        vm.prank(op);
        vm.expectRevert(ProviderBond.ZeroAddress.selector);
        pb.withdraw(PID, address(0));
    }

    function test_withdraw_revertsNoRequest() public {
        _bond(PID, op, MIN);
        vm.prank(op);
        vm.expectRevert(IProviderBond.NothingToWithdraw.selector);
        pb.withdraw(PID, op);
    }

    function test_withdraw_revertsSlashPending_thenCancelledUnblocks() public {
        _bond(PID, op, MIN);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        uint256 id = _propose(1e6, false);
        vm.warp(T0 + 14 days);
        vm.prank(op);
        vm.expectRevert(IProviderBond.SlashPending.selector);
        pb.withdraw(PID, op);
        vm.prank(slasher);
        pb.cancelSlash(id);
        vm.prank(op);
        pb.withdraw(PID, op);
        assertEq(pb.bondOf(PID), 0);
    }

    function test_withdraw_afterSlashPaysMin() public {
        _bond(PID, op, 2 * MIN);
        vm.prank(op);
        pb.requestWithdraw(PID, 2 * MIN);
        uint256 id = _propose(8_000e6, false); // locked amount is still slashable
        vm.warp(T0 + 72 hours);
        _execute(id);
        vm.warp(T0 + 14 days);
        vm.expectEmit(true, true, true, true, address(pb));
        emit IProviderBond.Withdrawn(PID, payout, 12_000e6);
        vm.prank(op);
        pb.withdraw(PID, payout);
        assertEq(usdg.balanceOf(payout), 12_000e6);
        assertEq(usdg.balanceOf(refundPool), 8_000e6);
        assertEq(pb.bondOf(PID), 0);
        assertEq(usdg.balanceOf(address(pb)), 0);
    }

    function test_withdraw_revertsWhenSlashedToZero() public {
        _bond(PID, op, MIN);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        uint256 id = _propose(MIN, false);
        vm.warp(T0 + 72 hours);
        _execute(id);
        vm.warp(T0 + 14 days);
        vm.prank(op);
        vm.expectRevert(IProviderBond.NothingToWithdraw.selector);
        pb.withdraw(PID, op);
        // operator can clear the stale request
        vm.prank(op);
        pb.cancelWithdraw(PID);
    }

    function test_withdraw_delistedCanWithdrawRemainder() public {
        _bond(PID, op, 2 * MIN);
        uint256 id = _propose(5_000e6, true);
        vm.warp(T0 + 72 hours);
        _execute(id);
        assertTrue(pb.isDelisted(PID));
        vm.prank(op);
        pb.requestWithdraw(PID, 15_000e6);
        vm.warp(T0 + 72 hours + 14 days);
        vm.prank(op);
        pb.withdraw(PID, payout);
        assertEq(usdg.balanceOf(payout), 15_000e6);
        assertEq(pb.bondOf(PID), 0);
    }

    // --- proposeSlash --------------------------------------------------------------------------

    function test_proposeSlash() public {
        _bond(PID, op, MIN);
        vm.expectEmit(true, true, true, true, address(pb));
        emit IProviderBond.SlashProposed(1, PID, IProviderBond.Kind.Uptime, 500e6, EVIDENCE, T0 + 72 hours);
        vm.prank(slasher);
        uint256 id = pb.proposeSlash(PID, IProviderBond.Kind.Uptime, 500e6, EVIDENCE, true);
        assertEq(id, 1);
        assertEq(pb.slashCount(), 1);
        assertEq(pb.pendingSlashes(PID), 1);
        (
            bytes32 pid,
            uint256 amount,
            bytes32 evidence,
            bytes32 dispute,
            uint64 executableAt,
            IProviderBond.Kind kind,
            bool delist,
            ProviderBond.Status status
        ) = pb.slashes(id);
        assertEq(pid, PID);
        assertEq(amount, 500e6);
        assertEq(evidence, EVIDENCE);
        assertEq(dispute, bytes32(0));
        assertEq(executableAt, T0 + 72 hours);
        assertEq(uint8(kind), uint8(IProviderBond.Kind.Uptime));
        assertTrue(delist);
        assertEq(uint8(status), uint8(ProviderBond.Status.Pending));
        // proposing does not move funds
        assertEq(pb.bondOf(PID), MIN);
    }

    function test_proposeSlash_sequentialIds() public {
        _bond(PID, op, MIN);
        assertEq(_propose(1, false), 1);
        assertEq(_propose(1, false), 2);
        assertEq(_propose(1, false), 3);
        assertEq(pb.pendingSlashes(PID), 3);
    }

    function test_proposeSlash_revertsNotSlasher() public {
        _bond(PID, op, MIN);
        vm.prank(owner);
        vm.expectRevert(IProviderBond.NotSlasher.selector);
        pb.proposeSlash(PID, IProviderBond.Kind.Other, 1, EVIDENCE, false);
    }

    function test_proposeSlash_revertsInvalidAmount() public {
        _bond(PID, op, MIN);
        vm.startPrank(slasher);
        vm.expectRevert(ProviderBond.InvalidAmount.selector);
        pb.proposeSlash(PID, IProviderBond.Kind.Other, 0, EVIDENCE, false);
        vm.expectRevert(ProviderBond.InvalidAmount.selector);
        pb.proposeSlash(PID, IProviderBond.Kind.Other, MIN + 1, EVIDENCE, false);
        vm.expectRevert(ProviderBond.InvalidAmount.selector);
        pb.proposeSlash(PID2, IProviderBond.Kind.Other, 1, EVIDENCE, false); // unknown provider
        vm.stopPrank();
    }

    // --- disputeSlash --------------------------------------------------------------------------

    function test_disputeSlash_recordsButDoesNotBlock() public {
        _bond(PID, op, MIN);
        uint256 id = _propose(1_000e6, false);
        vm.expectEmit(true, true, true, true, address(pb));
        emit IProviderBond.SlashDisputed(id, keccak256("counter-evidence"));
        vm.prank(op);
        pb.disputeSlash(id, keccak256("counter-evidence"));
        (,,, bytes32 dispute,,,,) = pb.slashes(id);
        assertEq(dispute, keccak256("counter-evidence"));
        vm.warp(T0 + 72 hours);
        _execute(id);
        assertEq(pb.bondOf(PID), 9_000e6);
    }

    function test_disputeSlash_reverts() public {
        _bond(PID, op, MIN);
        _bond(PID2, op2, MIN);
        uint256 id = _propose(1, false);
        vm.prank(op2); // operator of another provider
        vm.expectRevert(IProviderBond.NotOperator.selector);
        pb.disputeSlash(id, bytes32(uint256(1)));
        vm.prank(slasher);
        vm.expectRevert(IProviderBond.NotOperator.selector);
        pb.disputeSlash(id, bytes32(uint256(1)));
        vm.prank(op);
        vm.expectRevert(IProviderBond.UnknownSlash.selector);
        pb.disputeSlash(99, bytes32(uint256(1)));
        vm.prank(slasher);
        pb.cancelSlash(id);
        vm.prank(op);
        vm.expectRevert(IProviderBond.AlreadyFinal.selector);
        pb.disputeSlash(id, bytes32(uint256(1)));
    }

    // --- cancelSlash ---------------------------------------------------------------------------

    function test_cancelSlash() public {
        _bond(PID, op, MIN);
        uint256 id = _propose(1_000e6, false);
        vm.expectEmit(true, true, true, true, address(pb));
        emit IProviderBond.SlashCancelled(id);
        vm.prank(slasher);
        pb.cancelSlash(id);
        assertEq(uint8(_status(id)), uint8(ProviderBond.Status.Cancelled));
        assertEq(pb.pendingSlashes(PID), 0);
        assertEq(pb.bondOf(PID), MIN);
        vm.prank(slasher);
        vm.expectRevert(IProviderBond.AlreadyFinal.selector);
        pb.cancelSlash(id);
        vm.warp(T0 + 72 hours);
        vm.prank(slasher);
        vm.expectRevert(IProviderBond.AlreadyFinal.selector);
        pb.executeSlash(id);
    }

    function test_cancelSlash_reverts() public {
        _bond(PID, op, MIN);
        uint256 id = _propose(1, false);
        vm.prank(op);
        vm.expectRevert(IProviderBond.NotSlasher.selector);
        pb.cancelSlash(id);
        vm.startPrank(slasher);
        vm.expectRevert(IProviderBond.UnknownSlash.selector);
        pb.cancelSlash(0);
        vm.expectRevert(IProviderBond.UnknownSlash.selector);
        pb.cancelSlash(2);
        vm.stopPrank();
        vm.warp(T0 + 72 hours);
        _execute(id);
        vm.prank(slasher);
        vm.expectRevert(IProviderBond.AlreadyFinal.selector);
        pb.cancelSlash(id);
    }

    // --- executeSlash --------------------------------------------------------------------------

    function test_executeSlash() public {
        _bond(PID, op, 2 * MIN);
        uint256 id = _propose(3_000e6, false);
        vm.warp(T0 + 72 hours - 1);
        vm.prank(slasher);
        vm.expectRevert(IProviderBond.NotReady.selector);
        pb.executeSlash(id);

        vm.warp(T0 + 72 hours);
        vm.expectEmit(true, true, true, true, address(pb));
        emit IProviderBond.SlashExecuted(id, PID, 3_000e6, false);
        _execute(id);
        assertEq(usdg.balanceOf(refundPool), 3_000e6);
        assertEq(pb.bondOf(PID), 17_000e6);
        assertEq(pb.pendingSlashes(PID), 0);
        assertFalse(pb.isDelisted(PID));
        assertEq(uint8(_status(id)), uint8(ProviderBond.Status.Executed));

        vm.prank(slasher);
        vm.expectRevert(IProviderBond.AlreadyFinal.selector);
        pb.executeSlash(id);
    }
}

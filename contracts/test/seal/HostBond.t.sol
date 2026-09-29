// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {HostBond} from "../../src/seal/HostBond.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";

contract HostBondTest is Test {
    uint256 internal constant MIN = 5_000e6;
    uint64 internal constant T0 = 1_750_000_000;

    MockUSDG internal usdg;
    HostBond internal hb;
    address internal owner = makeAddr("owner");
    address internal slasher = makeAddr("slasher");
    address internal refundPool = makeAddr("refundPool");
    address internal op = makeAddr("operator");
    address internal op2 = makeAddr("operator2");
    address internal rando = makeAddr("rando");
    address internal payout = makeAddr("payout");

    bytes32 internal constant HID = keccak256("host-a");
    bytes32 internal constant HID2 = keccak256("host-b");
    bytes32 internal constant EVIDENCE = keccak256("evidence-root");

    event Bonded(bytes32 indexed hostId, address indexed operator, uint256 amount, uint256 total);
    event UnbondRequested(bytes32 indexed hostId, uint256 amount, uint64 availableAt);
    event Unbonded(bytes32 indexed hostId, address indexed to, uint256 amount);
    event SlashProposed(
        uint256 indexed slashId,
        bytes32 indexed hostId,
        HostBond.Reason reason,
        uint256 amount,
        bytes32 evidenceRoot,
        uint64 executableAt
    );
    event SlashDisputed(uint256 indexed slashId, bytes32 disputeHash);
    event SlashApproved(uint256 indexed slashId, bytes32 disputeHash);
    event SlashExecuted(uint256 indexed slashId, bytes32 indexed hostId, uint256 amount, bool delisted);
    event Delisted(bytes32 indexed hostId);
    event MinBondSet(uint256 minBond);

    function setUp() public {
        vm.warp(T0);
        usdg = new MockUSDG();
        hb = new HostBond(IERC20(address(usdg)), owner, slasher, refundPool);
        address[3] memory ops = [op, op2, rando];
        for (uint256 i; i < 3; ++i) {
            usdg.mint(ops[i], 10_000_000e6);
            vm.prank(ops[i]);
            usdg.approve(address(hb), type(uint256).max);
        }
    }

    // --- helpers -----------------------------------------------------------------------------------

    function _bond(bytes32 hid, address who, uint256 amt) internal {
        vm.prank(who);
        hb.bond(hid, amt);
    }

    function _propose(HostBond.Reason reason, uint256 amt, bool delist) internal returns (uint256 id) {
        vm.prank(slasher);
        id = hb.proposeSlash(HID, reason, amt, EVIDENCE, delist);
    }

    function _dispute(uint256 id) internal view returns (bytes32 d) {
        (,,, d,,,,) = hb.slashes(id);
    }

    function _status(uint256 id) internal view returns (HostBond.Status s) {
        (,,,,,,, s) = hb.slashes(id);
    }

    function _approve(uint256 id) internal {
        bytes32 d = _dispute(id);
        vm.prank(owner);
        hb.approveSlash(id, d);
    }

    // --- constructor / config ----------------------------------------------------------------------

    function test_constructor() public view {
        assertEq(address(hb.usdg()), address(usdg));
        assertEq(hb.owner(), owner);
        assertEq(hb.slasher(), slasher);
        assertEq(hb.refundPool(), refundPool);
        assertEq(hb.minBond(), MIN);
        assertEq(hb.MIN_BOND_FLOOR(), MIN);
        assertEq(hb.DISPUTE_WINDOW(), 72 hours);
        assertEq(hb.UNBOND_COOLDOWN(), 14 days);
        assertEq(hb.UPTIME_TARGET_BPS(), 9_500);
    }

    function test_constructorRejects() public {
        IERC20 t = IERC20(address(usdg));
        vm.expectRevert(HostBond.ZeroAddress.selector);
        new HostBond(IERC20(address(0)), owner, slasher, refundPool);
        vm.expectRevert(HostBond.ZeroAddress.selector);
        new HostBond(t, owner, address(0), refundPool);
        vm.expectRevert(HostBond.ZeroAddress.selector);
        new HostBond(t, owner, slasher, address(0));
        vm.expectRevert(HostBond.IndependentOwnerRequired.selector);
        new HostBond(t, slasher, slasher, refundPool);
    }

    function test_reasonsAreTheFourSealReasons() public pure {
        assertEq(uint8(HostBond.Reason.MeasurementDrift), 0);
        assertEq(uint8(HostBond.Reason.ShadowMismatch), 1);
        assertEq(uint8(HostBond.Reason.EmptyResponses), 2);
        assertEq(uint8(HostBond.Reason.Uptime), 3);
    }

    function test_setMinBondWithinBounds() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        hb.setMinBond(10_000e6);

        vm.startPrank(owner);
        vm.expectRevert(HostBond.MinBondOutOfBounds.selector);
        hb.setMinBond(MIN - 1);
        uint256 ceiling = hb.MIN_BOND_CEILING();
        vm.expectRevert(HostBond.MinBondOutOfBounds.selector);
        hb.setMinBond(ceiling + 1);
        vm.expectEmit(address(hb));
        emit MinBondSet(ceiling);
        hb.setMinBond(ceiling);
        vm.stopPrank();
        assertEq(hb.minBond(), ceiling);
    }

    function testFuzz_setMinBondBounds(uint256 v) public {
        bool ok = v >= hb.MIN_BOND_FLOOR() && v <= hb.MIN_BOND_CEILING();
        if (!ok) vm.expectRevert(HostBond.MinBondOutOfBounds.selector);
        vm.prank(owner);
        hb.setMinBond(v);
        if (ok) assertEq(hb.minBond(), v);
    }

    function test_setSlasherAndRefundPool() public {
        vm.startPrank(owner);
        vm.expectRevert(HostBond.ZeroAddress.selector);
        hb.setSlasher(address(0));
        vm.expectRevert(HostBond.IndependentOwnerRequired.selector);
        hb.setSlasher(owner);
        vm.expectRevert(HostBond.ZeroAddress.selector);
        hb.setRefundPool(address(0));
        uint256 gen = hb.approvalGeneration();
        hb.setSlasher(rando);
        hb.setRefundPool(payout);
        vm.stopPrank();
        assertEq(hb.slasher(), rando);
        assertEq(hb.refundPool(), payout);
        assertEq(hb.approvalGeneration(), gen + 2);
    }

    function test_ownerCannotBecomeSlasher() public {
        vm.prank(owner);
        hb.transferOwnership(slasher);
        vm.prank(slasher);
        vm.expectRevert(HostBond.IndependentOwnerRequired.selector);
        hb.acceptOwnership();
        assertEq(hb.owner(), owner);

        // Nor can the pending owner be made slasher.
        vm.prank(owner);
        hb.transferOwnership(rando);
        vm.prank(owner);
        vm.expectRevert(HostBond.IndependentOwnerRequired.selector);
        hb.setSlasher(rando);
    }

    // --- bonding -----------------------------------------------------------------------------------

    function test_bondRegistersOperatorAndEmits() public {
        vm.expectEmit(address(hb));
        emit Bonded(HID, op, MIN, MIN);
        _bond(HID, op, MIN);
        assertEq(hb.operatorOf(HID), op);
        assertEq(hb.bondOf(HID), MIN);
        assertEq(hb.activeBondOf(HID), MIN);
        assertTrue(hb.isBonded(HID));
        assertEq(usdg.balanceOf(address(hb)), MIN);

        _bond(HID, op, 1e6);
        assertEq(hb.bondOf(HID), MIN + 1e6);
    }

    function test_bondValidation() public {
        vm.prank(op);
        vm.expectRevert(HostBond.InvalidHost.selector);
        hb.bond(0, MIN);
        vm.prank(op);
        vm.expectRevert(HostBond.InvalidAmount.selector);
        hb.bond(HID, 0);
        vm.prank(op);
        vm.expectRevert(HostBond.BelowMinimum.selector);
        hb.bond(HID, MIN - 1);

        _bond(HID, op, MIN);
        vm.prank(op2);
        vm.expectRevert(HostBond.NotOperator.selector);
        hb.bond(HID, MIN);
    }

    function test_raisedMinimumMakesExistingHostIneligible() public {
        _bond(HID, op, MIN);
        vm.prank(owner);
        hb.setMinBond(10_000e6);
        assertFalse(hb.isBonded(HID));
        vm.prank(op);
        vm.expectRevert(HostBond.BelowMinimum.selector);
        hb.bond(HID, 1e6);
        _bond(HID, op, 5_000e6);
        assertTrue(hb.isBonded(HID));
    }

    function testFuzz_bondMinimum(uint256 amount) public {
        amount = bound(amount, 1, 10_000_000e6);
        if (amount < MIN) vm.expectRevert(HostBond.BelowMinimum.selector);
        _bond(HID, op, amount);
        assertEq(hb.isBonded(HID), amount >= MIN);
    }

    // --- unbonding ---------------------------------------------------------------------------------

    function test_unbondAfterCooldown() public {
        _bond(HID, op, 8_000e6);
        vm.expectEmit(address(hb));
        emit UnbondRequested(HID, 3_000e6, T0 + 14 days);
        vm.prank(op);
        hb.requestUnbond(HID, 3_000e6);
        assertEq(hb.activeBondOf(HID), 5_000e6);
        assertEq(hb.bondOf(HID), 8_000e6);

        vm.warp(T0 + 14 days - 1);
        vm.prank(op);
        vm.expectRevert(HostBond.NotReady.selector);
        hb.unbond(HID, payout);

        vm.warp(T0 + 14 days);
        vm.expectEmit(address(hb));
        emit Unbonded(HID, payout, 3_000e6);
        vm.prank(op);
        hb.unbond(HID, payout);
        assertEq(usdg.balanceOf(payout), 3_000e6);
        assertEq(hb.bondOf(HID), 5_000e6);
        (uint256 amt,) = hb.unbondRequest(HID);
        assertEq(amt, 0);
    }

    function test_fullExitAllowed() public {
        _bond(HID, op, MIN);
        vm.prank(op);
        hb.requestUnbond(HID, MIN);
        assertFalse(hb.isBonded(HID));
        vm.warp(T0 + 14 days);
        vm.prank(op);
        hb.unbond(HID, op);
        assertEq(hb.bondOf(HID), 0);
    }

    function test_unbondValidation() public {
        _bond(HID, op, 8_000e6);
        vm.prank(rando);
        vm.expectRevert(HostBond.NotOperator.selector);
        hb.requestUnbond(HID, 1e6);

        vm.startPrank(op);
        vm.expectRevert(HostBond.InvalidAmount.selector);
        hb.requestUnbond(HID, 0);
        vm.expectRevert(HostBond.InvalidAmount.selector);
        hb.requestUnbond(HID, 8_000e6 + 1);
        vm.expectRevert(HostBond.BelowMinimum.selector);
        hb.requestUnbond(HID, 3_000e6 + 1);
        vm.expectRevert(HostBond.NothingToUnbond.selector);
        hb.unbond(HID, op);
        vm.expectRevert(HostBond.NothingToUnbond.selector);
        hb.cancelUnbond(HID);
        hb.requestUnbond(HID, 1e6);
        vm.expectRevert(HostBond.ZeroAddress.selector);
        hb.unbond(HID, address(0));
        hb.cancelUnbond(HID);
        vm.stopPrank();
        assertEq(hb.activeBondOf(HID), 8_000e6);
    }

    function test_unbondBlockedWhileSlashPending() public {
        _bond(HID, op, 8_000e6);
        vm.prank(op);
        hb.requestUnbond(HID, 3_000e6);
        _propose(HostBond.Reason.Uptime, 1_000e6, false);

        vm.warp(T0 + 14 days);
        vm.prank(op);
        vm.expectRevert(HostBond.SlashPending.selector);
        hb.unbond(HID, op);
        vm.prank(op);
        vm.expectRevert(HostBond.SlashPending.selector);
        hb.requestUnbond(HID, 1e6);
    }

    function test_queuedUnbondStaysSlashable() public {
        _bond(HID, op, MIN);
        vm.prank(op);
        hb.requestUnbond(HID, MIN);
        uint256 id = _propose(HostBond.Reason.EmptyResponses, MIN, false);
        vm.warp(T0 + 72 hours);
        _approve(id);
        vm.prank(slasher);
        hb.executeSlash(id);
        assertEq(usdg.balanceOf(refundPool), MIN);

        vm.warp(T0 + 14 days);
        vm.prank(op);
        vm.expectRevert(HostBond.NothingToUnbond.selector);
        hb.unbond(HID, op);
    }

    // --- slashing ----------------------------------------------------------------------------------

    function test_slashFullFlowWithDisputeWindow() public {
        _bond(HID, op, 10_000e6);
        vm.expectEmit(address(hb));
        emit SlashProposed(1, HID, HostBond.Reason.MeasurementDrift, 4_000e6, EVIDENCE, T0 + 72 hours);
        uint256 id = _propose(HostBond.Reason.MeasurementDrift, 4_000e6, false);
        assertEq(id, 1);
        assertEq(hb.pendingSlashes(HID), 1);
        assertEq(uint8(_status(id)), uint8(HostBond.Status.Pending));

        _approve(id);
        vm.warp(T0 + 72 hours - 1);
        vm.prank(slasher);
        vm.expectRevert(HostBond.NotReady.selector);
        hb.executeSlash(id);

        vm.warp(T0 + 72 hours);
        vm.expectEmit(address(hb));
        emit SlashExecuted(id, HID, 4_000e6, false);
        vm.prank(slasher);
        hb.executeSlash(id);

        assertEq(hb.bondOf(HID), 6_000e6);
        assertEq(usdg.balanceOf(refundPool), 4_000e6);
        assertEq(hb.pendingSlashes(HID), 0);
        assertEq(uint8(_status(id)), uint8(HostBond.Status.Executed));

        vm.prank(slasher);
        vm.expectRevert(HostBond.AlreadyFinal.selector);
        hb.executeSlash(id);
    }

    function test_executeRequiresApproval() public {
        _bond(HID, op, MIN);
        uint256 id = _propose(HostBond.Reason.ShadowMismatch, 1_000e6, false);
        vm.warp(T0 + 72 hours);
        vm.prank(slasher);
        vm.expectRevert(HostBond.ApprovalRequired.selector);
        hb.executeSlash(id);
    }

    function test_disputeVoidsApprovalAndNeedsExactReapproval() public {
        _bond(HID, op, MIN);
        uint256 id = _propose(HostBond.Reason.ShadowMismatch, 1_000e6, false);
        _approve(id);

        bytes32 disputeHash = keccak256("host-evidence");
        vm.expectEmit(address(hb));
        emit SlashDisputed(id, disputeHash);
        vm.prank(op);
        hb.disputeSlash(id, disputeHash);
        assertEq(hb.slashApproval(id), 0);

        vm.warp(T0 + 72 hours);
        vm.prank(slasher);
        vm.expectRevert(HostBond.ApprovalRequired.selector);
        hb.executeSlash(id);

        vm.prank(owner);
        vm.expectRevert(HostBond.InvalidDispute.selector);
        hb.approveSlash(id, bytes32(0));
        vm.expectEmit(address(hb));
        emit SlashApproved(id, disputeHash);
        vm.prank(owner);
        hb.approveSlash(id, disputeHash);
        vm.prank(slasher);
        hb.executeSlash(id);
        assertEq(hb.bondOf(HID), MIN - 1_000e6);
    }

    function test_disputeValidation() public {
        _bond(HID, op, MIN);
        uint256 id = _propose(HostBond.Reason.Uptime, 1_000e6, false);
        vm.prank(rando);
        vm.expectRevert(HostBond.NotOperator.selector);
        hb.disputeSlash(id, keccak256("x"));
        vm.startPrank(op);
        vm.expectRevert(HostBond.InvalidDispute.selector);
        hb.disputeSlash(id, 0);
        hb.disputeSlash(id, keccak256("x"));
        vm.expectRevert(HostBond.InvalidDispute.selector);
        hb.disputeSlash(id, keccak256("y"));
        vm.expectRevert(HostBond.UnknownSlash.selector);
        hb.disputeSlash(99, keccak256("x"));
        vm.stopPrank();
    }

    function test_slashAccessControl() public {
        _bond(HID, op, MIN);
        vm.prank(owner);
        vm.expectRevert(HostBond.NotSlasher.selector);
        hb.proposeSlash(HID, HostBond.Reason.Uptime, 1, EVIDENCE, false);
        vm.prank(op);
        vm.expectRevert(HostBond.NotSlasher.selector);
        hb.proposeSlash(HID, HostBond.Reason.Uptime, 1, EVIDENCE, false);

        uint256 id = _propose(HostBond.Reason.Uptime, 1, false);
        vm.warp(T0 + 72 hours);
        _approve(id);
        vm.prank(owner);
        vm.expectRevert(HostBond.NotSlasher.selector);
        hb.executeSlash(id);
        vm.prank(slasher);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, slasher));
        hb.approveSlash(id, 0);
        vm.prank(rando);
        vm.expectRevert(HostBond.NotSlasher.selector);
        hb.cancelSlash(id);
    }

    function test_proposeValidation() public {
        _bond(HID, op, MIN);
        vm.startPrank(slasher);
        vm.expectRevert(HostBond.InvalidAmount.selector);
        hb.proposeSlash(HID, HostBond.Reason.Uptime, 0, EVIDENCE, false);
        vm.expectRevert(HostBond.InvalidAmount.selector);
        hb.proposeSlash(HID, HostBond.Reason.Uptime, MIN + 1, EVIDENCE, false);
        vm.expectRevert(HostBond.InvalidAmount.selector);
        hb.proposeSlash(HID2, HostBond.Reason.Uptime, 1, EVIDENCE, false);
        vm.expectRevert(HostBond.InvalidEvidence.selector);
        hb.proposeSlash(HID, HostBond.Reason.Uptime, 1, 0, false);
        vm.stopPrank();
    }

    function test_cancelBySlasherOrOwner() public {
        _bond(HID, op, MIN);
        uint256 a = _propose(HostBond.Reason.Uptime, 1_000e6, false);
        uint256 b = _propose(HostBond.Reason.Uptime, 1_000e6, false);
        assertEq(hb.pendingSlashes(HID), 2);
        vm.prank(slasher);
        hb.cancelSlash(a);
        vm.prank(owner);
        hb.cancelSlash(b);
        assertEq(hb.pendingSlashes(HID), 0);
        assertEq(uint8(_status(a)), uint8(HostBond.Status.Cancelled));
        vm.prank(slasher);
        vm.expectRevert(HostBond.AlreadyFinal.selector);
        hb.cancelSlash(a);
        vm.prank(owner);
        vm.expectRevert(HostBond.AlreadyFinal.selector);
        hb.approveSlash(a, 0);
    }

    function test_revokedApprovalsBlockExecution() public {
        _bond(HID, op, MIN);
        uint256 id = _propose(HostBond.Reason.Uptime, 1_000e6, false);
        _approve(id);
        vm.prank(owner);
        hb.revokeSlashApprovals();
        vm.warp(T0 + 72 hours);
        vm.prank(slasher);
        vm.expectRevert(HostBond.ApprovalRequired.selector);
        hb.executeSlash(id);

        // An ownership handover also voids approvals.
        _approve(id);
        vm.prank(owner);
        hb.transferOwnership(rando);
        vm.prank(rando);
        hb.acceptOwnership();
        vm.prank(slasher);
        vm.expectRevert(HostBond.ApprovalRequired.selector);
        hb.executeSlash(id);
    }

    function test_slashWithDelist() public {
        _bond(HID, op, 10_000e6);
        uint256 id = _propose(HostBond.Reason.MeasurementDrift, 10_000e6, true);
        vm.warp(T0 + 72 hours);
        _approve(id);
        vm.expectEmit(address(hb));
        emit Delisted(HID);
        vm.prank(slasher);
        hb.executeSlash(id);
        assertTrue(hb.isDelisted(HID));
        assertFalse(hb.isBonded(HID));
        vm.prank(op);
        vm.expectRevert(HostBond.HostDelisted.selector);
        hb.bond(HID, MIN);
    }

    function test_executePaysAtMostCurrentBond() public {
        _bond(HID, op, MIN);
        uint256 a = _propose(HostBond.Reason.Uptime, MIN, false);
        uint256 b = _propose(HostBond.Reason.EmptyResponses, MIN, false);
        vm.warp(T0 + 72 hours);
        _approve(a);
        _approve(b);
        vm.startPrank(slasher);
        hb.executeSlash(a);
        vm.expectEmit(address(hb));
        emit SlashExecuted(b, HID, 0, false);
        hb.executeSlash(b);
        vm.stopPrank();
        assertEq(usdg.balanceOf(refundPool), MIN);
        assertEq(hb.bondOf(HID), 0);
    }

    function testFuzz_slashConservesUsdg(uint256 bondAmt, uint256 slashAmt, uint8 reasonRaw) public {
        bondAmt = bound(bondAmt, MIN, 10_000_000e6);
        slashAmt = bound(slashAmt, 1, bondAmt);
        HostBond.Reason reason = HostBond.Reason(bound(reasonRaw, 0, 3));
        _bond(HID, op, bondAmt);
        uint256 id = _propose(reason, slashAmt, false);
        vm.warp(T0 + 72 hours);
        _approve(id);
        vm.prank(slasher);
        hb.executeSlash(id);
        assertEq(hb.bondOf(HID), bondAmt - slashAmt);
        assertEq(usdg.balanceOf(refundPool), slashAmt);
        assertEq(usdg.balanceOf(address(hb)), bondAmt - slashAmt);
    }

    function testFuzz_executeRespectsDisputeWindow(uint64 elapsed) public {
        elapsed = uint64(bound(elapsed, 0, 30 days));
        _bond(HID, op, MIN);
        uint256 id = _propose(HostBond.Reason.Uptime, 1_000e6, false);
        _approve(id);
        vm.warp(T0 + elapsed);
        if (elapsed < 72 hours) vm.expectRevert(HostBond.NotReady.selector);
        vm.prank(slasher);
        hb.executeSlash(id);
    }
}

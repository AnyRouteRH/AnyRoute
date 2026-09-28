// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {CreditsBase} from "./Credits.t.sol";
import {ProviderBondBase} from "./ProviderBond.t.sol";
import {Credits} from "../src/Credits.sol";
import {ProviderBond} from "../src/ProviderBond.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract CreditsControlsTest is CreditsBase {
    function test_timelockApprovesOnlyAfterDelayAndThenWorkerCanPost() public {
        address[] memory safe = new address[](1);
        safe[0] = owner;
        TimelockController timelock = new TimelockController(1 days, safe, safe, address(0));
        vm.prank(owner);
        credits.transferOwnership(address(timelock));
        vm.prank(address(timelock));
        credits.acceptOwnership();
        bytes32 root = keccak256("reviewed-root");
        uint64 asOf = uint64(block.timestamp);
        bytes memory data = abi.encodeCall(Credits.approveSpentRoot, (1, root, asOf, 0));
        vm.prank(owner);
        timelock.schedule(address(credits), 0, data, bytes32(0), bytes32(0), 1 days);
        vm.prank(owner);
        vm.expectRevert();
        timelock.execute(address(credits), 0, data, bytes32(0), bytes32(0));
        vm.prank(settlement);
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.postSpentRoot(root, asOf, 0);
        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        timelock.execute(address(credits), 0, data, bytes32(0), bytes32(0));
        vm.prank(settlement);
        credits.postSpentRoot(root, asOf, 0);
        assertEq(credits.latestEpoch(), 1);
    }

    function test_workerCannotApproveOrInventRoot() public {
        vm.prank(settlement);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, settlement));
        credits.approveSpentRoot(1, bytes32(uint256(1)), uint64(block.timestamp), 100e6);
        vm.prank(settlement);
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.postSpentRoot(bytes32(uint256(1)), uint64(block.timestamp), 100e6);
        assertEq(credits.latestEpoch(), 0);
    }

    function testFuzz_rootApprovalBindsAllFields(bytes32 root, uint64 asOf, uint128 total) public {
        asOf = uint64(bound(asOf, 1, block.timestamp - 1));
        _approveRoot(root, asOf, total);
        vm.startPrank(settlement);
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.postSpentRoot(bytes32(uint256(root) ^ 1), asOf, total);
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.postSpentRoot(root, asOf + 1, total);
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.postSpentRoot(root, asOf, uint256(total) + 1);
        credits.postSpentRoot(root, asOf, total);
        assertEq(credits.rootApproval(), bytes32(0));
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.postSpentRoot(root, asOf + 1, total);
        vm.stopPrank();
    }

    function test_sweepRequiresExactOneTimeAuthorization() public {
        _deposit(keyHash, 100e6);
        _postSingle(keyHash, 100e6, 100e6);
        vm.prank(settlement);
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.sweep(settlement, 100e6);
        _approveSweep(recipient, 10e6);
        vm.startPrank(settlement);
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.sweep(settlement, 10e6);
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.sweep(recipient, 11e6);
        credits.sweep(recipient, 10e6);
        vm.expectRevert(Credits.ApprovalRequired.selector);
        credits.sweep(recipient, 10e6);
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(Credits.StaleApproval.selector);
        credits.approveSweep(0, recipient, 10e6);
        assertEq(usdg.balanceOf(address(credits)), 90e6);
    }

    function test_revokeAndRotationInvalidateApprovals() public {
        _approveRoot(bytes32(uint256(1)), uint64(block.timestamp), 0);
        _approveSweep(recipient, 1);
        vm.prank(owner);
        credits.revokeApprovals();
        assertEq(credits.rootApproval(), bytes32(0));
        assertEq(credits.sweepApproval(), bytes32(0));
        _approveRoot(bytes32(uint256(1)), uint64(block.timestamp), 0);
        vm.prank(owner);
        credits.setSettlement(relayer);
        assertEq(credits.rootApproval(), bytes32(0));
        _approveSweep(recipient, 1);
        vm.prank(owner);
        credits.transferOwnership(alice);
        vm.prank(alice);
        credits.acceptOwnership();
        assertEq(credits.sweepApproval(), bytes32(0));
    }

    function test_rolesCannotCollapseOrLoseReviewer() public {
        vm.prank(owner);
        vm.expectRevert(Credits.IndependentOwnerRequired.selector);
        credits.setSettlement(owner);
        vm.prank(owner);
        credits.transferOwnership(settlement);
        vm.prank(settlement);
        vm.expectRevert(Credits.IndependentOwnerRequired.selector);
        credits.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(Credits.IndependentOwnerRequired.selector);
        credits.renounceOwnership();
    }
}

contract BondControlsTest is ProviderBondBase {
    function test_workerCannotApproveOrExecutePenalty() public {
        _bond(PID, op, MIN);
        uint256 id = _propose(100e6, false);
        vm.warp(T0 + 72 hours);
        vm.prank(slasher);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, slasher));
        pb.approveSlash(id, bytes32(0));
        vm.prank(slasher);
        vm.expectRevert(ProviderBond.ApprovalRequired.selector);
        pb.executeSlash(id);
        assertEq(pb.bondOf(PID), MIN);
    }

    function test_disputeInvalidatesPreapprovalAndCannotBeErased() public {
        _bond(PID, op, MIN);
        uint256 id = _propose(100e6, false);
        vm.prank(owner);
        pb.approveSlash(id, bytes32(0));
        vm.prank(op);
        pb.disputeSlash(id, EVIDENCE);
        vm.prank(op);
        vm.expectRevert(ProviderBond.InvalidDispute.selector);
        pb.disputeSlash(id, bytes32(0));
        vm.prank(op);
        vm.expectRevert(ProviderBond.InvalidDispute.selector);
        pb.disputeSlash(id, keccak256("replacement"));
        vm.warp(T0 + 72 hours);
        vm.prank(slasher);
        vm.expectRevert(ProviderBond.ApprovalRequired.selector);
        pb.executeSlash(id);
        vm.prank(owner);
        vm.expectRevert(ProviderBond.InvalidDispute.selector);
        pb.approveSlash(id, bytes32(0));
        vm.prank(owner);
        pb.approveSlash(id, EVIDENCE);
        vm.prank(slasher);
        pb.executeSlash(id);
        assertEq(pb.bondOf(PID), MIN - 100e6);
    }

    function test_ownerCanRejectAndReleaseWithdrawal() public {
        _bond(PID, op, MIN);
        uint256 id = _propose(100e6, false);
        vm.prank(op);
        pb.disputeSlash(id, EVIDENCE);
        vm.prank(owner);
        pb.cancelSlash(id);
        vm.prank(op);
        pb.requestWithdraw(PID, MIN);
        vm.warp(block.timestamp + 14 days);
        vm.prank(op);
        pb.withdraw(PID, payout);
        assertEq(usdg.balanceOf(payout), MIN);
    }

    function test_destinationRotationRevokesSlashApproval() public {
        _bond(PID, op, MIN);
        uint256 id = _propose(100e6, false);
        vm.prank(owner);
        pb.approveSlash(id, bytes32(0));
        vm.prank(owner);
        pb.setRefundPool(payout);
        vm.warp(T0 + 72 hours);
        vm.prank(slasher);
        vm.expectRevert(ProviderBond.ApprovalRequired.selector);
        pb.executeSlash(id);
        assertEq(usdg.balanceOf(payout), 0);
    }

    function test_bondRolesCannotCollapse() public {
        vm.prank(owner);
        vm.expectRevert(ProviderBond.IndependentOwnerRequired.selector);
        pb.setSlasher(owner);
        vm.prank(owner);
        pb.transferOwnership(slasher);
        vm.prank(slasher);
        vm.expectRevert(ProviderBond.IndependentOwnerRequired.selector);
        pb.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(ProviderBond.IndependentOwnerRequired.selector);
        pb.renounceOwnership();
    }
}

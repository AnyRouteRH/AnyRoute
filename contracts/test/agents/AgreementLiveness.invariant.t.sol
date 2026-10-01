// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgreementEscrow} from "../../src/agents/AgreementEscrow.sol";
import {DisputeOracle} from "../../src/agents/DisputeOracle.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";

/// @dev Exercises valid and refused calls, owner changes, hung tallies and time passage.
contract AgreementLivenessHandler is Test {
    MockUSDG public token;
    AgreementEscrow public escrow;
    DisputeOracle public oracle;
    address public constant PAYER = address(0xA11CE);
    address public constant PAYEE = address(0xB0B);
    uint256 public constant INITIAL_BALANCE = 1_000_000e6;
    bytes32 public constant ROOT = keccak256("liveness evidence");
    uint256 private keyOffset;
    uint256 public successfulCalls;

    constructor() {
        token = new MockUSDG();
        oracle = new DisputeOracle(address(this), _signers(), 2, address(0xCAFE));
        escrow = new AgreementEscrow(IERC20(address(token)), 3 days, 30 days);
        token.mint(PAYER, INITIAL_BALANCE);
        vm.prank(PAYER);
        token.approve(address(escrow), type(uint256).max);
    }

    function create(uint256 rawAmount, uint256 rawCount, uint256 rawDays) public {
        if (escrow.agreementCount() >= 8) return;
        uint256[] memory amounts = new uint256[](bound(rawCount, 1, 4));
        for (uint256 i; i < amounts.length; ++i) {
            amounts[i] = bound(rawAmount, 1, 1_000e6) + i;
        }
        vm.prank(PAYER);
        escrow.createAgreement(
            PAYEE,
            keccak256("liveness terms"),
            amounts,
            block.timestamp + bound(rawDays, 1, 60) * 1 days,
            address(oracle)
        );
    }

    function elapse(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 0, 40 days));
    }

    function rotateAuthorities(bool changeJury, bool alternate) external {
        if (changeJury) {
            keyOffset = alternate ? 3 : 0;
            oracle.setJury(_signers(), 2);
        } else {
            oracle.setPanel(alternate ? address(0xCAFF) : address(0xCAFE));
        }
    }

    function act(uint256 action, uint256 rawId, uint256 rawMilestone, uint16 rawBps, uint256 actor) public {
        uint256 count = escrow.agreementCount();
        if (count == 0) return;
        uint256 id = bound(rawId, 1, count);
        (,,,,, uint256 milestoneCount) = escrow.agreements(id);
        uint256 milestone = bound(rawMilestone, 0, milestoneCount - 1);
        uint16 bps = uint16(bound(rawBps, 0, 10_000));
        address caller = actor % 4 == 0
            ? PAYER
            : actor % 4 == 1 ? PAYEE : actor % 4 == 2 ? oracle.panel() : address(0xDEAD);
        uint256 operation = action % 10;
        if (operation == 6 || operation == 7) {
            DisputeOracle.Vote[] memory votes = new DisputeOracle.Vote[](3);
            for (uint256 i; i < 3; ++i) {
                uint16 choice = operation == 6 ? bps : i == 0 ? 0 : i == 1 ? 10_000 : 5000;
                // Expired or non-disputed contexts cannot produce a valid new tally.
                try oracle.voteDigest(address(escrow), id, milestone, ROOT, choice) returns (bytes32 digest) {
                    (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyOffset + i + 1, digest);
                    votes[i] = DisputeOracle.Vote(choice, abi.encodePacked(r, s, v));
                } catch {
                    return;
                }
            }
            _attempt(
                address(oracle),
                caller,
                abi.encodeCall(oracle.postRuling, (address(escrow), id, milestone, ROOT, votes))
            );
            return;
        }
        if (operation == 8) {
            _attempt(
                address(oracle),
                caller,
                abi.encodeCall(oracle.postPanelRuling, (address(escrow), id, milestone, ROOT, bps))
            );
            return;
        }
        bytes memory data;
        if (operation == 0) {
            data = abi.encodeCall(escrow.submitDelivery, (id, milestone, keccak256("delivery")));
        } else if (operation == 1) {
            data = abi.encodeCall(escrow.release, (id, milestone));
        } else if (operation == 2) {
            data = abi.encodeCall(escrow.claimAfterTimeout, (id, milestone));
        } else if (operation == 3) {
            data = abi.encodeCall(escrow.refundAfterDeadline, (id, milestone));
        } else if (operation == 4) {
            data = abi.encodeCall(escrow.openDispute, (id, milestone, ROOT));
        } else if (operation == 5) {
            data = abi.encodeCall(escrow.resolveStaleDispute, (id, milestone));
        } else {
            data = abi.encodeCall(escrow.rule, (id, milestone, bps));
        }
        _attempt(address(escrow), caller, data);
    }

    function _attempt(address target, address caller, bytes memory data) private {
        vm.prank(caller);
        (bool success,) = target.call(data);
        if (success) ++successfulCalls;
    }

    function _signers() private view returns (address[] memory signers) {
        signers = new address[](3);
        for (uint256 i; i < 3; ++i) {
            signers[i] = vm.addr(keyOffset + i + 1);
        }
    }
}

contract AgreementLivenessInvariant is StdInvariant, Test {
    AgreementLivenessHandler handler;
    AgreementEscrow escrow;
    MockUSDG token;

    function setUp() public {
        handler = new AgreementLivenessHandler();
        escrow = handler.escrow();
        token = handler.token();
        // Every run begins with funded, delivered, disputed and panel-pending milestones.
        handler.create(101, 4, 7);
        handler.act(0, 1, 1, 0, 1);
        handler.act(0, 1, 2, 0, 1);
        handler.act(4, 1, 2, 0, 0);
        handler.act(0, 1, 3, 0, 1);
        handler.act(4, 1, 3, 0, 0);
        handler.act(7, 1, 3, 0, 3);
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.create.selector;
        selectors[1] = handler.elapse.selector;
        selectors[2] = handler.rotateAuthorities.selector;
        selectors[3] = handler.act.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_everyFundedUnitIsPaidOrHasAReachableExit() public {
        address payer = handler.PAYER();
        address payee = handler.PAYEE();
        assertEq(
            token.balanceOf(payer) + token.balanceOf(payee) + token.balanceOf(address(escrow)),
            handler.INITIAL_BALANCE()
        );
        uint256 snapshot = vm.snapshotState();
        uint256 outstanding;
        uint256 count = escrow.agreementCount();
        // Execute a finite recovery schedule on a snapshot, then restore the randomized sequence.
        for (uint256 id = 1; id <= count; ++id) {
            (,,, uint256 deadline,, uint256 milestoneCount) = escrow.agreements(id);
            for (uint256 milestone; milestone < milestoneCount; ++milestone) {
                outstanding += _recover(id, milestone, deadline);
            }
        }
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(payer) + token.balanceOf(payee), handler.INITIAL_BALANCE());
        assertTrue(vm.revertToStateAndDelete(snapshot));
        assertEq(token.balanceOf(address(escrow)), outstanding);
    }

    function _recover(uint256 id, uint256 milestone, uint256 deadline) private returns (uint256) {
        AgreementEscrow.Milestone memory m;
        (m.amount, m.deliverableHash, m.evidenceHash, m.submittedAt, m.disputedAt, m.status) =
            escrow.milestones(id, milestone);
        if (m.status == AgreementEscrow.Status.Settled) return 0;
        address payer = handler.PAYER();
        address payee = handler.PAYEE();
        uint256 payeeBefore = token.balanceOf(payee);
        uint256 payerBefore = token.balanceOf(payer);
        uint256 expectedPayee;
        if (m.status == AgreementEscrow.Status.Funded) {
            vm.warp(block.timestamp > deadline ? block.timestamp : deadline + 1);
            vm.prank(payer);
            escrow.refundAfterDeadline(id, milestone);
        } else if (m.status == AgreementEscrow.Status.Delivered) {
            uint256 reviewUntil = m.submittedAt + escrow.reviewWindow();
            vm.warp(block.timestamp > reviewUntil ? block.timestamp : reviewUntil + 1);
            vm.prank(payee);
            escrow.claimAfterTimeout(id, milestone);
            expectedPayee = m.amount;
        } else {
            uint256 expiresAt = m.disputedAt + escrow.DISPUTE_TIMEOUT();
            vm.warp(block.timestamp >= expiresAt ? block.timestamp : expiresAt);
            vm.prank(address(0xDEAD));
            escrow.resolveStaleDispute(id, milestone);
            expectedPayee = m.amount - m.amount / 2;
        }
        assertEq(token.balanceOf(payee) - payeeBefore, expectedPayee);
        assertEq(token.balanceOf(payer) - payerBefore, m.amount - expectedPayee);
        (,,,,, AgreementEscrow.Status status) = escrow.milestones(id, milestone);
        assertEq(uint256(status), uint256(AgreementEscrow.Status.Settled));
        return m.amount;
    }
}

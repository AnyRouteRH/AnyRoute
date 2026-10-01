// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AgreementEscrow} from "../../src/agents/AgreementEscrow.sol";
import {DisputeOracle} from "../../src/agents/DisputeOracle.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {DeployAgreements} from "../../script/DeployAgreements.s.sol";

contract CallbackUSDG is ERC20 {
    AgreementEscrow public target;
    bool public attempted;
    bool public entered;
    bytes4 public rejection;
    address public blockedRecipient;
    constructor() ERC20("Callback USDG", "USDG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(AgreementEscrow escrow) external {
        target = escrow;
    }

    function blockRecipient(address recipient) external {
        blockedRecipient = recipient;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (address(target) != address(0) && from == address(target)) {
            require(to != blockedRecipient, "payout blocked");
            attempted = true;
            bytes memory result;
            (entered, result) = address(target).call(abi.encodeCall(target.claimAfterTimeout, (1, 0)));
            if (result.length >= 4) rejection = bytes4(result);
        }
    }
}

contract AgreementsTest is Test {
    MockUSDG token;
    AgreementEscrow escrow;
    DisputeOracle oracle;
    address payer = address(0xA11CE);
    address payee = address(0xB0B);
    address panel = address(0xCAFE);
    bytes32 terms = keccak256("terms");
    bytes32 delivery = keccak256("delivery");
    bytes32 evidence = keccak256("opening evidence");
    bytes32 root = keccak256("evidence root");
    uint256 deadline;

    function setUp() public {
        address[] memory signers = new address[](3);
        for (uint256 i; i < 3; ++i) {
            signers[i] = vm.addr(i + 1);
        }
        token = new MockUSDG();
        oracle = new DisputeOracle(address(this), signers, 2, panel);
        escrow = new AgreementEscrow(IERC20(address(token)), 3 days, 30 days);
        deadline = block.timestamp + 7 days;
        token.mint(payer, 1_000e6);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
    }

    function create(uint256 amount) internal returns (uint256 id) {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        vm.prank(payer);
        id = escrow.createAgreement(payee, terms, amounts, deadline, address(oracle));
    }

    function deliver(uint256 id) internal {
        vm.prank(payee);
        escrow.submitDelivery(id, 0, delivery);
    }

    function dispute(uint256 id) internal {
        deliver(id);
        vm.prank(payer);
        escrow.openDispute(id, 0, evidence);
    }

    function votesFor(uint256 id, uint16 a, uint16 b, uint16 c)
        internal
        view
        returns (DisputeOracle.Vote[] memory votes)
    {
        votes = new DisputeOracle.Vote[](3);
        uint16[3] memory bps = [a, b, c];
        for (uint256 i; i < 3; ++i) {
            bytes32 digest = oracle.voteDigest(address(escrow), id, 0, root, bps[i]);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(i + 1, digest);
            votes[i] = DisputeOracle.Vote(bps[i], abi.encodePacked(r, s, v));
        }
    }

    function assertSettled(uint256 id) internal view {
        (,,,,, AgreementEscrow.Status status) = escrow.milestones(id, 0);
        assertEq(uint256(status), uint256(AgreementEscrow.Status.Settled));
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(payer) + token.balanceOf(payee), 1_000e6);
    }

    function testHappyPathSixDecimals() public {
        assertEq(token.decimals(), 6);
        uint256 id = create(100e6);
        deliver(id);
        vm.prank(payer);
        escrow.release(id, 0);
        assertEq(token.balanceOf(payee), 100e6);
        assertSettled(id);
        vm.prank(payer);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        escrow.release(id, 0);
    }

    function testReviewBoundaryThenTimeout() public {
        uint256 id = create(100e6);
        deliver(id);
        vm.warp(block.timestamp + 3 days);
        vm.prank(payee);
        vm.expectRevert(AgreementEscrow.WrongTime.selector);
        escrow.claimAfterTimeout(id, 0);
        vm.warp(block.timestamp + 1);
        vm.prank(payer);
        vm.expectRevert(AgreementEscrow.WrongTime.selector);
        escrow.openDispute(id, 0, evidence);
        vm.prank(payee);
        escrow.claimAfterTimeout(id, 0);
        assertSettled(id);
    }

    function testDisputeAtReviewBoundaryBlocksTimeoutAndDeadline() public {
        uint256 id = create(100e6);
        deliver(id);
        vm.warp(block.timestamp + 3 days);
        vm.prank(payee);
        escrow.openDispute(id, 0, evidence);
        vm.warp(deadline + 1);
        vm.prank(payee);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        escrow.claimAfterTimeout(id, 0);
        vm.prank(payer);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        escrow.refundAfterDeadline(id, 0);
        oracle.postRuling(address(escrow), id, 0, root, votesFor(id, 10_000, 10_000, 0));
        assertSettled(id);
    }

    function testDeadlineBoundaryAndRefund() public {
        uint256 id = create(100e6);
        vm.warp(deadline);
        vm.prank(payer);
        vm.expectRevert(AgreementEscrow.WrongTime.selector);
        escrow.refundAfterDeadline(id, 0);
        vm.warp(deadline + 1);
        vm.prank(payee);
        vm.expectRevert(AgreementEscrow.WrongTime.selector);
        escrow.submitDelivery(id, 0, delivery);
        vm.prank(payer);
        escrow.refundAfterDeadline(id, 0);
        assertEq(token.balanceOf(payee), 0);
        assertSettled(id);
    }

    function testDeliveryAtDeadlineRetainsFullReviewWindow() public {
        uint256 id = create(100e6);
        vm.warp(deadline);
        deliver(id);
        vm.warp(deadline + 1);
        vm.prank(payer);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        escrow.refundAfterDeadline(id, 0);
        vm.warp(deadline + 3 days + 1);
        vm.prank(payee);
        escrow.claimAfterTimeout(id, 0);
        assertSettled(id);
    }

    function testIndependentMilestones() public {
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 100e6;
        amounts[1] = 200e6;
        amounts[2] = 300e6;
        vm.prank(payer);
        uint256 id = escrow.createAgreement(payee, terms, amounts, deadline, address(oracle));
        deliver(id);
        vm.prank(payee);
        escrow.submitDelivery(id, 1, delivery);
        vm.prank(payer);
        escrow.openDispute(id, 0, evidence);
        vm.warp(deadline + 1);
        vm.prank(payer);
        escrow.refundAfterDeadline(id, 2);
        vm.prank(payee);
        escrow.claimAfterTimeout(id, 1);
        oracle.postRuling(address(escrow), id, 0, root, votesFor(id, 5000, 5000, 0));
        assertEq(token.balanceOf(payee), 250e6);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testNonOracleAndNonPartiesRefused() public {
        uint256 id = create(100e6);
        vm.expectRevert(AgreementEscrow.Unauthorized.selector);
        escrow.submitDelivery(id, 0, delivery);
        deliver(id);
        vm.expectRevert(AgreementEscrow.Unauthorized.selector);
        escrow.release(id, 0);
        vm.expectRevert(AgreementEscrow.Unauthorized.selector);
        escrow.openDispute(id, 0, evidence);
        vm.prank(payer);
        escrow.openDispute(id, 0, evidence);
        vm.expectRevert(AgreementEscrow.Unauthorized.selector);
        escrow.rule(id, 0, 10_000);
        vm.prank(payer);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        escrow.release(id, 0);
    }

    function testFuzzJurySettlementPreservesSum(uint128 rawAmount, uint16 rawBps) public {
        uint256 amount = bound(rawAmount, 1, 1_000e6);
        uint16 bps = uint16(bound(rawBps, 0, 10_000));
        uint256 id = create(amount);
        dispute(id);
        DisputeOracle.Vote[] memory votes = votesFor(id, bps, bps, bps);
        oracle.postRuling(address(escrow), id, 0, root, votes);
        assertEq(token.balanceOf(payee), amount * bps / 10_000);
        assertSettled(id);
        vm.expectRevert(DisputeOracle.AlreadyPosted.selector);
        oracle.postRuling(address(escrow), id, 0, root, votes);
        vm.prank(panel);
        vm.expectRevert(DisputeOracle.AlreadyPosted.selector);
        oracle.postPanelRuling(address(escrow), id, 0, root, bps);
    }

    function testEachJuryRulingKind() public {
        for (uint16 i; i < 3; ++i) {
            uint16 bps = i == 0 ? 0 : i == 1 ? 10_000 : 3333;
            uint256 id = create(99);
            dispute(id);
            oracle.postRuling(address(escrow), id, 0, root, votesFor(id, bps, bps, 1234));
            (
                DisputeOracle.Path path,,,
                uint256 participants,
                uint256 consensus,
                uint16 ruled,
                DisputeOracle.Verdict verdict,
            ) = oracle.rulings(oracle.rulingKey(address(escrow), id, 0));
            assertEq(uint256(path), uint256(DisputeOracle.Path.Jury));
            assertEq(participants, 7);
            assertEq(consensus, 3);
            assertEq(ruled, bps);
            assertEq(uint256(verdict), i);
        }
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testFuzzHungPanelSettlement(uint128 rawAmount, uint16 rawBps) public {
        uint256 amount = bound(rawAmount, 1, 1_000e6);
        uint16 bps = uint16(bound(rawBps, 0, 10_000));
        uint256 id = create(amount);
        dispute(id);
        vm.prank(panel);
        vm.expectRevert(DisputeOracle.PanelNotRequired.selector);
        oracle.postPanelRuling(address(escrow), id, 0, root, bps);
        oracle.postRuling(address(escrow), id, 0, root, votesFor(id, 0, 10_000, 5000));
        vm.expectRevert(DisputeOracle.Unauthorized.selector);
        oracle.postPanelRuling(address(escrow), id, 0, root, bps);
        vm.prank(panel);
        vm.expectRevert(DisputeOracle.InvalidInput.selector);
        oracle.postPanelRuling(address(escrow), id, 0, evidence, bps);
        vm.prank(panel);
        oracle.postPanelRuling(address(escrow), id, 0, root, bps);
        assertEq(token.balanceOf(payee), amount * bps / 10_000);
        assertSettled(id);
        vm.prank(panel);
        vm.expectRevert(DisputeOracle.AlreadyPosted.selector);
        oracle.postPanelRuling(address(escrow), id, 0, root, bps);
    }

    function testRejectDuplicateIncompleteAndWrongEvidenceSignatures() public {
        uint256 id = create(100e6);
        dispute(id);
        DisputeOracle.Vote[] memory votes = votesFor(id, 0, 0, 0);
        votes[1] = votes[0];
        vm.expectRevert(DisputeOracle.InvalidTally.selector);
        oracle.postRuling(address(escrow), id, 0, root, votes);
        votes = votesFor(id, 0, 0, 0);
        vm.expectRevert(DisputeOracle.InvalidTally.selector);
        oracle.postRuling(address(escrow), id, 0, evidence, votes);
        vm.expectRevert(DisputeOracle.InvalidTally.selector);
        oracle.postRuling(address(escrow), id, 0, root, new DisputeOracle.Vote[](0));
    }

    function testDomainAndJuryVersionPreventReplay() public {
        uint256 id = create(100e6);
        dispute(id);
        DisputeOracle.Vote[] memory votes = votesFor(id, 0, 0, 0);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(DisputeOracle.InvalidTally.selector);
        oracle.postRuling(address(escrow), id, 0, root, votes);
        vm.chainId(block.chainid - 1);
        uint256 second = create(100e6);
        dispute(second);
        vm.expectRevert(DisputeOracle.InvalidTally.selector);
        oracle.postRuling(address(escrow), second, 0, root, votes);
        address[] memory signers = new address[](3);
        for (uint256 i; i < 3; ++i) {
            signers[i] = vm.addr(i + 1);
        }
        oracle.setJury(signers, 2);
        vm.expectRevert(DisputeOracle.InvalidTally.selector);
        oracle.postRuling(address(escrow), id, 0, root, votes);
    }

    function testOwnershipAndJuryBounds() public {
        address[] memory signers = new address[](3);
        for (uint256 i; i < 3; ++i) {
            signers[i] = vm.addr(i + 1);
        }
        vm.expectRevert(DisputeOracle.InvalidInput.selector);
        oracle.setJury(signers, 1);
        signers[1] = signers[0];
        vm.expectRevert(DisputeOracle.InvalidInput.selector);
        oracle.setJury(signers, 2);
        vm.expectRevert(DisputeOracle.InvalidInput.selector);
        oracle.setJury(new address[](33), 17);
        vm.expectRevert(DisputeOracle.InvalidInput.selector);
        oracle.setPanel(vm.addr(1));
        vm.prank(payer);
        vm.expectRevert();
        oracle.setPanel(payer);
        oracle.transferOwnership(payer);
        assertEq(oracle.owner(), address(this));
        vm.prank(payee);
        vm.expectRevert();
        oracle.acceptOwnership();
        vm.prank(payer);
        oracle.acceptOwnership();
        assertEq(oracle.owner(), payer);
    }

    function testDisputeExpiryStartsAtOpeningAndNeutralSplitRoundsToPayee() public {
        uint256 id = create(101);
        deliver(id);
        vm.warp(block.timestamp + 3 days);
        vm.prank(payee);
        escrow.openDispute(id, 0, evidence);
        (,,,, uint256 openedAt,) = escrow.milestones(id, 0);
        assertEq(openedAt, block.timestamp);
        vm.warp(openedAt + escrow.DISPUTE_TIMEOUT() - 1);
        vm.expectRevert(AgreementEscrow.WrongTime.selector);
        escrow.resolveStaleDispute(id, 0);
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit AgreementEscrow.StaleDisputeResolved(id, 0, 51, 50);
        // An unrelated caller can recover without either party or the oracle responding.
        vm.prank(address(0xDEAD));
        escrow.resolveStaleDispute(id, 0);
        assertEq(token.balanceOf(payee), 51);
        assertSettled(id);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        escrow.resolveStaleDispute(id, 0);
    }

    function testFuzzStaleSplitConservesEveryBaseUnit(uint128 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1_000e6);
        uint256 id = create(amount);
        dispute(id);
        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT());
        escrow.resolveStaleDispute(id, 0);
        assertEq(token.balanceOf(payee), amount - amount / 2);
        assertSettled(id);
    }

    function testJuryRulingImmediatelyBeforeExpiryWorks() public {
        uint256 id = create(101);
        dispute(id);
        DisputeOracle.Vote[] memory votes = votesFor(id, 3333, 3333, 0);
        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT() - 1);
        oracle.postRuling(address(escrow), id, 0, root, votes);
        assertEq(token.balanceOf(payee), 33);
        assertSettled(id);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        escrow.resolveStaleDispute(id, 0);
    }

    function testExpiredJuryAndDirectRulingsRefusedBeforeRecovery() public {
        uint256 id = create(101);
        dispute(id);
        DisputeOracle.Vote[] memory votes = votesFor(id, 10_000, 10_000, 0);
        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT());
        vm.prank(address(oracle));
        vm.expectRevert(AgreementEscrow.WrongTime.selector);
        escrow.rule(id, 0, 10_000);
        vm.expectRevert(AgreementEscrow.WrongTime.selector);
        oracle.postRuling(address(escrow), id, 0, root, votes);
        (DisputeOracle.Path path,,,,,,,) = oracle.rulings(oracle.rulingKey(address(escrow), id, 0));
        assertEq(uint256(path), uint256(DisputeOracle.Path.None));
        escrow.resolveStaleDispute(id, 0);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        oracle.postRuling(address(escrow), id, 0, root, votes);
        assertSettled(id);
    }

    function testHungPanelDoesNotRestartExpiryAndLateRulingRollsBack() public {
        uint256 id = create(101);
        dispute(id);
        DisputeOracle.Vote[] memory votes = votesFor(id, 0, 10_000, 5000);
        uint256 expiresAt = block.timestamp + escrow.DISPUTE_TIMEOUT();
        vm.warp(expiresAt - 1);
        oracle.postRuling(address(escrow), id, 0, root, votes);
        vm.warp(expiresAt);
        vm.prank(panel);
        vm.expectRevert(AgreementEscrow.WrongTime.selector);
        oracle.postPanelRuling(address(escrow), id, 0, root, 10_000);
        (DisputeOracle.Path path,,,,,,,) = oracle.rulings(oracle.rulingKey(address(escrow), id, 0));
        assertEq(uint256(path), uint256(DisputeOracle.Path.PanelPending));
        escrow.resolveStaleDispute(id, 0);
        assertEq(token.balanceOf(payee), 51);
        vm.prank(panel);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        oracle.postPanelRuling(address(escrow), id, 0, root, 10_000);
        assertSettled(id);
    }

    function testPanelRulingImmediatelyBeforeExpiryWorks() public {
        uint256 id = create(101);
        dispute(id);
        oracle.postRuling(address(escrow), id, 0, root, votesFor(id, 0, 10_000, 5000));
        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT() - 1);
        vm.prank(panel);
        oracle.postPanelRuling(address(escrow), id, 0, root, 10_000);
        assertEq(token.balanceOf(payee), 101);
        assertSettled(id);
    }

    function testExpiryCannotSettleOtherStatesOrMilestones() public {
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 101;
        amounts[1] = 200;
        amounts[2] = 300;
        vm.prank(payer);
        uint256 id = escrow.createAgreement(payee, terms, amounts, deadline, address(oracle));
        dispute(id);
        vm.prank(payee);
        escrow.submitDelivery(id, 1, delivery);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        escrow.resolveStaleDispute(id, 1);
        vm.expectRevert(AgreementEscrow.WrongStatus.selector);
        escrow.resolveStaleDispute(id, 2);
        vm.expectRevert(AgreementEscrow.InvalidMilestone.selector);
        escrow.resolveStaleDispute(id, 3);
        vm.expectRevert(AgreementEscrow.InvalidAgreement.selector);
        escrow.resolveStaleDispute(id + 1, 0);
        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT());
        escrow.resolveStaleDispute(id, 0);
        assertEq(token.balanceOf(address(escrow)), 500);
        vm.prank(payee);
        escrow.claimAfterTimeout(id, 1);
        vm.prank(payer);
        escrow.refundAfterDeadline(id, 2);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(payee), 251);
    }

    function testFuzzDisputeTimeoutBounds(uint256 timeout) public {
        if (timeout < 7 days || timeout > 180 days) {
            vm.expectRevert(AgreementEscrow.InvalidInput.selector);
            new AgreementEscrow(IERC20(address(token)), 3 days, timeout);
        } else {
            AgreementEscrow bounded = new AgreementEscrow(IERC20(address(token)), 3 days, timeout);
            assertEq(bounded.DISPUTE_TIMEOUT(), timeout);
        }
        assertEq(new AgreementEscrow(IERC20(address(token)), 3 days, 7 days).DISPUTE_TIMEOUT(), 7 days);
        assertEq(new AgreementEscrow(IERC20(address(token)), 3 days, 180 days).DISPUTE_TIMEOUT(), 180 days);
    }

    function testExtremeDeadlineCannotOverflowDisputeExpiry() public {
        uint256 latest = type(uint256).max - escrow.reviewWindow() - escrow.DISPUTE_TIMEOUT();
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        vm.prank(payer);
        vm.expectRevert(AgreementEscrow.InvalidInput.selector);
        escrow.createAgreement(payee, terms, amounts, latest + 1, address(oracle));
        vm.prank(payer);
        uint256 id = escrow.createAgreement(payee, terms, amounts, latest, address(oracle));
        vm.warp(latest);
        deliver(id);
        vm.warp(latest + escrow.reviewWindow());
        vm.prank(payer);
        escrow.openDispute(id, 0, evidence);
        vm.warp(type(uint256).max);
        escrow.resolveStaleDispute(id, 0);
        assertEq(token.balanceOf(payee), 1);
        assertSettled(id);
    }

    function testInvalidInputsAndIndices() public {
        vm.expectRevert(AgreementEscrow.InvalidInput.selector);
        new AgreementEscrow(IERC20(address(token)), 0, 30 days);
        uint256[] memory amounts = new uint256[](1);
        vm.prank(payer);
        vm.expectRevert(AgreementEscrow.InvalidInput.selector);
        escrow.createAgreement(payee, terms, amounts, deadline, address(oracle));
        amounts[0] = 1;
        vm.prank(payer);
        vm.expectRevert(AgreementEscrow.InvalidInput.selector);
        escrow.createAgreement(payee, terms, amounts, deadline, payer);
        uint256 id = create(100e6);
        vm.prank(payee);
        vm.expectRevert(AgreementEscrow.InvalidMilestone.selector);
        escrow.submitDelivery(id, 1, delivery);
        vm.prank(payee);
        vm.expectRevert(AgreementEscrow.InvalidInput.selector);
        escrow.submitDelivery(id, 0, bytes32(0));
        vm.expectRevert(AgreementEscrow.InvalidAgreement.selector);
        escrow.release(id + 1, 0);
    }

    function testReentrancyAttemptCannotDoubleSpend() public {
        CallbackUSDG callback = new CallbackUSDG();
        AgreementEscrow guarded = new AgreementEscrow(IERC20(address(callback)), 1 days, 30 days);
        callback.mint(payer, 100e6);
        vm.prank(payer);
        callback.approve(address(guarded), 100e6);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100e6;
        vm.prank(payer);
        guarded.createAgreement(payee, terms, amounts, deadline, address(oracle));
        vm.prank(payee);
        guarded.submitDelivery(1, 0, delivery);
        callback.arm(guarded);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(payee);
        guarded.claimAfterTimeout(1, 0);
        assertTrue(callback.attempted());
        assertFalse(callback.entered());
        assertEq(callback.rejection(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(callback.balanceOf(payee), 100e6);
        assertEq(callback.balanceOf(address(guarded)), 0);
    }

    function testStaleRecoveryRollbackAndReentrancyProtection() public {
        CallbackUSDG callback = new CallbackUSDG();
        AgreementEscrow guarded = new AgreementEscrow(IERC20(address(callback)), 1 days, 7 days);
        callback.mint(payer, 101);
        vm.prank(payer);
        callback.approve(address(guarded), 101);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 101;
        vm.prank(payer);
        guarded.createAgreement(payee, terms, amounts, deadline, address(oracle));
        vm.prank(payee);
        guarded.submitDelivery(1, 0, delivery);
        vm.prank(payer);
        guarded.openDispute(1, 0, evidence);
        vm.warp(block.timestamp + 7 days);
        callback.arm(guarded);
        // Fail the second transfer: the first payout and state change must also roll back.
        callback.blockRecipient(payer);
        vm.expectRevert("payout blocked");
        guarded.resolveStaleDispute(1, 0);
        (,,,,, AgreementEscrow.Status status) = guarded.milestones(1, 0);
        assertEq(uint256(status), uint256(AgreementEscrow.Status.Disputed));
        assertEq(callback.balanceOf(address(guarded)), 101);
        assertEq(callback.balanceOf(payee), 0);
        assertEq(callback.balanceOf(payer), 0);
        callback.blockRecipient(address(0));
        guarded.resolveStaleDispute(1, 0);
        assertTrue(callback.attempted());
        assertFalse(callback.entered());
        assertEq(callback.rejection(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(callback.balanceOf(payee), 51);
        assertEq(callback.balanceOf(payer), 50);
        assertEq(callback.balanceOf(address(guarded)), 0);
    }

    function testDeploymentIsOptInAndDoesNotBroadcast() public {
        DeployAgreements script = new DeployAgreements();
        vm.setEnv("AGENT_AGREEMENTS_ENABLED", "false");
        vm.expectRevert("AGENT_AGREEMENTS_ENABLED is false");
        script.run();
        vm.setEnv("AGENT_AGREEMENTS_ENABLED", "true");
        vm.setEnv("OWNER", vm.toString(address(this)));
        vm.setEnv("PANEL", vm.toString(panel));
        vm.setEnv("USDG", vm.toString(address(token)));
        vm.setEnv(
            "JURY_SIGNERS",
            string.concat(vm.toString(vm.addr(1)), ",", vm.toString(vm.addr(2)), ",", vm.toString(vm.addr(3)))
        );
        vm.setEnv("AGREEMENTS_BROADCAST", "false");
        vm.setEnv("DISPUTE_TIMEOUT_DAYS", "30");
        (AgreementEscrow deployed, DisputeOracle jury) = script.run();
        assertEq(address(deployed.usdg()), address(token));
        assertEq(jury.owner(), address(this));
        assertEq(jury.panel(), panel);
        assertEq(jury.threshold(), 2);
        assertEq(deployed.DISPUTE_TIMEOUT(), 30 days);
        vm.setEnv("DISPUTE_TIMEOUT_DAYS", "7");
        (deployed,) = script.run();
        assertEq(deployed.DISPUTE_TIMEOUT(), 7 days);
        vm.setEnv("DISPUTE_TIMEOUT_DAYS", "180");
        (deployed,) = script.run();
        assertEq(deployed.DISPUTE_TIMEOUT(), 180 days);
        vm.setEnv("DISPUTE_TIMEOUT_DAYS", "6");
        vm.expectRevert("DISPUTE_TIMEOUT_DAYS must be 7..180");
        script.run();
        vm.setEnv("DISPUTE_TIMEOUT_DAYS", "181");
        vm.expectRevert("DISPUTE_TIMEOUT_DAYS must be 7..180");
        script.run();
        vm.setEnv("DISPUTE_TIMEOUT_DAYS", "30");
        vm.setEnv("AGENT_AGREEMENTS_ENABLED", "false");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {KmsGovernance} from "../../src/seal/KmsGovernance.sol";

contract KmsGovernanceTest is Test {
    uint64 internal constant T0 = 1_750_000_000;

    KmsGovernance internal gov;
    address internal safe = makeAddr("safe");
    address internal rando = makeAddr("rando");

    bytes32 internal constant OS = keccak256("os-image");
    bytes32 internal constant COMPOSE = keccak256("compose");
    bytes32 internal constant MR = keccak256("kms-mr");
    bytes32 internal constant TRANSCRIPT = keccak256("dkg-transcript");

    event OsImageSet(bytes32 indexed osImageHash, bool allowed);
    event ComposeHashSet(bytes32 indexed composeHash, bool allowed);
    event KmsMrSet(bytes32 indexed mr, bool allowed);
    event KmsRootSet(uint32 indexed rootVersion, bytes k256Pubkey, bytes32 transcriptHash);
    event EpochBumped(uint64 indexed epoch, string reason);

    function setUp() public {
        vm.warp(T0);
        gov = new KmsGovernance(safe);
    }

    function _pubkey(bytes1 prefix) internal pure returns (bytes memory k) {
        k = abi.encodePacked(prefix, keccak256("x-coordinate"));
    }

    function test_genesis() public {
        assertEq(gov.owner(), safe);
        assertEq(gov.epoch(), 1);
        assertEq(gov.epochStartedAt(), T0);
        assertEq(gov.rootVersion(), 0);
        assertEq(gov.k256Pubkey().length, 0);
        vm.expectEmit();
        emit EpochBumped(1, "genesis");
        new KmsGovernance(safe);
    }

    function test_ownershipIsTwoStep() public {
        vm.prank(safe);
        gov.transferOwnership(rando);
        assertEq(gov.owner(), safe);
        assertEq(gov.pendingOwner(), rando);
        vm.prank(rando);
        gov.acceptOwnership();
        assertEq(gov.owner(), rando);
    }

    function test_everyMutatorIsOwnerOnly() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando);
        vm.startPrank(rando);
        vm.expectRevert(unauthorized);
        gov.addOsImage(OS);
        vm.expectRevert(unauthorized);
        gov.removeOsImage(OS);
        vm.expectRevert(unauthorized);
        gov.addComposeHash(COMPOSE);
        vm.expectRevert(unauthorized);
        gov.removeComposeHash(COMPOSE);
        vm.expectRevert(unauthorized);
        gov.addKmsMr(MR);
        vm.expectRevert(unauthorized);
        gov.removeKmsMr(MR);
        vm.expectRevert(unauthorized);
        gov.setKmsRoot(_pubkey(0x02), TRANSCRIPT);
        vm.expectRevert(unauthorized);
        gov.bumpEpoch("monthly");
        vm.stopPrank();
    }

    function test_allowlistsAddRemoveAndEmit() public {
        vm.startPrank(safe);
        vm.expectEmit(address(gov));
        emit OsImageSet(OS, true);
        gov.addOsImage(OS);
        vm.expectEmit(address(gov));
        emit ComposeHashSet(COMPOSE, true);
        gov.addComposeHash(COMPOSE);
        vm.expectEmit(address(gov));
        emit KmsMrSet(MR, true);
        gov.addKmsMr(MR);
        vm.stopPrank();

        assertTrue(gov.isOsImageAllowed(OS));
        assertTrue(gov.isComposeHashAllowed(COMPOSE));
        assertTrue(gov.isKmsAllowed(MR));
        assertTrue(gov.isAppAllowed(OS, COMPOSE));
        assertFalse(gov.isAppAllowed(OS, keccak256("other")));
        assertFalse(gov.isAppAllowed(keccak256("other"), COMPOSE));
        assertEq(gov.allowedOsImages().length, 1);
        assertEq(gov.allowedOsImages()[0], OS);
        assertEq(gov.allowedComposeHashes()[0], COMPOSE);
        assertEq(gov.kmsAllowedMrs()[0], MR);

        vm.startPrank(safe);
        vm.expectEmit(address(gov));
        emit OsImageSet(OS, false);
        gov.removeOsImage(OS);
        vm.expectEmit(address(gov));
        emit ComposeHashSet(COMPOSE, false);
        gov.removeComposeHash(COMPOSE);
        vm.expectEmit(address(gov));
        emit KmsMrSet(MR, false);
        gov.removeKmsMr(MR);
        vm.stopPrank();

        assertFalse(gov.isAppAllowed(OS, COMPOSE));
        assertFalse(gov.isKmsAllowed(MR));
        assertEq(gov.allowedOsImages().length, 0);
        assertEq(gov.allowedComposeHashes().length, 0);
        assertEq(gov.kmsAllowedMrs().length, 0);
    }

    function test_allowlistRejectsZeroDuplicateAndMissing() public {
        vm.startPrank(safe);
        vm.expectRevert(KmsGovernance.ZeroValue.selector);
        gov.addOsImage(0);
        vm.expectRevert(KmsGovernance.ZeroValue.selector);
        gov.addComposeHash(0);
        vm.expectRevert(KmsGovernance.ZeroValue.selector);
        gov.addKmsMr(0);
        gov.addOsImage(OS);
        vm.expectRevert(KmsGovernance.AlreadyAllowed.selector);
        gov.addOsImage(OS);
        vm.expectRevert(KmsGovernance.NotAllowed.selector);
        gov.removeComposeHash(COMPOSE);
        vm.expectRevert(KmsGovernance.NotAllowed.selector);
        gov.removeKmsMr(MR);
        vm.stopPrank();
    }

    function test_setKmsRoot() public {
        bytes memory k = _pubkey(0x02);
        vm.expectEmit(address(gov));
        emit KmsRootSet(1, k, TRANSCRIPT);
        vm.prank(safe);
        gov.setKmsRoot(k, TRANSCRIPT);
        (bytes memory key, uint32 v, uint64 e) = gov.kmsInfo();
        assertEq(key, k);
        assertEq(v, 1);
        assertEq(e, 1);
        assertEq(gov.rootTranscriptHash(), TRANSCRIPT);

        bytes memory k2 = _pubkey(0x03);
        vm.prank(safe);
        gov.setKmsRoot(k2, keccak256("t2"));
        assertEq(gov.k256Pubkey(), k2);
        assertEq(gov.rootVersion(), 2);
    }

    function test_setKmsRootRejectsMalformed() public {
        vm.startPrank(safe);
        vm.expectRevert(KmsGovernance.InvalidPubkey.selector);
        gov.setKmsRoot(_pubkey(0x04), TRANSCRIPT);
        vm.expectRevert(KmsGovernance.InvalidPubkey.selector);
        gov.setKmsRoot(abi.encodePacked(bytes1(0x02), bytes31(0)), TRANSCRIPT);
        vm.expectRevert(KmsGovernance.InvalidPubkey.selector);
        gov.setKmsRoot("", TRANSCRIPT);
        vm.expectRevert(KmsGovernance.ZeroValue.selector);
        gov.setKmsRoot(_pubkey(0x02), 0);
        vm.stopPrank();
    }

    function test_bumpEpoch() public {
        vm.warp(T0 + 30 days);
        vm.expectEmit(address(gov));
        emit EpochBumped(2, "monthly");
        vm.prank(safe);
        assertEq(gov.bumpEpoch("monthly"), 2);
        assertEq(gov.epoch(), 2);
        assertEq(gov.epochStartedAt(), T0 + 30 days);

        vm.prank(safe);
        vm.expectRevert(KmsGovernance.EmptyReason.selector);
        gov.bumpEpoch("");
    }

    function testFuzz_epochIsMonotonic(uint8 bumps) public {
        vm.startPrank(safe);
        for (uint256 i; i < bumps; ++i) {
            assertEq(gov.bumpEpoch("advisory"), i + 2);
        }
        vm.stopPrank();
        assertEq(gov.epoch(), uint64(bumps) + 1);
    }

    function testFuzz_appAllowedIffBothSets(bytes32 os, bytes32 compose, bool addOs, bool addCompose) public {
        vm.assume(os != 0 && compose != 0);
        vm.startPrank(safe);
        if (addOs) gov.addOsImage(os);
        if (addCompose) gov.addComposeHash(compose);
        vm.stopPrank();
        assertEq(gov.isAppAllowed(os, compose), addOs && addCompose);
    }
}

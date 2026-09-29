// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SealMeasurementRegistry} from "../../src/seal/SealMeasurementRegistry.sol";

contract SealMeasurementRegistryTest is Test {
    uint64 internal constant T0 = 1_750_000_000;

    SealMeasurementRegistry internal reg;
    address internal owner = makeAddr("owner");
    address internal publisher = makeAddr("publisher");
    address internal guardian = makeAddr("guardian");
    address internal rando = makeAddr("rando");

    bytes32 internal constant IMAGE = keccak256("seal-sidecar@sha256:1");
    bytes32 internal constant COMPOSE = keccak256("compose-1");
    bytes internal constant SIG = hex"3045022100aa";

    event ManifestPublished(
        bytes32 indexed imageDigest,
        bytes32 composeHash,
        uint32 policyVersion,
        bytes32 osImageHash,
        uint64 validFrom,
        uint64 validUntil,
        bytes32 rekorEntry,
        bytes32 dsseSigHash
    );
    event ManifestRevoked(bytes32 indexed imageDigest, string advisory);
    event PublisherSet(address indexed publisher);
    event GuardianSet(address indexed guardian);

    function setUp() public {
        vm.warp(T0);
        reg = new SealMeasurementRegistry(owner, publisher, guardian);
    }

    function _manifest(bytes32 image) internal pure returns (SealMeasurementRegistry.Manifest memory m) {
        m.imageDigest = image;
        m.osImageHash = keccak256("os");
        m.mrtd = keccak256("mrtd");
        m.rtmr = [keccak256("rtmr0"), keccak256("rtmr1"), keccak256("rtmr2")];
        m.composeHash = COMPOSE;
        m.rekorEntry = keccak256("rekor");
        m.policyVersion = 3;
        m.validFrom = T0;
        m.validUntil = T0 + 30 days;
    }

    function _publish(SealMeasurementRegistry.Manifest memory m) internal {
        vm.prank(publisher);
        reg.publish(m, SIG);
    }

    // --- constructor / roles -----------------------------------------------------------------------

    function test_constructorSetsRoles() public view {
        assertEq(reg.owner(), owner);
        assertEq(reg.publisher(), publisher);
        assertEq(reg.guardian(), guardian);
        assertEq(reg.manifestCount(), 0);
    }

    function test_constructorRejectsZeroRoles() public {
        vm.expectRevert(SealMeasurementRegistry.ZeroAddress.selector);
        new SealMeasurementRegistry(owner, address(0), guardian);
        vm.expectRevert(SealMeasurementRegistry.ZeroAddress.selector);
        new SealMeasurementRegistry(owner, publisher, address(0));
    }

    function test_setRolesOnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        reg.setPublisher(rando);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        reg.setGuardian(rando);

        vm.startPrank(owner);
        vm.expectEmit(address(reg));
        emit PublisherSet(rando);
        reg.setPublisher(rando);
        vm.expectEmit(address(reg));
        emit GuardianSet(rando);
        reg.setGuardian(rando);
        vm.expectRevert(SealMeasurementRegistry.ZeroAddress.selector);
        reg.setPublisher(address(0));
        vm.expectRevert(SealMeasurementRegistry.ZeroAddress.selector);
        reg.setGuardian(address(0));
        vm.stopPrank();
        assertEq(reg.publisher(), rando);
        assertEq(reg.guardian(), rando);
    }

    function test_ownershipIsTwoStep() public {
        vm.prank(owner);
        reg.transferOwnership(rando);
        assertEq(reg.owner(), owner);
        vm.prank(rando);
        reg.acceptOwnership();
        assertEq(reg.owner(), rando);
    }

    // --- publish -----------------------------------------------------------------------------------

    function test_publishStoresManifestAndEmits() public {
        SealMeasurementRegistry.Manifest memory m = _manifest(IMAGE);
        vm.expectEmit(address(reg));
        emit ManifestPublished(
            IMAGE, COMPOSE, 3, m.osImageHash, m.validFrom, m.validUntil, m.rekorEntry, keccak256(SIG)
        );
        _publish(m);

        SealMeasurementRegistry.Record memory r = reg.recordOf(IMAGE);
        assertEq(r.dsseSigHash, keccak256(SIG));
        assertEq(r.publishedAt, T0);
        assertEq(r.revokedAt, 0);
        assertEq(abi.encode(r.manifest), abi.encode(m));
        assertEq(abi.encode(reg.manifestOf(IMAGE)), abi.encode(m));
        assertEq(reg.manifestCount(), 1);
        assertFalse(reg.isRevoked(IMAGE));
    }

    function test_publishOnlyPublisher() public {
        SealMeasurementRegistry.Manifest memory m = _manifest(IMAGE);
        address[3] memory callers = [rando, guardian, owner];
        for (uint256 i; i < 3; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(SealMeasurementRegistry.NotPublisher.selector);
            reg.publish(m, SIG);
        }
    }

    function test_publishRejectsZeroFields() public {
        for (uint256 i; i < 9; ++i) {
            SealMeasurementRegistry.Manifest memory m = _manifest(IMAGE);
            if (i == 0) m.imageDigest = 0;
            if (i == 1) m.osImageHash = 0;
            if (i == 2) m.mrtd = 0;
            if (i == 3) m.rtmr[0] = 0;
            if (i == 4) m.rtmr[1] = 0;
            if (i == 5) m.rtmr[2] = 0;
            if (i == 6) m.composeHash = 0;
            if (i == 7) m.rekorEntry = 0;
            if (i == 8) m.policyVersion = 0;
            vm.prank(publisher);
            vm.expectRevert(SealMeasurementRegistry.InvalidManifest.selector);
            reg.publish(m, SIG);
        }
    }

    function test_publishRejectsEmptyWindowAndSignature() public {
        SealMeasurementRegistry.Manifest memory m = _manifest(IMAGE);
        m.validUntil = m.validFrom;
        vm.prank(publisher);
        vm.expectRevert(SealMeasurementRegistry.InvalidWindow.selector);
        reg.publish(m, SIG);

        m = _manifest(IMAGE);
        vm.prank(publisher);
        vm.expectRevert(SealMeasurementRegistry.EmptySignature.selector);
        reg.publish(m, "");
    }

    function test_publishIsWriteOnce() public {
        _publish(_manifest(IMAGE));
        SealMeasurementRegistry.Manifest memory m2 = _manifest(IMAGE);
        m2.composeHash = keccak256("other");
        vm.prank(publisher);
        vm.expectRevert(SealMeasurementRegistry.AlreadyPublished.selector);
        reg.publish(m2, SIG);
    }

    // --- validity window ---------------------------------------------------------------------------

    function test_isValidWindowIsHalfOpen() public {
        SealMeasurementRegistry.Manifest memory m = _manifest(IMAGE);
        m.validFrom = T0 + 1 days;
        _publish(m);
        assertFalse(reg.isValid(IMAGE, COMPOSE, m.validFrom - 1));
        assertTrue(reg.isValid(IMAGE, COMPOSE, m.validFrom));
        assertTrue(reg.isValid(IMAGE, COMPOSE, m.validUntil - 1));
        assertFalse(reg.isValid(IMAGE, COMPOSE, m.validUntil));
    }

    function test_isValidRequiresMatchingCompose() public {
        _publish(_manifest(IMAGE));
        assertTrue(reg.isValid(IMAGE, COMPOSE, T0));
        assertFalse(reg.isValid(IMAGE, keccak256("other"), T0));
        assertFalse(reg.isValid(keccak256("unknown"), COMPOSE, T0));
    }

    function testFuzz_isValidMatchesWindow(uint64 from, uint64 len, uint64 at) public {
        len = uint64(bound(len, 1, type(uint64).max - 1));
        from = uint64(bound(from, 0, type(uint64).max - len));
        SealMeasurementRegistry.Manifest memory m = _manifest(IMAGE);
        m.validFrom = from;
        m.validUntil = from + len;
        _publish(m);
        assertEq(reg.isValid(IMAGE, COMPOSE, at), at >= from && at < from + len);
    }

    // --- revocation --------------------------------------------------------------------------------

    function test_revokeByPublisherOrGuardian() public {
        _publish(_manifest(IMAGE));
        bytes32 image2 = keccak256("image-2");
        _publish(_manifest(image2));

        vm.warp(T0 + 1 hours);
        vm.expectEmit(address(reg));
        emit ManifestRevoked(IMAGE, "INTEL-SA-00001");
        vm.prank(publisher);
        reg.revoke(IMAGE, "INTEL-SA-00001");

        vm.prank(guardian);
        reg.revoke(image2, "incident");

        assertTrue(reg.isRevoked(IMAGE));
        assertTrue(reg.isRevoked(image2));
        assertEq(reg.recordOf(IMAGE).revokedAt, T0 + 1 hours);
    }

    function test_revokeAccessControl() public {
        _publish(_manifest(IMAGE));
        address[2] memory callers = [rando, owner];
        for (uint256 i; i < 2; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(SealMeasurementRegistry.NotPublisherOrGuardian.selector);
            reg.revoke(IMAGE, "x");
        }
    }

    function test_revokeRejectsUnknownEmptyAndRepeat() public {
        vm.prank(guardian);
        vm.expectRevert(SealMeasurementRegistry.UnknownManifest.selector);
        reg.revoke(IMAGE, "x");

        _publish(_manifest(IMAGE));
        vm.prank(guardian);
        vm.expectRevert(SealMeasurementRegistry.EmptyAdvisory.selector);
        reg.revoke(IMAGE, "");

        vm.prank(guardian);
        reg.revoke(IMAGE, "x");
        vm.prank(publisher);
        vm.expectRevert(SealMeasurementRegistry.AlreadyRevoked.selector);
        reg.revoke(IMAGE, "again");
    }

    function test_revocationIsPermanent() public {
        _publish(_manifest(IMAGE));
        assertTrue(reg.isValid(IMAGE, COMPOSE, T0));
        vm.prank(guardian);
        reg.revoke(IMAGE, "INTEL-SA-00001");

        // Invalid at every time, including before the revocation.
        assertFalse(reg.isValid(IMAGE, COMPOSE, T0));
        assertFalse(reg.isValid(IMAGE, COMPOSE, T0 + 1 days));

        // Cannot be republished, not even by a new publisher.
        vm.prank(owner);
        reg.setPublisher(rando);
        vm.prank(rando);
        vm.expectRevert(SealMeasurementRegistry.AlreadyPublished.selector);
        reg.publish(_manifest(IMAGE), SIG);

        // Ownership handover does not undo it either.
        vm.prank(owner);
        reg.transferOwnership(rando);
        vm.prank(rando);
        reg.acceptOwnership();
        vm.warp(T0 + 365 days);
        assertTrue(reg.isRevoked(IMAGE));
        assertFalse(reg.isValid(IMAGE, COMPOSE, T0 + 1));
    }

    function testFuzz_revokedNeverValid(uint64 at, bytes32 compose) public {
        _publish(_manifest(IMAGE));
        vm.prank(publisher);
        reg.revoke(IMAGE, "advisory");
        assertFalse(reg.isValid(IMAGE, compose, at));
    }
}

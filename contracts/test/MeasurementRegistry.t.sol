// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MeasurementRegistry} from "../src/MeasurementRegistry.sol";
import {IMeasurementRegistry} from "../src/interfaces/IMeasurementRegistry.sol";

contract MeasurementRegistryTest is Test {
    MeasurementRegistry internal reg;
    address internal owner = makeAddr("owner");
    address internal attestor = makeAddr("attestor");
    address internal rando = makeAddr("rando");

    uint64 internal constant T0 = 1_750_000_000;
    bytes32 internal constant PID = keccak256("provider-a");
    bytes32 internal constant PID2 = keccak256("provider-b");
    bytes32 internal constant IMG = keccak256("image-1");
    bytes32 internal constant IMG2 = keccak256("image-2");
    bytes32 internal constant COMPOSE = keccak256("compose-1");
    bytes32 internal constant MODEL = keccak256("model-1");
    bytes32 internal constant MODEL2 = keccak256("model-2");
    bytes32 internal constant REKOR = keccak256("rekor-entry-1");
    bytes internal constant PROOF = hex"0102030405";

    function setUp() public {
        vm.warp(T0);
        reg = new MeasurementRegistry(owner, attestor);
    }

    function _m(bytes32 img, bytes32 model) internal pure returns (IMeasurementRegistry.Measurement memory) {
        return IMeasurementRegistry.Measurement({
            imageDigest: img,
            composeHash: COMPOSE,
            modelDigest: model,
            rekorEntry: REKOR,
            attestedAt: 0,
            revoked: false
        });
    }

    function _register(bytes32 pid, bytes32 img, bytes32 model) internal {
        vm.prank(attestor);
        reg.register(pid, _m(img, model), PROOF);
    }

    // --- roles ---------------------------------------------------------------------------------

    function test_constructor() public view {
        assertEq(reg.owner(), owner);
        assertEq(reg.attestor(), attestor);
    }

    function test_constructor_emitsAttestorSet() public {
        vm.expectEmit(true, true, true, true);
        emit IMeasurementRegistry.AttestorSet(attestor);
        new MeasurementRegistry(owner, attestor);
    }

    function test_constructor_revertsZeroAttestor() public {
        vm.expectRevert(IMeasurementRegistry.ZeroAddress.selector);
        new MeasurementRegistry(owner, address(0));
    }

    function test_constructor_revertsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MeasurementRegistry(address(0), attestor);
    }

    function test_setAttestor_onlyOwner() public {
        address a2 = makeAddr("a2");
        vm.expectEmit(true, true, true, true, address(reg));
        emit IMeasurementRegistry.AttestorSet(a2);
        vm.prank(owner);
        reg.setAttestor(a2);
        assertEq(reg.attestor(), a2);

        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attestor));
        reg.setAttestor(attestor);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        reg.setAttestor(rando);
    }

    function test_setAttestor_revertsZero() public {
        vm.prank(owner);
        vm.expectRevert(IMeasurementRegistry.ZeroAddress.selector);
        reg.setAttestor(address(0));
    }

    function test_setAttestor_rotationMovesRegisterAuthority() public {
        address a2 = makeAddr("a2");
        vm.prank(owner);
        reg.setAttestor(a2);

        vm.prank(attestor);
        vm.expectRevert(IMeasurementRegistry.NotAttestor.selector);
        reg.register(PID, _m(IMG, MODEL), PROOF);

        vm.prank(a2);
        reg.register(PID, _m(IMG, MODEL), PROOF);
        assertTrue(reg.isAttested(PID, IMG, MODEL));
    }

    function test_ownership_isTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        reg.transferOwnership(newOwner);
        assertEq(reg.owner(), owner);
        assertEq(reg.pendingOwner(), newOwner);
        vm.prank(newOwner);
        reg.acceptOwnership();
        assertEq(reg.owner(), newOwner);
    }

    // --- register ------------------------------------------------------------------------------

    function test_register_storesRecordAndEmits() public {
        bytes32 proofHash = keccak256(PROOF);
        vm.expectEmit(true, true, true, true, address(reg));
        emit IMeasurementRegistry.Attested(PID, IMG, MODEL, COMPOSE, REKOR, proofHash);
        _register(PID, IMG, MODEL);

        (bytes32 img, bytes32 compose, bytes32 model, bytes32 rekor, uint64 attestedAt, bool revoked) =
            reg.measurements(PID, IMG);
        assertEq(img, IMG);
        assertEq(compose, COMPOSE);
        assertEq(model, MODEL);
        assertEq(rekor, REKOR);
        assertEq(attestedAt, T0);
        assertFalse(revoked);
        assertEq(reg.quoteProofHashes(PID, IMG), proofHash);
    }

    function test_register_ignoresCallerSuppliedTimestampAndRevokedFlag() public {
        IMeasurementRegistry.Measurement memory m = _m(IMG, MODEL);
        m.attestedAt = 1;
        m.revoked = true;
        vm.prank(attestor);
        reg.register(PID, m, PROOF);
        (,,,, uint64 attestedAt, bool revoked) = reg.measurements(PID, IMG);
        assertEq(attestedAt, T0);
        assertFalse(revoked);
        assertTrue(reg.isAttested(PID, IMG, MODEL));
    }

    function test_register_onlyAttestor() public {
        vm.prank(rando);
        vm.expectRevert(IMeasurementRegistry.NotAttestor.selector);
        reg.register(PID, _m(IMG, MODEL), PROOF);
        // the owner administers the role but cannot write records itself
        vm.prank(owner);
        vm.expectRevert(IMeasurementRegistry.NotAttestor.selector);
        reg.register(PID, _m(IMG, MODEL), PROOF);
        assertFalse(reg.isAttested(PID, IMG, MODEL));
    }

    function test_register_revertsInvalidInputs() public {
        vm.startPrank(attestor);
        vm.expectRevert(IMeasurementRegistry.InvalidProvider.selector);
        reg.register(bytes32(0), _m(IMG, MODEL), PROOF);

        IMeasurementRegistry.Measurement memory m = _m(bytes32(0), MODEL);
        vm.expectRevert(IMeasurementRegistry.InvalidMeasurement.selector);
        reg.register(PID, m, PROOF);

        m = _m(IMG, bytes32(0));
        vm.expectRevert(IMeasurementRegistry.InvalidMeasurement.selector);
        reg.register(PID, m, PROOF);

        m = _m(IMG, MODEL);
        m.composeHash = bytes32(0);
        vm.expectRevert(IMeasurementRegistry.InvalidMeasurement.selector);
        reg.register(PID, m, PROOF);

        m = _m(IMG, MODEL);
        m.rekorEntry = bytes32(0);
        vm.expectRevert(IMeasurementRegistry.InvalidMeasurement.selector);
        reg.register(PID, m, PROOF);

        vm.expectRevert(IMeasurementRegistry.EmptyQuoteProof.selector);
        reg.register(PID, _m(IMG, MODEL), "");
        vm.stopPrank();
    }

    function test_register_neverOverwrites() public {
        _register(PID, IMG, MODEL);
        vm.warp(T0 + 1 days);
        vm.prank(attestor);
        vm.expectRevert(IMeasurementRegistry.AlreadyRegistered.selector);
        reg.register(PID, _m(IMG, MODEL2), hex"aabb");
        (,,,, uint64 attestedAt,) = reg.measurements(PID, IMG);
        assertEq(attestedAt, T0);
        assertFalse(reg.isAttested(PID, IMG, MODEL2));
        assertEq(reg.quoteProofHashes(PID, IMG), keccak256(PROOF));
    }

    function test_register_revokedRecordCannotBeReRegistered() public {
        _register(PID, IMG, MODEL);
        vm.prank(attestor);
        reg.revoke(PID, IMG);
        vm.prank(attestor);
        vm.expectRevert(IMeasurementRegistry.AlreadyRegistered.selector);
        reg.register(PID, _m(IMG, MODEL), PROOF);
        assertFalse(reg.isAttested(PID, IMG, MODEL));
    }

    function test_register_isPerProviderAndPerImage() public {
        _register(PID, IMG, MODEL);
        _register(PID2, IMG, MODEL2); // same image digest under another provider
        _register(PID, IMG2, MODEL2); // another image under the same provider
        assertTrue(reg.isAttested(PID, IMG, MODEL));
        assertTrue(reg.isAttested(PID2, IMG, MODEL2));
        assertTrue(reg.isAttested(PID, IMG2, MODEL2));
        assertFalse(reg.isAttested(PID2, IMG, MODEL));
    }

    // --- isAttested ----------------------------------------------------------------------------

    function test_isAttested_falseWhenNothingRegistered() public view {
        assertFalse(reg.isAttested(PID, IMG, MODEL));
        assertFalse(reg.isAttested(bytes32(0), bytes32(0), bytes32(0)));
        (bytes32 img,,,, uint64 attestedAt,) = reg.measurements(PID, IMG);
        assertEq(img, bytes32(0));
        assertEq(attestedAt, 0);
        assertEq(reg.quoteProofHashes(PID, IMG), bytes32(0));
    }

    function test_isAttested_requiresExactImageAndModel() public {
        _register(PID, IMG, MODEL);
        assertTrue(reg.isAttested(PID, IMG, MODEL));
        assertFalse(reg.isAttested(PID, IMG, MODEL2)); // served model differs
        assertFalse(reg.isAttested(PID, IMG2, MODEL)); // running image differs
        assertFalse(reg.isAttested(PID2, IMG, MODEL)); // other provider
    }

    // --- revoke --------------------------------------------------------------------------------

    function test_revoke_byAttestor() public {
        _register(PID, IMG, MODEL);
        vm.expectEmit(true, true, true, true, address(reg));
        emit IMeasurementRegistry.Revoked(PID, IMG, attestor);
        vm.prank(attestor);
        reg.revoke(PID, IMG);
        assertFalse(reg.isAttested(PID, IMG, MODEL));
        (,,,,, bool revoked) = reg.measurements(PID, IMG);
        assertTrue(revoked);
        // the record and its proof hash stay as an audit trail
        assertEq(reg.quoteProofHashes(PID, IMG), keccak256(PROOF));
    }

    function test_revoke_byOwner() public {
        _register(PID, IMG, MODEL);
        vm.expectEmit(true, true, true, true, address(reg));
        emit IMeasurementRegistry.Revoked(PID, IMG, owner);
        vm.prank(owner);
        reg.revoke(PID, IMG);
        assertFalse(reg.isAttested(PID, IMG, MODEL));
    }

    function test_revoke_ownerCanContainReplacedAttestor() public {
        _register(PID, IMG, MODEL);
        address a2 = makeAddr("a2");
        vm.prank(owner);
        reg.setAttestor(a2);
        // the old attestor can no longer revoke, but the owner still can
        vm.prank(attestor);
        vm.expectRevert(IMeasurementRegistry.NotAttestor.selector);
        reg.revoke(PID, IMG);
        vm.prank(owner);
        reg.revoke(PID, IMG);
        assertFalse(reg.isAttested(PID, IMG, MODEL));
    }

    function test_revoke_revertsUnauthorized() public {
        _register(PID, IMG, MODEL);
        vm.prank(rando);
        vm.expectRevert(IMeasurementRegistry.NotAttestor.selector);
        reg.revoke(PID, IMG);
        assertTrue(reg.isAttested(PID, IMG, MODEL));
    }

    function test_revoke_revertsUnknown() public {
        vm.prank(attestor);
        vm.expectRevert(IMeasurementRegistry.UnknownMeasurement.selector);
        reg.revoke(PID, IMG);
        _register(PID, IMG, MODEL);
        vm.prank(attestor);
        vm.expectRevert(IMeasurementRegistry.UnknownMeasurement.selector);
        reg.revoke(PID2, IMG); // a different provider's record is not touched
        vm.prank(attestor);
        vm.expectRevert(IMeasurementRegistry.UnknownMeasurement.selector);
        reg.revoke(PID, IMG2);
    }

    function test_revoke_revertsAlreadyRevoked() public {
        _register(PID, IMG, MODEL);
        vm.startPrank(attestor);
        reg.revoke(PID, IMG);
        vm.expectRevert(IMeasurementRegistry.AlreadyRevoked.selector);
        reg.revoke(PID, IMG);
        vm.stopPrank();
    }

    function test_revoke_onlyAffectsThatProviderAndImage() public {
        _register(PID, IMG, MODEL);
        _register(PID2, IMG, MODEL);
        _register(PID, IMG2, MODEL);
        vm.prank(attestor);
        reg.revoke(PID, IMG);
        assertFalse(reg.isAttested(PID, IMG, MODEL));
        assertTrue(reg.isAttested(PID2, IMG, MODEL));
        assertTrue(reg.isAttested(PID, IMG2, MODEL));
    }

    // --- fuzz ----------------------------------------------------------------------------------

    function testFuzz_register_thenIsAttestedOnlyForExactDigests(
        bytes32 pid,
        bytes32 img,
        bytes32 compose,
        bytes32 model,
        bytes32 rekor,
        bytes calldata proof,
        bytes32 otherModel
    ) public {
        vm.assume(pid != 0 && img != 0 && compose != 0 && model != 0 && rekor != 0 && proof.length != 0);
        vm.prank(attestor);
        reg.register(
            pid,
            IMeasurementRegistry.Measurement({
                imageDigest: img,
                composeHash: compose,
                modelDigest: model,
                rekorEntry: rekor,
                attestedAt: 0,
                revoked: false
            }),
            proof
        );
        assertTrue(reg.isAttested(pid, img, model));
        assertEq(reg.isAttested(pid, img, otherModel), otherModel == model);
        assertEq(reg.quoteProofHashes(pid, img), keccak256(proof));
        vm.prank(owner);
        reg.revoke(pid, img);
        assertFalse(reg.isAttested(pid, img, model));
    }
}

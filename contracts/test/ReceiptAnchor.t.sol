// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {IReceiptAnchor} from "../src/interfaces/IReceiptAnchor.sol";
import {Merkle} from "./utils/Merkle.sol";

contract ReceiptAnchorTest is Test {
    ReceiptAnchor internal ra;
    address internal owner = makeAddr("owner");
    address internal anchorer = makeAddr("anchorer");
    address internal rando = makeAddr("rando");

    uint64 internal constant T0 = 1_750_000_000;
    bytes8 internal constant KW1 = "k-2026w1";
    bytes8 internal constant K1 = "k1";
    bytes8 internal constant K2 = "k2";
    bytes8 internal constant KNOPE = "nope";

    function setUp() public {
        vm.warp(T0);
        ra = new ReceiptAnchor(owner, anchorer);
    }

    function _leaves(uint256 n, uint256 salt) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            // leaf = keccak256(bytes.concat(keccak256(receiptCanonicalBytes || signatureBytes)))
            leaves[i] = Merkle.doubleHash(abi.encodePacked("receipt", salt, i, "sig", keccak256(abi.encode(i))));
        }
    }

    // --- constructor ---------------------------------------------------------------------------

    function test_constructor() public view {
        assertEq(ra.owner(), owner);
        assertEq(ra.anchorer(), anchorer);
        assertEq(ra.anchorCount(), 0);
    }

    function test_constructor_emitsAnchorerSet() public {
        vm.expectEmit(true, true, true, true);
        emit IReceiptAnchor.AnchorerSet(anchorer);
        new ReceiptAnchor(owner, anchorer);
    }

    function test_constructor_revertsZeroAnchorer() public {
        vm.expectRevert(ReceiptAnchor.ZeroAddress.selector);
        new ReceiptAnchor(owner, address(0));
    }

    function test_constructor_revertsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ReceiptAnchor(address(0), anchorer);
    }

    // --- anchor --------------------------------------------------------------------------------

    function test_anchor_sequentialIndices() public {
        vm.expectEmit(true, true, true, true, address(ra));
        emit IReceiptAnchor.Anchored(0, keccak256("r0"), T0 - 7200, T0 - 3600, 10);
        vm.prank(anchorer);
        uint256 i0 = ra.anchor(keccak256("r0"), T0 - 7200, T0 - 3600, 10);

        vm.expectEmit(true, true, true, true, address(ra));
        emit IReceiptAnchor.Anchored(1, keccak256("r1"), T0 - 3600, T0, 20);
        vm.prank(anchorer);
        uint256 i1 = ra.anchor(keccak256("r1"), T0 - 3600, T0, 20);

        assertEq(i0, 0);
        assertEq(i1, 1);
        assertEq(ra.anchorCount(), 2);
        (bytes32 root, uint64 fromTs, uint64 toTs, uint32 count) = ra.anchors(1);
        assertEq(root, keccak256("r1"));
        assertEq(fromTs, T0 - 3600);
        assertEq(toTs, T0);
        assertEq(count, 20);
    }

    function test_anchor_gapBetweenWindowsOk() public {
        vm.startPrank(anchorer);
        ra.anchor(keccak256("r0"), T0 - 9000, T0 - 8000, 1);
        ra.anchor(keccak256("r1"), T0 - 100, T0 - 50, 1);
        vm.stopPrank();
        assertEq(ra.anchorCount(), 2);
    }

    function test_anchor_revertsEmptyHalfOpenWindow() public {
        vm.prank(anchorer);
        vm.expectRevert(ReceiptAnchor.InvalidWindow.selector);
        ra.anchor(keccak256("r0"), T0, T0, 0);
        assertEq(ra.anchorCount(), 0);
    }

    function test_anchor_sharedBoundaryBelongsOnlyToLaterWindow() public {
        vm.startPrank(anchorer);
        ra.anchor(keccak256("r0"), T0 - 20, T0 - 10, 1);
        ra.anchor(keccak256("r1"), T0 - 10, T0, 1);
        vm.stopPrank();
        (, uint64 firstFrom, uint64 firstTo,) = ra.anchors(0);
        (, uint64 secondFrom, uint64 secondTo,) = ra.anchors(1);
        uint64 boundary = T0 - 10;
        assertFalse(boundary >= firstFrom && boundary < firstTo);
        assertTrue(boundary >= secondFrom && boundary < secondTo);
    }

    function test_anchor_revertsNotAnchorer() public {
        vm.prank(owner);
        vm.expectRevert(IReceiptAnchor.NotAnchorer.selector);
        ra.anchor(keccak256("r"), T0 - 1, T0, 1);
        vm.prank(rando);
        vm.expectRevert(IReceiptAnchor.NotAnchorer.selector);
        ra.anchor(keccak256("r"), T0 - 1, T0, 1);
    }

    function test_anchor_revertsEmptyRoot() public {
        vm.prank(anchorer);
        vm.expectRevert(IReceiptAnchor.EmptyRoot.selector);
        ra.anchor(bytes32(0), T0 - 1, T0, 1);
    }

    function test_anchor_revertsFromAfterTo() public {
        vm.prank(anchorer);
        vm.expectRevert(ReceiptAnchor.InvalidWindow.selector);
        ra.anchor(keccak256("r"), T0, T0 - 1, 1);
    }

    function test_anchor_revertsFutureWindow() public {
        vm.prank(anchorer);
        vm.expectRevert(ReceiptAnchor.InvalidWindow.selector);
        ra.anchor(keccak256("r"), T0, T0 + 1, 1);
    }

    function test_anchor_revertsOverlap() public {
        vm.prank(anchorer);
        ra.anchor(keccak256("r0"), T0 - 3600, T0 - 100, 1);
        vm.prank(anchorer);
        vm.expectRevert(IReceiptAnchor.OutOfOrder.selector);
        ra.anchor(keccak256("r1"), T0 - 101, T0, 1);
    }

    function test_anchor_revertsBackwards() public {
        vm.prank(anchorer);
        ra.anchor(keccak256("r0"), T0 - 100, T0, 1);
        vm.prank(anchorer);
        vm.expectRevert(IReceiptAnchor.OutOfOrder.selector);
        ra.anchor(keccak256("r1"), T0 - 3600, T0 - 3000, 1);
    }

    function testFuzz_anchor_sequence(uint32[6] memory lens, uint32[6] memory gaps) public {
        uint64 t = T0;
        vm.warp(T0 + 400 days);
        for (uint256 i; i < 6; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 fromTs = t + uint64(bound(gaps[i], 0, 1 days));
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 toTs = fromTs + uint64(bound(lens[i], 1, 1 days));
            vm.prank(anchorer);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 idx = ra.anchor(bytes32(i + 1), fromTs, toTs, uint32(i));
            assertEq(idx, i);
            t = toTs;
        }
        assertEq(ra.anchorCount(), 6);
    }

    function testFuzz_anchor_rejectsZeroDuration(uint64 timestamp) public {
        timestamp = uint64(bound(timestamp, 0, T0));
        vm.prank(anchorer);
        vm.expectRevert(ReceiptAnchor.InvalidWindow.selector);
        ra.anchor(keccak256("empty interval"), timestamp, timestamp, 1);
    }

    // --- verify --------------------------------------------------------------------------------

    function test_verify_allLeaves() public {
        bytes32[] memory leaves = _leaves(13, 1);
        vm.prank(anchorer);
        uint256 idx = ra.anchor(Merkle.getRoot(leaves), T0 - 3600, T0, 13);
        for (uint256 i; i < leaves.length; ++i) {
            assertTrue(ra.verify(leaves[i], Merkle.getProof(leaves, i), idx));
        }
    }

    function test_verify_falseForWrongIndex() public {
        bytes32[] memory a = _leaves(4, 1);
        bytes32[] memory b = _leaves(4, 2);
        vm.startPrank(anchorer);
        ra.anchor(Merkle.getRoot(a), T0 - 7200, T0 - 3600, 4);
        ra.anchor(Merkle.getRoot(b), T0 - 3600, T0, 4);
        vm.stopPrank();
        assertTrue(ra.verify(a[2], Merkle.getProof(a, 2), 0));
        assertFalse(ra.verify(a[2], Merkle.getProof(a, 2), 1));
        assertTrue(ra.verify(b[3], Merkle.getProof(b, 3), 1));
    }

    function test_verify_falseForUnknownIndex_neverReverts() public {
        bytes32[] memory a = _leaves(4, 1);
        assertFalse(ra.verify(a[0], Merkle.getProof(a, 0), 0));
        vm.prank(anchorer);
        ra.anchor(Merkle.getRoot(a), T0 - 1, T0, 4);
        assertFalse(ra.verify(a[0], Merkle.getProof(a, 0), 1));
        assertFalse(ra.verify(a[0], Merkle.getProof(a, 0), type(uint256).max));
    }

    function test_verify_falseForTamperedLeafOrProof() public {
        bytes32[] memory a = _leaves(8, 1);
        vm.prank(anchorer);
        ra.anchor(Merkle.getRoot(a), T0 - 1, T0, 8);
        bytes32[] memory proof = Merkle.getProof(a, 5);
        assertFalse(ra.verify(keccak256("forged"), proof, 0));
        proof[0] = bytes32(uint256(proof[0]) ^ 1);
        assertFalse(ra.verify(a[5], proof, 0));
        assertFalse(ra.verify(a[5], new bytes32[](0), 0));
    }

    function test_verify_singleLeafTree() public {
        bytes32[] memory a = _leaves(1, 7);
        vm.prank(anchorer);
        ra.anchor(Merkle.getRoot(a), T0 - 1, T0, 1);
        assertTrue(ra.verify(a[0], new bytes32[](0), 0));
    }

    function testFuzz_verify(uint8 n, uint256 salt, uint256 pick) public {
        n = uint8(bound(n, 1, 64));
        pick = bound(pick, 0, n - 1);
        bytes32[] memory a = _leaves(n, salt);
        vm.prank(anchorer);
        ra.anchor(Merkle.getRoot(a), T0 - 1, T0, n);
        bytes32[] memory proof = Merkle.getProof(a, pick);
        assertTrue(ra.verify(a[pick], proof, 0));
        assertFalse(ra.verify(keccak256(abi.encode(salt, "x")), proof, 0));
    }

    function test_anchors_unknownIndexReturnsZeros() public view {
        (bytes32 root, uint64 fromTs, uint64 toTs, uint32 count) = ra.anchors(5);
        assertEq(root, bytes32(0));
        assertEq(fromTs, 0);
        assertEq(toTs, 0);
        assertEq(count, 0);
    }

    // --- signing keys --------------------------------------------------------------------------

    function test_registerSigningKey_byAnchorer() public {
        vm.expectEmit(true, true, true, true, address(ra));
        emit IReceiptAnchor.SigningKeyRegistered(KW1, keccak256("pk1"), T0 + 10);
        vm.prank(anchorer);
        ra.registerSigningKey(KW1, keccak256("pk1"), T0 + 10);
        (bytes32 pk, uint64 validFrom, uint64 revokedAt) = ra.signingKeys(KW1);
        assertEq(pk, keccak256("pk1"));
        assertEq(validFrom, T0 + 10);
        assertEq(revokedAt, 0);
    }

    function test_registerSigningKey_byOwner() public {
        vm.prank(owner);
        ra.registerSigningKey(K1, keccak256("pk1"), 0);
        (bytes32 pk,,) = ra.signingKeys(K1);
        assertEq(pk, keccak256("pk1"));
    }

    function test_registerSigningKey_revertsUnauthorized() public {
        vm.prank(rando);
        vm.expectRevert(IReceiptAnchor.NotAnchorer.selector);
        ra.registerSigningKey(K1, keccak256("pk1"), 0);
    }

    function test_registerSigningKey_revertsZeroId() public {
        vm.prank(anchorer);
        vm.expectRevert(ReceiptAnchor.InvalidKey.selector);
        ra.registerSigningKey(bytes8(0), keccak256("pk1"), 0);
    }

    function test_registerSigningKey_revertsZeroPubkey() public {
        vm.prank(anchorer);
        vm.expectRevert(ReceiptAnchor.InvalidKey.selector);
        ra.registerSigningKey(K1, bytes32(0), 0);
    }

    function test_registerSigningKey_revertsExisting() public {
        vm.prank(anchorer);
        ra.registerSigningKey(K1, keccak256("pk1"), 0);
        vm.prank(owner);
        vm.expectRevert(ReceiptAnchor.KeyExists.selector);
        ra.registerSigningKey(K1, keccak256("pk2"), 0);
    }

    function test_revokeSigningKey_byAnchorerAndOwner() public {
        vm.startPrank(anchorer);
        ra.registerSigningKey(K1, keccak256("pk1"), 0);
        ra.registerSigningKey(K2, keccak256("pk2"), 0);
        vm.stopPrank();

        vm.warp(T0 + 7 days);
        vm.expectEmit(true, true, true, true, address(ra));
        emit IReceiptAnchor.SigningKeyRevoked(K1, T0 + 7 days);
        vm.prank(anchorer);
        ra.revokeSigningKey(K1);
        (, , uint64 revokedAt) = ra.signingKeys(K1);
        assertEq(revokedAt, T0 + 7 days);

        vm.prank(owner);
        ra.revokeSigningKey(K2);
        (, , revokedAt) = ra.signingKeys(K2);
        assertEq(revokedAt, T0 + 7 days);
    }

    function test_revokeSigningKey_revertsUnknown() public {
        vm.prank(anchorer);
        vm.expectRevert(IReceiptAnchor.UnknownKey.selector);
        ra.revokeSigningKey(KNOPE);
    }

    function test_revokeSigningKey_revertsAlreadyRevoked() public {
        vm.startPrank(anchorer);
        ra.registerSigningKey(K1, keccak256("pk1"), 0);
        ra.revokeSigningKey(K1);
        vm.warp(T0 + 1);
        vm.expectRevert(ReceiptAnchor.AlreadyRevoked.selector);
        ra.revokeSigningKey(K1);
        vm.stopPrank();
        (, , uint64 revokedAt) = ra.signingKeys(K1);
        assertEq(revokedAt, T0);
    }

    function test_revokeSigningKey_revertsUnauthorized() public {
        vm.prank(anchorer);
        ra.registerSigningKey(K1, keccak256("pk1"), 0);
        vm.prank(rando);
        vm.expectRevert(IReceiptAnchor.NotAnchorer.selector);
        ra.revokeSigningKey(K1);
    }

    function test_revokedKeyCannotBeReRegistered() public {
        vm.startPrank(anchorer);
        ra.registerSigningKey(K1, keccak256("pk1"), 0);
        ra.revokeSigningKey(K1);
        vm.expectRevert(ReceiptAnchor.KeyExists.selector);
        ra.registerSigningKey(K1, keccak256("pk9"), 0);
        vm.stopPrank();
    }

    // --- admin ---------------------------------------------------------------------------------

    function test_setAnchorer() public {
        address a2 = makeAddr("a2");
        vm.expectEmit(true, true, true, true, address(ra));
        emit IReceiptAnchor.AnchorerSet(a2);
        vm.prank(owner);
        ra.setAnchorer(a2);
        assertEq(ra.anchorer(), a2);

        vm.prank(anchorer);
        vm.expectRevert(IReceiptAnchor.NotAnchorer.selector);
        ra.anchor(keccak256("r"), T0 - 1, T0, 1);
        vm.prank(anchorer);
        vm.expectRevert(IReceiptAnchor.NotAnchorer.selector);
        ra.registerSigningKey(K1, keccak256("pk1"), 0);

        vm.prank(a2);
        ra.anchor(keccak256("r"), T0 - 1, T0, 1);
    }

    function test_setAnchorer_onlyOwner() public {
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anchorer));
        ra.setAnchorer(anchorer);
    }

    function test_setAnchorer_revertsZero() public {
        vm.prank(owner);
        vm.expectRevert(ReceiptAnchor.ZeroAddress.selector);
        ra.setAnchorer(address(0));
    }
    // --- anchorAttested ------------------------------------------------------------------------

    bytes32 internal constant PROVIDER = keccak256("provider-a");
    bytes32 internal constant ATT_REF = keccak256("attestation-ref");

    function test_anchorAttested_sequentialIndicesAndEvent() public {
        vm.expectEmit(true, true, true, true, address(ra));
        emit IReceiptAnchor.AttestedAnchored(0, PROVIDER, keccak256("r0"), ATT_REF);
        vm.prank(anchorer);
        uint256 i0 = ra.anchorAttested(PROVIDER, keccak256("r0"), ATT_REF);

        vm.warp(T0 + 100);
        vm.expectEmit(true, true, true, true, address(ra));
        emit IReceiptAnchor.AttestedAnchored(1, keccak256("provider-b"), keccak256("r1"), keccak256("ref-b"));
        vm.prank(anchorer);
        uint256 i1 = ra.anchorAttested(keccak256("provider-b"), keccak256("r1"), keccak256("ref-b"));

        assertEq(i0, 0);
        assertEq(i1, 1);
        assertEq(ra.attestedAnchorCount(), 2);
        (bytes32 pid, bytes32 root, bytes32 ref, uint64 at) = ra.attestedAnchors(0);
        assertEq(pid, PROVIDER);
        assertEq(root, keccak256("r0"));
        assertEq(ref, ATT_REF);
        assertEq(at, T0);
        (, , , at) = ra.attestedAnchors(1);
        assertEq(at, T0 + 100);
    }

    function test_anchorAttested_isSeparateFromWindowedAnchors() public {
        vm.prank(anchorer);
        ra.anchor(keccak256("w0"), T0 - 3600, T0, 5);
        vm.prank(anchorer);
        ra.anchorAttested(PROVIDER, keccak256("a0"), ATT_REF);

        // windowed anchors are untouched and keep enforcing their own ordering
        assertEq(ra.anchorCount(), 1);
        assertEq(ra.attestedAnchorCount(), 1);
        (bytes32 root,,,) = ra.anchors(0);
        assertEq(root, keccak256("w0"));
        vm.prank(anchorer);
        vm.expectRevert(IReceiptAnchor.OutOfOrder.selector);
        ra.anchor(keccak256("w1"), T0 - 1, T0, 1);
        vm.warp(T0 + 1);
        vm.prank(anchorer);
        ra.anchor(keccak256("w1"), T0, T0 + 1, 1);
        assertEq(ra.anchorCount(), 2);
        assertEq(ra.attestedAnchorCount(), 1);
    }

    function test_anchorAttested_revertsUnauthorized() public {
        vm.prank(rando);
        vm.expectRevert(IReceiptAnchor.NotAnchorer.selector);
        ra.anchorAttested(PROVIDER, keccak256("r"), ATT_REF);
        // like anchor(), the owner alone cannot publish roots
        vm.prank(owner);
        vm.expectRevert(IReceiptAnchor.NotAnchorer.selector);
        ra.anchorAttested(PROVIDER, keccak256("r"), ATT_REF);
        assertEq(ra.attestedAnchorCount(), 0);
    }

    function test_anchorAttested_revertsEmptyInputs() public {
        vm.startPrank(anchorer);
        vm.expectRevert(IReceiptAnchor.EmptyProvider.selector);
        ra.anchorAttested(bytes32(0), keccak256("r"), ATT_REF);
        vm.expectRevert(IReceiptAnchor.EmptyRoot.selector);
        ra.anchorAttested(PROVIDER, bytes32(0), ATT_REF);
        vm.expectRevert(IReceiptAnchor.EmptyAttestationRef.selector);
        ra.anchorAttested(PROVIDER, keccak256("r"), bytes32(0));
        vm.stopPrank();
        assertEq(ra.attestedAnchorCount(), 0);
    }

    function test_anchorAttested_followsAnchorerRotation() public {
        address a2 = makeAddr("a2");
        vm.prank(owner);
        ra.setAnchorer(a2);
        vm.prank(anchorer);
        vm.expectRevert(IReceiptAnchor.NotAnchorer.selector);
        ra.anchorAttested(PROVIDER, keccak256("r"), ATT_REF);
        vm.prank(a2);
        ra.anchorAttested(PROVIDER, keccak256("r"), ATT_REF);
    }

    function test_verifyAttested_inclusion() public {
        bytes32[] memory leaves = _leaves(5, 7);
        vm.prank(anchorer);
        uint256 idx = ra.anchorAttested(PROVIDER, Merkle.getRoot(leaves), ATT_REF);
        for (uint256 i; i < leaves.length; ++i) {
            assertTrue(ra.verifyAttested(leaves[i], Merkle.getProof(leaves, i), idx));
        }
        assertFalse(ra.verifyAttested(keccak256("not-a-leaf"), Merkle.getProof(leaves, 0), idx));
        // an attested root does not verify through the windowed-anchor index space
        assertFalse(ra.verify(leaves[0], Merkle.getProof(leaves, 0), idx));
    }

    function test_attestedAnchors_unknownIndexReturnsZeros() public view {
        (bytes32 pid, bytes32 root, bytes32 ref, uint64 at) = ra.attestedAnchors(9);
        assertEq(pid, bytes32(0));
        assertEq(root, bytes32(0));
        assertEq(ref, bytes32(0));
        assertEq(at, 0);
        assertFalse(ra.verifyAttested(keccak256("x"), new bytes32[](0), 9));
    }

    function testFuzz_anchorAttested_recordsInputs(bytes32 pid, bytes32 root, bytes32 ref) public {
        vm.assume(pid != bytes32(0) && root != bytes32(0) && ref != bytes32(0));
        vm.prank(anchorer);
        uint256 i = ra.anchorAttested(pid, root, ref);
        (bytes32 p2, bytes32 r2, bytes32 f2,) = ra.attestedAnchors(i);
        assertEq(p2, pid);
        assertEq(r2, root);
        assertEq(f2, ref);
    }
}

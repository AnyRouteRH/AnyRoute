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

    function test_anchor_pointWindowOk() public {
        vm.prank(anchorer);
        ra.anchor(keccak256("r0"), T0, T0, 0);
        vm.prank(anchorer);
        ra.anchor(keccak256("r1"), T0, T0, 0); // starts exactly where the previous ended
        assertEq(ra.anchorCount(), 2);
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
            uint64 toTs = fromTs + uint64(bound(lens[i], 0, 1 days));
            vm.prank(anchorer);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 idx = ra.anchor(bytes32(i + 1), fromTs, toTs, uint32(i));
            assertEq(idx, i);
            t = toTs;
        }
        assertEq(ra.anchorCount(), 6);
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
}

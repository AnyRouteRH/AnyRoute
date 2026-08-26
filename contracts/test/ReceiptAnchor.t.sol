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
}

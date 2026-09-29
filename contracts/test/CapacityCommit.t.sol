// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {APIU} from "../src/APIU.sol";
import {CapacityCommit} from "../src/CapacityCommit.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {IAPIU} from "../src/interfaces/IAPIU.sol";
import {ICapacityCommit} from "../src/interfaces/ICapacityCommit.sol";
import {IProviderBond} from "../src/interfaces/IProviderBond.sol";
import {IReceiptAnchor} from "../src/interfaces/IReceiptAnchor.sol";

/// @dev Just the two registry reads CapacityCommit makes.
contract RegistryStub {
    mapping(bytes32 => address) public operatorOf;
    mapping(bytes32 => bool) public isDelisted;

    function set(bytes32 id, address op, bool delisted) external {
        operatorOf[id] = op;
        isDelisted[id] = delisted;
    }
}

abstract contract CapacityCommitBase is Test {
    uint64 internal constant T0 = 1_750_000_000;
    uint16 internal constant DISCOUNT = 8_000; // 80%
    uint256 internal constant BOND_RATE = 100_000; // 0.1 USDG per 1,000,000 token-units
    uint64 internal constant GRACE = 1 days;
    uint128 internal constant TPD = 10_000_000; // token-units per day
    uint32 internal constant DAYS = 10;
    uint256 internal constant UNITS = 100_000_000; // TPD * DAYS
    uint256 internal constant BOND = 10e6; // 100 x BOND_RATE
    uint256 internal constant CAP = 80e18; // 100 APIU x 80%
    bytes32 internal constant PID = keccak256("provider-a");
    bytes32 internal constant PID2 = keccak256("provider-b");
    bytes32 internal constant EVIDENCE = keccak256("evidence");

    MockUSDG internal usdg;
    APIU internal apiu;
    ReceiptAnchor internal anchor;
    CapacityCommit internal cc;
    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal anchorer = makeAddr("anchorer");
    address internal pool = makeAddr("slashPool");
    address internal prov = makeAddr("provider");
    address internal prov2 = makeAddr("provider2");
    address internal buyer = makeAddr("buyer");
    address internal rando = makeAddr("rando");

    function setUp() public virtual {
        vm.warp(T0);
        usdg = new MockUSDG();
        apiu = new APIU(owner);
        anchor = new ReceiptAnchor(owner, anchorer);
        cc = new CapacityCommit(
            IERC20(address(usdg)),
            IAPIU(address(apiu)),
            IReceiptAnchor(address(anchor)),
            owner,
            keeper,
            pool,
            DISCOUNT,
            BOND_RATE,
            GRACE
        );
        vm.prank(owner);
        apiu.setMinter(address(cc));
        address[2] memory ps = [prov, prov2];
        for (uint256 i; i < 2; ++i) {
            usdg.mint(ps[i], 1_000_000e6);
            vm.prank(ps[i]);
            usdg.approve(address(cc), type(uint256).max);
        }
    }

    // --- helpers ---------------------------------------------------------------------------------

    function _post() internal returns (uint256) {
        vm.prank(prov);
        return cc.post(PID, TPD, DAYS, BOND);
    }

    function _mint(uint256 id, uint256 amount) internal {
        vm.prank(prov);
        cc.mint(id, buyer, amount);
    }

    /// @dev Anchor the window [from, to] (to must not be in the future) and return its index and root.
    function _anchorWindow(uint64 from, uint64 to, bytes32 salt)
        internal
        returns (uint256 idx, bytes32 root)
    {
        root = keccak256(abi.encode("root", salt, from, to));
        vm.prank(anchorer);
        idx = anchor.anchor(root, from, to, 10);
    }

    function _deliver(uint256 id, uint256 units, uint64 from, uint64 to) internal returns (uint256 idx) {
        bytes32 root;
        (idx, root) = _anchorWindow(from, to, bytes32(units));
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = id;
        us[0] = units;
        vm.prank(keeper);
        cc.recordDelivery(idx, root, EVIDENCE, ids, us);
    }

    function _endTs(uint256 id) internal view returns (uint64) {
        return cc.commitOf(id).endTs;
    }

    function _finalizeAt(uint256 id) internal {
        vm.warp(uint256(_endTs(id)) + GRACE);
        cc.finalize(id);
    }
}

contract CapacityCommitTest is CapacityCommitBase {
    // --- constructor -----------------------------------------------------------------------------

    function test_constructor() public view {
        assertEq(address(cc.usdg()), address(usdg));
        assertEq(address(cc.apiu()), address(apiu));
        assertEq(address(cc.receiptAnchor()), address(anchor));
        assertEq(cc.owner(), owner);
        assertEq(cc.keeper(), keeper);
        assertEq(cc.slashRecipient(), pool);
        assertEq(cc.discountBps(), DISCOUNT);
        assertEq(cc.bondPerMillionUnits(), BOND_RATE);
        assertEq(cc.reportGrace(), GRACE);
        assertEq(cc.commitCount(), 0);
        assertEq(cc.openCapacityApiu(), 0);
        assertFalse(cc.mintingPaused());
    }

    function test_constructor_reverts() public {
        IERC20 u = IERC20(address(usdg));
        IAPIU a = IAPIU(address(apiu));
        IReceiptAnchor r = IReceiptAnchor(address(anchor));
        vm.expectRevert(ICapacityCommit.ZeroAddress.selector);
        new CapacityCommit(IERC20(address(0)), a, r, owner, keeper, pool, DISCOUNT, BOND_RATE, GRACE);
        vm.expectRevert(ICapacityCommit.ZeroAddress.selector);
        new CapacityCommit(u, IAPIU(address(0)), r, owner, keeper, pool, DISCOUNT, BOND_RATE, GRACE);
        vm.expectRevert(ICapacityCommit.ZeroAddress.selector);
        new CapacityCommit(u, a, IReceiptAnchor(address(0)), owner, keeper, pool, DISCOUNT, BOND_RATE, GRACE);
        vm.expectRevert(ICapacityCommit.ZeroAddress.selector);
        new CapacityCommit(u, a, r, owner, address(0), pool, DISCOUNT, BOND_RATE, GRACE);
        vm.expectRevert(ICapacityCommit.ZeroAddress.selector);
        new CapacityCommit(u, a, r, owner, keeper, address(0), DISCOUNT, BOND_RATE, GRACE);
        vm.expectRevert(ICapacityCommit.InvalidDiscount.selector);
        new CapacityCommit(u, a, r, owner, keeper, pool, 0, BOND_RATE, GRACE);
        vm.expectRevert(ICapacityCommit.InvalidDiscount.selector);
        new CapacityCommit(u, a, r, owner, keeper, pool, 10_001, BOND_RATE, GRACE);
        vm.expectRevert(ICapacityCommit.InvalidGrace.selector);
        new CapacityCommit(u, a, r, owner, keeper, pool, DISCOUNT, BOND_RATE, 59 minutes);
        vm.expectRevert(ICapacityCommit.InvalidGrace.selector);
        new CapacityCommit(u, a, r, owner, keeper, pool, DISCOUNT, BOND_RATE, 31 days);
    }

    // --- post ------------------------------------------------------------------------------------

    function test_post_pullsBondAndRecordsCommit() public {
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.Posted(1, PID, prov, TPD, DAYS, BOND, CAP, DISCOUNT, T0, T0 + 10 days);
        uint256 id = _post();
        assertEq(id, 1);
        assertEq(cc.commitCount(), 1);
        assertEq(usdg.balanceOf(address(cc)), BOND);
        assertEq(usdg.balanceOf(prov), 1_000_000e6 - BOND);
        assertEq(cc.openCapacityApiu(), CAP);
        ICapacityCommit.Commit memory c = cc.commitOf(id);
        assertEq(c.provider, prov);
        assertEq(uint8(c.status), uint8(ICapacityCommit.Status.Open));
        assertEq(c.providerId, PID);
        assertEq(c.tokensPerDay, TPD);
        assertEq(c.durationDays, DAYS);
        assertEq(c.startTs, T0);
        assertEq(c.endTs, T0 + 10 days);
        assertEq(c.bond, BOND);
        assertEq(c.capApiu, CAP);
        assertEq(c.mintedApiu, 0);
        assertEq(c.deliveredUnits, 0);
        assertEq(cc.totalUnitsOf(id), UNITS);
        assertEq(cc.mintableOf(id), CAP);
    }

    function test_post_reverts() public {
        vm.startPrank(prov);
        vm.expectRevert(ICapacityCommit.InvalidProvider.selector);
        cc.post(bytes32(0), TPD, DAYS, BOND);
        vm.expectRevert(ICapacityCommit.InvalidCommit.selector);
        cc.post(PID, 0, DAYS, BOND);
        vm.expectRevert(ICapacityCommit.InvalidCommit.selector);
        cc.post(PID, TPD, 0, BOND);
        vm.expectRevert(ICapacityCommit.InvalidCommit.selector);
        cc.post(PID, TPD, 366, BOND);
        vm.expectRevert(ICapacityCommit.InvalidBond.selector);
        cc.post(PID, TPD, DAYS, 0);
        vm.expectRevert(ICapacityCommit.InvalidBond.selector);
        cc.post(PID, TPD, DAYS, uint256(type(uint128).max) + 1);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.BondTooLow.selector, BOND));
        cc.post(PID, TPD, DAYS, BOND - 1);
        vm.stopPrank();
        assertEq(cc.commitCount(), 0);
        assertEq(cc.openCapacityApiu(), 0);
    }

    function test_post_withoutAllowanceReverts() public {
        usdg.mint(rando, 100e6);
        vm.prank(rando);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(cc), 0, BOND)
        );
        cc.post(PID, TPD, DAYS, BOND);
        assertEq(cc.commitCount(), 0);
    }

    function test_post_requiredBondRoundsUp() public {
        // 15 token-units need ceil(15 * 100_000 / 1_000_000) = ceil(1.5) = 2 base units.
        vm.startPrank(prov);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.BondTooLow.selector, 2));
        cc.post(PID, 15, 1, 1);
        cc.post(PID, 15, 1, 2);
        vm.stopPrank();
    }

    function test_post_zeroBondRateStillNeedsABond() public {
        vm.prank(owner);
        cc.setBondPerMillionUnits(0);
        vm.prank(prov);
        vm.expectRevert(ICapacityCommit.InvalidBond.selector);
        cc.post(PID, TPD, DAYS, 0);
        vm.prank(prov);
        cc.post(PID, TPD, DAYS, 1);
        assertEq(usdg.balanceOf(address(cc)), 1);
    }

    function test_post_registryChecks() public {
        RegistryStub reg = new RegistryStub();
        vm.prank(owner);
        cc.setProviderBond(IProviderBond(address(reg)));
        // Unregistered: the operator is address zero, not the caller.
        vm.prank(prov);
        vm.expectRevert(ICapacityCommit.ProviderNotAuthorized.selector);
        cc.post(PID, TPD, DAYS, BOND);
        reg.set(PID, prov, false);
        vm.prank(prov2);
        vm.expectRevert(ICapacityCommit.ProviderNotAuthorized.selector);
        cc.post(PID, TPD, DAYS, BOND);
        reg.set(PID, prov, true);
        vm.prank(prov);
        vm.expectRevert(ICapacityCommit.ProviderNotAuthorized.selector);
        cc.post(PID, TPD, DAYS, BOND);
        reg.set(PID, prov, false);
        assertEq(_post(), 1);
        // Clearing the registry turns the check off.
        vm.prank(owner);
        cc.setProviderBond(IProviderBond(address(0)));
        vm.prank(prov2);
        assertEq(cc.post(PID2, TPD, DAYS, BOND), 2);
    }

    function test_post_discountIsFixedAtPostTime() public {
        uint256 id = _post();
        vm.prank(owner);
        cc.setDiscountBps(5_000);
        vm.prank(owner);
        cc.setBondPerMillionUnits(1);
        assertEq(cc.commitOf(id).capApiu, CAP);
        assertEq(cc.commitOf(id).discountBps, DISCOUNT);
        vm.prank(prov);
        uint256 id2 = cc.post(PID, TPD, DAYS, 100);
        assertEq(cc.commitOf(id2).capApiu, 50e18);
        assertEq(cc.openCapacityApiu(), CAP + 50e18);
    }

    function testFuzz_post_capMatchesFormula(uint128 tpd, uint32 dayCount, uint16 discount) public {
        tpd = uint128(bound(tpd, 1, 1e15));
        dayCount = uint32(bound(dayCount, 1, 365));
        discount = uint16(bound(discount, 1, 10_000));
        vm.prank(owner);
        cc.setDiscountBps(discount);
        uint256 units = uint256(tpd) * dayCount;
        uint256 need = (units * BOND_RATE + 999_999) / 1_000_000;
        if (need == 0) need = 1;
        usdg.mint(prov, need);
        vm.prank(prov);
        uint256 id = cc.post(PID, tpd, dayCount, need);
        uint256 cap = cc.commitOf(id).capApiu;
        assertEq(cap, units * 1e12 * discount / 10_000);
        // The cap never exceeds the committed units expressed in APIU.
        assertLe(cap, units * 1e12);
        assertEq(cc.openCapacityApiu(), cap);
    }

    // --- mint ------------------------------------------------------------------------------------

    function test_mint_upToCap() public {
        uint256 id = _post();
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.Minted(id, buyer, 30e18, 30e18);
        _mint(id, 30e18);
        _mint(id, 50e18);
        assertEq(apiu.balanceOf(buyer), CAP);
        assertEq(apiu.totalSupply(), CAP);
        assertEq(cc.mintableOf(id), 0);
        vm.prank(prov);
        vm.expectRevert(ICapacityCommit.ExceedsCommitCapacity.selector);
        cc.mint(id, buyer, 1);
    }

    function test_mint_onlyProvider() public {
        uint256 id = _post();
        vm.prank(rando);
        vm.expectRevert(ICapacityCommit.NotProvider.selector);
        cc.mint(id, rando, 1e18);
        vm.prank(keeper);
        vm.expectRevert(ICapacityCommit.NotProvider.selector);
        cc.mint(id, keeper, 1e18);
        vm.prank(owner);
        vm.expectRevert(ICapacityCommit.NotProvider.selector);
        cc.mint(id, owner, 1e18);
    }

    function test_mint_reverts() public {
        uint256 id = _post();
        vm.startPrank(prov);
        vm.expectRevert(ICapacityCommit.UnknownCommit.selector);
        cc.mint(99, buyer, 1e18);
        vm.expectRevert(ICapacityCommit.ZeroAddress.selector);
        cc.mint(id, address(0), 1e18);
        vm.expectRevert(ICapacityCommit.InvalidAmount.selector);
        cc.mint(id, buyer, 0);
        vm.stopPrank();
    }

    function test_mint_notAfterExpiry() public {
        uint256 id = _post();
        vm.warp(T0 + 10 days - 1);
        _mint(id, 1e18);
        vm.warp(T0 + 10 days);
        assertEq(cc.mintableOf(id), 0);
        vm.prank(prov);
        vm.expectRevert(ICapacityCommit.CommitExpired.selector);
        cc.mint(id, buyer, 1e18);
    }

    function test_mint_paused() public {
        uint256 id = _post();
        vm.prank(owner);
        cc.setMintingPaused(true);
        assertEq(cc.mintableOf(id), 0);
        vm.prank(prov);
        vm.expectRevert(ICapacityCommit.MintingPaused.selector);
        cc.mint(id, buyer, 1e18);
        vm.prank(owner);
        cc.setMintingPaused(false);
        _mint(id, 1e18);
        assertEq(apiu.totalSupply(), 1e18);
    }

    function test_mint_notAfterFinalize() public {
        uint256 id = _post();
        _finalizeAt(id);
        vm.prank(prov);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.NotOpen.selector, id));
        cc.mint(id, buyer, 1e18);
    }

    function test_mint_twoCommitsShareOneTokenButNotOneCap() public {
        uint256 a = _post();
        vm.prank(prov2);
        uint256 b = cc.post(PID2, TPD, DAYS, BOND);
        assertEq(cc.openCapacityApiu(), 2 * CAP);
        _mint(a, CAP);
        vm.prank(prov2);
        cc.mint(b, buyer, CAP);
        assertEq(apiu.totalSupply(), 2 * CAP);
        // Each provider stays inside its own commitment.
        vm.prank(prov);
        vm.expectRevert(ICapacityCommit.ExceedsCommitCapacity.selector);
        cc.mint(a, buyer, 1);
        vm.prank(prov2);
        vm.expectRevert(ICapacityCommit.ExceedsCommitCapacity.selector);
        cc.mint(b, buyer, 1);
    }

    // --- recordDelivery --------------------------------------------------------------------------

    function test_recordDelivery_countsUnitsAndEmits() public {
        uint256 id = _post();
        vm.warp(T0 + 1 days);
        (uint256 idx, bytes32 root) = _anchorWindow(T0, T0 + 1 days, "a");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = id;
        us[0] = 4_000_000;
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.DeliveryRecorded(id, idx, root, 4_000_000, 4_000_000, EVIDENCE);
        vm.prank(keeper);
        cc.recordDelivery(idx, root, EVIDENCE, ids, us);
        assertEq(cc.commitOf(id).deliveredUnits, 4_000_000);
        assertTrue(cc.deliveryRecorded(id, idx));
        vm.warp(T0 + 2 days);
        _deliver(id, 6_000_000, T0 + 1 days, T0 + 2 days);
        assertEq(cc.commitOf(id).deliveredUnits, 10_000_000);
    }

    function test_recordDelivery_clampsToCommittedTotal() public {
        uint256 id = _post();
        vm.warp(T0 + 1 days);
        _deliver(id, UNITS * 5, T0, T0 + 1 days);
        assertEq(cc.commitOf(id).deliveredUnits, UNITS);
    }

    function test_recordDelivery_onlyKeeper() public {
        uint256 id = _post();
        vm.warp(T0 + 1 days);
        (uint256 idx, bytes32 root) = _anchorWindow(T0, T0 + 1 days, "x");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = id;
        us[0] = 1;
        vm.prank(rando);
        vm.expectRevert(ICapacityCommit.NotKeeper.selector);
        cc.recordDelivery(idx, root, EVIDENCE, ids, us);
        vm.prank(owner);
        vm.expectRevert(ICapacityCommit.NotKeeper.selector);
        cc.recordDelivery(idx, root, EVIDENCE, ids, us);
    }

    function test_recordDelivery_lengthChecks() public {
        uint256 id = _post();
        vm.warp(T0 + 1 days);
        (uint256 idx, bytes32 root) = _anchorWindow(T0, T0 + 1 days, "x");
        uint256[] memory none = new uint256[](0);
        uint256[] memory one = new uint256[](1);
        one[0] = id;
        uint256[] memory two = new uint256[](2);
        vm.startPrank(keeper);
        vm.expectRevert(ICapacityCommit.LengthMismatch.selector);
        cc.recordDelivery(idx, root, EVIDENCE, none, none);
        vm.expectRevert(ICapacityCommit.LengthMismatch.selector);
        cc.recordDelivery(idx, root, EVIDENCE, one, two);
        vm.stopPrank();
    }

    function test_recordDelivery_anchorMustExistAndMatch() public {
        uint256 id = _post();
        vm.warp(T0 + 1 days);
        (uint256 idx, bytes32 root) = _anchorWindow(T0, T0 + 1 days, "x");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = id;
        us[0] = 1;
        vm.startPrank(keeper);
        vm.expectRevert(ICapacityCommit.AnchorMismatch.selector);
        cc.recordDelivery(idx, keccak256("other"), EVIDENCE, ids, us);
        vm.expectRevert(); // ReceiptAnchor rejects an unknown index
        cc.recordDelivery(idx + 1, root, EVIDENCE, ids, us);
        vm.stopPrank();
    }

    function test_recordDelivery_anchorMustOverlapTerm() public {
        vm.warp(T0 + 5 days);
        // A window that ended before the term starts.
        vm.prank(anchorer);
        uint256 early = anchor.anchor(keccak256("early"), T0 - 2 days, T0 - 1 days, 1);
        uint256 id = _post(); // term starts now (T0 + 5 days)
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = id;
        us[0] = 1;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.AnchorOutsideTerm.selector, id));
        cc.recordDelivery(early, keccak256("early"), EVIDENCE, ids, us);
        // A window that starts at or after the term end.
        vm.warp(T0 + 15 days + 12 hours); // inside the reporting grace
        vm.prank(anchorer);
        uint256 late = anchor.anchor(keccak256("late"), T0 + 15 days, T0 + 15 days + 1 hours, 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.AnchorOutsideTerm.selector, id));
        cc.recordDelivery(late, keccak256("late"), EVIDENCE, ids, us);
    }

    function test_recordDelivery_anchorCountsOncePerCommit() public {
        uint256 id = _post();
        vm.warp(T0 + 1 days);
        uint256 idx = _deliver(id, 1_000_000, T0, T0 + 1 days);
        bytes32 root = keccak256(abi.encode("root", bytes32(uint256(1_000_000)), T0, T0 + 1 days));
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = id;
        us[0] = 1_000_000;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.AlreadyRecorded.selector, id, idx));
        cc.recordDelivery(idx, root, EVIDENCE, ids, us);
        // The same commitment twice in one report is the same error.
        vm.warp(T0 + 2 days);
        (uint256 idx2, bytes32 root2) = _anchorWindow(T0 + 1 days, T0 + 2 days, "y");
        uint256[] memory ids2 = new uint256[](2);
        uint256[] memory us2 = new uint256[](2);
        ids2[0] = id;
        ids2[1] = id;
        us2[0] = 1;
        us2[1] = 1;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.AlreadyRecorded.selector, id, idx2));
        cc.recordDelivery(idx2, root2, EVIDENCE, ids2, us2);
    }

    function test_recordDelivery_oneAnchorManyCommits() public {
        uint256 a = _post();
        vm.prank(prov2);
        uint256 b = cc.post(PID2, TPD, DAYS, BOND);
        vm.warp(T0 + 1 days);
        (uint256 idx, bytes32 root) = _anchorWindow(T0, T0 + 1 days, "z");
        uint256[] memory ids = new uint256[](2);
        uint256[] memory us = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        us[0] = 7;
        us[1] = 9;
        vm.prank(keeper);
        cc.recordDelivery(idx, root, EVIDENCE, ids, us);
        assertEq(cc.commitOf(a).deliveredUnits, 7);
        assertEq(cc.commitOf(b).deliveredUnits, 9);
    }

    function test_recordDelivery_unknownOrClosedCommit() public {
        uint256 id = _post();
        vm.warp(T0 + 1 days);
        (uint256 idx, bytes32 root) = _anchorWindow(T0, T0 + 1 days, "z");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = 42;
        us[0] = 1;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.NotOpen.selector, uint256(42)));
        cc.recordDelivery(idx, root, EVIDENCE, ids, us);
        // Whole call reverts on the first invalid entry: nothing is recorded for the valid one.
        ids = new uint256[](2);
        us = new uint256[](2);
        ids[0] = id;
        ids[1] = 42;
        us[0] = 5;
        us[1] = 5;
        vm.prank(keeper);
        vm.expectRevert();
        cc.recordDelivery(idx, root, EVIDENCE, ids, us);
        assertEq(cc.commitOf(id).deliveredUnits, 0);
        assertFalse(cc.deliveryRecorded(id, idx));
    }

    function test_recordDelivery_closedAfterGrace() public {
        uint256 id = _post();
        vm.warp(T0 + 10 days + GRACE - 1);
        (uint256 idx, bytes32 root) = _anchorWindow(T0 + 9 days, T0 + 10 days, "late");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = id;
        us[0] = 1;
        vm.prank(keeper);
        cc.recordDelivery(idx, root, EVIDENCE, ids, us); // last second of the grace period
        vm.warp(T0 + 10 days + GRACE);
        (uint256 idx2, bytes32 root2) = _anchorWindow(T0 + 10 days, T0 + 10 days + 1, "later");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.ReportingClosed.selector, id));
        cc.recordDelivery(idx2, root2, EVIDENCE, ids, us);
    }

    // --- finalize (slashing) ---------------------------------------------------------------------

    function test_finalize_notReadyBeforeGrace() public {
        uint256 id = _post();
        vm.warp(T0 + 10 days + GRACE - 1);
        vm.expectRevert(ICapacityCommit.NotReady.selector);
        cc.finalize(id);
        vm.warp(T0 + 10 days - 1);
        vm.expectRevert(ICapacityCommit.NotReady.selector);
        cc.finalize(id);
    }

    function test_finalize_unknown() public {
        vm.expectRevert(ICapacityCommit.UnknownCommit.selector);
        cc.finalize(1);
    }

    function test_finalize_fullDeliveryNoSlash() public {
        uint256 id = _post();
        vm.warp(T0 + 5 days);
        _deliver(id, UNITS, T0, T0 + 5 days);
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.Finalized(id, UNITS, 0, 0);
        _finalizeAt(id);
        assertEq(usdg.balanceOf(pool), 0);
        assertEq(usdg.balanceOf(address(cc)), BOND);
        assertEq(cc.commitOf(id).slashed, 0);
        assertEq(uint8(cc.commitOf(id).status), uint8(ICapacityCommit.Status.Finalized));
    }

    function test_finalize_slashesProportionalToShortfall() public {
        uint256 id = _post();
        vm.warp(T0 + 5 days);
        _deliver(id, 75_000_000, T0, T0 + 5 days); // 75% delivered
        uint256 expected = BOND / 4; // 25% short
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.Finalized(id, 75_000_000, 25_000_000, expected);
        _finalizeAt(id);
        assertEq(usdg.balanceOf(pool), expected);
        assertEq(cc.commitOf(id).slashed, expected);
        assertEq(usdg.balanceOf(address(cc)), BOND - expected);
    }

    function test_finalize_noDeliveryLosesTheWholeBond() public {
        uint256 id = _post();
        _finalizeAt(id);
        assertEq(usdg.balanceOf(pool), BOND);
        assertEq(usdg.balanceOf(address(cc)), 0);
        assertEq(cc.commitOf(id).slashed, BOND);
    }

    function test_finalize_anyoneCanCallOnce() public {
        uint256 id = _post();
        vm.warp(uint256(_endTs(id)) + GRACE);
        vm.prank(rando);
        cc.finalize(id);
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.NotOpen.selector, id));
        cc.finalize(id);
    }

    function test_finalize_slashRecipientIsTheCurrentOne() public {
        uint256 id = _post();
        address newPool = makeAddr("newPool");
        vm.prank(owner);
        cc.setSlashRecipient(newPool);
        _finalizeAt(id);
        assertEq(usdg.balanceOf(newPool), BOND);
        assertEq(usdg.balanceOf(pool), 0);
    }

    function testFuzz_finalize_cutIsBondTimesShortfallOverTotal(uint128 delivered) public {
        uint256 id = _post();
        vm.warp(T0 + 5 days);
        uint256 d = bound(delivered, 1, UNITS);
        _deliver(id, d, T0, T0 + 5 days);
        _finalizeAt(id);
        uint256 cut = BOND * (UNITS - d) / UNITS;
        assertEq(cc.commitOf(id).slashed, cut);
        assertEq(usdg.balanceOf(pool), cut);
        assertLe(cut, BOND);
    }

    // --- close -----------------------------------------------------------------------------------

    function test_close_needsFinalize() public {
        uint256 id = _post();
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.NotFinalized.selector, id));
        cc.close(id);
        vm.expectRevert(ICapacityCommit.UnknownCommit.selector);
        cc.close(77);
    }

    function test_close_releasesRemainingBondToProvider() public {
        uint256 id = _post();
        vm.warp(T0 + 5 days);
        _deliver(id, 90_000_000, T0, T0 + 5 days);
        _finalizeAt(id);
        uint256 cut = BOND / 10;
        uint256 before = usdg.balanceOf(prov);
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.Closed(id, prov, BOND - cut);
        vm.prank(rando);
        cc.close(id);
        assertEq(usdg.balanceOf(prov) - before, BOND - cut);
        assertEq(usdg.balanceOf(address(cc)), 0);
        assertEq(cc.openCapacityApiu(), 0);
        assertEq(uint8(cc.commitOf(id).status), uint8(ICapacityCommit.Status.Closed));
        vm.expectRevert(abi.encodeWithSelector(ICapacityCommit.NotFinalized.selector, id));
        cc.close(id);
    }

    function test_close_blockedWhileTheUnitsItBackedAreOutstanding() public {
        uint256 id = _post();
        vm.warp(T0 + 5 days);
        _mint(id, 30e18);
        _deliver(id, UNITS, T0, T0 + 5 days);
        _finalizeAt(id);
        vm.expectRevert(ICapacityCommit.SupplyExceedsOpenCapacity.selector);
        cc.close(id);
        // Holders redeem part of it: still blocked until all 30 are gone.
        vm.prank(buyer);
        apiu.redeem(29e18);
        vm.expectRevert(ICapacityCommit.SupplyExceedsOpenCapacity.selector);
        cc.close(id);
        vm.prank(buyer);
        apiu.redeem(1e18);
        cc.close(id);
        assertEq(usdg.balanceOf(prov), 1_000_000e6);
        assertEq(cc.openCapacityApiu(), 0);
        assertEq(apiu.totalSupply(), 0);
    }

    function test_close_providerCanBuyBackAndRedeem() public {
        uint256 id = _post();
        vm.warp(T0 + 5 days);
        _mint(id, 10e18);
        _deliver(id, UNITS, T0, T0 + 5 days);
        _finalizeAt(id);
        vm.prank(buyer);
        apiu.transfer(prov, 10e18); // bought back on the open market
        vm.prank(prov);
        apiu.redeem(10e18);
        cc.close(id);
        assertEq(cc.openCapacityApiu(), 0);
    }

    function test_close_supplyOfAnotherCommitDoesNotBlockWhenItFitsItsCap() public {
        uint256 a = _post();
        vm.prank(prov2);
        uint256 b = cc.post(PID2, TPD, DAYS, BOND);
        _mint(a, 10e18); // will be redeemed
        vm.prank(prov2);
        cc.mint(b, buyer, 40e18);
        vm.prank(buyer);
        apiu.redeem(10e18);
        _finalizeAt(a);
        cc.close(a); // supply 40 <= remaining cap 80
        assertEq(cc.openCapacityApiu(), CAP);
        assertLe(apiu.totalSupply(), cc.openCapacityApiu());
    }

    // --- admin -----------------------------------------------------------------------------------

    function test_admin_onlyOwner() public {
        bytes memory nope = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando);
        vm.startPrank(rando);
        vm.expectRevert(nope);
        cc.setKeeper(rando);
        vm.expectRevert(nope);
        cc.setSlashRecipient(rando);
        vm.expectRevert(nope);
        cc.setDiscountBps(1);
        vm.expectRevert(nope);
        cc.setBondPerMillionUnits(1);
        vm.expectRevert(nope);
        cc.setReportGrace(2 hours);
        vm.expectRevert(nope);
        cc.setMintingPaused(true);
        vm.expectRevert(nope);
        cc.setProviderBond(IProviderBond(rando));
        vm.stopPrank();
    }

    function test_admin_setters() public {
        address k2 = makeAddr("k2");
        vm.startPrank(owner);
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.KeeperSet(k2);
        cc.setKeeper(k2);
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.DiscountSet(9_000);
        cc.setDiscountBps(9_000);
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.ReportGraceSet(2 hours);
        cc.setReportGrace(2 hours);
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.BondRateSet(5);
        cc.setBondPerMillionUnits(5);
        vm.expectEmit(true, true, true, true, address(cc));
        emit ICapacityCommit.MintingPausedSet(true);
        cc.setMintingPaused(true);
        vm.stopPrank();
        assertEq(cc.keeper(), k2);
        assertEq(cc.discountBps(), 9_000);
        assertEq(cc.reportGrace(), 2 hours);

        vm.startPrank(owner);
        vm.expectRevert(ICapacityCommit.ZeroAddress.selector);
        cc.setKeeper(address(0));
        vm.expectRevert(ICapacityCommit.ZeroAddress.selector);
        cc.setSlashRecipient(address(0));
        vm.expectRevert(ICapacityCommit.InvalidDiscount.selector);
        cc.setDiscountBps(0);
        vm.expectRevert(ICapacityCommit.InvalidDiscount.selector);
        cc.setDiscountBps(10_001);
        vm.expectRevert(ICapacityCommit.InvalidGrace.selector);
        cc.setReportGrace(30 minutes);
        vm.stopPrank();

        // The old keeper can no longer report.
        uint256 id = _post();
        vm.warp(T0 + 1 days);
        (uint256 idx, bytes32 root) = _anchorWindow(T0, T0 + 1 days, "k");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = id;
        us[0] = 1;
        vm.prank(keeper);
        vm.expectRevert(ICapacityCommit.NotKeeper.selector);
        cc.recordDelivery(idx, root, EVIDENCE, ids, us);
    }

    function test_apiu_onlyCapacityCommitCanMint() public {
        vm.prank(owner);
        vm.expectRevert(IAPIU.NotMinter.selector);
        apiu.mint(owner, 1);
        vm.prank(prov);
        vm.expectRevert(IAPIU.NotMinter.selector);
        apiu.mint(prov, 1);
    }

    // --- a full lifecycle ------------------------------------------------------------------------

    function test_lifecycle() public {
        uint256 id = _post();
        _mint(id, 60e18);
        vm.prank(buyer);
        apiu.transfer(rando, 20e18);
        vm.prank(rando);
        apiu.redeem(20e18);
        vm.warp(T0 + 4 days);
        _deliver(id, 50_000_000, T0, T0 + 4 days);
        vm.warp(T0 + 10 days);
        _deliver(id, 20_000_000, T0 + 4 days, T0 + 10 days);
        _finalizeAt(id);
        uint256 cut = BOND * 30_000_000 / UNITS;
        assertEq(usdg.balanceOf(pool), cut);
        vm.expectRevert(ICapacityCommit.SupplyExceedsOpenCapacity.selector);
        cc.close(id);
        vm.prank(buyer);
        apiu.redeem(40e18);
        cc.close(id);
        assertEq(apiu.totalSupply(), 0);
        assertEq(usdg.balanceOf(address(cc)), 0);
        assertEq(usdg.balanceOf(prov), 1_000_000e6 - cut);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {APIU} from "../src/APIU.sol";
import {CapacityCommit} from "../src/CapacityCommit.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {IAPIU} from "../src/interfaces/IAPIU.sol";
import {ICapacityCommit} from "../src/interfaces/ICapacityCommit.sol";
import {IReceiptAnchor} from "../src/interfaces/IReceiptAnchor.sol";

/// @dev Random providers post, mint, deliver, finalize and close while holders trade and redeem. Every
/// call is wrapped so a rejected call is just a no-op; the invariants are checked between calls.
contract CapacityHandler is Test {
    CapacityCommit public cc;
    APIU public apiu;
    MockUSDG public usdg;
    ReceiptAnchor public anchor;
    address public owner;
    address public keeper;
    address public anchorer;

    address[3] public providers;
    address[3] public holders;

    uint64 public lastAnchorTo;
    uint256 public ghostMinted;
    uint256 public ghostRedeemed;
    uint256 public ghostPosts;
    uint256 public ghostFinalized;
    uint256 public ghostClosed;
    uint256 public ghostBlockedClose;

    constructor(
        CapacityCommit cc_,
        APIU apiu_,
        MockUSDG usdg_,
        ReceiptAnchor anchor_,
        address owner_,
        address keeper_,
        address anchorer_
    ) {
        cc = cc_;
        apiu = apiu_;
        usdg = usdg_;
        anchor = anchor_;
        owner = owner_;
        keeper = keeper_;
        anchorer = anchorer_;
        lastAnchorTo = uint64(block.timestamp);
        for (uint256 i; i < 3; ++i) {
            providers[i] = makeAddr(string.concat("p", vm.toString(i)));
            holders[i] = makeAddr(string.concat("h", vm.toString(i)));
            vm.prank(providers[i]);
            usdg.approve(address(cc), type(uint256).max);
        }
    }

    /// @dev A pseudo-random share (1%..100%, at least 1) of `whole`; the fuzzer likes tiny inputs.
    function _share(uint256 whole, uint256 seed) internal pure returns (uint256) {
        uint256 v = whole * (1 + seed % 100) / 100;
        return v == 0 ? 1 : v;
    }

    function post(uint256 who, uint256 tpd, uint256 dayCount) external {
        address p = providers[who % 3];
        tpd = 1_000_000 * (1 + tpd % 1_000); // 1M..1B token-units per day
        dayCount = 1 + dayCount % 4;
        uint256 required = (tpd * dayCount * cc.bondPerMillionUnits() + 999_999) / 1_000_000;
        uint256 bond = required == 0 ? 1 : required;
        usdg.mint(p, bond);
        vm.prank(p);
        try cc.post(bytes32(uint256(uint160(p)) + who), uint128(tpd), uint32(dayCount), bond) {
            ++ghostPosts;
        } catch {}
    }

    function mint(uint256 sel, uint256 who, uint256 amount, bool overshoot) external {
        uint256 n = cc.commitCount();
        if (n == 0) return;
        uint256 id = (sel % n) + 1;
        ICapacityCommit.Commit memory c = cc.commitOf(id);
        uint256 room = cc.mintableOf(id);
        amount = overshoot ? room + 1 + amount % 1e18 : _share(room, amount);
        vm.prank(c.provider);
        try cc.mint(id, holders[who % 3], amount) {
            ghostMinted += amount;
        } catch {}
    }

    function transfer(uint256 from, uint256 to, uint256 amount) external {
        address a = holders[from % 3];
        uint256 bal = apiu.balanceOf(a);
        if (bal == 0) return;
        vm.prank(a);
        apiu.transfer(holders[to % 3], _share(bal, amount));
    }

    function redeem(uint256 who, uint256 amount) external {
        address a = holders[who % 3];
        uint256 bal = apiu.balanceOf(a);
        if (bal == 0) return;
        amount = _share(bal, amount);
        vm.prank(a);
        apiu.redeem(amount);
        ghostRedeemed += amount;
    }

    function redeemFromProvider(uint256 who, uint256 amount) external {
        // Providers can also hold APIU (buy-back) and redeem it.
        address a = holders[who % 3];
        uint256 bal = apiu.balanceOf(a);
        if (bal == 0) return;
        amount = _share(bal, amount);
        vm.prank(a);
        apiu.transfer(providers[who % 3], amount);
        vm.prank(providers[who % 3]);
        apiu.redeem(amount);
        ghostRedeemed += amount;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + 1 hours + secs % 4 days);
    }

    function deliver(uint256 sel, uint256 units) external {
        uint256 n = cc.commitCount();
        if (n == 0 || block.timestamp <= lastAnchorTo) return;
        uint256 id = (sel % n) + 1;
        bytes32 root = keccak256(abi.encode("root", lastAnchorTo, block.timestamp));
        vm.prank(anchorer);
        uint256 idx = anchor.anchor(root, lastAnchorTo, uint64(block.timestamp), 1);
        lastAnchorTo = uint64(block.timestamp);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory us = new uint256[](1);
        ids[0] = id;
        us[0] = (units % 3 == 0) ? 0 : (units % 2 == 0 ? units % 1e12 : 1e8 * (units % 100));
        vm.prank(keeper);
        try cc.recordDelivery(idx, root, bytes32(0), ids, us) {} catch {}
    }

    function finalize(uint256 sel) external {
        uint256 n = cc.commitCount();
        if (n == 0) return;
        // Prefer a commitment that is ready; otherwise poke a random one (which should revert).
        uint256 id = _pick(sel, ICapacityCommit.Status.Open, true);
        try cc.finalize(id) {
            ++ghostFinalized;
        } catch {}
    }

    function close(uint256 sel) external {
        uint256 n = cc.commitCount();
        if (n == 0) return;
        uint256 id = _pick(sel, ICapacityCommit.Status.Finalized, false);
        try cc.close(id) {
            ++ghostClosed;
        } catch (bytes memory err) {
            if (bytes4(err) == ICapacityCommit.SupplyExceedsOpenCapacity.selector) ++ghostBlockedClose;
        }
    }

    /// @dev The first commitment at or after `sel` (wrapping) with `status` (and past its grace when
    /// `ready`), or `sel` itself when there is none.
    function _pick(uint256 sel, ICapacityCommit.Status status, bool ready) internal view returns (uint256) {
        uint256 n = cc.commitCount();
        for (uint256 k; k < n; ++k) {
            uint256 id = ((sel + k) % n) + 1;
            ICapacityCommit.Commit memory c = cc.commitOf(id);
            if (c.status != status) continue;
            if (ready && block.timestamp < uint256(c.endTs) + cc.reportGrace()) continue;
            return id;
        }
        return (sel % n) + 1;
    }

    function setDiscount(uint256 bps) external {
        vm.prank(owner);
        cc.setDiscountBps(uint16(bound(bps, 1, 10_000)));
    }

    function setBondRate(uint256 rate) external {
        vm.prank(owner);
        cc.setBondPerMillionUnits(bound(rate, 0, 10e6));
    }

    function pause(uint256 seed) external {
        // Mostly unpaused, so minting keeps happening.
        vm.prank(owner);
        cc.setMintingPaused(seed % 6 == 0);
    }
}

contract CapacityCommitInvariantTest is Test {
    CapacityHandler internal h;
    CapacityCommit internal cc;
    APIU internal apiu;
    MockUSDG internal usdg;

    function setUp() public {
        vm.warp(1_750_000_000);
        address owner = makeAddr("owner");
        address keeper = makeAddr("keeper");
        address anchorer = makeAddr("anchorer");
        usdg = new MockUSDG();
        apiu = new APIU(owner);
        ReceiptAnchor anchor = new ReceiptAnchor(owner, anchorer);
        cc = new CapacityCommit(
            IERC20(address(usdg)),
            IAPIU(address(apiu)),
            IReceiptAnchor(address(anchor)),
            owner,
            keeper,
            makeAddr("pool"),
            8_000,
            100_000,
            1 days
        );
        vm.prank(owner);
        apiu.setMinter(address(cc));
        h = new CapacityHandler(cc, apiu, usdg, anchor, owner, keeper, anchorer);
        targetContract(address(h));
    }

    /// @dev The headline rule: APIU supply never exceeds the open committed capacity.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 96
    function invariant_supplyNeverExceedsOpenCapacity() public view {
        assertLe(apiu.totalSupply(), cc.openCapacityApiu());
    }

    /// @dev Open capacity is exactly the caps of the commitments that are not closed, and each cap is
    /// at most the committed token-units expressed in APIU.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 96
    function invariant_openCapacityIsTheSumOfOpenCaps() public view {
        uint256 sum;
        uint256 n = cc.commitCount();
        for (uint256 id = 1; id <= n; ++id) {
            ICapacityCommit.Commit memory c = cc.commitOf(id);
            if (c.status != ICapacityCommit.Status.Closed) sum += c.capApiu;
            assertLe(c.mintedApiu, c.capApiu);
            assertLe(c.capApiu, cc.totalUnitsOf(id) * 1e12);
            assertLe(c.deliveredUnits, cc.totalUnitsOf(id));
            assertLe(c.slashed, c.bond);
        }
        assertEq(cc.openCapacityApiu(), sum);
    }

    /// @dev Supply is what was minted through CapacityCommit minus what was redeemed.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 96
    function invariant_supplyIsMintedMinusRedeemed() public view {
        assertEq(apiu.totalSupply(), h.ghostMinted() - h.ghostRedeemed());
        uint256 minted;
        uint256 n = cc.commitCount();
        for (uint256 id = 1; id <= n; ++id) {
            minted += cc.commitOf(id).mintedApiu;
        }
        assertEq(minted, h.ghostMinted());
    }

    /// @dev The contract holds exactly the bonds that have not been released or slashed.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 96
    function invariant_bondCustody() public view {
        uint256 held;
        uint256 n = cc.commitCount();
        for (uint256 id = 1; id <= n; ++id) {
            ICapacityCommit.Commit memory c = cc.commitOf(id);
            if (c.status == ICapacityCommit.Status.Open) held += c.bond;
            else if (c.status == ICapacityCommit.Status.Finalized) held += c.bond - c.slashed;
        }
        assertEq(usdg.balanceOf(address(cc)), held);
    }
}

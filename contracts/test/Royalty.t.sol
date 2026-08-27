// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Royalty} from "../src/Royalty.sol";
import {IRoyalty} from "../src/interfaces/IRoyalty.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

contract RoyaltyTest is Test {
    MockUSDG internal usdg;
    Royalty internal royalty;
    address internal owner = makeAddr("owner");
    address internal registrar = makeAddr("registrar");
    address internal settlement = makeAddr("settlement");
    address internal creator = makeAddr("creator");
    address internal creator2 = makeAddr("creator2");
    address internal sink = makeAddr("sink");

    bytes32 internal constant M1 = keccak256("org/llama-ft-1");
    bytes32 internal constant M2 = keccak256("org/qwen-ft-2");

    function setUp() public {
        usdg = new MockUSDG();
        royalty = new Royalty(IERC20(address(usdg)), owner, registrar, settlement);
        usdg.mint(settlement, 10_000_000e6);
        vm.prank(settlement);
        usdg.approve(address(royalty), type(uint256).max);
    }

    function _register(bytes32 m, address c, uint16 bps) internal {
        vm.prank(registrar);
        royalty.register(m, c, bps);
    }

    function _stream(bytes32 m, uint256 amt) internal {
        vm.prank(settlement);
        royalty.stream(m, amt);
    }

    // --- constructor ---------------------------------------------------------------------------

    function test_constructor() public view {
        assertEq(address(royalty.usdg()), address(usdg));
        assertEq(royalty.owner(), owner);
        assertEq(royalty.registrar(), registrar);
        assertEq(royalty.settlement(), settlement);
        assertEq(royalty.MAX_BPS(), 2000);
    }

    function test_constructor_emits() public {
        vm.expectEmit(true, true, true, true);
        emit Royalty.RegistrarSet(registrar);
        vm.expectEmit(true, true, true, true);
        emit Royalty.SettlementSet(settlement);
        new Royalty(IERC20(address(usdg)), owner, registrar, settlement);
    }

    function test_constructor_revertsZeros() public {
        vm.expectRevert(Royalty.ZeroAddress.selector);
        new Royalty(IERC20(address(0)), owner, registrar, settlement);
        vm.expectRevert(Royalty.ZeroAddress.selector);
        new Royalty(IERC20(address(usdg)), owner, address(0), settlement);
        vm.expectRevert(Royalty.ZeroAddress.selector);
        new Royalty(IERC20(address(usdg)), owner, registrar, address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new Royalty(IERC20(address(usdg)), address(0), registrar, settlement);
    }

    // --- register ------------------------------------------------------------------------------

    function test_register() public {
        vm.expectEmit(true, true, true, true, address(royalty));
        emit IRoyalty.Registered(M1, creator, 1500);
        _register(M1, creator, 1500);
        (address c, uint16 bps, uint256 total) = royalty.models(M1);
        assertEq(c, creator);
        assertEq(bps, 1500);
        assertEq(total, 0);
    }

    function test_register_maxBpsOk() public {
        _register(M1, creator, 2000);
        (, uint16 bps,) = royalty.models(M1);
        assertEq(bps, 2000);
    }

    function test_register_zeroBpsOk() public {
        _register(M1, creator, 0);
        (address c,,) = royalty.models(M1);
        assertEq(c, creator);
    }

    function test_register_revertsBpsTooHigh() public {
        vm.prank(registrar);
        vm.expectRevert(IRoyalty.BpsTooHigh.selector);
        royalty.register(M1, creator, 2001);
    }

    function test_register_revertsNotRegistrar() public {
        vm.prank(owner);
        vm.expectRevert(IRoyalty.NotRegistrar.selector);
        royalty.register(M1, creator, 100);
    }

    function test_register_revertsZeroCreator() public {
        vm.prank(registrar);
        vm.expectRevert(Royalty.ZeroAddress.selector);
        royalty.register(M1, address(0), 100);
    }

    function test_register_reRegisterUpdatesAndKeepsTotals() public {
        _register(M1, creator, 1000);
        _stream(M1, 100e6);
        vm.expectEmit(true, true, true, true, address(royalty));
        emit IRoyalty.Registered(M1, creator2, 500);
        _register(M1, creator2, 500);
        (address c, uint16 bps, uint256 total) = royalty.models(M1);
        assertEq(c, creator2);
        assertEq(bps, 500);
        assertEq(total, 100e6);
        // accrued stays with the previous creator; new streams go to the new one
        assertEq(royalty.claimable(creator), 100e6);
        _stream(M1, 7e6);
        assertEq(royalty.claimable(creator2), 7e6);
        assertEq(royalty.claimable(creator), 100e6);
    }

    function testFuzz_register(bytes32 m, address c, uint16 bps) public {
        vm.assume(c != address(0));
        vm.prank(registrar);
        if (bps > 2000) {
            vm.expectRevert(IRoyalty.BpsTooHigh.selector);
            royalty.register(m, c, bps);
        } else {
            royalty.register(m, c, bps);
            (address cc, uint16 b,) = royalty.models(m);
            assertEq(cc, c);
            assertEq(b, bps);
        }
    }

    // --- transferCreator -----------------------------------------------------------------------

    function test_transferCreator() public {
        _register(M1, creator, 1000);
        _stream(M1, 10e6);
        vm.expectEmit(true, true, true, true, address(royalty));
        emit IRoyalty.CreatorUpdated(M1, creator2);
        vm.prank(creator);
        royalty.transferCreator(M1, creator2);
        (address c, uint16 bps,) = royalty.models(M1);
        assertEq(c, creator2);
        assertEq(bps, 1000);
        _stream(M1, 5e6);
        assertEq(royalty.claimable(creator), 10e6);
        assertEq(royalty.claimable(creator2), 5e6);
        // old creator lost control
        vm.prank(creator);
        vm.expectRevert(IRoyalty.NotCreator.selector);
        royalty.transferCreator(M1, creator);
    }
}

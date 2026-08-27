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
}

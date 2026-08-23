// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CallPay} from "../src/CallPay.sol";
import {ICallPay} from "../src/interfaces/ICallPay.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockUSDG3009} from "../src/mocks/MockUSDG3009.sol";

contract CallPayTest is Test {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MockUSDG internal usdg;
    CallPay internal callPay;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal payer;
    uint256 internal payerPk;
    address internal other = makeAddr("other");

    function setUp() public {
        vm.warp(1_750_000_000);
        (payer, payerPk) = makeAddrAndKey("payer");
        usdg = new MockUSDG();
        callPay = new CallPay(IERC20(address(usdg)), treasury, owner);
        usdg.mint(payer, 1_000_000e6);
        usdg.mint(other, 1_000_000e6);
        vm.prank(payer);
        usdg.approve(address(callPay), type(uint256).max);
        vm.prank(other);
        usdg.approve(address(callPay), type(uint256).max);
    }

    function _permit(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, payer, address(callPay), value, usdg.nonces(payer), deadline));
        (v, r, s) = vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));
    }

    // --- constructor ---------------------------------------------------------------------------

    function test_constructor_setsState() public view {
        assertEq(callPay.usdg(), address(usdg));
        assertEq(callPay.treasury(), treasury);
        assertEq(callPay.owner(), owner);
    }

    function test_constructor_emitsTreasurySet() public {
        vm.expectEmit(true, true, true, true);
        emit ICallPay.TreasurySet(treasury);
        new CallPay(IERC20(address(usdg)), treasury, owner);
    }

    function test_constructor_revertsZeroUsdg() public {
        vm.expectRevert(CallPay.ZeroAddress.selector);
        new CallPay(IERC20(address(0)), treasury, owner);
    }

    function test_constructor_revertsZeroTreasury() public {
        vm.expectRevert(CallPay.ZeroAddress.selector);
        new CallPay(IERC20(address(usdg)), address(0), owner);
    }

    function test_constructor_revertsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new CallPay(IERC20(address(usdg)), treasury, address(0));
    }

    // --- pay -----------------------------------------------------------------------------------

    function test_pay_transfersToTreasuryAndRecords() public {
        bytes32 nonce = keccak256("quote-1");
        uint256 before = usdg.balanceOf(payer);
        vm.expectEmit(true, true, true, true, address(callPay));
        emit ICallPay.Paid(nonce, payer, 1_234_567);
        vm.prank(payer);
        callPay.pay(nonce, 1_234_567, block.timestamp + 60);
        assertEq(usdg.balanceOf(treasury), 1_234_567);
        assertEq(usdg.balanceOf(payer), before - 1_234_567);
        assertEq(usdg.balanceOf(address(callPay)), 0);
        (address p, uint256 a) = callPay.paid(nonce);
        assertEq(p, payer);
        assertEq(a, 1_234_567);
    }
}

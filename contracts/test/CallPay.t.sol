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

    function test_pay_expiryEqualNowOk() public {
        vm.prank(payer);
        callPay.pay(bytes32(uint256(1)), 1, block.timestamp);
        (address p,) = callPay.paid(bytes32(uint256(1)));
        assertEq(p, payer);
    }

    function test_pay_revertsExpired() public {
        vm.prank(payer);
        vm.expectRevert(ICallPay.Expired.selector);
        callPay.pay(bytes32(uint256(1)), 1, block.timestamp - 1);
    }

    function test_pay_revertsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(ICallPay.InvalidAmount.selector);
        callPay.pay(bytes32(uint256(1)), 0, block.timestamp);
    }

    function test_pay_revertsNonceUsedSamePayer() public {
        vm.startPrank(payer);
        callPay.pay(bytes32(uint256(1)), 5, block.timestamp);
        vm.expectRevert(ICallPay.NonceUsed.selector);
        callPay.pay(bytes32(uint256(1)), 5, block.timestamp);
        vm.stopPrank();
    }

    function test_pay_revertsNonceUsedOtherPayer() public {
        vm.prank(payer);
        callPay.pay(bytes32(uint256(1)), 5, block.timestamp);
        vm.prank(other);
        vm.expectRevert(ICallPay.NonceUsed.selector);
        callPay.pay(bytes32(uint256(1)), 7, block.timestamp);
    }

    function test_pay_revertsWithoutAllowance() public {
        address poor = makeAddr("poor");
        usdg.mint(poor, 10);
        vm.prank(poor);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(callPay), 0, 10)
        );
        callPay.pay(bytes32(uint256(1)), 10, block.timestamp);
    }

    function test_pay_revertsInsufficientBalance() public {
        address poor = makeAddr("poor");
        usdg.mint(poor, 9);
        vm.prank(poor);
        usdg.approve(address(callPay), 10);
        vm.prank(poor);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, poor, 9, 10));
        callPay.pay(bytes32(uint256(1)), 10, block.timestamp);
        (address p,) = callPay.paid(bytes32(uint256(1)));
        assertEq(p, address(0)); // state rolled back, nonce still usable
    }

    function test_paid_unknownNonceIsZero() public view {
        (address p, uint256 a) = callPay.paid(keccak256("nope"));
        assertEq(p, address(0));
        assertEq(a, 0);
    }

    function testFuzz_pay(bytes32 nonce, uint256 amount, uint256 ttl) public {
        amount = bound(amount, 1, 1_000_000e6);
        ttl = bound(ttl, 0, 365 days);
        vm.prank(payer);
        callPay.pay(nonce, amount, block.timestamp + ttl);
        assertEq(usdg.balanceOf(treasury), amount);
        (address p, uint256 a) = callPay.paid(nonce);
        assertEq(p, payer);
        assertEq(a, amount);
        vm.prank(other);
        vm.expectRevert(ICallPay.NonceUsed.selector);
        callPay.pay(nonce, amount, block.timestamp + ttl);
    }

    function testFuzz_pay_manyNonces(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 1, 30));
        uint256 total;
        for (uint256 i; i < n; ++i) {
            uint256 amt = bound(uint256(keccak256(abi.encode(seed, i))), 1, 10_000e6);
            total += amt;
            vm.prank(i % 2 == 0 ? payer : other);
            callPay.pay(keccak256(abi.encode(seed, "nonce", i)), amt, block.timestamp);
        }
        assertEq(usdg.balanceOf(treasury), total);
    }

    // --- payWithPermit -------------------------------------------------------------------------

    function test_payWithPermit_works() public {
        vm.prank(payer);
        usdg.approve(address(callPay), 0);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(50e6, dl);
        vm.expectEmit(true, true, true, true, address(callPay));
        emit ICallPay.Paid(bytes32(uint256(9)), payer, 50e6);
        vm.prank(payer);
        callPay.payWithPermit(bytes32(uint256(9)), 50e6, block.timestamp, dl, v, r, s);
        assertEq(usdg.balanceOf(treasury), 50e6);
        assertEq(usdg.allowance(payer, address(callPay)), 0);
    }

    function test_payWithPermit_frontRunPermitStillPays() public {
        vm.prank(payer);
        usdg.approve(address(callPay), 0);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(50e6, dl);
        vm.prank(other);
        usdg.permit(payer, address(callPay), 50e6, dl, v, r, s);
        vm.prank(payer);
        callPay.payWithPermit(bytes32(uint256(9)), 50e6, block.timestamp, dl, v, r, s);
        assertEq(usdg.balanceOf(treasury), 50e6);
    }

    function test_payWithPermit_badPermitNoAllowanceReverts() public {
        vm.prank(payer);
        usdg.approve(address(callPay), 0);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(callPay), 0, 50e6)
        );
        callPay.payWithPermit(bytes32(uint256(9)), 50e6, block.timestamp, block.timestamp, 27, bytes32(0), bytes32(0));
    }

    function test_payWithPermit_revertsNonceUsed() public {
        vm.prank(payer);
        callPay.pay(bytes32(uint256(9)), 1, block.timestamp);
        vm.prank(payer);
        vm.expectRevert(ICallPay.NonceUsed.selector);
        callPay.payWithPermit(bytes32(uint256(9)), 1, block.timestamp, block.timestamp, 0, 0, 0);
    }

    function test_payWithPermit_revertsExpired() public {
        vm.prank(payer);
        vm.expectRevert(ICallPay.Expired.selector);
        callPay.payWithPermit(bytes32(uint256(9)), 1, block.timestamp - 1, block.timestamp, 0, 0, 0);
    }

    function test_payWithPermit_revertsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(ICallPay.InvalidAmount.selector);
        callPay.payWithPermit(bytes32(uint256(9)), 0, block.timestamp, block.timestamp, 0, 0, 0);
    }

    // --- admin ---------------------------------------------------------------------------------

    function test_setTreasury() public {
        address t2 = makeAddr("t2");
        vm.expectEmit(true, true, true, true, address(callPay));
        emit ICallPay.TreasurySet(t2);
        vm.prank(owner);
        callPay.setTreasury(t2);
        assertEq(callPay.treasury(), t2);
        vm.prank(payer);
        callPay.pay(bytes32(uint256(1)), 3, block.timestamp);
        assertEq(usdg.balanceOf(t2), 3);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    function test_setTreasury_onlyOwner() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payer));
        callPay.setTreasury(payer);
    }

    function test_setTreasury_revertsZero() public {
        vm.prank(owner);
        vm.expectRevert(CallPay.ZeroAddress.selector);
        callPay.setTreasury(address(0));
    }

    function test_ownership_twoStep() public {
        address n = makeAddr("newOwner");
        vm.prank(owner);
        callPay.transferOwnership(n);
        assertEq(callPay.owner(), owner);
        vm.prank(n);
        callPay.acceptOwnership();
        assertEq(callPay.owner(), n);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        callPay.setTreasury(owner);
    }
}

contract CallPayAuthorizationTest is Test {
    bytes32 internal constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    MockUSDG3009 internal usdg;
    CallPay internal callPay;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal relayer = makeAddr("relayer");
    address internal attacker = makeAddr("attacker");
    address internal payer;
    uint256 internal payerPk;

    uint256 internal constant T0 = 1_750_000_000;
    bytes32 internal constant QUOTE = keccak256("quote-3009");

    function setUp() public {
        vm.warp(T0);
        (payer, payerPk) = makeAddrAndKey("payer");
        usdg = new MockUSDG3009();
        callPay = new CallPay(IERC20(address(usdg)), treasury, owner);
        usdg.mint(payer, 1_000e6);
        usdg.mint(attacker, 1_000e6);
    }

    function _auth(uint256 pk, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 n)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(RWA_TYPEHASH, from, to, value, validAfter, validBefore, n));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _sig(uint256 amount) internal view returns (bytes memory) {
        return _auth(payerPk, payer, address(callPay), amount, T0 - 1, T0 + 300, QUOTE);
    }

    function test_payWithAuthorization_paysTreasury() public {
        bytes memory sig = _sig(25e6);
        vm.expectEmit(true, true, true, true, address(callPay));
        emit ICallPay.Paid(QUOTE, payer, 25e6);
        vm.prank(relayer);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0 - 1, T0 + 300, sig);
        assertEq(usdg.balanceOf(treasury), 25e6);
        assertEq(usdg.balanceOf(payer), 975e6);
        assertEq(usdg.balanceOf(address(callPay)), 0);
        assertEq(usdg.balanceOf(relayer), 0);
        (address p, uint256 a) = callPay.paid(QUOTE);
        assertEq(p, payer);
        assertEq(a, 25e6);
        assertTrue(usdg.authorizationState(payer, QUOTE));
    }

    function test_payWithAuthorization_replayFails() public {
        bytes memory sig = _sig(25e6);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0 - 1, T0 + 300, sig);
        vm.expectRevert(ICallPay.NonceUsed.selector);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0 - 1, T0 + 300, sig);
        assertEq(usdg.balanceOf(treasury), 25e6);
    }

    function test_payWithAuthorization_signatureBoundToQuoteNonce() public {
        bytes memory sig = _sig(25e6);
        vm.expectRevert(MockUSDG3009.InvalidSignature.selector);
        callPay.payWithAuthorization(keccak256("other-quote"), 25e6, T0 + 60, payer, T0 - 1, T0 + 300, sig);
    }

    function test_payWithAuthorization_tamperedAmountFails() public {
        bytes memory sig = _sig(25e6);
        vm.expectRevert(MockUSDG3009.InvalidSignature.selector);
        callPay.payWithAuthorization(QUOTE, 26e6, T0 + 60, payer, T0 - 1, T0 + 300, sig);
    }

    function test_payWithAuthorization_wrongFromFails() public {
        bytes memory sig = _sig(25e6);
        vm.expectRevert(MockUSDG3009.InvalidSignature.selector);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, attacker, T0 - 1, T0 + 300, sig);
    }

    function test_payWithAuthorization_thirdPartyCannotRedirect() public {
        bytes memory sig = _sig(25e6);
        // calling USDG directly with to = CallPay: caller must be the payee
        vm.prank(attacker);
        vm.expectRevert(MockUSDG3009.CallerMustBePayee.selector);
        usdg.receiveWithAuthorization(payer, address(callPay), 25e6, T0 - 1, T0 + 300, QUOTE, sig);
        // calling USDG directly with to = attacker: signature does not cover that recipient
        vm.prank(attacker);
        vm.expectRevert(MockUSDG3009.InvalidSignature.selector);
        usdg.receiveWithAuthorization(payer, attacker, 25e6, T0 - 1, T0 + 300, QUOTE, sig);
        // a signature made out to another recipient can't be consumed through CallPay
        bytes memory toAttacker = _auth(payerPk, payer, attacker, 25e6, T0 - 1, T0 + 300, QUOTE);
        vm.expectRevert(MockUSDG3009.InvalidSignature.selector);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0 - 1, T0 + 300, toAttacker);
        assertEq(usdg.balanceOf(attacker), 1_000e6);
        assertFalse(usdg.authorizationState(payer, QUOTE));
    }

    function test_payWithAuthorization_frontRunSubmitterIsHarmless() public {
        bytes memory sig = _sig(25e6);
        vm.prank(attacker); // someone else submits the relayer's payload first
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0 - 1, T0 + 300, sig);
        (address p,) = callPay.paid(QUOTE);
        assertEq(p, payer); // payer is the signer, never the submitter
        assertEq(usdg.balanceOf(treasury), 25e6);
        assertEq(usdg.balanceOf(attacker), 1_000e6);
    }

    function test_payWithAuthorization_quoteExpired() public {
        bytes memory sig = _sig(25e6);
        vm.expectRevert(ICallPay.Expired.selector);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 - 1, payer, T0 - 1, T0 + 300, sig);
    }

    function test_payWithAuthorization_authorizationExpired() public {
        bytes memory sig = _auth(payerPk, payer, address(callPay), 25e6, T0 - 10, T0, QUOTE);
        vm.expectRevert(MockUSDG3009.AuthorizationExpired.selector);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0 - 10, T0, sig);
    }

    function test_payWithAuthorization_authorizationNotYetValid() public {
        bytes memory sig = _auth(payerPk, payer, address(callPay), 25e6, T0, T0 + 300, QUOTE);
        vm.expectRevert(MockUSDG3009.AuthorizationNotYetValid.selector);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0, T0 + 300, sig);
        (address p,) = callPay.paid(QUOTE);
        assertEq(p, address(0)); // rolled back
        vm.warp(T0 + 1);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0, T0 + 300, sig);
        assertEq(usdg.balanceOf(treasury), 25e6);
    }

    function test_payWithAuthorization_nonceUsedByPayFirst() public {
        vm.prank(attacker);
        usdg.approve(address(callPay), type(uint256).max);
        vm.prank(attacker);
        callPay.pay(QUOTE, 1, T0);
        bytes memory sig = _sig(25e6);
        vm.expectRevert(ICallPay.NonceUsed.selector);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0 - 1, T0 + 300, sig);
    }

    function test_pay_nonceUsedByAuthorizationFirst() public {
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0 - 1, T0 + 300, _sig(25e6));
        vm.prank(payer);
        usdg.approve(address(callPay), type(uint256).max);
        vm.prank(payer);
        vm.expectRevert(ICallPay.NonceUsed.selector);
        callPay.pay(QUOTE, 25e6, T0);
    }

    function test_payWithAuthorization_authorizationNonceAlreadyUsedElsewhere() public {
        // the payer already spent this authorization nonce in another receiveWithAuthorization
        address other = makeAddr("otherPayee");
        bytes memory sigOther = _auth(payerPk, payer, other, 1e6, T0 - 1, T0 + 300, QUOTE);
        vm.prank(other);
        usdg.receiveWithAuthorization(payer, other, 1e6, T0 - 1, T0 + 300, QUOTE, sigOther);
        bytes memory sig = _sig(25e6);
        vm.expectRevert(MockUSDG3009.AuthorizationAlreadyUsed.selector);
        callPay.payWithAuthorization(QUOTE, 25e6, T0 + 60, payer, T0 - 1, T0 + 300, sig);
    }

    function test_payWithAuthorization_revertsZeroAmount() public {
        bytes memory sig = _sig(0);
        vm.expectRevert(ICallPay.InvalidAmount.selector);
        callPay.payWithAuthorization(QUOTE, 0, T0 + 60, payer, T0 - 1, T0 + 300, sig);
    }

    function test_payWithAuthorization_revertsZeroFrom() public {
        bytes memory sig = _sig(1);
        vm.expectRevert(CallPay.ZeroAddress.selector);
        callPay.payWithAuthorization(QUOTE, 1, T0 + 60, address(0), T0 - 1, T0 + 300, sig);
    }

    function test_payWithAuthorization_insufficientBalance() public {
        bytes memory sig = _sig(1_001e6);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, payer, 1_000e6, 1_001e6));
        callPay.payWithAuthorization(QUOTE, 1_001e6, T0 + 60, payer, T0 - 1, T0 + 300, sig);
    }

    function test_payWithAuthorization_malformedSignature() public {
        vm.expectRevert(MockUSDG3009.InvalidSignature.selector);
        callPay.payWithAuthorization(QUOTE, 1, T0 + 60, payer, T0 - 1, T0 + 300, hex"deadbeef");
    }

    function testFuzz_payWithAuthorization(uint256 pk, uint256 amount, bytes32 quote) public {
        pk = bound(pk, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        amount = bound(amount, 1, 1_000_000e6);
        address from = vm.addr(pk);
        usdg.mint(from, amount);
        bytes memory sig = _auth(pk, from, address(callPay), amount, T0 - 1, T0 + 1, quote);
        vm.prank(relayer);
        callPay.payWithAuthorization(quote, amount, T0, from, T0 - 1, T0 + 1, sig);
        (address p, uint256 a) = callPay.paid(quote);
        assertEq(p, from);
        assertEq(a, amount);
        assertEq(usdg.balanceOf(treasury), amount);
        assertEq(usdg.balanceOf(address(callPay)), 0);
    }
}

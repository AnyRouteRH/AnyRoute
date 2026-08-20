// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {AnyrPaymaster} from "../src/AnyrPaymaster.sol";

/// @dev Minimal ERC-4337 account: accepts any op from the EntryPoint (the paymaster is what is under test).
contract TestAccount is IAccount {
    IEntryPoint public immutable ep;
    uint256 public counter;

    error Boom();

    constructor(IEntryPoint ep_) {
        ep = ep_;
    }

    function validateUserOp(PackedUserOperation calldata, bytes32, uint256 missingAccountFunds)
        external
        returns (uint256)
    {
        require(msg.sender == address(ep), "not ep");
        if (missingAccountFunds != 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok;
        }
        return 0;
    }

    function bump() external {
        require(msg.sender == address(ep), "not ep");
        counter += 1;
    }

    function fail() external pure {
        revert Boom();
    }

    receive() external payable {}
}

contract AnyrPaymasterTest is Test {
    EntryPoint ep;
    AnyrPaymaster pm;
    TestAccount account;

    address owner = makeAddr("owner");
    address bundler = makeAddr("bundler");
    address stranger = makeAddr("stranger");
    address signer;
    uint256 signerPk;

    uint128 constant VERIF_GAS = 150_000;
    uint128 constant CALL_GAS = 100_000;
    uint128 constant PM_VERIF_GAS = 150_000;
    uint128 constant PM_POSTOP_GAS = 60_000;
    uint256 constant PVG = 50_000;
    uint128 constant FEE = 1 gwei;
    uint256 constant MAX_COST = (uint256(VERIF_GAS) + CALL_GAS + PM_VERIF_GAS + PM_POSTOP_GAS + PVG) * FEE;

    uint256 constant T0 = 1_750_000_000; // mid-day UTC

    function setUp() public {
        vm.warp(T0);
        (signer, signerPk) = makeAddrAndKey("routerSigner");
        ep = new EntryPoint();
        pm = new AnyrPaymaster(IEntryPoint(address(ep)), signer, 3 * MAX_COST, owner);
        account = new TestAccount(IEntryPoint(address(ep)));
        vm.deal(owner, 100 ether);
        vm.prank(owner);
        pm.deposit{value: 10 ether}();
    }

    // ------------------------------------------------------------------ helpers

    function _op(bytes memory callData, uint256 nonceOffset)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = address(account);
        op.nonce = ep.getNonce(address(account), 0) + nonceOffset;
        op.initCode = "";
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(VERIF_GAS) << 128) | uint256(CALL_GAS));
        op.preVerificationGas = PVG;
        op.gasFees = bytes32((uint256(FEE) << 128) | uint256(FEE));
        op.signature = "";
    }

    function _sponsor(PackedUserOperation memory op, uint48 validUntil, uint48 validAfter, uint256 pk)
        internal
        view
        returns (PackedUserOperation memory)
    {
        op.paymasterAndData =
            abi.encodePacked(address(pm), PM_VERIF_GAS, PM_POSTOP_GAS, abi.encode(validUntil, validAfter));
        bytes32 h = pm.getHash(op, validUntil, validAfter);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, r, s, v);
        return op;
    }

    function _bumpOp(uint256 nonceOffset) internal view returns (PackedUserOperation memory) {
        return _sponsor(
            _op(abi.encodeCall(TestAccount.bump, ()), nonceOffset),
            uint48(block.timestamp + 10 minutes),
            uint48(block.timestamp - 1),
            signerPk
        );
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));
    }

    function _usage() internal view returns (uint64 day, uint256 spent) {
        (day, spent) = pm.usage(address(account));
    }

    // ------------------------------------------------------------------ sponsorship

    function test_constructorState() public view {
        assertEq(address(pm.entryPoint()), address(ep));
        assertEq(pm.verifyingSigner(), signer);
        assertEq(pm.dailyCap(), 3 * MAX_COST);
        assertEq(pm.owner(), owner);
        assertEq(ep.balanceOf(address(pm)), 10 ether);
    }

    function test_sponsoredOpExecutesAndReconciles() public {
        uint256 depBefore = ep.balanceOf(address(pm));
        _handle(_bumpOp(0));
        uint256 finalCharge = depBefore - ep.balanceOf(address(pm));

        assertEq(account.counter(), 1);
        (uint64 day, uint256 spent) = _usage();
        assertEq(day, (block.timestamp + 10 minutes) / 1 days);
        assertLt(spent, MAX_COST, "reservation replaced by the estimated charge");
        assertGe(spent, finalCharge, "estimate upper-bounds the EntryPoint's final charge");
        assertGt(finalCharge, 0);
        assertEq(address(account).balance, 0, "account paid nothing");
    }

    function test_revertedCallStillReconciled() public {
        PackedUserOperation memory op = _sponsor(
            _op(abi.encodeCall(TestAccount.fail, ()), 0),
            uint48(block.timestamp + 10 minutes),
            uint48(block.timestamp - 1),
            signerPk
        );
        uint256 depBefore = ep.balanceOf(address(pm));
        _handle(op);
        (, uint256 spent) = _usage();
        assertLt(spent, MAX_COST);
        assertGe(spent, depBefore - ep.balanceOf(address(pm)));
    }

    function test_badSignatureRejected() public {
        (, uint256 wrongPk) = makeAddrAndKey("impostor");
        PackedUserOperation memory op = _sponsor(
            _op(abi.encodeCall(TestAccount.bump, ()), 0),
            uint48(block.timestamp + 10 minutes),
            uint48(block.timestamp - 1),
            wrongPk
        );
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
        (, uint256 spent) = _usage();
        assertEq(spent, 0);
    }

    function test_tamperedOpRejected() public {
        PackedUserOperation memory op = _bumpOp(0);
        op.callData = abi.encodeCall(TestAccount.fail, ()); // signed over bump()
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    function test_badSignatureLengthReverts() public {
        PackedUserOperation memory op = _op(abi.encodeCall(TestAccount.bump, ()), 0);
        op.paymasterAndData = abi.encodePacked(
            address(pm),
            PM_VERIF_GAS,
            PM_POSTOP_GAS,
            abi.encode(uint48(block.timestamp + 60), uint48(0)),
            hex"1234"
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(AnyrPaymaster.InvalidSignatureLength.selector)
            )
        );
        _handle(op);
    }

    function test_expiredRejected() public {
        PackedUserOperation memory op = _sponsor(
            _op(abi.encodeCall(TestAccount.bump, ()), 0),
            uint48(block.timestamp - 1 minutes),
            uint48(block.timestamp - 1 hours),
            signerPk
        );
        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due")
        );
        _handle(op);
    }

    function test_validityWindowTooLongRejected() public {
        PackedUserOperation memory op = _sponsor(
            _op(abi.encodeCall(TestAccount.bump, ()), 0),
            uint48(block.timestamp + 1 days),
            uint48(block.timestamp - 1),
            signerPk
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(AnyrPaymaster.InvalidValidityWindow.selector)
            )
        );
        _handle(op);
    }

    function test_noExpiryRejected() public {
        PackedUserOperation memory op =
            _sponsor(_op(abi.encodeCall(TestAccount.bump, ()), 0), uint48(0), uint48(0), signerPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(AnyrPaymaster.InvalidValidityWindow.selector)
            )
        );
        _handle(op);
    }

    // ------------------------------------------------------------------ daily cap

    function test_capBelowMaxCostRejected() public {
        vm.prank(owner);
        pm.setDailyCap(MAX_COST - 1);
        PackedUserOperation memory op = _bumpOp(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(
                    AnyrPaymaster.DailyCapExceeded.selector, address(account), 0, MAX_COST, MAX_COST - 1
                )
            )
        );
        _handle(op);
    }
}

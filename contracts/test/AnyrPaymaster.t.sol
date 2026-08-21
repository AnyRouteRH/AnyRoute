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

    function test_bundleReservesMaxCostPerOp() public {
        vm.prank(owner);
        pm.setDailyCap(2 * MAX_COST - 1);
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _bumpOp(0);
        ops[1] = _bumpOp(1);
        // op 1 is validated while op 0 still holds its full maxCost reservation
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                1,
                "AA33 reverted",
                abi.encodeWithSelector(
                    AnyrPaymaster.DailyCapExceeded.selector,
                    address(account),
                    MAX_COST,
                    MAX_COST,
                    2 * MAX_COST - 1
                )
            )
        );
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));

        // with room for both reservations the bundle goes through and both are reconciled
        vm.prank(owner);
        pm.setDailyCap(2 * MAX_COST);
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));
        assertEq(account.counter(), 2);
        (, uint256 spent) = _usage();
        assertLt(spent, 2 * MAX_COST);
    }

    /// @dev Keep sponsoring until the cap binds; the model (spent + maxCost > cap => reject) must hold every time.
    function test_capAccumulatesUntilExhausted() public {
        uint256 cap = pm.dailyCap();
        uint256 successes;
        bool rejected;
        for (uint256 i; i < 20 && !rejected; ++i) {
            (, uint256 spent) = _usage();
            PackedUserOperation memory op = _bumpOp(0);
            if (spent + MAX_COST > cap) {
                vm.expectRevert(
                    abi.encodeWithSelector(
                        IEntryPoint.FailedOpWithRevert.selector,
                        0,
                        "AA33 reverted",
                        abi.encodeWithSelector(
                            AnyrPaymaster.DailyCapExceeded.selector, address(account), spent, MAX_COST, cap
                        )
                    )
                );
                _handle(op);
                rejected = true;
            } else {
                _handle(op);
                successes++;
                (, uint256 after_) = _usage();
                assertGt(after_, spent);
                assertLe(after_, cap);
            }
        }
        assertTrue(rejected, "cap never bound");
        assertGe(successes, 3);
        assertEq(account.counter(), successes);
        assertEq(pm.remaining(address(account)), cap - _spent());
    }

    function _spent() internal view returns (uint256 s) {
        (, s) = _usage();
    }

    function test_newDayResetsCap() public {
        vm.prank(owner);
        pm.setDailyCap(MAX_COST);
        _handle(_bumpOp(0));
        PackedUserOperation memory op = _bumpOp(0);
        vm.expectRevert(); // cap reached for today (spent + maxCost > cap)
        _handle(op);

        vm.warp(block.timestamp + 1 days);
        _handle(_bumpOp(0));
        assertEq(account.counter(), 2);
        (uint64 day,) = _usage();
        assertEq(day, (block.timestamp + 10 minutes) / 1 days);
    }

    function test_bucketNeverMovesBackwards() public {
        // op signed so that validUntil lands tomorrow => bucket = tomorrow
        uint48 tomorrowUntil = uint48(block.timestamp + 1 days - 1);
        PackedUserOperation memory op1 = _sponsor(
            _op(abi.encodeCall(TestAccount.bump, ()), 0), tomorrowUntil, uint48(block.timestamp), signerPk
        );
        _handle(op1);
        (uint64 day1, uint256 spent1) = _usage();
        assertEq(day1, tomorrowUntil / 1 days);
        assertEq(day1, block.timestamp / 1 days + 1);

        // a later op signed for "today" is charged to the (newer) stored bucket instead of resetting it
        _handle(_bumpOp(0));
        (uint64 day2, uint256 spent2) = _usage();
        assertEq(day2, day1);
        assertGt(spent2, spent1);
    }

    // ------------------------------------------------------------------ access control / admin

    function test_onlyEntryPoint() public {
        PackedUserOperation memory op = _bumpOp(0);
        vm.expectRevert("Sender not EntryPoint");
        pm.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
        vm.expectRevert("Sender not EntryPoint");
        pm.postOp(
            IPaymaster.PostOpMode.opSucceeded, abi.encode(address(account), uint64(1), MAX_COST, 0), 1, 1
        );
    }

    function test_directValidationAsEntryPoint() public {
        // simulate the EntryPoint calling validate/postOp directly (unit-level check of the accounting)
        PackedUserOperation memory op = _bumpOp(0);
        vm.prank(address(ep));
        (bytes memory ctx, uint256 vd) = pm.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(uint160(vd), 0, "signature ok"); // low 160 bits = aggregator/sig-failed flag
        assertEq(_spent(), MAX_COST);
        vm.prank(address(ep));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, ctx, 100_000 gwei, FEE);
        uint256 extraGas = PM_POSTOP_GAS + (uint256(CALL_GAS) + PM_POSTOP_GAS) / 10 + pm.POSTOP_OVERHEAD_GAS();
        assertEq(_spent(), 100_000 gwei + extraGas * FEE);
    }

    function test_admin() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pm.setVerifyingSigner(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pm.setDailyCap(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pm.withdrawTo(payable(stranger), 1);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(AnyrPaymaster.ZeroAddress.selector);
        pm.setVerifyingSigner(address(0));
        vm.expectEmit(true, false, false, false);
        emit AnyrPaymaster.VerifyingSignerSet(stranger);
        pm.setVerifyingSigner(stranger);
        vm.expectEmit(false, false, false, true);
        emit AnyrPaymaster.DailyCapSet(42);
        pm.setDailyCap(42);
        pm.withdrawTo(payable(owner), 1 ether);
        vm.stopPrank();
        assertEq(ep.balanceOf(address(pm)), 9 ether);

        // rotated signer: old signatures no longer sponsor
        vm.prank(owner);
        pm.setDailyCap(10 * MAX_COST);
        PackedUserOperation memory op = _bumpOp(0);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    function test_ownable2Step() public {
        vm.prank(owner);
        pm.transferOwnership(stranger);
        assertEq(pm.owner(), owner);
        assertEq(pm.pendingOwner(), stranger);
        vm.prank(stranger);
        pm.acceptOwnership();
        assertEq(pm.owner(), stranger);
    }
}

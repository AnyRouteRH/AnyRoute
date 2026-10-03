// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {AnyrPaymaster} from "../src/AnyrPaymaster.sol";
import {TestAccount} from "./AnyrPaymaster.t.sol";

contract PaymasterConservationHandler is Test {
    EntryPoint public ep;
    AnyrPaymaster public paymaster;
    TestAccount[3] public accounts;
    address public governor;
    address public beneficiary;
    address public recipient;
    uint256 private signerKey;
    uint256 public funded;
    uint256 public charged;
    uint256 public withdrawn;
    uint256 public operations;
    uint256 public constant MAX_COST = 560_000 * 1 gwei;
    uint256 public constant CAP = 3 * MAX_COST;
    constructor() {
        governor = makeAddr("governor"); beneficiary = makeAddr("beneficiary"); recipient = makeAddr("withdraw-recipient");
        (address signer, uint256 key) = makeAddrAndKey("sponsor-signer"); signerKey = key;
        ep = new EntryPoint(); paymaster = new AnyrPaymaster(ep, signer, CAP, governor);
        for (uint256 i; i < 3; i++) accounts[i] = new TestAccount(ep);
        deposit(10 ether - 1);
    }
    function deposit(uint256 amount) public {
        amount = 1 + amount % 11 ether; vm.deal(governor, amount);
        vm.prank(governor); paymaster.deposit{value: amount}(); funded += amount;
    }
    function withdraw(uint256 amount) external {
        uint256 balance = ep.balanceOf(address(paymaster)); if (balance == 0) return;
        amount = 1 + amount % balance;
        vm.prank(governor); paymaster.withdrawTo(payable(recipient), amount); withdrawn += amount;
    }
    function sponsor(uint256 who, bool fail) external {
        TestAccount account = accounts[who % 3];
        uint48 until = uint48(block.timestamp + 10 minutes);
        (uint64 day, uint256 spent) = paymaster.usage(address(account));
        if (day < until / 1 days) spent = 0;
        if (spent + MAX_COST > CAP || ep.balanceOf(address(paymaster)) < MAX_COST) return;
        PackedUserOperation memory op;
        op.sender = address(account); op.nonce = ep.getNonce(address(account), 0);
        op.callData = fail ? abi.encodeCall(TestAccount.fail, ()) : abi.encodeCall(TestAccount.bump, ());
        op.accountGasLimits = bytes32((uint256(150_000) << 128) | 100_000);
        op.preVerificationGas = 50_000; op.gasFees = bytes32((uint256(1 gwei) << 128) | 1 gwei);
        uint48 after_ = uint48(block.timestamp - 1);
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(150_000), uint128(60_000), abi.encode(until, after_));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, MessageHashUtils.toEthSignedMessageHash(paymaster.getHash(op, until, after_)));
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, r, s, v);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1); ops[0] = op;
        uint256 beforeBalance = ep.balanceOf(address(paymaster));
        ep.handleOps(ops, payable(beneficiary));
        uint256 cost = beforeBalance - ep.balanceOf(address(paymaster));
        assertLe(cost, MAX_COST); charged += cost; operations++;
    }
    function advance(uint256 seconds_) external { vm.warp(block.timestamp + 1 + seconds_ % 2 days); }
    function assertConservation() external view {
        assertEq(ep.balanceOf(address(paymaster)), funded - withdrawn - charged);
        assertEq(recipient.balance, withdrawn); assertEq(beneficiary.balance, charged);
        for (uint256 i; i < 3; i++) { (,uint256 spent) = paymaster.usage(address(accounts[i])); assertLe(spent, CAP); assertEq(address(accounts[i]).balance, 0); }
    }
}
contract PaymasterConservationTest is Test {
    PaymasterConservationHandler internal handler;
    function setUp() external {
        vm.warp(1_800_000_000); handler = new PaymasterConservationHandler(); targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.deposit.selector; selectors[1] = handler.withdraw.selector; selectors[2] = handler.sponsor.selector; selectors[3] = handler.advance.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }
    function invariant_entryPointDepositAndGasPaymentsConserveFunding() external view { handler.assertConservation(); }
    function test_successAndRevertedExecutionBothPayGas() external { handler.sponsor(0, false); handler.sponsor(1, true); handler.withdraw(1 ether); handler.assertConservation(); assertEq(handler.operations(), 2); assertGt(handler.charged(), 0); }
}

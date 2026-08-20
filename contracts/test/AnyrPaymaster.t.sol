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
}

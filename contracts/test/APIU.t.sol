// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {APIU} from "../src/APIU.sol";
import {IAPIU, ICapacitySource} from "../src/interfaces/IAPIU.sol";

/// @dev A stand-in minter whose reported capacity the test controls.
contract CapacityStub is ICapacitySource {
    uint256 public override openCapacityApiu;

    function setCapacity(uint256 c) external {
        openCapacityApiu = c;
    }

    function mintOn(APIU token, address to, uint256 amount) external {
        token.mint(to, amount);
    }
}

    contract APIUTest is Test {
        APIU internal apiu;
        CapacityStub internal stub;
        address internal owner = makeAddr("owner");
        address internal alice = makeAddr("alice");
        address internal bob = makeAddr("bob");

        function setUp() public {
            apiu = new APIU(owner);
            stub = new CapacityStub();
            vm.prank(owner);
            apiu.setMinter(address(stub));
            stub.setCapacity(1_000e18);
        }

        function test_metadata() public view {
            assertEq(apiu.decimals(), 18);
            assertEq(apiu.symbol(), "APIU");
            assertEq(apiu.UNITS_PER_APIU(), 1_000_000);
            assertEq(apiu.owner(), owner);
            assertEq(apiu.minter(), address(stub));
            assertEq(apiu.totalSupply(), 0);
        }

        // --- minter link -----------------------------------------------------------------------------

        function test_setMinter_onlyOwner() public {
            APIU fresh = new APIU(owner);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
            fresh.setMinter(address(stub));
        }

        function test_setMinter_zeroAddress() public {
            APIU fresh = new APIU(owner);
            vm.prank(owner);
            vm.expectRevert(IAPIU.ZeroAddress.selector);
            fresh.setMinter(address(0));
        }

        function test_setMinter_onlyOnce() public {
            vm.prank(owner);
            vm.expectRevert(IAPIU.MinterAlreadySet.selector);
            apiu.setMinter(address(this));
        }

        function test_setMinter_emits() public {
            APIU fresh = new APIU(owner);
            vm.expectEmit(true, true, true, true, address(fresh));
            emit IAPIU.MinterSet(address(stub));
            vm.prank(owner);
            fresh.setMinter(address(stub));
        }

        // --- minting ---------------------------------------------------------------------------------

        function test_mint_onlyMinter() public {
            vm.prank(alice);
            vm.expectRevert(IAPIU.NotMinter.selector);
            apiu.mint(alice, 1e18);
            vm.prank(owner);
            vm.expectRevert(IAPIU.NotMinter.selector);
            apiu.mint(owner, 1e18);
        }

        function test_mint_upToCapacity() public {
            stub.mintOn(apiu, alice, 600e18);
            stub.mintOn(apiu, bob, 400e18);
            assertEq(apiu.totalSupply(), 1_000e18);
            assertEq(apiu.balanceOf(alice), 600e18);
        }

        function test_mint_revertsAboveReportedCapacity() public {
            stub.mintOn(apiu, alice, 1_000e18);
            vm.expectRevert(IAPIU.SupplyExceedsCapacity.selector);
            stub.mintOn(apiu, alice, 1);
        }

        function test_mint_revertsWhenCapacityFellBelowSupply() public {
            stub.mintOn(apiu, alice, 500e18);
            stub.setCapacity(400e18);
            vm.expectRevert(IAPIU.SupplyExceedsCapacity.selector);
            stub.mintOn(apiu, alice, 1);
        }

        function testFuzz_mint_neverExceedsCapacity(uint128 capacity, uint128 first, uint128 second) public {
            stub.setCapacity(capacity);
            try stub.mintOn(apiu, alice, first) {} catch {}
            try stub.mintOn(apiu, bob, second) {} catch {}
            assertLe(apiu.totalSupply(), capacity);
        }

        // --- transfers and redemption ----------------------------------------------------------------

        function test_transferable() public {
            stub.mintOn(apiu, alice, 10e18);
            vm.prank(alice);
            apiu.transfer(bob, 4e18);
            assertEq(apiu.balanceOf(alice), 6e18);
            assertEq(apiu.balanceOf(bob), 4e18);
            assertEq(apiu.totalSupply(), 10e18);
        }

        function test_redeem_burnsAndEmits() public {
            stub.mintOn(apiu, alice, 10e18);
            bytes32 expected = keccak256(abi.encode(block.chainid, address(apiu), uint256(1)));
            vm.expectEmit(true, true, true, true, address(apiu));
            emit IAPIU.Redeemed(3e18, expected);
            vm.prank(alice);
            bytes32 id = apiu.redeem(3e18);
            assertEq(id, expected);
            assertEq(apiu.balanceOf(alice), 7e18);
            assertEq(apiu.totalSupply(), 7e18);
            assertEq(apiu.redemptionCount(), 1);
        }

        function test_redeem_idsAreUnique() public {
            stub.mintOn(apiu, alice, 10e18);
            vm.startPrank(alice);
            bytes32 a = apiu.redeem(1e18);
            bytes32 b = apiu.redeem(1e18);
            vm.stopPrank();
            assertTrue(a != b);
        }

        function test_redeem_recordsNothingAboutTheRedeemer() public {
            // The event has exactly two fields: the amount and the id. Its id does not depend on the caller.
            stub.mintOn(apiu, alice, 2e18);
            stub.mintOn(apiu, bob, 2e18);
            vm.recordLogs();
            vm.prank(alice);
            apiu.redeem(1e18);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            // Transfer(alice, 0, amount) from the burn, then Redeemed.
            Vm.Log memory redeemed = logs[logs.length - 1];
            assertEq(redeemed.topics[0], keccak256("Redeemed(uint256,bytes32)"));
            assertEq(redeemed.topics.length, 2); // signature + indexed id only
            assertEq(abi.decode(redeemed.data, (uint256)), 1e18);
        }

        function test_redeem_zeroReverts() public {
            vm.prank(alice);
            vm.expectRevert(IAPIU.InvalidAmount.selector);
            apiu.redeem(0);
        }

        function test_redeem_overBalanceReverts() public {
            stub.mintOn(apiu, alice, 1e18);
            vm.prank(alice);
            vm.expectRevert(
                abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 1e18, 2e18)
            );
            apiu.redeem(2e18);
        }

        function test_redeemFreesMintHeadroom() public {
            stub.setCapacity(10e18);
            stub.mintOn(apiu, alice, 10e18);
            vm.prank(alice);
            apiu.redeem(4e18);
            stub.mintOn(apiu, alice, 4e18);
            assertEq(apiu.totalSupply(), 10e18);
        }
    }

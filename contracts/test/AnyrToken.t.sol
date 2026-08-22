// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AnyrToken} from "../src/AnyrToken.sol";

contract AnyrTokenTest is Test {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    AnyrToken internal token;
    address internal treasury;
    uint256 internal treasuryPk;
    address internal team = makeAddr("team");
    address internal liquidity = makeAddr("liquidity");
    address internal community = makeAddr("community");

    function setUp() public {
        (treasury, treasuryPk) = makeAddrAndKey("treasury");
        token = new AnyrToken([treasury, team, liquidity, community]);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Anyroute");
        assertEq(token.symbol(), "ANYR");
        assertEq(token.decimals(), 18);
        assertEq(token.TOTAL_SUPPLY(), 1_000_000_000e18);
    }

    function test_distribution_80_10_5_5() public view {
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.balanceOf(treasury), 800_000_000e18);
        assertEq(token.balanceOf(team), 100_000_000e18);
        assertEq(token.balanceOf(liquidity), 50_000_000e18);
        assertEq(token.balanceOf(community), 50_000_000e18);
    }

    function test_constructor_emitsTransfers() public {
        vm.expectEmit(true, true, true, true);
        emit IERC20Transfer.Transfer(address(0), treasury, 800_000_000e18);
        vm.expectEmit(true, true, true, true);
        emit IERC20Transfer.Transfer(address(0), team, 100_000_000e18);
        vm.expectEmit(true, true, true, true);
        emit IERC20Transfer.Transfer(address(0), liquidity, 50_000_000e18);
        vm.expectEmit(true, true, true, true);
        emit IERC20Transfer.Transfer(address(0), community, 50_000_000e18);
        new AnyrToken([treasury, team, liquidity, community]);
    }

    function test_sameRecipientGetsEverything() public {
        AnyrToken t = new AnyrToken([team, team, team, team]);
        assertEq(t.balanceOf(team), 1_000_000_000e18);
    }

    function test_constructor_revertsZeroRecipient() public {
        for (uint256 i; i < 4; ++i) {
            address[4] memory r = [treasury, team, liquidity, community];
            r[i] = address(0);
            vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
            new AnyrToken(r);
        }
    }

    function test_noMintNoOwnerNoPause() public {
        (bool ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", team, 1));
        assertFalse(ok);
        (ok,) = address(token).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
        (ok,) = address(token).call(abi.encodeWithSignature("pause()"));
        assertFalse(ok);
        (ok,) = address(token).call(abi.encodeWithSignature("burn(uint256)", 1));
        assertFalse(ok);
    }

    function test_permit() public {
        address spender = makeAddr("spender");
        uint256 dl = block.timestamp + 1 days;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, treasury, spender, 5e18, 0, dl));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(treasuryPk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        token.permit(treasury, spender, 5e18, dl, v, r, s);
        assertEq(token.allowance(treasury, spender), 5e18);
        assertEq(token.nonces(treasury), 1);

        vm.prank(spender);
        assertTrue(token.transferFrom(treasury, spender, 5e18));
        assertEq(token.balanceOf(spender), 5e18);

        // replay fails
        vm.expectRevert();
        token.permit(treasury, spender, 5e18, dl, v, r, s);
    }

    function test_permit_revertsExpired() public {
        address spender = makeAddr("spender");
        uint256 dl = block.timestamp;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, treasury, spender, 1, 0, dl));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(treasuryPk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        vm.warp(dl + 1);
        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, dl));
        token.permit(treasury, spender, 1, dl, v, r, s);
    }

    function test_permit_revertsWrongSigner() public {
        address spender = makeAddr("spender");
        uint256 dl = block.timestamp + 1;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, treasury, spender, 1, 0, dl));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0xBAD, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        vm.expectRevert(
            abi.encodeWithSelector(ERC20Permit.ERC2612InvalidSigner.selector, vm.addr(0xBAD), treasury)
        );
        token.permit(treasury, spender, 1, dl, v, r, s);
    }

    function testFuzz_transferConservesSupply(address to, uint256 amount) public {
        vm.assume(to != address(0));
        amount = bound(amount, 0, 800_000_000e18);
        uint256 toBefore = token.balanceOf(to);
        vm.prank(treasury);
        assertTrue(token.transfer(to, amount));
        assertEq(token.totalSupply(), 1_000_000_000e18);
        if (to != treasury) {
            assertEq(token.balanceOf(to), toBefore + amount);
            assertEq(token.balanceOf(treasury), 800_000_000e18 - amount);
        }
    }
}

interface IERC20Transfer {
    event Transfer(address indexed from, address indexed to, uint256 value);
}

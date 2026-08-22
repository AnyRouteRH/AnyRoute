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
}

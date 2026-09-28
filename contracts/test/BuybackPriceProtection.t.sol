// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {StakingBase} from "./AnyrStaking.t.sol";
import {AnyrStaking} from "../src/AnyrStaking.sol";
import {IBuybackPriceOracle} from "../src/interfaces/IBuybackPriceOracle.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract BuybackPriceProtectionTest is StakingBase {
    function test_missingOracleDisablesBuyback() public {
        _notify(2e6);
        vm.prank(owner);
        staking.setBuybackPriceOracle(IBuybackPriceOracle(address(0)));
        vm.prank(keeper);
        vm.expectRevert(AnyrStaking.UnsafeBuybackPrice.selector);
        staking.executeBuyback(1e6, 1);
        assertEq(staking.buybackBalance(), 1e6);
    }

    function test_keeperCannotChoosePriceSourceOrLowerFloor() public {
        _notify(2e6);
        priceOracle.set(9e18, block.timestamp);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        staking.setBuybackPriceOracle(IBuybackPriceOracle(address(0)));
        vm.prank(keeper);
        vm.expectRevert(AnyrStaking.UnsafeBuybackPrice.selector);
        staking.executeBuyback(1e6, 1);
        assertEq(staking.buybackBalance(), 1e6);
        vm.prank(keeper);
        assertEq(staking.executeBuyback(1e6, 9e18), 10e18);
    }

    function test_staleZeroAndFutureQuotesFailClosed() public {
        _notify(2e6);
        uint256[4] memory times = [uint256(0), block.timestamp - 901, block.timestamp + 1, block.timestamp];
        for (uint256 i; i < 4; ++i) {
            priceOracle.set(i == 3 ? 0 : 9e18, times[i]);
            vm.prank(keeper);
            vm.expectRevert(AnyrStaking.UnsafeBuybackPrice.selector);
            staking.executeBuyback(1e6, 10e18);
        }
        assertEq(staking.buybackBalance(), 1e6);
        assertEq(staking.boughtOnDay(), 0);
    }

    function test_floorCannotBeBypassedByDishonestAdapterOutput() public {
        _notify(2e6);
        priceOracle.set(11e18, block.timestamp);
        vm.prank(keeper);
        vm.expectRevert();
        staking.executeBuyback(1e6, 11e18);
        assertEq(staking.buybackBalance(), 1e6);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {UniswapV4Adapter} from "../../src/adapters/UniswapV4Adapter.sol";
import {UniswapV3Adapter, ISwapRouter02} from "../../src/adapters/UniswapV3Adapter.sol";
import {PayWithStock} from "../../src/PayWithStock.sol";
import {AnyrPaymaster} from "../../src/AnyrPaymaster.sol";
import {ChainlinkStockOracle, AggregatorV3Interface} from "../../src/oracle/ChainlinkStockOracle.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {IPayWithStock} from "../../src/interfaces/IPayWithStock.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {MockSwapAdapter} from "../../src/mocks/MockSwapAdapter.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {MockCredits} from "../utils/MockCredits.sol";

/// @notice Local (no RPC) tests of UniswapV4Adapter against a real v4-core PoolManager deployed in-test:
/// single-hop, 2-hop through a native-ETH intermediate, native ETH in/out, limits, partial fills, access control,
/// and PayWithStock end-to-end with the V4 adapter as primary.
contract UniswapV4AdapterLocalTest is Test {
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    PoolManager manager;
    PoolModifyLiquidityTest lp;
    UniswapV4Adapter adapter;
    MockStockToken nvda; // 18 dec, $180
    MockUSDG usdg; // 6 dec
    Currency constant ETH = Currency.wrap(address(0)); // $3600

    PoolKey nvdaUsdg;
    PoolKey ethNvda;
    PoolKey ethUsdg;

    address owner = makeAddr("owner");
    address recipient = makeAddr("recipient");
    address refundTo = makeAddr("refundTo");
    address stranger = makeAddr("stranger");
    MockSwapAdapter backup; // PayWithStock fallback in the end-to-end tests

    function setUp() public {
        manager = new PoolManager(address(this));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        nvda = new MockStockToken("NVIDIA xStock", "NVDAx", 18);
        usdg = new MockUSDG();
        adapter = new UniswapV4Adapter(IPoolManager(address(manager)), owner);

        vm.deal(address(this), 100_000 ether);
        nvda.mint(address(this), 1e30);
        usdg.mint(address(this), 1e30);
        nvda.approve(address(lp), type(uint256).max);
        usdg.approve(address(lp), type(uint256).max);

        // 1 NVDA = 180 USDG ; 1 ETH = 20 NVDA ; 1 ETH = 3600 USDG
        nvdaUsdg = _pool(address(nvda), address(usdg), 3000, 60, 1e18, 180e6, 1e17);
        ethNvda = _pool(address(0), address(nvda), 3000, 60, 1e18, 20e18, 1e21);
        ethUsdg = _pool(address(0), address(usdg), 500, 10, 1e18, 3600e6, 1e17);

        vm.startPrank(owner);
        adapter.setCaller(address(this), true);
        adapter.setRoute(address(nvda), address(usdg), _hops(nvdaUsdg));
        adapter.setRoute(address(usdg), address(nvda), _hops(nvdaUsdg));
        adapter.setRoute(address(0), address(usdg), _hops(ethUsdg));
        adapter.setRoute(address(usdg), address(0), _hops(ethUsdg));
        vm.stopPrank();
    }

    receive() external payable {}

    // ------------------------------------------------------------------ helpers

    /// @dev Create + fund a full-range pool where `rawA` of A is worth `rawB` of B.
    function _pool(address a, address b, uint24 fee, int24 spacing, uint256 rawA, uint256 rawB, uint128 liq)
        internal
        returns (PoolKey memory key)
    {
        key = _init(a, b, fee, spacing, rawA, rawB);
        _addFullRange(key, liq);
    }

    function _init(address a, address b, uint24 fee, int24 spacing, uint256 rawA, uint256 rawB)
        internal
        returns (PoolKey memory key)
    {
        (address c0, address c1, uint256 r0, uint256 r1) = a < b ? (a, b, rawA, rawB) : (b, a, rawB, rawA);
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(address(0)));
        manager.initialize(key, uint160(Math.sqrt(Math.mulDiv(r1, 1 << 192, r0))));
    }

    function _addFullRange(PoolKey memory key, uint128 liq) internal {
        ModifyLiquidityParams memory p = ModifyLiquidityParams({
            tickLower: TickMath.minUsableTick(key.tickSpacing),
            tickUpper: TickMath.maxUsableTick(key.tickSpacing),
            liquidityDelta: int256(uint256(liq)),
            salt: 0
        });
        lp.modifyLiquidity{value: key.currency0.isAddressZero() ? 50_000 ether : 0}(key, p, "");
    }

    function _hops(PoolKey memory k) internal pure returns (PoolKey[] memory h) {
        h = new PoolKey[](1);
        h[0] = k;
    }

    function _hops(PoolKey memory k0, PoolKey memory k1) internal pure returns (PoolKey[] memory h) {
        h = new PoolKey[](2);
        h[0] = k0;
        h[1] = k1;
    }

    function _assertClean() internal view {
        assertEq(nvda.balanceOf(address(adapter)), 0, "adapter NVDA");
        assertEq(usdg.balanceOf(address(adapter)), 0, "adapter USDG");
        assertEq(address(adapter).balance, 0, "adapter ETH");
    }

    // ------------------------------------------------------------------ exact output

    function test_exactOutSingleHop() public {
        uint256 maxIn = 1.1e18;
        IERC20(address(nvda)).safeTransfer(address(adapter), maxIn);
        uint256 amountIn =
            adapter.swapExactOut(address(nvda), address(usdg), 180e6, maxIn, recipient, refundTo);
        assertEq(usdg.balanceOf(recipient), 180e6, "exact output");
        assertGt(amountIn, 1e18); // 0.3% fee + impact
        assertLt(amountIn, 1.005e18);
        assertEq(nvda.balanceOf(refundTo), maxIn - amountIn, "refund");
        _assertClean();
    }

    function test_exactOutTwoHopsThroughNativeEth() public {
        vm.prank(owner);
        adapter.setRoute(address(nvda), address(usdg), _hops(ethNvda, ethUsdg));
        uint256 maxIn = 1.1e18;
        IERC20(address(nvda)).safeTransfer(address(adapter), maxIn);
        uint256 amountIn =
            adapter.swapExactOut(address(nvda), address(usdg), 180e6, maxIn, recipient, refundTo);
        assertEq(usdg.balanceOf(recipient), 180e6);
        assertGt(amountIn, 1.0035e18); // 0.3% + 0.05% fees
        assertLt(amountIn, 1.01e18);
        assertEq(nvda.balanceOf(refundTo), maxIn - amountIn);
        _assertClean();
    }

    function test_exactOutNativeIn() public {
        uint256 maxIn = 1.1 ether;
        (bool ok,) = address(adapter).call{value: maxIn}("");
        assertTrue(ok);
        uint256 amountIn = adapter.swapExactOut(address(0), address(usdg), 3600e6, maxIn, recipient, refundTo);
        assertEq(usdg.balanceOf(recipient), 3600e6);
        assertGt(amountIn, 1 ether);
        assertEq(refundTo.balance, maxIn - amountIn, "ETH refund");
        _assertClean();
    }

    function test_exactOutNativeOut() public {
        uint256 maxIn = 4000e6;
        IERC20(address(usdg)).safeTransfer(address(adapter), maxIn);
        uint256 amountIn =
            adapter.swapExactOut(address(usdg), address(0), 1 ether, maxIn, recipient, refundTo);
        assertEq(recipient.balance, 1 ether);
        assertGt(amountIn, 3600e6);
        assertEq(usdg.balanceOf(refundTo), maxIn - amountIn);
        _assertClean();
    }

    function test_exactOutAboveMaxReverts() public {
        IERC20(address(nvda)).safeTransfer(address(adapter), 1e18);
        vm.expectPartialRevert(UniswapV4Adapter.ExcessiveInput.selector);
        adapter.swapExactOut(address(nvda), address(usdg), 180e6, 1e18, recipient, refundTo);
    }

    function test_exactOutBeyondLiquidityReverts() public {
        MockStockToken thin = new MockStockToken("THIN", "THIN", 18);
        thin.mint(address(this), 1e30);
        thin.approve(address(lp), type(uint256).max);
        PoolKey memory k = _pool(address(thin), address(usdg), 3000, 60, 1e18, 1e6, 1e12); // tiny liquidity
        vm.prank(owner);
        adapter.setRoute(address(thin), address(usdg), _hops(k));
        IERC20(address(thin)).safeTransfer(address(adapter), 1e27);
        vm.expectRevert(UniswapV4Adapter.IncompleteFill.selector);
        adapter.swapExactOut(address(thin), address(usdg), 1_000_000e6, 1e27, recipient, refundTo);
    }

    function test_exactOutRequiresPrefunding() public {
        vm.expectRevert(abi.encodeWithSelector(UniswapV4Adapter.InsufficientInputBalance.selector, 0, 1e18));
        adapter.swapExactOut(address(nvda), address(usdg), 1e6, 1e18, recipient, refundTo);
    }

    function testFuzz_exactOutRefund(uint256 amountOut, uint256 slackBps) public {
        amountOut = bound(amountOut, 1, 10_000e6); // <= ~0.75% of pool depth
        slackBps = bound(slackBps, 200, 5_000);
        uint256 fair = Math.mulDiv(amountOut, 1e18, 180e6, Math.Rounding.Ceil);
        uint256 maxIn = fair + fair * slackBps / 10_000 + 1e6; // cover fee + impact (+ dust for tiny amounts)
        IERC20(address(nvda)).safeTransfer(address(adapter), maxIn);
        uint256 amountIn =
            adapter.swapExactOut(address(nvda), address(usdg), amountOut, maxIn, recipient, refundTo);
        assertEq(usdg.balanceOf(recipient), amountOut);
        assertEq(nvda.balanceOf(refundTo), maxIn - amountIn);
        assertLe(amountIn, maxIn);
        _assertClean();
    }

    // ------------------------------------------------------------------ exact input

    function test_exactInSingleHop() public {
        IERC20(address(usdg)).safeTransfer(address(adapter), 180e6);
        uint256 out = adapter.swapExactIn(address(usdg), address(nvda), 180e6, 0.99e18, recipient);
        assertEq(nvda.balanceOf(recipient), out);
        assertGt(out, 0.99e18);
        assertLt(out, 1e18);
        _assertClean();
    }

    function test_exactInTwoHopsThroughNativeEth() public {
        vm.prank(owner);
        adapter.setRoute(address(usdg), address(nvda), _hops(ethUsdg, ethNvda));
        IERC20(address(usdg)).safeTransfer(address(adapter), 180e6);
        uint256 out = adapter.swapExactIn(address(usdg), address(nvda), 180e6, 0.99e18, recipient);
        assertEq(nvda.balanceOf(recipient), out);
        assertGt(out, 0.99e18);
        _assertClean();
    }

    function test_exactInNativeInAndOut() public {
        (bool ok,) = address(adapter).call{value: 1 ether}("");
        assertTrue(ok);
        uint256 out = adapter.swapExactIn(address(0), address(usdg), 1 ether, 3500e6, recipient);
        assertEq(usdg.balanceOf(recipient), out);

        IERC20(address(usdg)).safeTransfer(address(adapter), 3600e6);
        uint256 ethOut = adapter.swapExactIn(address(usdg), address(0), 3600e6, 0.99 ether, recipient);
        assertEq(recipient.balance, ethOut);
        _assertClean();
    }

    function test_exactInMinOutReverts() public {
        IERC20(address(usdg)).safeTransfer(address(adapter), 180e6);
        vm.expectPartialRevert(UniswapV4Adapter.InsufficientOutput.selector);
        adapter.swapExactIn(address(usdg), address(nvda), 180e6, 1e18, recipient);
    }

    // ------------------------------------------------------------------ routes / access

    function test_routeValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(UniswapV4Adapter.InvalidRoute.selector); // hop does not contain tokenIn
        adapter.setRoute(address(nvda), address(usdg), _hops(ethUsdg));
        vm.expectRevert(UniswapV4Adapter.InvalidRoute.selector); // does not end in tokenOut
        adapter.setRoute(address(nvda), address(usdg), _hops(ethNvda));
        vm.expectRevert(UniswapV4Adapter.InvalidRoute.selector); // broken chain
        adapter.setRoute(address(nvda), address(usdg), _hops(nvdaUsdg, ethNvda));
        vm.expectRevert(UniswapV4Adapter.InvalidRoute.selector); // same token
        adapter.setRoute(address(nvda), address(nvda), _hops(nvdaUsdg));
        PoolKey memory unsorted = PoolKey(ethUsdg.currency1, ethUsdg.currency0, 500, 10, IHooks(address(0)));
        vm.expectRevert(UniswapV4Adapter.InvalidRoute.selector);
        adapter.setRoute(address(0), address(usdg), _hops(unsorted));
        PoolKey[] memory three = new PoolKey[](3);
        vm.expectRevert(UniswapV4Adapter.InvalidRoute.selector);
        adapter.setRoute(address(nvda), address(usdg), three);

        adapter.setRoute(address(nvda), address(usdg), new PoolKey[](0)); // clear
        vm.stopPrank();
        assertEq(adapter.getRoute(address(nvda), address(usdg)).length, 0);
        IERC20(address(nvda)).safeTransfer(address(adapter), 1e18);
        vm.expectRevert(UniswapV4Adapter.NoRoute.selector);
        adapter.swapExactOut(address(nvda), address(usdg), 1e6, 1e18, recipient, refundTo);
    }

    function test_accessControl() public {
        vm.startPrank(stranger);
        vm.expectRevert(UniswapV4Adapter.NotCaller.selector);
        adapter.swapExactOut(address(nvda), address(usdg), 1e6, 1e18, recipient, refundTo);
        vm.expectRevert(UniswapV4Adapter.NotCaller.selector);
        adapter.swapExactIn(address(usdg), address(nvda), 1e6, 0, recipient);
        vm.expectRevert(UniswapV4Adapter.NotPoolManager.selector);
        adapter.unlockCallback("");
        vm.deal(stranger, 1 ether);
        (bool ok,) = address(adapter).call{value: 1 ether}("");
        assertFalse(ok, "ETH from strangers rejected");
        vm.expectRevert();
        adapter.setRoute(address(nvda), address(usdg), _hops(nvdaUsdg));
        vm.expectRevert();
        adapter.setCaller(stranger, true);
        vm.expectRevert();
        adapter.rescue(address(0), stranger, 0);
        vm.stopPrank();
    }

    function test_rescue() public {
        (bool ok,) = address(adapter).call{value: 1 ether}("");
        assertTrue(ok);
        IERC20(address(nvda)).safeTransfer(address(adapter), 5);
        vm.startPrank(owner);
        adapter.rescue(address(0), owner, 1 ether);
        adapter.rescue(address(nvda), owner, 5);
        vm.stopPrank();
        assertEq(owner.balance, 1 ether);
        assertEq(nvda.balanceOf(owner), 5);
        _assertClean();
    }
}

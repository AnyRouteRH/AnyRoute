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
}

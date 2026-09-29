// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AnyrStaking} from "../../src/AnyrStaking.sol";
import {TwapBuybackPriceOracle} from "../../src/oracle/TwapBuybackPriceOracle.sol";
import {UniswapV3Adapter, ISwapRouter02} from "../../src/adapters/UniswapV3Adapter.sol";
import {IBuybackAdapter} from "../../src/interfaces/IBuybackAdapter.sol";

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}

/// @notice The TWAP buyback oracle against a live Robinhood Chain Uniswap V3 pool. No ANYR pool exists yet, so the
/// WETH/USDG 0.01% pool stands in for it (WETH plays ANYR: 18 decimals, token0). Skipped unless RHC_RPC_URL is set:
///   RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/*"
contract TwapBuybackOracleForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant QUOTER_V2 = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;
    address constant WETH_USDG_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // 0.01%
    uint24 constant FEE = 100;

    AnyrStaking staking;
    UniswapV3Adapter v3;
    TwapBuybackPriceOracle oracle;
    address keeper = makeAddr("keeper");
    address settlement = makeAddr("settlement");

    function setUp() public {
        string memory rpc = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        v3 = new UniswapV3Adapter(ISwapRouter02(SWAP_ROUTER_02), address(this));
        staking = new AnyrStaking(
            IERC20(WETH), IERC20(USDG), address(this), keeper, makeAddr("ops"), IBuybackAdapter(address(v3))
        );
        v3.setCaller(address(staking), true);
        v3.setPath(USDG, WETH, abi.encodePacked(USDG, FEE, WETH));

        TwapBuybackPriceOracle.Config memory c;
        c.pool = WETH_USDG_POOL;
        c.factory = V3_FACTORY;
        c.staking = address(staking);
        c.routeAdapter = address(v3);
        c.usdg = USDG;
        c.anyr = WETH;
        c.usdgDecimals = 6;
        c.anyrDecimals = 18;
        c.twapWindow = 30 minutes;
        c.shortWindow = 5 minutes;
        c.minCardinality = 1800;
        c.minLiquidity = 1e17;
        c.maxDeviationTicks = 500;
        c.haircutBps = 100;
        oracle = new TwapBuybackPriceOracle(c, address(this), address(this));
        staking.setBuybackPriceOracle(oracle);
    }

    function test_fork_floorTracksTheLivePoolAndCostsLittleGas() public {
        (TwapBuybackPriceOracle.Status s, TwapBuybackPriceOracle.Reading memory r) = oracle.status();
        assertEq(uint256(s), uint256(TwapBuybackPriceOracle.Status.Ok), "live pool passes every guard");
        assertTrue(oracle.anyrIsToken0());

        uint256 g = gasleft();
        (uint256 floor, uint256 updatedAt) = oracle.minimumOutput(USDG, WETH, 1_000e6);
        g -= gasleft();
        assertEq(updatedAt, block.timestamp);

        (uint256 quoted,,,) = IQuoterV2(QUOTER_V2)
            .quoteExactInputSingle(
                IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: USDG, tokenOut: WETH, amountIn: 1_000e6, fee: FEE, sqrtPriceLimitX96: 0
            })
            );
        assertGt(quoted, floor, "a fair swap clears the floor");
        assertGt(floor, quoted * 97 / 100, "and the floor is within the haircut of it");

        console2.log("minimumOutput gas (first call)", g);
        console2.log("spot tick", int256(r.spotTick));
        console2.log("5m tick", int256(r.shortTick));
        console2.log("30m tick", int256(r.longTick));
        console2.log("floor WETH for 1,000 USDG", floor);
        console2.log("QuoterV2 WETH for 1,000 USDG", quoted);
        console2.log("pool liquidity / harmonic", uint256(r.liquidity), uint256(r.harmonicLiquidity));
        console2.log("cardinality", uint256(r.cardinality));
    }

    function test_fork_buybackThroughTheRealRouterClearsTheFloor() public {
        vm.prank(WETH_USDG_POOL); // the pool holds USDG; avoids guessing the proxy's balance slot
        assertTrue(IERC20(USDG).transfer(settlement, 4_000e6));
        vm.startPrank(settlement);
        IERC20(USDG).approve(address(staking), type(uint256).max);
        staking.notifyMargin(4_000e6);
        vm.stopPrank();

        (uint256 floor,) = oracle.minimumOutput(USDG, WETH, 1_000e6);
        vm.prank(keeper);
        uint256 g = gasleft();
        uint256 out = staking.executeBuyback(1_000e6, floor);
        g -= gasleft();
        assertGe(out, floor);
        assertEq(IERC20(WETH).balanceOf(address(staking)), out);
        console2.log("executeBuyback gas (oracle + swap)", g);
        console2.log("WETH bought / floor", out, floor);

        vm.prank(keeper);
        vm.expectRevert(AnyrStaking.UnsafeBuybackPrice.selector);
        staking.executeBuyback(1_000e6, floor / 2);
    }
}

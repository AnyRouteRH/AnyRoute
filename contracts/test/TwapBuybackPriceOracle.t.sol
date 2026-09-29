// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {AnyrStaking} from "../src/AnyrStaking.sol";
import {TwapBuybackPriceOracle} from "../src/oracle/TwapBuybackPriceOracle.sol";
import {UniswapV3Adapter, ISwapRouter02} from "../src/adapters/UniswapV3Adapter.sol";
import {IBuybackAdapter} from "../src/interfaces/IBuybackAdapter.sol";
import {IBuybackPriceOracle} from "../src/interfaces/IBuybackPriceOracle.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockBuybackAdapter} from "../src/mocks/MockBuybackAdapter.sol";
import {MockV3Factory, MockV3Pool, MockV3SwapRouter} from "./utils/MockUniswapV3.sol";

/// @notice ANYR/USDG Uniswap V3 pool (mock with V3 oracle semantics), UniswapV3Adapter, AnyrStaking and the oracle.
/// The pool has sat at $0.05 per ANYR for an hour, with ~$1M of virtual depth per side.
abstract contract TwapOracleFixture is Test {
    uint256 internal constant T0 = 1_750_032_000; // 2025-06-16 00:00:00 UTC
    uint24 internal constant FEE = 3000; // 0.30%
    uint32 internal constant WINDOW = 30 minutes;
    uint32 internal constant SHORT = 5 minutes;
    uint16 internal constant MIN_CARD = 1800;
    int24 internal constant MAX_DEV = 500; // ~5.1%
    uint16 internal constant HAIRCUT = 100; // 1%
    uint256 internal constant BPS = 10_000;

    address internal constant USDG_AT = address(0x5000000000000000000000000000000000000005);
    address internal constant ANYR_LOW = address(0x1000000000000000000000000000000000000001);
    address internal constant ANYR_HIGH = address(0x9000000000000000000000000000000000000009);

    MockUSDG internal usdg;
    MockStockToken internal anyr;
    MockV3Factory internal factory;
    MockV3Pool internal pool;
    MockV3SwapRouter internal router;
    UniswapV3Adapter internal v3;
    AnyrStaking internal staking;
    TwapBuybackPriceOracle internal oracle;

    address internal gov = makeAddr("gov"); // the timelock in production
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal ops = makeAddr("ops");
    address internal settlement = makeAddr("settlement");
    address internal attacker = makeAddr("attacker");
    address internal stranger = makeAddr("stranger");

    // ---- variant knobs ---------------------------------------------------------------------------

    function _anyrIsToken0() internal pure virtual returns (bool);

    function _anyrDecimals() internal pure virtual returns (uint8) {
        return 18;
    }

    /// @dev |tick| at $0.05 per ANYR: log_1.0001(20 * 10^(anyrDecimals - 6)).
    function _priceTick() internal pure virtual returns (int24) {
        return 306_280;
    }

    /// @dev In-range liquidity worth ~$1M of virtual USDG (L = y / sqrt(P)).
    function _liq() internal pure virtual returns (uint128) {
        return 4.5e18;
    }

    function _minLiq() internal pure virtual returns (uint128) {
        return 1e18;
    }

    // ---- setup -----------------------------------------------------------------------------------

    function setUp() public virtual {
        vm.warp(T0);
        deployCodeTo("MockUSDG.sol:MockUSDG", USDG_AT);
        usdg = MockUSDG(USDG_AT);
        address anyrAt = _anyrIsToken0() ? ANYR_LOW : ANYR_HIGH;
        deployCodeTo(
            "MockStockToken.sol:MockStockToken", abi.encode("Anyroute", "ANYR", _anyrDecimals()), anyrAt
        );
        anyr = MockStockToken(anyrAt);

        factory = new MockV3Factory();
        pool = new MockV3Pool(address(factory), address(usdg), address(anyr), FEE);
        factory.setPool(address(usdg), address(anyr), FEE, address(pool));
        router = new MockV3SwapRouter(address(factory));
        v3 = new UniswapV3Adapter(ISwapRouter02(address(router)), gov);
        staking = new AnyrStaking(
            IERC20(address(anyr)), IERC20(address(usdg)), gov, keeper, ops, IBuybackAdapter(address(v3))
        );
        vm.startPrank(gov);
        v3.setCaller(address(staking), true);
        v3.setPath(address(usdg), address(anyr), _path(FEE));
        vm.stopPrank();

        pool.initialize(_baseTick(), _liq(), MIN_CARD);
        anyr.mint(address(pool), 1e40);
        usdg.mint(address(pool), 1e18);
        vm.warp(T0 + 1 hours);

        oracle = new TwapBuybackPriceOracle(_config(), gov, guardian);
        vm.prank(gov);
        staking.setBuybackPriceOracle(oracle);

        usdg.mint(settlement, 1e15);
        vm.prank(settlement);
        usdg.approve(address(staking), type(uint256).max);
        usdg.mint(attacker, 1e15);
        vm.prank(attacker);
        usdg.approve(address(router), type(uint256).max);
    }

    function _config() internal view returns (TwapBuybackPriceOracle.Config memory c) {
        c.pool = address(pool);
        c.factory = address(factory);
        c.staking = address(staking);
        c.routeAdapter = address(v3);
        c.usdg = address(usdg);
        c.anyr = address(anyr);
        c.usdgDecimals = 6;
        c.anyrDecimals = _anyrDecimals();
        c.twapWindow = WINDOW;
        c.shortWindow = SHORT;
        c.minCardinality = MIN_CARD;
        c.minLiquidity = _minLiq();
        c.maxDeviationTicks = MAX_DEV;
        c.haircutBps = HAIRCUT;
    }

    function _path(uint24 fee) internal view returns (bytes memory) {
        return abi.encodePacked(address(usdg), fee, address(anyr));
    }

    // ---- price helpers ---------------------------------------------------------------------------

    function _baseTick() internal pure returns (int24) {
        return _anyrIsToken0() ? -_priceTick() : _priceTick();
    }

    /// @dev `ticks` towards a more expensive ANYR (fewer ANYR per USDG: the direction that lowers the floor).
    function _pricier(int24 tick, int24 ticks) internal pure returns (int24) {
        return _anyrIsToken0() ? tick + ticks : tick - ticks;
    }

    function _one() internal pure returns (uint256) {
        return 10 ** _anyrDecimals();
    }

    /// @dev Uniswap OracleLibrary.getQuoteAtTick (rounding down): `amountIn` USDG in ANYR at `tick`.
    function _refQuote(int24 tick, uint256 amountIn) internal view returns (uint256) {
        uint160 sqrtRatioX96 = TickMath.getSqrtPriceAtTick(tick);
        bool usdgFirst = address(usdg) < address(anyr);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return usdgFirst
                ? Math.mulDiv(ratioX192, amountIn, 1 << 192)
                : Math.mulDiv(1 << 192, amountIn, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return
            usdgFirst
                ? Math.mulDiv(ratioX128, amountIn, 1 << 128)
                : Math.mulDiv(1 << 128, amountIn, ratioX128);
    }

    function _refFloor(int24 tick, uint256 amountIn) internal view returns (uint256) {
        return Math.mulDiv(_refQuote(tick, amountIn), BPS - HAIRCUT, BPS);
    }

    function _floor(uint256 amountIn) internal view returns (uint256 f) {
        (f,) = oracle.minimumOutput(address(usdg), address(anyr), amountIn);
    }

    function _status()
        internal
        view
        returns (TwapBuybackPriceOracle.Status s, TwapBuybackPriceOracle.Reading memory r)
    {
        return oracle.status();
    }

    function _assertStatus(TwapBuybackPriceOracle.Status expected) internal view {
        (TwapBuybackPriceOracle.Status s,) = oracle.status();
        assertEq(uint256(s), uint256(expected), "status");
    }

    // ---- actions ---------------------------------------------------------------------------------

    function _notify(uint256 amount) internal {
        vm.prank(settlement);
        staking.notifyMargin(amount);
    }

    function _attackerBuysAnyr(uint256 usdgIn) internal returns (uint256) {
        vm.prank(attacker);
        return router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(usdg),
                tokenOut: address(anyr),
                fee: FEE,
                recipient: attacker,
                amountIn: usdgIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }
}

/// @notice The oracle cases, run for each token order / decimals variant.
abstract contract TwapOracleCases is TwapOracleFixture {
    // =============================================================================================
    // Construction
    // =============================================================================================

    function test_constructorStoresReviewedConfig() public view {
        assertEq(address(oracle.pool()), address(pool));
        assertEq(oracle.factory(), address(factory));
        assertEq(oracle.staking(), address(staking));
        assertEq(oracle.routeAdapter(), address(v3));
        assertEq(oracle.usdg(), address(usdg));
        assertEq(oracle.anyr(), address(anyr));
        assertEq(oracle.fee(), FEE);
        assertEq(oracle.anyrIsToken0(), _anyrIsToken0());
        assertEq(oracle.usdgDecimals(), 6);
        assertEq(oracle.anyrDecimals(), _anyrDecimals());
        assertEq(oracle.twapWindow(), WINDOW);
        assertEq(oracle.shortWindow(), SHORT);
        assertEq(oracle.minCardinality(), MIN_CARD);
        assertEq(oracle.minLiquidity(), _minLiq());
        assertEq(oracle.maxDeviationTicks(), MAX_DEV);
        assertEq(oracle.haircutBps(), HAIRCUT);
        assertEq(oracle.routeHash(), keccak256(_path(FEE)));
        assertEq(oracle.owner(), gov);
        assertEq(oracle.guardian(), guardian);
        assertFalse(oracle.paused());
        assertEq(oracle.MAX_DEVIATION_TICKS(), 2_000);
    }

    function _expectInvalid(TwapBuybackPriceOracle.Config memory c) internal {
        vm.expectRevert(TwapBuybackPriceOracle.InvalidConfig.selector);
        new TwapBuybackPriceOracle(c, gov, guardian);
    }

    function test_constructorRejectsUnsafeParameters() public {
        TwapBuybackPriceOracle.Config memory c;
        c = _config();
        c.twapWindow = 30 minutes - 1;
        _expectInvalid(c);
        c = _config();
        c.twapWindow = 1 days + 1;
        _expectInvalid(c);
        c = _config();
        c.shortWindow = 59;
        _expectInvalid(c);
        c = _config();
        c.shortWindow = WINDOW / 2 + 1;
        _expectInvalid(c);
        c = _config();
        c.minCardinality = 1;
        _expectInvalid(c);
        c = _config();
        c.minLiquidity = 0;
        _expectInvalid(c);
        c = _config();
        c.maxDeviationTicks = 0;
        _expectInvalid(c);
        c = _config();
        c.maxDeviationTicks = -5;
        _expectInvalid(c);
        c = _config();
        c.maxDeviationTicks = 2_001;
        _expectInvalid(c);
        c = _config();
        c.haircutBps = 30; // == the 0.30% pool fee: a fair swap could never clear the floor
        _expectInvalid(c);
        c = _config();
        c.haircutBps = 1_001;
        _expectInvalid(c);
        c = _config();
        c.usdgDecimals = 18;
        _expectInvalid(c);
        c = _config();
        c.anyrDecimals = _anyrDecimals() + 1;
        _expectInvalid(c);
        c = _config();
        c.anyr = address(usdg);
        _expectInvalid(c);

        // the edge values themselves are accepted
        c = _config();
        c.twapWindow = 30 minutes;
        c.shortWindow = 15 minutes;
        c.minCardinality = 2;
        c.maxDeviationTicks = 2_000;
        c.haircutBps = 31;
        new TwapBuybackPriceOracle(c, gov, address(0));
    }

    function test_constructorRejectsZeroAddresses() public {
        for (uint256 i; i < 6; ++i) {
            TwapBuybackPriceOracle.Config memory c = _config();
            if (i == 0) c.pool = address(0);
            if (i == 1) c.factory = address(0);
            if (i == 2) c.staking = address(0);
            if (i == 3) c.routeAdapter = address(0);
            if (i == 4) c.usdg = address(0);
            if (i == 5) c.anyr = address(0);
            vm.expectRevert(TwapBuybackPriceOracle.ZeroAddress.selector);
            new TwapBuybackPriceOracle(c, gov, guardian);
        }
    }

    function test_constructorRejectsAPoolOutsideTheCanonicalFactory() public {
        // a look-alike pool the factory does not know
        MockV3Pool rogue = new MockV3Pool(address(factory), address(usdg), address(anyr), FEE);
        rogue.initialize(_baseTick(), _liq(), MIN_CARD);
        TwapBuybackPriceOracle.Config memory c = _config();
        c.pool = address(rogue);
        _expectInvalid(c);

        // the right pool claimed under another factory
        c = _config();
        c.factory = address(new MockV3Factory());
        _expectInvalid(c);

        // a canonical pool for another pair
        MockStockToken other = new MockStockToken("Other", "OTH", 18);
        MockV3Pool otherPool = new MockV3Pool(address(factory), address(usdg), address(other), FEE);
        factory.setPool(address(usdg), address(other), FEE, address(otherPool));
        c = _config();
        c.pool = address(otherPool);
        _expectInvalid(c);
    }

    function test_constructorRejectsARouteThatCannotReachThePool() public {
        // an AnyrStaking trading other tokens
        MockStockToken other = new MockStockToken("Other", "OTH", _anyrDecimals());
        AnyrStaking otherStaking = new AnyrStaking(
            IERC20(address(other)), IERC20(address(usdg)), gov, keeper, ops, IBuybackAdapter(address(v3))
        );
        TwapBuybackPriceOracle.Config memory c = _config();
        c.staking = address(otherStaking);
        _expectInvalid(c);

        // an adapter whose router resolves pools from another factory
        UniswapV3Adapter elsewhere = new UniswapV3Adapter(
            ISwapRouter02(address(new MockV3SwapRouter(address(new MockV3Factory())))), gov
        );
        c = _config();
        c.routeAdapter = address(elsewhere);
        _expectInvalid(c);
    }

    // =============================================================================================
    // Floor at a fair price
    // =============================================================================================

    function test_fairFloorIsTwapMinusHaircut() public view {
        (uint256 floor, uint256 updatedAt) = oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
        assertEq(updatedAt, block.timestamp);
        uint256 ref = _refFloor(_baseTick(), 1_000e6);
        assertGe(floor, ref, "rounded against the keeper");
        assertLe(floor - ref, 2);
        // $1,000 at $0.05 is 20,000 ANYR; minus 1% = 19,800
        assertApproxEqRel(floor, 19_800 * _one(), 0.001e18);

        (TwapBuybackPriceOracle.Status s, TwapBuybackPriceOracle.Reading memory r) = _status();
        assertEq(uint256(s), uint256(TwapBuybackPriceOracle.Status.Ok));
        assertEq(r.spotTick, _baseTick());
        assertEq(r.shortTick, _baseTick());
        assertEq(r.longTick, _baseTick());
        assertEq(r.basisTick, _baseTick());
        assertEq(r.liquidity, _liq());
        assertApproxEqRel(r.harmonicLiquidity, _liq(), 1e9);
        assertEq(r.cardinality, MIN_CARD);
    }

    function test_floorRoundsAgainstTheKeeper() public view {
        uint256[6] memory amounts = [uint256(1), 7, 1e6, 999_999_999, 1e12 + 3, 123_456_789_012_345];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 floor = _floor(amounts[i]);
            uint256 ref = _refFloor(_baseTick(), amounts[i]);
            assertGe(floor, ref);
            assertLe(floor - ref, 2);
            assertGe(floor, 1);
        }
    }

    function test_meanTickRoundsTowardsMoreAnyr() public {
        int24 base = _baseTick();
        // one second one tick up: the mean is base + 1/1800
        pool.setTick(base + 1);
        vm.warp(block.timestamp + 1);
        pool.setTick(base);
        vm.warp(block.timestamp + WINDOW - 1);
        (, TwapBuybackPriceOracle.Reading memory r) = _status();
        assertEq(r.longTick, _anyrIsToken0() ? base : base + 1);

        // one second one tick down: the mean is base - 1/1800
        pool.setTick(base - 1);
        vm.warp(block.timestamp + 1);
        pool.setTick(base);
        vm.warp(block.timestamp + WINDOW - 1);
        (, r) = _status();
        assertEq(r.longTick, _anyrIsToken0() ? base - 1 : base);
    }

    // =============================================================================================
    // Manipulation
    // =============================================================================================

    function test_sameBlockSpikeCannotLowerTheFloor() public {
        uint256 fair = _floor(1_000e6);
        pool.setTick(_pricier(_baseTick(), 400));
        assertEq(_floor(1_000e6), fair, "a zero-duration spike has no weight and the pricier spot is ignored");

        pool.setTick(_pricier(_baseTick(), MAX_DEV + 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapBuybackPriceOracle.PriceDeviation.selector,
                _pricier(_baseTick(), MAX_DEV + 1),
                _baseTick(),
                _baseTick()
            )
        );
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
        _assertStatus(TwapBuybackPriceOracle.Status.PriceDeviation);
    }

    function test_cheaperPriceRaisesTheFloorOnceItHolds() public {
        uint256 fair = _floor(1_000e6);
        int24 cheaper = _pricier(_baseTick(), -200);
        pool.setTick(cheaper);
        assertEq(_floor(1_000e6), fair, "spot alone never moves the floor");

        // held for the short window: priced at the short average, the more favourable one
        vm.warp(block.timestamp + SHORT);
        (, TwapBuybackPriceOracle.Reading memory r) = _status();
        assertEq(r.shortTick, cheaper);
        assertEq(r.basisTick, cheaper);
        uint256 floor = _floor(1_000e6);
        assertGt(floor, fair);
        assertGe(floor, _refFloor(cheaper, 1_000e6));
        assertLe(floor - _refFloor(cheaper, 1_000e6), 2);

        pool.setTick(_pricier(_baseTick(), -(MAX_DEV + 50)));
        vm.expectRevert();
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
    }

    function test_shortHeldManipulationMovesTheFloorByItsTimeShareOnly() public {
        // 450 ticks (~4.6%) held for 2 of the 30 minutes: long mean moves 30 ticks, short 180, spot 450
        pool.setTick(_pricier(_baseTick(), 450));
        vm.warp(block.timestamp + 2 minutes);
        (TwapBuybackPriceOracle.Status s, TwapBuybackPriceOracle.Reading memory r) = _status();
        assertEq(uint256(s), uint256(TwapBuybackPriceOracle.Status.Ok));
        assertEq(r.longTick, _pricier(_baseTick(), 30));
        assertEq(r.shortTick, _pricier(_baseTick(), 180));
        assertEq(r.basisTick, r.longTick, "priced at the least manipulated average");
        uint256 floor = _floor(1_000e6);
        assertGe(floor, _refFloor(_pricier(_baseTick(), 30), 1_000e6));
        assertApproxEqRel(floor, 19_800 * _one() * 997 / 1000, 0.002e18); // ~0.3% lower, not 4.6%

        // a larger displacement is refused outright
        pool.setTick(_pricier(_baseTick(), 600));
        vm.expectRevert();
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
    }

    function test_shortWindowGuardCatchesAMoveThatSpotAlreadyReverted() public {
        // push 1,000 ticks for 4 minutes, then put spot back: short mean is far from the long mean
        pool.setTick(_pricier(_baseTick(), 1_000));
        vm.warp(block.timestamp + 4 minutes);
        pool.setTick(_baseTick());
        vm.warp(block.timestamp + 30);
        (TwapBuybackPriceOracle.Status s, TwapBuybackPriceOracle.Reading memory r) = _status();
        assertEq(uint256(s), uint256(TwapBuybackPriceOracle.Status.PriceDeviation));
        assertEq(r.spotTick, _baseTick());
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapBuybackPriceOracle.PriceDeviation.selector, r.spotTick, r.shortTick, r.longTick
            )
        );
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
    }

    function test_sustainedMoveIsTreatedAsTheMarketPrice() public {
        // Documented limit: a price held for the whole window (against arbitrage) is the price.
        int24 moved = _pricier(_baseTick(), 450);
        pool.setTick(moved);
        vm.warp(block.timestamp + WINDOW);
        uint256 floor = _floor(1_000e6);
        assertGe(floor, _refFloor(moved, 1_000e6));
        assertLe(floor - _refFloor(moved, 1_000e6), 2);
    }

    // =============================================================================================
    // History, freshness, cardinality, liquidity, lock
    // =============================================================================================

    function test_quietPoolStaysFreshAndExact() public {
        vm.warp(block.timestamp + 6 hours);
        assertEq(pool.observationCount(), 1, "no activity since initialize");
        (uint256 floor, uint256 updatedAt) = oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
        assertEq(updatedAt, block.timestamp, "the window ends in this block");
        assertGe(floor, _refFloor(_baseTick(), 1_000e6));
        assertLe(floor - _refFloor(_baseTick(), 1_000e6), 2);
    }

    function test_historyShorterThanTheWindowReverts() public {
        vm.warp(T0 + WINDOW - 1); // the pool was initialized at T0
        vm.expectRevert(TwapBuybackPriceOracle.InsufficientHistory.selector);
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
        _assertStatus(TwapBuybackPriceOracle.Status.InsufficientHistory);
        vm.warp(T0 + WINDOW);
        _floor(1_000e6);
    }

    function test_overwrittenRingReverts() public {
        // A small ring filled by one observation per second no longer reaches back 30 minutes.
        TwapBuybackPriceOracle.Config memory c = _config();
        c.minCardinality = 8;
        TwapBuybackPriceOracle small = new TwapBuybackPriceOracle(c, gov, guardian);
        pool.setCardinality(8);
        for (uint256 i; i < 9; ++i) {
            pool.setTick(_baseTick() + (i % 2 == 0 ? int24(1) : int24(0)));
            vm.warp(block.timestamp + 1);
        }
        vm.expectRevert(TwapBuybackPriceOracle.InsufficientHistory.selector);
        small.minimumOutput(address(usdg), address(anyr), 1_000e6);
    }

    function test_cardinalityBelowMinimumReverts() public {
        pool.setCardinality(MIN_CARD - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapBuybackPriceOracle.InsufficientCardinality.selector, MIN_CARD - 1, MIN_CARD
            )
        );
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
        _assertStatus(TwapBuybackPriceOracle.Status.InsufficientCardinality);
    }

    function test_lowCurrentLiquidityReverts() public {
        pool.setLiquidity(_minLiq() - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapBuybackPriceOracle.InsufficientLiquidity.selector, _minLiq() - 1, _minLiq()
            )
        );
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
        _assertStatus(TwapBuybackPriceOracle.Status.InsufficientLiquidity);
    }

    function test_justInTimeLiquidityDoesNotPassTheHarmonicMean() public {
        pool.setLiquidity(_minLiq() / 100);
        vm.warp(block.timestamp + WINDOW);
        pool.setLiquidity(_liq()); // added in the buyback block
        (TwapBuybackPriceOracle.Status s, TwapBuybackPriceOracle.Reading memory r) = _status();
        assertEq(uint256(s), uint256(TwapBuybackPriceOracle.Status.InsufficientLiquidity));
        assertEq(r.liquidity, _liq());
        assertApproxEqRel(r.harmonicLiquidity, _minLiq() / 100, 1e9);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapBuybackPriceOracle.InsufficientLiquidity.selector, r.harmonicLiquidity, _minLiq()
            )
        );
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
    }

    function test_midSwapReadIsRefused() public {
        pool.setUnlocked(false);
        vm.expectRevert(TwapBuybackPriceOracle.PoolLocked.selector);
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
        _assertStatus(TwapBuybackPriceOracle.Status.PoolLocked);
    }

    // =============================================================================================
    // Guardian pause
    // =============================================================================================

    function test_guardianPausesOnlyOwnerUnpauses() public {
        vm.prank(stranger);
        vm.expectRevert(TwapBuybackPriceOracle.NotGuardian.selector);
        oracle.pause();

        vm.expectEmit(true, true, true, true);
        emit TwapBuybackPriceOracle.PauseSet(true, guardian);
        vm.prank(guardian);
        oracle.pause();
        assertTrue(oracle.paused());
        vm.expectRevert(TwapBuybackPriceOracle.OraclePaused.selector);
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
        _assertStatus(TwapBuybackPriceOracle.Status.Paused);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        oracle.unpause();

        vm.prank(gov);
        oracle.unpause();
        assertFalse(oracle.paused());
        _floor(1_000e6);

        vm.prank(gov);
        oracle.pause(); // the owner can pause too
        assertTrue(oracle.paused());
    }

    function test_onlyOwnerSetsGuardian() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        oracle.setGuardian(stranger);
        vm.prank(gov);
        oracle.setGuardian(address(0));
        vm.prank(guardian);
        vm.expectRevert(TwapBuybackPriceOracle.NotGuardian.selector);
        oracle.pause();
    }

    // =============================================================================================
    // Route consistency and inputs
    // =============================================================================================

    function test_floorOnlyAppliesToTheSinglePoolRoute() public {
        // another fee tier (another pool)
        vm.prank(gov);
        v3.setPath(address(usdg), address(anyr), _path(500));
        vm.expectRevert(TwapBuybackPriceOracle.RouteMismatch.selector);
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);

        // a multi-hop route
        address mid = address(new MockStockToken("Mid", "MID", 18));
        vm.prank(gov);
        v3.setPath(
            address(usdg), address(anyr), abi.encodePacked(address(usdg), FEE, mid, FEE, address(anyr))
        );
        vm.expectRevert(TwapBuybackPriceOracle.RouteMismatch.selector);
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);

        // no route
        vm.prank(gov);
        v3.setPath(address(usdg), address(anyr), "");
        vm.expectRevert(TwapBuybackPriceOracle.RouteMismatch.selector);
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);
        _assertStatus(TwapBuybackPriceOracle.Status.RouteMismatch);

        // back on the pool, but AnyrStaking swaps through another adapter
        vm.startPrank(gov);
        v3.setPath(address(usdg), address(anyr), _path(FEE));
        staking.setAdapter(new MockBuybackAdapter(1, 1));
        vm.stopPrank();
        vm.expectRevert(TwapBuybackPriceOracle.RouteMismatch.selector);
        oracle.minimumOutput(address(usdg), address(anyr), 1_000e6);

        vm.prank(gov);
        staking.setAdapter(v3);
        _floor(1_000e6);
    }

    function test_rejectsOtherPairsAndAmounts() public {
        vm.expectRevert(TwapBuybackPriceOracle.UnsupportedPair.selector);
        oracle.minimumOutput(address(anyr), address(usdg), 1_000e6);
        vm.expectRevert(TwapBuybackPriceOracle.UnsupportedPair.selector);
        oracle.minimumOutput(address(usdg), stranger, 1_000e6);
        vm.expectRevert(TwapBuybackPriceOracle.InvalidAmount.selector);
        oracle.minimumOutput(address(usdg), address(anyr), 0);
        vm.expectRevert(TwapBuybackPriceOracle.InvalidAmount.selector);
        oracle.minimumOutput(address(usdg), address(anyr), uint256(type(uint128).max) + 1);
        assertGt(_floor(type(uint128).max), 0);
    }

    // =============================================================================================
    // AnyrStaking integration
    // =============================================================================================

    function test_buybackAtAFairPriceSucceeds() public {
        _notify(4_000e6);
        uint256 floor = _floor(1_000e6);
        vm.prank(keeper);
        uint256 out = staking.executeBuyback(1_000e6, floor);
        assertGe(out, floor);
        assertApproxEqRel(out, 20_000 * _one() * 9955 / 10_000, 0.002e18); // 0.3% fee + ~0.1% impact
        assertEq(anyr.balanceOf(address(staking)), out);
        assertEq(staking.rewardReserve(), out);
        assertEq(staking.buybackBalance(), 1_000e6);
        assertEq(usdg.balanceOf(address(v3)), 0);
    }

    function test_keeperCannotUndercutTheFloor() public {
        _notify(4_000e6);
        uint256 floor = _floor(1_000e6);
        vm.prank(keeper);
        vm.expectRevert(AnyrStaking.UnsafeBuybackPrice.selector);
        staking.executeBuyback(1_000e6, floor - 1);
    }

    function test_buybackRevertsAfterASpotManipulation() public {
        _notify(4_000e6);
        _attackerBuysAnyr(60_000e6); // ~12% up in the buyback block
        (, TwapBuybackPriceOracle.Reading memory r) = _status();
        assertGt(_anyrIsToken0() ? r.spotTick - _baseTick() : _baseTick() - r.spotTick, MAX_DEV);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapBuybackPriceOracle.PriceDeviation.selector, r.spotTick, _baseTick(), _baseTick()
            )
        );
        staking.executeBuyback(1_000e6, 1);
        assertEq(staking.buybackBalance(), 2_000e6);
        assertEq(staking.boughtOnDay(), 0);
    }

    function test_sandwichInsideTheGuardCannotFillBelowTheFloor() public {
        _notify(4_000e6);
        uint256 floorBefore = _floor(1_000e6);
        _attackerBuysAnyr(15_000e6); // ~3% up: inside the deviation guard
        (TwapBuybackPriceOracle.Status s, TwapBuybackPriceOracle.Reading memory r) = _status();
        assertEq(uint256(s), uint256(TwapBuybackPriceOracle.Status.Ok));
        assertGt(_anyrIsToken0() ? r.spotTick - _baseTick() : _baseTick() - r.spotTick, 250);
        assertEq(_floor(1_000e6), floorBefore, "the front-run does not move the floor");
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        staking.executeBuyback(1_000e6, floorBefore);
        assertEq(staking.buybackBalance(), 2_000e6);
    }

    function test_oversizedBuybackFailsClosed() public {
        // $10k in ~$1M of depth costs ~1.3% (fee + impact), more than the 1% haircut allows
        _notify(20_000e6);
        uint256 floor = _floor(10_000e6);
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        staking.executeBuyback(10_000e6, floor);
    }

    function test_quietPoolBuybackPassesStakingFreshnessRule() public {
        _notify(4_000e6);
        vm.warp(block.timestamp + 6 hours);
        uint256 floor = _floor(1_000e6);
        vm.prank(keeper);
        assertGe(staking.executeBuyback(1_000e6, floor), floor);
    }

    /// The keeper bids its read floor plus 0.1%: enough for the averages to drift in the stakers' favour until
    /// the transaction lands (here a 480-tick move priced into the 5-minute average over 3 seconds).
    function test_keeperMarginCoversFloorDriftUntilInclusion() public {
        _notify(4_000e6);
        pool.setTick(_pricier(_baseTick(), -480));
        uint256 read = _floor(1_000e6);
        uint256 bid = read + Math.mulDiv(read, 10, BPS, Math.Rounding.Ceil);
        vm.warp(block.timestamp + 3);
        uint256 atInclusion = _floor(1_000e6);
        assertGt(atInclusion, read, "the short average moved towards the cheaper spot");
        assertLe(atInclusion, bid);
        vm.prank(keeper);
        assertGe(staking.executeBuyback(1_000e6, bid), bid);
    }

    function test_pausedOrReroutedOracleStopsBuybacks() public {
        _notify(4_000e6);
        vm.prank(guardian);
        oracle.pause();
        vm.prank(keeper);
        vm.expectRevert(TwapBuybackPriceOracle.OraclePaused.selector);
        staking.executeBuyback(1_000e6, type(uint128).max);

        vm.startPrank(gov);
        oracle.unpause();
        staking.setAdapter(new MockBuybackAdapter(1e30, 1));
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(TwapBuybackPriceOracle.RouteMismatch.selector);
        staking.executeBuyback(1_000e6, type(uint128).max);
        assertEq(staking.buybackBalance(), 2_000e6);
    }

    // =============================================================================================
    // Fuzz
    // =============================================================================================

    /// A move in the buyback block (a front-run) never changes the floor: it has no weight, or it is refused.
    function testFuzz_sameBlockMoveNeverChangesTheFloor(int24 move, uint256 amountIn) public {
        move = int24(bound(move, -3_000, 3_000));
        amountIn = bound(amountIn, 1, 1e13);
        uint256 fair = _floor(amountIn);
        pool.setTick(_baseTick() + move);
        try oracle.minimumOutput(address(usdg), address(anyr), amountIn) returns (uint256 f, uint256 at) {
            assertLe(move < 0 ? -move : move, MAX_DEV);
            assertEq(f, fair);
            assertEq(at, block.timestamp);
        } catch (bytes memory err) {
            assertGt(move < 0 ? -move : move, MAX_DEV);
            assertEq(bytes4(err), TwapBuybackPriceOracle.PriceDeviation.selector);
        }
    }

    /// Holding a displacement shifts the floor by at most its time share of the long window, and any displacement
    /// held for less than the whole window that exceeds the guard by its remainder is refused.
    function testFuzz_heldMoveShiftsTheFloorByItsTimeShareAtMost(
        uint256 ticks,
        uint256 heldFor,
        uint256 amountIn
    ) public {
        ticks = bound(ticks, 1, 3_000);
        heldFor = bound(heldFor, 0, WINDOW);
        amountIn = bound(amountIn, 1e6, 1e12);
        // forge-lint: disable-next-line(unsafe-typecast)
        pool.setTick(_pricier(_baseTick(), int24(int256(ticks))));
        vm.warp(block.timestamp + heldFor);
        uint256 shift = Math.mulDiv(ticks, heldFor, WINDOW, Math.Rounding.Ceil);
        try oracle.minimumOutput(address(usdg), address(anyr), amountIn) returns (uint256 f, uint256) {
            assertLe(ticks - shift, uint256(int256(MAX_DEV)) + 1);
            // forge-lint: disable-next-line(unsafe-typecast)
            assertGe(f, _refFloor(_pricier(_baseTick(), int24(int256(shift))), amountIn));
        } catch (bytes memory err) {
            assertGt(ticks, uint256(int256(MAX_DEV)));
            assertEq(bytes4(err), TwapBuybackPriceOracle.PriceDeviation.selector);
        }
    }

    /// Every rounding step raises the floor (never below the reference quote, at most 4 base units above).
    function testFuzz_roundsAgainstTheKeeper(int24 tick, uint256 amountIn) public {
        tick = int24(bound(tick, -700_000, 700_000));
        amountIn = bound(amountIn, 1, type(uint128).max);
        pool.setTick(tick);
        vm.warp(block.timestamp + WINDOW);
        uint256 f = _floor(amountIn);
        uint256 ref = _refFloor(tick, amountIn);
        assertGe(f, ref);
        assertLe(f - ref, 4);
        assertGe(f, 1);
    }

    function testFuzz_floorIsMonotoneInAmount(uint256 a, uint256 b) public view {
        a = bound(a, 1, type(uint128).max);
        b = bound(b, a, type(uint128).max);
        assertLe(_floor(a), _floor(b));
    }
}

/// @notice ANYR sorts below USDG (token0): price = USDG per ANYR, ticks around -306,280.
contract TwapOracleAnyrToken0Test is TwapOracleCases {
    function _anyrIsToken0() internal pure override returns (bool) {
        return true;
    }
}

/// @notice ANYR sorts above USDG (token1): price = ANYR per USDG, ticks around +306,280.
contract TwapOracleAnyrToken1Test is TwapOracleCases {
    function _anyrIsToken0() internal pure override returns (bool) {
        return false;
    }
}

/// @notice An 8-decimal ANYR as token1 (ticks around +76,013): the math works in base units.
contract TwapOracleAnyr8DecimalsTest is TwapOracleCases {
    function _anyrIsToken0() internal pure override returns (bool) {
        return false;
    }

    function _anyrDecimals() internal pure override returns (uint8) {
        return 8;
    }

    function _priceTick() internal pure override returns (int24) {
        return 76_013;
    }

    function _liq() internal pure override returns (uint128) {
        return 4.5e13;
    }

    function _minLiq() internal pure override returns (uint128) {
        return 1e13;
    }
}

/// @notice Deploy.s.sol wiring: the oracle is deployed owned by the timelock and enabled only by the governance batch.
contract TwapOracleDeployTest is TwapOracleFixture {
    Deploy internal script;
    TimelockController internal timelock;
    address internal safe = makeAddr("owner-safe");
    string internal constant OUT = "deployments/test-buyback-oracle.json";

    function _anyrIsToken0() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        script = new Deploy();
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        timelock = new TimelockController(1 days, proposers, proposers, address(0));
        // production state before the oracle: buybacks through another adapter, no oracle, no V3 route
        vm.startPrank(gov);
        staking.setBuybackPriceOracle(IBuybackPriceOracle(address(0)));
        staking.setAdapter(new MockBuybackAdapter(1, 1));
        v3.setPath(address(usdg), address(anyr), "");
        staking.transferOwnership(address(timelock));
        v3.transferOwnership(address(timelock));
        vm.stopPrank();
        vm.startPrank(address(timelock));
        staking.acceptOwnership();
        v3.acceptOwnership();
        vm.stopPrank();
    }

    function _params(string memory out) internal view returns (Deploy.BuybackOracleParams memory p) {
        p.deployerKey = uint256(keccak256("deployer"));
        p.timelock = address(timelock);
        p.ownerSafe = safe;
        p.guardian = guardian;
        p.oracle = _config();
        p.outPath = out;
    }

    function test_deployWritesTheGovernanceBatchThatEnablesTheOracle() public {
        vm.createDir("deployments", true);
        TwapBuybackPriceOracle o = TwapBuybackPriceOracle(script.deployBuybackOracleWith(_params(OUT)));
        assertEq(o.owner(), address(timelock));
        assertEq(o.guardian(), guardian);
        // nothing is enabled until governance executes the batch
        assertEq(address(staking.buybackPriceOracle()), address(0));
        (TwapBuybackPriceOracle.Status s,) = o.status();
        assertEq(uint256(s), uint256(TwapBuybackPriceOracle.Status.RouteMismatch));

        string memory batch = vm.readFile(OUT);
        string memory execFile = vm.readFile(script.executeBatchPathFor(OUT));
        vm.removeFile(OUT);
        vm.removeFile(script.executeBatchPathFor(OUT));
        assertEq(vm.parseJsonString(batch, ".anyroute.schema"), "anyroute.buyback-oracle/v1");
        assertEq(vm.parseJsonAddress(batch, ".anyroute.oracle"), address(o));
        assertEq(vm.parseJsonAddress(batch, ".anyroute.pool"), address(pool));
        assertEq(vm.parseJsonAddress(batch, ".anyroute.anyrStaking"), address(staking));
        assertEq(vm.parseJsonAddress(batch, ".anyroute.uniswapV3Adapter"), address(v3));
        assertEq(vm.parseJsonBytes(batch, ".anyroute.path"), _path(FEE));
        assertEq(vm.parseJsonUint(batch, ".anyroute.params.twapWindow"), WINDOW);
        assertEq(vm.parseJsonUint(batch, ".anyroute.params.haircutBps"), HAIRCUT);
        assertEq(vm.parseJsonInt(batch, ".anyroute.params.maxDeviationTicks"), MAX_DEV);
        assertEq(vm.parseJsonString(batch, ".anyroute.params.minLiquidity"), vm.toString(_minLiq()));
        assertEq(vm.parseJsonAddress(batch, ".meta.createdFromSafeAddress"), safe);
        assertEq(vm.parseJsonAddress(batch, ".transactions[0].to"), address(timelock));
        assertEq(vm.parseJsonAddress(execFile, ".transactions[0].to"), address(timelock));

        // OWNER_SAFE schedules, waits out the delay and executes, exactly as written
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads, bytes32 salt) =
            script.buybackOracleBatch(o);
        bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), salt);
        assertEq(vm.parseJsonBytes32(batch, ".anyroute.operationId"), id);
        vm.prank(safe);
        (bool ok,) = address(timelock).call(vm.parseJsonBytes(batch, ".transactions[0].data"));
        assertTrue(ok, "schedule");
        vm.warp(block.timestamp + 1 days);
        vm.prank(safe);
        (ok,) = address(timelock).call(vm.parseJsonBytes(execFile, ".transactions[0].data"));
        assertTrue(ok, "execute");
        assertTrue(timelock.isOperationDone(id));

        assertEq(address(staking.buybackPriceOracle()), address(o));
        assertEq(address(staking.adapter()), address(v3));
        (bytes memory path,) = v3.getPath(address(usdg), address(anyr));
        assertEq(path, _path(FEE));
        (s,) = o.status();
        assertEq(uint256(s), uint256(TwapBuybackPriceOracle.Status.Ok));

        _notify(4_000e6);
        (uint256 floor,) = o.minimumOutput(address(usdg), address(anyr), 1_000e6);
        vm.prank(keeper);
        assertGe(staking.executeBuyback(1_000e6, floor), floor);
    }

    /// The env entry point is opt-in and reads the production manifest's addresses.
    function test_envEntryPointIsOptInAndReadsTheManifest() public {
        vm.expectRevert(bytes("Deploy: set BUYBACK_ORACLE=1 to deploy the buyback oracle"));
        script.deployBuybackOracle();

        vm.createDir("deployments", true);
        string memory manifestPath = "deployments/test-buyback-manifest.json";
        string memory configPath = "deployments/test-buyback-config.json";
        string memory outPath = "deployments/test-buyback-oracle-env.json";
        vm.writeFile(
            manifestPath,
            string.concat(
                '{"mode":"production","chainId":',
                vm.toString(block.chainid),
                ',"contracts":{"usdg":"',
                vm.toString(address(usdg)),
                '","anyrToken":"',
                vm.toString(address(anyr)),
                '","anyrStaking":"',
                vm.toString(address(staking)),
                '","uniswapV3Adapter":"',
                vm.toString(address(v3)),
                '","timelock":"',
                vm.toString(address(timelock)),
                '"},"roles":{"ownerSafe":"',
                vm.toString(safe),
                '","guardian":"',
                vm.toString(guardian),
                '"}}'
            )
        );
        vm.writeFile(
            configPath,
            string.concat(
                '{"usdg":{"decimals":6},"uniswap":{"v3Factory":"', vm.toString(address(factory)), '"}}'
            )
        );
        vm.setEnv("BUYBACK_ORACLE", "1");
        vm.setEnv("DEPLOYMENTS_PATH", manifestPath);
        vm.setEnv("CONFIG_PATH", configPath);
        vm.setEnv("BUYBACK_ORACLE_PATH", outPath);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(uint256(keccak256("deployer"))));
        vm.setEnv("BUYBACK_V3_POOL", vm.toString(address(pool)));
        vm.setEnv("BUYBACK_MIN_LIQUIDITY", vm.toString(uint256(_minLiq())));
        TwapBuybackPriceOracle o = TwapBuybackPriceOracle(script.deployBuybackOracle());
        vm.setEnv("BUYBACK_ORACLE", "");
        vm.setEnv("DEPLOYMENTS_PATH", "");
        vm.setEnv("CONFIG_PATH", "");

        assertEq(o.owner(), address(timelock));
        assertEq(o.guardian(), guardian);
        assertEq(address(o.pool()), address(pool));
        assertEq(o.factory(), address(factory));
        assertEq(o.staking(), address(staking));
        assertEq(o.routeAdapter(), address(v3));
        assertEq(o.twapWindow(), 30 minutes);
        assertEq(o.shortWindow(), 5 minutes);
        assertEq(o.minCardinality(), 1800);
        assertEq(o.minLiquidity(), _minLiq());
        assertEq(o.maxDeviationTicks(), 500);
        assertEq(o.haircutBps(), 100);
        assertEq(vm.parseJsonAddress(vm.readFile(outPath), ".anyroute.oracle"), address(o));

        vm.removeFile(manifestPath);
        vm.removeFile(configPath);
        vm.removeFile(outPath);
        vm.removeFile(script.executeBatchPathFor(outPath));
    }
}

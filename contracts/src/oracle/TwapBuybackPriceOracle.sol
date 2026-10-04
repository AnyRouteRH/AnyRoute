// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IBuybackPriceOracle} from "../interfaces/IBuybackPriceOracle.sol";

/// @notice The Uniswap V3 pool views the oracle reads (canonical V3 core ABI).
interface IUniswapV3PoolOracle {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface IUniswapV3FactoryPools {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @notice NetworkFeeBurn views: its tokens and the adapter its buybacks swap through.
interface IBuybackExecutorRoute {
    function anyr() external view returns (address);
    function usdg() external view returns (address);
    function adapter() external view returns (address);
}

/// @notice UniswapV3Adapter views: its SwapRouter02 and the registered path per pair.
interface IV3BuybackAdapterRoute {
    function router() external view returns (address);
    function getPath(address tokenIn, address tokenOut)
        external
        view
        returns (bytes memory path, bytes memory reversedPath);
}

interface IV3RouterFactory {
    function factory() external view returns (address);
}

/// @title TwapBuybackPriceOracle
/// @notice Buyback floor for NetworkFeeBurn (USDG -> ANYR) from the time-weighted average price of one canonical
/// Uniswap V3 ANYR/USDG pool, the same pool the buyback swaps through.
///
/// Methodology (all parameters immutable; governance changes them by deploying a new oracle and pointing
/// NetworkFeeBurn at it through the timelock):
///  - Reads three ticks from the pool: the arithmetic-mean tick over `twapWindow` (>= 30 min), the mean tick over
///    `shortWindow`, and the current (spot) tick. Mean ticks are geometric-mean prices, so a short spike is weighted
///    by its duration only; a same-block spike has zero weight.
///  - Refuses (reverts) when the spot or short-window tick is more than `maxDeviationTicks` from the long-window tick
///    (1 tick ~ 1 bp), when the observation ring holds fewer than `minCardinality` slots or does not reach back
///    `twapWindow`, when the current or the window's harmonic-mean in-range liquidity is below `minLiquidity`,
///    while the pool is mid-swap (`slot0.unlocked == false`), while the guardian pause is set, and whenever
///    NetworkFeeBurn would not swap through exactly this pool (its adapter must be `routeAdapter` with the single-hop
///    path USDG | fee | ANYR).
///  - Prices at whichever of the two averages is more favourable to the burn executor (more ANYR per USDG), with every
///    rounding step raising the result: `minimumOut = ceil(quote(amountIn) * (10_000 - haircutBps) / 10_000)`.
///    Depressing the floor therefore requires depressing both averages, i.e. holding the pool price down for the
///    whole long window against arbitrage, while a recent move in the burn executor's favour is priced in within minutes.
///    Spot is only a guard: a front-run in the buyback block has zero weight in both averages, and pricing at spot
///    would make the floor jump between the keeper's read and its transaction. `haircutBps` must exceed the pool
///    fee: it is the most a keeper (or anyone sandwiching the keeper) can give away relative to the average price.
///  - `updatedAt` is `block.timestamp`: the averages end in the current block and are recomputed from the pool's own
///    accumulators on every call, so a successful read is never older than NetworkFeeBurn's MAX_PRICE_AGE. History that
///    does not cover the window makes the read revert instead of returning an older value. A pool that simply has not
///    traded keeps its last price, which the accumulator integrates exactly.
/// @dev The floor is only as good as the arbitrage that keeps the pool at the market price: with no arbitrageurs, a
/// price held for the whole window is indistinguishable from a real move. `minLiquidity`, NetworkFeeBurn's daily cap and
/// the haircut bound the value at stake per day.
contract TwapBuybackPriceOracle is IBuybackPriceOracle, Ownable2Step {
    enum Status {
        Ok,
        Paused,
        RouteMismatch,
        PoolLocked,
        InsufficientCardinality,
        InsufficientHistory,
        InsufficientLiquidity,
        PriceDeviation
    }

    struct Config {
        address pool; // canonical Uniswap V3 ANYR/USDG pool
        address factory; // canonical Uniswap V3 factory the pool and the router belong to
        address executor; // NetworkFeeBurn
        address routeAdapter; // UniswapV3Adapter NetworkFeeBurn must swap through
        address usdg; // tokenIn
        address anyr; // tokenOut
        uint8 usdgDecimals; // expected decimals, checked against the tokens
        uint8 anyrDecimals;
        uint32 twapWindow; // seconds, long average
        uint32 shortWindow; // seconds, short average
        uint16 minCardinality; // observation ring slots the pool must hold
        uint128 minLiquidity; // in-range liquidity, now and harmonic mean over twapWindow
        int24 maxDeviationTicks; // max |spot - long| and |short - long|
        uint16 haircutBps; // slippage allowance taken off the TWAP quote
    }

    /// @notice Snapshot of the values the floor is computed from.
    struct Reading {
        int24 spotTick;
        int24 shortTick;
        int24 longTick;
        int24 basisTick; // the tick the floor is priced at
        uint128 liquidity; // current in-range liquidity
        uint128 harmonicLiquidity; // harmonic-mean in-range liquidity over twapWindow
        uint16 cardinality;
    }

    uint32 public constant MIN_TWAP_WINDOW = 30 minutes;
    uint32 public constant MAX_TWAP_WINDOW = 1 days;
    uint32 public constant MIN_SHORT_WINDOW = 1 minutes;
    int24 public constant MAX_DEVIATION_TICKS = 2_000; // ~22%
    uint16 public constant MAX_HAIRCUT_BPS = 1_000; // 10%
    uint256 internal constant BPS = 10_000;

    IUniswapV3PoolOracle public immutable pool;
    address public immutable factory;
    address public immutable executor;
    address public immutable routeAdapter;
    address public immutable usdg;
    address public immutable anyr;
    uint24 public immutable fee;
    uint8 public immutable usdgDecimals;
    uint8 public immutable anyrDecimals;
    uint32 public immutable twapWindow;
    uint32 public immutable shortWindow;
    uint16 public immutable minCardinality;
    uint128 public immutable minLiquidity;
    int24 public immutable maxDeviationTicks;
    uint16 public immutable haircutBps;
    /// @notice True when ANYR is the pool's token0 (price = USDG per ANYR); false when it is token1.
    bool public immutable anyrIsToken0;
    /// @notice keccak256 of the only buyback path this floor applies to: USDG | fee | ANYR.
    bytes32 public immutable routeHash;

    /// @notice May pause instantly (bypassing the owner timelock). Cannot unpause.
    address public guardian;
    /// @notice While set, every quote reverts and buybacks stop.
    bool public paused;

    event GuardianSet(address indexed guardian);
    event PauseSet(bool paused, address indexed by);

    error ZeroAddress();
    error InvalidConfig();
    error NotGuardian();
    error UnsupportedPair();
    error InvalidAmount();
    error OraclePaused();
    error RouteMismatch();
    error PoolLocked();
    error InsufficientCardinality(uint16 cardinality, uint16 required);
    error InsufficientHistory();
    error InsufficientLiquidity(uint128 liquidity, uint128 required);
    error PriceDeviation(int24 spotTick, int24 shortTick, int24 longTick);

    /// @param c Pool, route and guard parameters (see `Config`).
    /// @param owner_ Owner (the governance timelock): sets the guardian and unpauses.
    /// @param guardian_ Pauses instantly; zero leaves only the owner able to pause.
    constructor(Config memory c, address owner_, address guardian_) Ownable(owner_) {
        if (
            c.pool == address(0) || c.factory == address(0) || c.executor == address(0)
                || c.routeAdapter == address(0) || c.usdg == address(0) || c.anyr == address(0)
        ) revert ZeroAddress();
        if (c.usdg == c.anyr) revert InvalidConfig();
        if (c.twapWindow < MIN_TWAP_WINDOW || c.twapWindow > MAX_TWAP_WINDOW) revert InvalidConfig();
        if (c.shortWindow < MIN_SHORT_WINDOW || uint256(c.shortWindow) * 2 > c.twapWindow) {
            revert InvalidConfig();
        }
        if (c.minCardinality < 2 || c.minLiquidity == 0) revert InvalidConfig();
        if (c.maxDeviationTicks <= 0 || c.maxDeviationTicks > MAX_DEVIATION_TICKS) revert InvalidConfig();

        // The pool is the canonical factory's pool for exactly this pair, in the expected token order.
        IUniswapV3PoolOracle p = IUniswapV3PoolOracle(c.pool);
        if (p.factory() != c.factory) revert InvalidConfig();
        (address t0, address t1) = c.anyr < c.usdg ? (c.anyr, c.usdg) : (c.usdg, c.anyr);
        if (p.token0() != t0 || p.token1() != t1) revert InvalidConfig();
        uint24 fee_ = p.fee();
        if (IUniswapV3FactoryPools(c.factory).getPool(c.usdg, c.anyr, fee_) != c.pool) {
            revert InvalidConfig();
        }
        // The haircut must cover at least the pool fee the swap pays, and stays bounded.
        if (uint256(c.haircutBps) * 100 <= fee_ || c.haircutBps > MAX_HAIRCUT_BPS) revert InvalidConfig();

        // Decimals are what governance reviewed.
        if (IERC20Metadata(c.usdg).decimals() != c.usdgDecimals) revert InvalidConfig();
        if (IERC20Metadata(c.anyr).decimals() != c.anyrDecimals) revert InvalidConfig();

        // The buyback side: NetworkFeeBurn trades these tokens, and the adapter's router resolves pools from the same
        // factory, so the path USDG | fee | ANYR through `routeAdapter` swaps in exactly `pool`.
        if (
            IBuybackExecutorRoute(c.executor).anyr() != c.anyr
                || IBuybackExecutorRoute(c.executor).usdg() != c.usdg
        ) {
            revert InvalidConfig();
        }
        if (IV3RouterFactory(IV3BuybackAdapterRoute(c.routeAdapter).router()).factory() != c.factory) {
            revert InvalidConfig();
        }

        pool = p;
        factory = c.factory;
        executor = c.executor;
        routeAdapter = c.routeAdapter;
        usdg = c.usdg;
        anyr = c.anyr;
        fee = fee_;
        usdgDecimals = c.usdgDecimals;
        anyrDecimals = c.anyrDecimals;
        twapWindow = c.twapWindow;
        shortWindow = c.shortWindow;
        minCardinality = c.minCardinality;
        minLiquidity = c.minLiquidity;
        maxDeviationTicks = c.maxDeviationTicks;
        haircutBps = c.haircutBps;
        anyrIsToken0 = t0 == c.anyr;
        routeHash = keccak256(abi.encodePacked(c.usdg, fee_, c.anyr));
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    // ---------------------------------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------------------------------

    /// @notice Set the guardian allowed to pause instantly (zero disables the role).
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Stop quoting (buybacks revert). Callable by the guardian or the owner.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        paused = true;
        emit PauseSet(true, msg.sender);
    }

    /// @notice Resume quoting. Owner (timelock) only.
    function unpause() external onlyOwner {
        paused = false;
        emit PauseSet(false, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Oracle
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IBuybackPriceOracle
    /// @dev `amountIn` USDG base units -> minimum ANYR base units. Reverts (never returns a zero, future or old
    /// quote) whenever a guard fails; see the contract notes.
    function minimumOutput(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 minimumOut, uint256 updatedAt)
    {
        if (tokenIn != usdg || tokenOut != anyr) revert UnsupportedPair();
        if (amountIn == 0 || amountIn > type(uint128).max) revert InvalidAmount();
        (Status s, Reading memory r) = _read();
        if (s != Status.Ok) _refuse(s, r);
        minimumOut = _floor(r.basisTick, amountIn);
        updatedAt = block.timestamp;
    }

    /// @notice Health of the price source without reverting (for monitoring and alerting): `Ok` means
    /// `minimumOutput` would quote now. `r` holds whatever was read before the first failing guard.
    function status() external view returns (Status s, Reading memory r) {
        return _read();
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _read() internal view returns (Status, Reading memory r) {
        if (paused) return (Status.Paused, r);
        if (!_routeMatches()) return (Status.RouteMismatch, r);

        IUniswapV3PoolOracle p = pool;
        (, int24 spot,, uint16 cardinality,,, bool unlocked) = p.slot0();
        r.spotTick = spot;
        r.cardinality = cardinality;
        if (!unlocked) return (Status.PoolLocked, r);
        if (cardinality < minCardinality) return (Status.InsufficientCardinality, r);
        r.liquidity = p.liquidity();
        if (r.liquidity < minLiquidity) return (Status.InsufficientLiquidity, r);

        uint32[] memory ago = new uint32[](3);
        ago[0] = twapWindow;
        ago[1] = shortWindow;
        int56[] memory tc;
        uint160[] memory spl;
        try p.observe(ago) returns (int56[] memory tc_, uint160[] memory spl_) {
            (tc, spl) = (tc_, spl_);
        } catch {
            return (Status.InsufficientHistory, r);
        }
        if (tc.length != 3 || spl.length != 3) return (Status.InsufficientHistory, r);

        r.longTick = _meanTick(tc[0], tc[2], twapWindow);
        r.shortTick = _meanTick(tc[1], tc[2], shortWindow);
        r.harmonicLiquidity = _harmonicLiquidity(spl[0], spl[2]);
        if (r.harmonicLiquidity < minLiquidity) return (Status.InsufficientLiquidity, r);

        int24 maxDev = maxDeviationTicks;
        if (_absDiff(r.spotTick, r.longTick) > maxDev || _absDiff(r.shortTick, r.longTick) > maxDev) {
            return (Status.PriceDeviation, r);
        }
        // More ANYR per USDG: the lower tick when ANYR is token0, the higher when it is token1.
        bool shortFavours = anyrIsToken0 ? r.shortTick < r.longTick : r.shortTick > r.longTick;
        r.basisTick = shortFavours ? r.shortTick : r.longTick;
        return (Status.Ok, r);
    }

    function _refuse(Status s, Reading memory r) internal view {
        if (s == Status.Paused) revert OraclePaused();
        if (s == Status.RouteMismatch) revert RouteMismatch();
        if (s == Status.PoolLocked) revert PoolLocked();
        if (s == Status.InsufficientCardinality) {
            revert InsufficientCardinality(r.cardinality, minCardinality);
        }
        if (s == Status.InsufficientHistory) revert InsufficientHistory();
        if (s == Status.InsufficientLiquidity) {
            // The current liquidity is checked first; if it passed, the window's harmonic mean failed.
            uint128 seen = r.liquidity < minLiquidity ? r.liquidity : r.harmonicLiquidity;
            revert InsufficientLiquidity(seen, minLiquidity);
        }
        revert PriceDeviation(r.spotTick, r.shortTick, r.longTick);
    }

    /// @dev NetworkFeeBurn swaps through `routeAdapter`, whose registered USDG -> ANYR path is the single hop through
    /// this pool (the router resolves USDG | fee | ANYR to `pool` via the shared factory).
    function _routeMatches() internal view returns (bool) {
        if (IBuybackExecutorRoute(executor).adapter() != routeAdapter) return false;
        (bytes memory path,) = IV3BuybackAdapterRoute(routeAdapter).getPath(usdg, anyr);
        return keccak256(path) == routeHash;
    }

    /// @dev Mean tick over `window` seconds, rounded towards more ANYR per USDG (down when ANYR is token0, up
    /// otherwise). Cumulatives wrap like the pool's, hence the unchecked difference.
    function _meanTick(int56 fromCumulative, int56 toCumulative, uint32 window)
        internal
        view
        returns (int24)
    {
        int56 delta;
        unchecked {
            delta = toCumulative - fromCumulative;
        }
        int56 w = int56(uint56(window));
        int56 q = delta / w;
        int56 rem = delta % w;
        if (rem != 0) {
            if (anyrIsToken0 && delta < 0) q--;
            else if (!anyrIsToken0 && delta > 0) q++;
        }
        // casting to 'int24' is safe because the mean of pool ticks lies within [MIN_TICK - 1, MAX_TICK + 1]
        // forge-lint: disable-next-line(unsafe-typecast)
        return int24(q);
    }

    /// @dev Harmonic-mean in-range liquidity over twapWindow (as Uniswap's OracleLibrary.consult), capped to uint128.
    function _harmonicLiquidity(uint160 fromCumulative, uint160 toCumulative)
        internal
        view
        returns (uint128)
    {
        uint160 delta;
        unchecked {
            delta = toCumulative - fromCumulative;
        }
        if (delta == 0) return 0;
        uint256 l = (uint256(twapWindow) * type(uint160).max) / (uint256(delta) << 32);
        // casting to 'uint128' is safe because larger values were just capped
        // forge-lint: disable-next-line(unsafe-typecast)
        return l > type(uint128).max ? type(uint128).max : uint128(l);
    }

    /// @dev ceil(quote * (1 - haircut)); quote = amountIn USDG in ANYR at `tick`, every step rounded up.
    function _floor(int24 tick, uint256 amountIn) internal view returns (uint256) {
        return Math.mulDiv(_quote(tick, amountIn), BPS - haircutBps, BPS, Math.Rounding.Ceil);
    }

    /// @dev Uniswap OracleLibrary.getQuoteAtTick with rounding towards a larger ANYR amount.
    function _quote(int24 tick, uint256 amountIn) internal view returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        bool usdgIsToken0 = !anyrIsToken0; // price = token1 per token0 = sqrtPrice^2
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return usdgIsToken0
                ? Math.mulDiv(ratioX192, amountIn, 1 << 192, Math.Rounding.Ceil)
                : Math.mulDiv(1 << 192, amountIn, ratioX192, Math.Rounding.Ceil);
        }
        uint256 ratioX128 = Math.mulDiv(
            sqrtPriceX96, sqrtPriceX96, 1 << 64, usdgIsToken0 ? Math.Rounding.Ceil : Math.Rounding.Floor
        );
        return usdgIsToken0
            ? Math.mulDiv(ratioX128, amountIn, 1 << 128, Math.Rounding.Ceil)
            : Math.mulDiv(1 << 128, amountIn, ratioX128, Math.Rounding.Ceil);
    }

    function _absDiff(int24 a, int24 b) internal pure returns (int24) {
        return a > b ? a - b : b - a;
    }
}

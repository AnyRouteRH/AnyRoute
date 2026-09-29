// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";

import {ISwapRouter02} from "../../src/adapters/UniswapV3Adapter.sol";

/// @notice Test double of the Uniswap V3 factory's pool registry.
contract MockV3Factory {
    mapping(bytes32 key => address) internal _pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        _pools[_key(a, b, fee)] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return _pools[_key(a, b, fee)];
    }

    function _key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        (a, b) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(a, b, fee));
    }
}

/// @notice Uniswap V3 pool double with a faithful price oracle and a single-range swap.
/// @dev Observations follow V3: one per timestamp, written with the tick and liquidity in force before the change,
/// only when the tick (swap/setTick) or in-range liquidity (setLiquidity) changes; the ring keeps the last
/// `cardinality` of them and `observe` reverts "OLD" before the oldest. Between observations the tick is constant,
/// so interpolation is exact. Swaps use V3 math for one range of constant liquidity (no tick crossing), move the
/// price and pay out of the pool's balances. Scripting: `setTick`, `setLiquidity`, `setCardinality`, `setUnlocked`.
contract MockV3Pool {
    using SafeERC20 for IERC20;

    struct Observation {
        uint32 blockTimestamp;
        int56 tickCumulative;
        uint160 secondsPerLiquidityCumulativeX128;
    }

    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    uint160 public sqrtPriceX96;
    int24 public tick;
    uint128 public liquidity;
    uint16 public cardinality;
    bool public unlocked = true;
    Observation[] internal _obs;

    constructor(address factory_, address tokenA, address tokenB, uint24 fee_) {
        factory = factory_;
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        fee = fee_;
    }

    function initialize(int24 tick_, uint128 liquidity_, uint16 cardinality_) external {
        require(_obs.length == 0, "initialized");
        tick = tick_;
        sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick_);
        liquidity = liquidity_;
        cardinality = cardinality_;
        _obs.push(Observation(uint32(block.timestamp), 0, 0));
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        uint16 index = uint16((_obs.length - 1) % cardinality);
        return (sqrtPriceX96, tick, index, cardinality, cardinality, 0, unlocked);
    }

    function observationCount() external view returns (uint256) {
        return _obs.length;
    }

    // ---- scripting -------------------------------------------------------------------------------

    function setTick(int24 tick_) public {
        if (tick_ != tick) _write();
        tick = tick_;
        sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick_);
    }

    function setLiquidity(uint128 liquidity_) external {
        _write();
        liquidity = liquidity_;
    }

    /// @dev V3 only grows the ring; tests may also shrink it to model an overwritten history.
    function setCardinality(uint16 cardinality_) external {
        cardinality = cardinality_;
    }

    function setUnlocked(bool unlocked_) external {
        unlocked = unlocked_;
    }

    // ---- swap (router side) ----------------------------------------------------------------------

    /// @notice Exact-input swap; the caller has already transferred `amountIn` of the input token to the pool.
    function swapExactIn(bool zeroForOne, uint256 amountIn, address recipient)
        external
        returns (uint256 amountOut)
    {
        require(unlocked, "LOK");
        uint256 lessFee = amountIn * (1e6 - fee) / 1e6;
        uint160 next = SqrtPriceMath.getNextSqrtPriceFromInput(sqrtPriceX96, liquidity, lessFee, zeroForOne);
        amountOut = zeroForOne
            ? SqrtPriceMath.getAmount1Delta(next, sqrtPriceX96, liquidity, false)
            : SqrtPriceMath.getAmount0Delta(sqrtPriceX96, next, liquidity, false);
        int24 nextTick = TickMath.getTickAtSqrtPrice(next);
        if (nextTick != tick) _write();
        tick = nextTick;
        sqrtPriceX96 = next;
        IERC20(zeroForOne ? token1 : token0).safeTransfer(recipient, amountOut);
    }

    // ---- oracle ----------------------------------------------------------------------------------

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(cardinality > 0, "I");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            Observation memory o = _observeSingle(uint32(block.timestamp) - secondsAgos[i]);
            tickCumulatives[i] = o.tickCumulative;
            secondsPerLiquidityCumulativeX128s[i] = o.secondsPerLiquidityCumulativeX128;
        }
    }

    function _observeSingle(uint32 target) internal view returns (Observation memory) {
        uint256 n = _obs.length;
        Observation memory last = _obs[n - 1];
        if (target >= last.blockTimestamp) return _transform(last, target);
        uint256 oldest = n > cardinality ? n - cardinality : 0;
        require(target >= _obs[oldest].blockTimestamp, "OLD");
        uint256 i = n - 1;
        while (_obs[i].blockTimestamp > target) --i;
        Observation memory a = _obs[i];
        if (a.blockTimestamp == target) return a;
        Observation memory b = _obs[i + 1];
        uint32 span = b.blockTimestamp - a.blockTimestamp;
        uint32 into = target - a.blockTimestamp;
        // The tick is constant between observations, so the division is exact (as in V3's Oracle.observeSingle).
        unchecked {
            return Observation(
                target,
                // forge-lint: disable-next-line(divide-before-multiply)
                a.tickCumulative + ((b.tickCumulative - a.tickCumulative) / int56(uint56(span)))
                    * int56(uint56(into)),
                a.secondsPerLiquidityCumulativeX128
                    + uint160(
                        (uint256(b.secondsPerLiquidityCumulativeX128 - a.secondsPerLiquidityCumulativeX128)
                                * into) / span
                    )
            );
        }
    }

    function _write() internal {
        Observation memory last = _obs[_obs.length - 1];
        if (last.blockTimestamp == uint32(block.timestamp)) return;
        _obs.push(_transform(last, uint32(block.timestamp)));
    }

    function _transform(Observation memory last, uint32 time) internal view returns (Observation memory) {
        uint32 delta = time - last.blockTimestamp;
        unchecked {
            return Observation(
                time,
                last.tickCumulative + int56(tick) * int56(uint56(delta)),
                last.secondsPerLiquidityCumulativeX128
                    + ((uint160(delta) << 128) / (liquidity > 0 ? liquidity : 1))
            );
        }
    }
}

/// @notice SwapRouter02 double: exact-input single hop through the factory's MockV3Pool.
contract MockV3SwapRouter {
    using SafeERC20 for IERC20;

    address public immutable factory;

    constructor(address factory_) {
        factory = factory_;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256 amountOut)
    {
        MockV3Pool pool = MockV3Pool(MockV3Factory(factory).getPool(p.tokenIn, p.tokenOut, p.fee));
        require(address(pool) != address(0), "no pool");
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(pool), p.amountIn);
        amountOut = pool.swapExactIn(p.tokenIn == pool.token0(), p.amountIn, p.recipient);
        require(amountOut >= p.amountOutMinimum, "Too little received");
    }
}

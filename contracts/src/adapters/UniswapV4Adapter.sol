// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IBuybackAdapter} from "../interfaces/IBuybackAdapter.sol";

/// @title UniswapV4Adapter
/// @notice Exact-output (ISwapAdapter) and exact-input (IBuybackAdapter) swaps routed through the Uniswap v4
/// PoolManager singleton using unlock/callback flash accounting. Routes are 1-2 hops registered by the owner per
/// (tokenIn, tokenOut); the intermediate currency may be native ETH (its deltas net to zero inside the unlock).
/// @dev Conventions:
///  - v4-core 1.0: `SwapParams.amountSpecified > 0` = exact output, `< 0` = exact input. BalanceDelta is from the
///    swapper's perspective (negative = owed to the pool, positive = owed to the swapper).
///  - Native ETH is `address(0)`. For native `tokenIn`, the whitelisted caller must send `amountInMax` / `amountIn`
///    wei to this adapter (plain transfer, accepted from whitelisted callers only) earlier in the same transaction,
///    exactly like it pre-transfers ERC20s. Unused ETH is refunded to `refundTo` (exact-out) or to msg.sender
///    (exact-in never leaves any). For native `tokenOut`, ETH is sent straight from the PoolManager to `recipient`.
///  - Every hop must fill completely; partial fills (liquidity exhausted) and hook-altered amounts revert.
///  - The adapter holds no balances between calls; `rescue` recovers anything sent by mistake.
contract UniswapV4Adapter is
    ISwapAdapter,
    IBuybackAdapter,
    IUnlockCallback,
    Ownable2Step,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    /// @notice Robinhood Chain PoolManager (informational; the constructor takes the address).
    address public constant RHC_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @notice Max hops per route.
    uint256 public constant MAX_HOPS = 2;

    IPoolManager public immutable poolManager;

    /// @notice Addresses allowed to call the swap functions (PayWithStock, NetworkFeeBurn).
    mapping(address caller => bool) public isCaller;

    mapping(address tokenIn => mapping(address tokenOut => PoolKey[])) internal _routes;

    enum Kind {
        ExactOut,
        ExactIn
    }

    struct CallbackData {
        Kind kind;
        address tokenIn;
        address tokenOut;
        uint256 amount; // exact-out: amountOut, exact-in: amountIn
        uint256 limit; // exact-out: amountInMax, exact-in: minOut
        address recipient;
    }

    event CallerSet(address indexed caller, bool allowed);
    event RouteSet(address indexed tokenIn, address indexed tokenOut, PoolKey[] hops);
    event Swapped(
        address indexed caller,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error NotCaller();
    error NotPoolManager();
    error ZeroAddress();
    error InvalidAmount();
    error InvalidRoute();
    error NoRoute();
    error InsufficientInputBalance(uint256 balance, uint256 required);
    error ExcessiveInput(uint256 amountIn, uint256 amountInMax);
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error IncompleteFill();
    error NativeTransferFailed();

    modifier onlyCaller() {
        if (!isCaller[msg.sender]) revert NotCaller();
        _;
    }

    constructor(IPoolManager poolManager_, address owner_) Ownable(owner_) {
        if (address(poolManager_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
    }

    /// @notice Accept native ETH only from the PoolManager or whitelisted callers (pre-funding native tokenIn).
    receive() external payable {
        if (msg.sender != address(poolManager) && !isCaller[msg.sender]) revert NotCaller();
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function setCaller(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        isCaller[caller] = allowed;
        emit CallerSet(caller, allowed);
    }

    /// @notice Register the ordered hop list for tokenIn -> tokenOut (empty array clears the route).
    /// @dev Each hop's currencies must chain: tokenIn -> (hop0 other side) -> ... -> tokenOut.
    function setRoute(address tokenIn, address tokenOut, PoolKey[] calldata hops) external onlyOwner {
        if (tokenIn == tokenOut || hops.length > MAX_HOPS) revert InvalidRoute();
        delete _routes[tokenIn][tokenOut];
        if (hops.length != 0) {
            Currency cur = Currency.wrap(tokenIn);
            for (uint256 i; i < hops.length; ++i) {
                PoolKey calldata k = hops[i];
                if (!(k.currency0 < k.currency1)) revert InvalidRoute();
                if (cur == k.currency0) cur = k.currency1;
                else if (cur == k.currency1) cur = k.currency0;
                else revert InvalidRoute();
                _routes[tokenIn][tokenOut].push(k);
            }
            if (Currency.unwrap(cur) != tokenOut) revert InvalidRoute();
        }
        emit RouteSet(tokenIn, tokenOut, hops);
    }

    /// @notice Recover tokens / ETH sent to the adapter by mistake (token = address(0) for ETH).
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _pay(token, to, amount);
        emit Rescued(token, to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Swaps
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ISwapAdapter
    function swapExactOut(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        address recipient,
        address refundTo
    ) external onlyCaller nonReentrant returns (uint256 amountIn) {
        if (amountOut == 0 || amountInMax == 0) revert InvalidAmount();
        if (recipient == address(0) || refundTo == address(0)) revert ZeroAddress();
        _requireRoute(tokenIn, tokenOut);
        _requireBalance(tokenIn, amountInMax);

        bytes memory res = poolManager.unlock(
            abi.encode(CallbackData(Kind.ExactOut, tokenIn, tokenOut, amountOut, amountInMax, recipient))
        );
        (amountIn,) = abi.decode(res, (uint256, uint256));

        uint256 refund = amountInMax - amountIn;
        if (refund != 0) _pay(tokenIn, refundTo, refund);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, recipient);
    }

    /// @inheritdoc IBuybackAdapter
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external onlyCaller nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert InvalidAmount();
        if (recipient == address(0)) revert ZeroAddress();
        _requireRoute(tokenIn, tokenOut);
        _requireBalance(tokenIn, amountIn);

        bytes memory res = poolManager.unlock(
            abi.encode(CallbackData(Kind.ExactIn, tokenIn, tokenOut, amountIn, minOut, recipient))
        );
        (, amountOut) = abi.decode(res, (uint256, uint256));
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, recipient);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory d = abi.decode(data, (CallbackData));
        PoolKey[] storage route = _routes[d.tokenIn][d.tokenOut];

        uint256 amountIn;
        uint256 amountOut;
        if (d.kind == Kind.ExactOut) {
            amountOut = d.amount;
            amountIn = _exactOutHops(route, Currency.wrap(d.tokenOut), amountOut);
            if (amountIn > d.limit) revert ExcessiveInput(amountIn, d.limit);
        } else {
            amountIn = d.amount;
            amountOut = _exactInHops(route, Currency.wrap(d.tokenIn), amountIn);
            if (amountOut < d.limit) revert InsufficientOutput(amountOut, d.limit);
        }

        // pay what we owe, then take what we are owed (flash accounting nets everything to zero)
        _settle(d.tokenIn, amountIn);
        poolManager.take(Currency.wrap(d.tokenOut), d.recipient, amountOut);
        return abi.encode(amountIn, amountOut);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function getRoute(address tokenIn, address tokenOut) external view returns (PoolKey[] memory) {
        return _routes[tokenIn][tokenOut];
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev Walk the route backwards: each hop outputs exactly what the next hop (or the recipient) needs.
    function _exactOutHops(PoolKey[] storage route, Currency outCur, uint256 amountOut)
        internal
        returns (uint256 needed)
    {
        needed = amountOut;
        for (uint256 i = route.length; i != 0;) {
            unchecked {
                --i;
            }
            PoolKey memory key = route[i];
            bool zeroForOne = key.currency1 == outCur;
            (int128 inDelta, int128 outDelta) = _swap(key, zeroForOne, needed.toInt256());
            // exact output must be filled completely, and input must be owed (negative delta)
            if (outDelta <= 0 || inDelta >= 0 || int256(outDelta).toUint256() != needed) {
                revert IncompleteFill();
            }
            needed = (-int256(inDelta)).toUint256();
            outCur = zeroForOne ? key.currency0 : key.currency1;
        }
    }

    /// @dev Walk the route forwards: each hop consumes exactly the previous hop's output.
    function _exactInHops(PoolKey[] storage route, Currency inCur, uint256 amountIn)
        internal
        returns (uint256 amount)
    {
        amount = amountIn;
        uint256 n = route.length;
        for (uint256 i; i < n; ++i) {
            PoolKey memory key = route[i];
            bool zeroForOne = key.currency0 == inCur;
            (int128 inDelta, int128 outDelta) = _swap(key, zeroForOne, -amount.toInt256());
            // exact input must be consumed completely, and output must be owed to us (positive delta)
            if (inDelta >= 0 || outDelta <= 0 || (-int256(inDelta)).toUint256() != amount) {
                revert IncompleteFill();
            }
            amount = int256(outDelta).toUint256();
            inCur = zeroForOne ? key.currency1 : key.currency0;
        }
    }

    function _swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified)
        internal
        returns (int128 inDelta, int128 outDelta)
    {
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (inDelta, outDelta) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
    }

    function _settle(address token, uint256 amount) internal {
        if (token == address(0)) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(Currency.wrap(token));
            IERC20(token).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    function _pay(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _requireRoute(address tokenIn, address tokenOut) internal view {
        if (_routes[tokenIn][tokenOut].length == 0) revert NoRoute();
    }

    function _requireBalance(address token, uint256 required) internal view {
        uint256 bal = token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
        if (bal < required) revert InsufficientInputBalance(bal, required);
    }
}

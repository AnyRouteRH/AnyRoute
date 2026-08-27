// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IBuybackAdapter} from "../interfaces/IBuybackAdapter.sol";

/// @notice Minimal Uniswap SwapRouter02 (IV3SwapRouter) interface. SwapRouter02 structs have no deadline.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputParams {
        bytes path; // reversed: tokenOut | fee | ... | tokenIn
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        returns (uint256 amountIn);
    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
}

/// @title UniswapV3Adapter
/// @notice Fallback swap adapter over a Uniswap V3 SwapRouter02. Exact-output for PayWithStock (ISwapAdapter) and
/// exact-input for buybacks (IBuybackAdapter). Paths are registered by the owner per (tokenIn, tokenOut) in forward
/// order (tokenIn | fee | [mid | fee |] tokenOut); the reversed path for exact-output is derived at registration.
/// @dev ERC20 only (use WETH for ether). Approvals are granted per swap and reset to zero afterwards; spent and
/// received amounts are verified with balance deltas. The adapter holds no balances between calls.
contract UniswapV3Adapter is ISwapAdapter, IBuybackAdapter, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant ADDR_SIZE = 20;
    uint256 internal constant FEE_SIZE = 3;
    uint256 internal constant HOP_SIZE = ADDR_SIZE + FEE_SIZE;
    /// @notice Max hops per path.
    uint256 public constant MAX_HOPS = 3;

    ISwapRouter02 public immutable router;

    /// @notice Addresses allowed to call the swap functions (PayWithStock, AnyrStaking).
    mapping(address caller => bool) public isCaller;

    struct Route {
        bytes path; // forward (exact-input) path
        bytes reversedPath; // exact-output path
    }

    mapping(address tokenIn => mapping(address tokenOut => Route)) internal _routes;

    event CallerSet(address indexed caller, bool allowed);
    event PathSet(address indexed tokenIn, address indexed tokenOut, bytes path);
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
    error ZeroAddress();
    error InvalidAmount();
    error InvalidPath();
    error NoRoute();
    error InsufficientInputBalance(uint256 balance, uint256 required);
    error ExcessiveInput(uint256 amountIn, uint256 amountInMax);
    error InsufficientOutput(uint256 amountOut, uint256 minOut);

    modifier onlyCaller() {
        if (!isCaller[msg.sender]) revert NotCaller();
        _;
    }

    constructor(ISwapRouter02 router_, address owner_) Ownable(owner_) {
        if (address(router_) == address(0)) revert ZeroAddress();
        router = router_;
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function setCaller(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        isCaller[caller] = allowed;
        emit CallerSet(caller, allowed);
    }

    /// @notice Register the forward path for tokenIn -> tokenOut (empty bytes clears the route).
    function setPath(address tokenIn, address tokenOut, bytes calldata path) external onlyOwner {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut) revert InvalidPath();
        if (path.length == 0) {
            delete _routes[tokenIn][tokenOut];
        } else {
            if (path.length < ADDR_SIZE + HOP_SIZE || (path.length - ADDR_SIZE) % HOP_SIZE != 0) {
                revert InvalidPath();
            }
            uint256 hops = (path.length - ADDR_SIZE) / HOP_SIZE;
            if (hops > MAX_HOPS) revert InvalidPath();
            if (address(bytes20(path[0:ADDR_SIZE])) != tokenIn) revert InvalidPath();
            if (address(bytes20(path[path.length - ADDR_SIZE:])) != tokenOut) revert InvalidPath();
            _routes[tokenIn][tokenOut] = Route({path: path, reversedPath: _reverse(path, hops)});
        }
        emit PathSet(tokenIn, tokenOut, path);
    }

    /// @notice Recover tokens sent to the adapter by mistake.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
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

        uint256 balBefore = _requireBalance(tokenIn, amountInMax);
        uint256 outBefore = IERC20(tokenOut).balanceOf(recipient);
        _routerExactOut(tokenIn, tokenOut, amountOut, amountInMax, recipient);

        amountIn = balBefore - IERC20(tokenIn).balanceOf(address(this));
        if (amountIn > amountInMax) revert ExcessiveInput(amountIn, amountInMax);
        uint256 received = IERC20(tokenOut).balanceOf(recipient) - outBefore;
        if (received < amountOut) revert InsufficientOutput(received, amountOut);

        if (amountInMax > amountIn) IERC20(tokenIn).safeTransfer(refundTo, amountInMax - amountIn);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, recipient);
    }
}

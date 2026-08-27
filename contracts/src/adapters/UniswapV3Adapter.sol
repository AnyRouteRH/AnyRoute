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
}

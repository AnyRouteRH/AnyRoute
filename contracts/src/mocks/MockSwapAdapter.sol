// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/// @notice Test/dev ISwapAdapter that fills exact-output swaps at a settable price.
/// `price18` = USD value of one whole tokenIn with 18 decimals (same unit as IStockOracle); tokenOut is valued at
/// $1 per whole token. amountIn = ceil(amountOut * 10^decIn * 1e18 / (price18 * 10^decOut)).
/// Spent input is forwarded to SINK so the adapter keeps no balance. Output comes from the adapter's balance,
/// topped up via `mint` when the token supports it (MockUSDG does).
/// Modes let tests simulate failures and misbehaving adapters.
contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    enum Mode {
        Normal, // honest fill
        Revert, // always revert
        ShortPay, // deliver amountOut - 1 without reverting
        NoRefund, // keep the unused input instead of refunding it
        LieAboutAmount // honest fill but return a bogus amountIn
    }

    address public constant SINK = address(0xdEaD);

    uint256 public price18;
    Mode public mode;
    uint256 public calls;

    error MockSwapFailed();
    error ExcessiveInput(uint256 amountIn, uint256 amountInMax);
    error NotFunded(uint256 balance, uint256 amountInMax);

    constructor(uint256 price18_) {
        price18 = price18_;
    }

    function setPrice(uint256 price18_) external {
        price18 = price18_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    /// @notice Input needed for `amountOut` at the current price.
    function quoteIn(address tokenIn, address tokenOut, uint256 amountOut) public view returns (uint256) {
        uint256 decIn = IERC20Metadata(tokenIn).decimals();
        uint256 decOut = IERC20Metadata(tokenOut).decimals();
        return Math.mulDiv(amountOut, 10 ** (decIn + 18), price18 * 10 ** decOut, Math.Rounding.Ceil);
    }

    /// @inheritdoc ISwapAdapter
    function swapExactOut(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        address recipient,
        address refundTo
    ) external returns (uint256 amountIn) {
        calls += 1;
        if (mode == Mode.Revert) revert MockSwapFailed();
        uint256 bal = IERC20(tokenIn).balanceOf(address(this));
        if (bal < amountInMax) revert NotFunded(bal, amountInMax);

        amountIn = quoteIn(tokenIn, tokenOut, amountOut);
        if (amountIn > amountInMax) revert ExcessiveInput(amountIn, amountInMax);

        uint256 outAmt = mode == Mode.ShortPay ? amountOut - 1 : amountOut;
        uint256 outBal = IERC20(tokenOut).balanceOf(address(this));
        if (outBal < outAmt) IMintableERC20(tokenOut).mint(address(this), outAmt - outBal);
        IERC20(tokenOut).safeTransfer(recipient, outAmt);

        IERC20(tokenIn).safeTransfer(SINK, amountIn);
        if (mode != Mode.NoRefund && amountInMax > amountIn) {
            IERC20(tokenIn).safeTransfer(refundTo, amountInMax - amountIn);
        }
        if (mode == Mode.LieAboutAmount) return 1;
    }
}

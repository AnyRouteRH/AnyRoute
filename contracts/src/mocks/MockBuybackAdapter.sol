// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBuybackAdapter} from "../interfaces/IBuybackAdapter.sol";

/// @notice Test/dev IBuybackAdapter: pays `amountIn * rateNum / rateDen` of tokenOut from its own
/// balance (fund it first). `shortfallBps` makes it misbehave by delivering less than it reports,
/// without reverting, to exercise callers' balance-delta checks.
contract MockBuybackAdapter is IBuybackAdapter {
    using SafeERC20 for IERC20;

    uint256 public rateNum;
    uint256 public rateDen;
    uint16 public shortfallBps;

    error Slippage(uint256 amountOut, uint256 minOut);
    error NotFunded();

    /// @param rateNum_ Numerator: tokenOut base units per `rateDen_` tokenIn base units.
    /// @param rateDen_ Denominator.
    constructor(uint256 rateNum_, uint256 rateDen_) {
        setRate(rateNum_, rateDen_);
    }

    /// @notice Set the exchange rate: amountOut = amountIn * num / den.
    function setRate(uint256 num, uint256 den) public {
        require(den != 0, "den=0");
        rateNum = num;
        rateDen = den;
    }

    /// @notice Deliver `bps`/10_000 less than quoted (and than minOut), without reverting.
    function setShortfallBps(uint16 bps) external {
        require(bps <= 10_000, "bps");
        shortfallBps = bps;
    }

    /// @notice Quote for `amountIn`.
    function quote(uint256 amountIn) public view returns (uint256) {
        return (amountIn * rateNum) / rateDen;
    }

    /// @inheritdoc IBuybackAdapter
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        if (IERC20(tokenIn).balanceOf(address(this)) < amountIn) revert NotFunded();
        amountOut = quote(amountIn);
        if (shortfallBps == 0) {
            if (amountOut < minOut) revert Slippage(amountOut, minOut);
            IERC20(tokenOut).safeTransfer(recipient, amountOut);
        } else {
            // Misbehaving mode: report `amountOut` but deliver less.
            IERC20(tokenOut).safeTransfer(recipient, (amountOut * (10_000 - shortfallBps)) / 10_000);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {UniswapV3Adapter, ISwapRouter02} from "../src/adapters/UniswapV3Adapter.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

interface IMint {
    function mint(address to, uint256 amount) external;
}

/// @dev SwapRouter02 stand-in. Rate per (tokenIn, tokenOut): out = in * num / den. Pulls input from msg.sender
/// via transferFrom, mints output to the recipient. Records the last call for assertions.
contract MockSwapRouter02 is ISwapRouter02 {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256[2])) public rates;
    bytes public lastPath;
    uint24 public lastFee;
    string public lastFn;
    bool public underConsume; // exact-in: consume only half the input (misbehaving router)
    bool public overDeliverShort; // exact-out: deliver one unit less than asked (misbehaving router)

    error TooMuchRequested();
    error TooLittleReceived();

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        rates[tokenIn][tokenOut] = [num, den];
    }

    function setUnderConsume(bool v) external {
        underConsume = v;
    }

    function setShortDeliver(bool v) external {
        overDeliverShort = v;
    }

    function _in(address tIn, address tOut, uint256 amountOut) internal view returns (uint256) {
        uint256[2] memory r = rates[tIn][tOut];
        return Math.mulDiv(amountOut, r[1], r[0], Math.Rounding.Ceil);
    }

    function _out(address tIn, address tOut, uint256 amountIn) internal view returns (uint256) {
        uint256[2] memory r = rates[tIn][tOut];
        return amountIn * r[0] / r[1];
    }

    function _first(bytes memory p) internal pure returns (address a) {
        assembly {
            a := shr(96, mload(add(p, 32)))
        }
    }

    function _last(bytes memory p) internal pure returns (address a) {
        uint256 l = p.length;
        assembly {
            a := shr(96, mload(add(add(p, 32), sub(l, 20))))
        }
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256 amountOut)
    {
        lastFn = "exactInputSingle";
        lastFee = p.fee;
        uint256 used = underConsume ? p.amountIn / 2 : p.amountIn;
        amountOut = _out(p.tokenIn, p.tokenOut, used);
        if (amountOut < p.amountOutMinimum) revert TooLittleReceived();
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), used);
        IMint(p.tokenOut).mint(p.recipient, amountOut);
    }
}

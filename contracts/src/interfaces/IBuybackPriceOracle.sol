// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Independently governed price protection; must not derive its floor from keeper calldata
/// or a manipulable instantaneous swap quote. Amounts use the respective token base units.
interface IBuybackPriceOracle {
    function minimumOutput(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256 minimumOut, uint256 updatedAt);
}

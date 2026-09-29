// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The source of the capacity APIU supply is bounded by (CapacityCommit).
interface ICapacitySource {
    /// @notice Sum over open capacity commitments of committed token-units x discount, in APIU base units (18 decimals).
    function openCapacityApiu() external view returns (uint256);
}

/// @notice APIU: a transferable prepaid inference unit. 1 APIU = 1,000,000 token-units of standard-tier
/// inference. Minted only by the capacity commitment contract, never above its open committed capacity, and
/// burned on redemption.
interface IAPIU {
    /// @notice `amount` APIU base units were burned for inference. The event carries only the amount and an
    /// id; nothing about the redeemer's later usage is recorded on-chain.
    event Redeemed(uint256 amount, bytes32 indexed redemptionId);
    event MinterSet(address indexed minter);

    error NotMinter();
    error MinterAlreadySet();
    error ZeroAddress();
    error InvalidAmount();
    error SupplyExceedsCapacity();

    /// @notice 1 APIU is this many token-units.
    function UNITS_PER_APIU() external view returns (uint256);
    function minter() external view returns (address);
    function redemptionCount() external view returns (uint256);

    /// @notice Mint `amount` to `to`. Only the minter; reverts if supply would exceed the minter's open capacity.
    function mint(address to, uint256 amount) external;
    /// @notice Burn `amount` from the caller and emit Redeemed.
    function redeem(uint256 amount) external returns (bytes32 redemptionId);
}

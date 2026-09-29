// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IAPIU, ICapacitySource} from "./interfaces/IAPIU.sol";

/// @title APIU
/// @notice A transferable prepaid inference unit. 1 APIU (18 decimals) = 1,000,000 token-units of
/// standard-tier inference. It is a stored-value unit, not a claim on anything but inference.
/// @dev Supply rule: the minter (CapacityCommit) is the only account that can mint, and every mint is
/// checked against the minter's own report of open committed capacity, so `totalSupply()` can never exceed
/// it through this contract. The minter is set exactly once by the owner (a one-time link avoids a
/// constructor cycle between the two contracts). Redemption burns the caller's units and emits
/// `Redeemed(amount, redemptionId)`; the router issues the inference credit off-chain, and nothing about
/// that later usage is written here. The router floors a redemption to whole token-units (1e12 base units).
contract APIU is IAPIU, ERC20, Ownable2Step {
    /// @inheritdoc IAPIU
    uint256 public constant UNITS_PER_APIU = 1_000_000;

    /// @inheritdoc IAPIU
    address public minter;
    /// @inheritdoc IAPIU
    uint256 public redemptionCount;

    /// @param owner_ Owner (timelock). Can set the minter once and nothing else.
    constructor(address owner_) ERC20("Anyroute Prepaid Inference Unit", "APIU") Ownable(owner_) {}

    /// @notice Link the capacity commitment contract as the only minter. Works once.
    function setMinter(address minter_) external onlyOwner {
        if (minter_ == address(0)) revert ZeroAddress();
        if (minter != address(0)) revert MinterAlreadySet();
        minter = minter_;
        emit MinterSet(minter_);
    }

    /// @inheritdoc IAPIU
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
        if (totalSupply() > ICapacitySource(msg.sender).openCapacityApiu()) revert SupplyExceedsCapacity();
    }

    /// @inheritdoc IAPIU
    function redeem(uint256 amount) external returns (bytes32 redemptionId) {
        if (amount == 0) revert InvalidAmount();
        _burn(msg.sender, amount);
        redemptionId = keccak256(abi.encode(block.chainid, address(this), ++redemptionCount));
        emit Redeemed(amount, redemptionId);
    }
}

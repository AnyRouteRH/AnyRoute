// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IRoyalty} from "./interfaces/IRoyalty.sol";

/// @title Royalty
/// @notice Creator royalties for open-weights fine-tunes. Settlement streams USDG per model; the
/// model's current creator accrues it and can claim at any time.
/// @dev `bps` is informational for settlement (royalty = revenue * bps / 10_000, computed off-chain).
contract Royalty is IRoyalty, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Model {
        address creator;
        uint16 bps;
        uint256 totalStreamed;
    }

    /// @inheritdoc IRoyalty
    uint16 public constant MAX_BPS = 2000;

    /// @notice The USDG token (6 decimals).
    IERC20 public immutable usdg;

    /// @notice Address allowed to register models after the off-chain claim check.
    address public registrar;
    /// @notice Address allowed to stream USDG.
    address public settlement;

    /// @inheritdoc IRoyalty
    mapping(bytes32 modelId => Model) public models;
    /// @inheritdoc IRoyalty
    mapping(address creator => uint256) public claimable;

    event RegistrarSet(address indexed registrar);
    event SettlementSet(address indexed settlement);

    error ZeroAddress();
    error InvalidAmount();

    /// @param usdg_ The USDG token.
    /// @param owner_ Owner (timelock).
    /// @param registrar_ Registrar.
    /// @param settlement_ Settlement.
    constructor(IERC20 usdg_, address owner_, address registrar_, address settlement_) Ownable(owner_) {
        if (address(usdg_) == address(0) || registrar_ == address(0) || settlement_ == address(0)) {
            revert ZeroAddress();
        }
        usdg = usdg_;
        registrar = registrar_;
        settlement = settlement_;
        emit RegistrarSet(registrar_);
        emit SettlementSet(settlement_);
    }
}

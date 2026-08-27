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

    /// @inheritdoc IRoyalty
    /// @dev Re-registering an existing model updates creator and bps; USDG already accrued stays
    /// claimable by the previous creator.
    function register(bytes32 modelId, address creator, uint16 bps) external {
        if (msg.sender != registrar) revert NotRegistrar();
        if (creator == address(0)) revert ZeroAddress();
        if (bps > MAX_BPS) revert BpsTooHigh();
        Model storage m = models[modelId];
        m.creator = creator;
        m.bps = bps;
        emit Registered(modelId, creator, bps);
    }

    /// @inheritdoc IRoyalty
    function transferCreator(bytes32 modelId, address newCreator) external {
        Model storage m = models[modelId];
        if (m.creator == address(0)) revert UnknownModel();
        if (msg.sender != m.creator) revert NotCreator();
        if (newCreator == address(0)) revert ZeroAddress();
        m.creator = newCreator;
        emit CreatorUpdated(modelId, newCreator);
    }

    /// @inheritdoc IRoyalty
    function stream(bytes32 modelId, uint256 amount) external nonReentrant {
        if (msg.sender != settlement) revert NotSettlement();
        if (amount == 0) revert InvalidAmount();
        Model storage m = models[modelId];
        address creator = m.creator;
        if (creator == address(0)) revert UnknownModel();
        m.totalStreamed += amount;
        claimable[creator] += amount;
        emit Streamed(modelId, creator, amount);
        usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc IRoyalty
    function claim(address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        emit Claimed(msg.sender, to, amount);
        usdg.safeTransfer(to, amount);
    }

    /// @notice Set the registrar.
    function setRegistrar(address registrar_) external onlyOwner {
        if (registrar_ == address(0)) revert ZeroAddress();
        registrar = registrar_;
        emit RegistrarSet(registrar_);
    }

    /// @notice Set the settlement address.
    function setSettlement(address settlement_) external onlyOwner {
        if (settlement_ == address(0)) revert ZeroAddress();
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }
}

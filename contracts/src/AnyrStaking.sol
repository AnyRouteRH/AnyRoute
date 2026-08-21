// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAnyrStaking} from "./interfaces/IAnyrStaking.sol";
import {IBuybackAdapter} from "./interfaces/IBuybackAdapter.sol";

/// @title AnyrStaking
/// @notice $ANYR staking. Protocol margin (USDG) arrives via notifyMargin: 50% is queued for keeper
/// buybacks (capped per UTC day, minOut-guarded) whose ANYR is distributed to stakers through a
/// rewardPerToken accumulator; 50% goes to the ops wallet immediately.
/// @dev Principal (staked + cooling down) and rewards are tracked separately: rewards are only ever
/// paid out of `rewardReserve`, which is funded exclusively by buyback proceeds.
contract AnyrStaking is IAnyrStaking, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Cooldown {
        uint256 amount;
        uint64 availableAt;
    }

    /// @notice Unstake cooldown.
    uint64 public constant COOLDOWN = 7 days;
    uint256 private constant PRECISION = 1e18;

    /// @notice The ANYR token (staked and paid as rewards).
    IERC20 public immutable anyr;
    /// @notice The USDG token (6 decimals).
    IERC20 public immutable usdg;

    /// @notice Address allowed to execute buybacks.
    address public keeper;
    /// @notice Receiver of the ops half of margin.
    address public opsWallet;
    /// @notice Swap adapter used for buybacks.
    IBuybackAdapter public adapter;
    /// @notice Max USDG swapped per UTC day.
    uint256 public maxDailyBuyback = 10_000e6;

    /// @inheritdoc IAnyrStaking
    uint256 public buybackBalance;
    /// @notice UTC day index (timestamp / 1 days) of the last buyback.
    uint256 public buybackDay;
    /// @notice USDG swapped during `buybackDay`.
    uint256 public boughtOnDay;

    /// @inheritdoc IAnyrStaking
    uint256 public totalStaked;
    /// @notice Principal waiting out the cooldown (not earning).
    uint256 public totalCooldown;
    /// @notice ANYR owned by stakers as rewards: distributed-but-unclaimed plus `undistributed`.
    uint256 public rewardReserve;
    /// @notice Bought-back ANYR not yet allocated (no stakers, or rounding remainder).
    uint256 public undistributed;
    /// @notice Accumulated rewards per staked token, scaled by 1e18.
    uint256 public rewardPerTokenStored;

    mapping(address account => uint256) private _staked;
    mapping(address account => uint256) public userRewardPerTokenPaid;
    mapping(address account => uint256) public rewards;
    /// @notice Provider an account's stake is attributed to (fixed at first non-zero stake).
    mapping(address account => bytes32) public providerOf;
    mapping(bytes32 providerId => uint256) private _providerStake;
    /// @notice Principal cooling down per account (amount, availableAt).
    mapping(address account => Cooldown) public pendingUnstake;

    event OpsWalletSet(address indexed opsWallet);
    event AdapterSet(address indexed adapter);
    event MaxDailyBuybackSet(uint256 maxDailyBuyback);

    error ZeroAddress();
    error ProviderMismatch();

    /// @param anyr_ ANYR token.
    /// @param usdg_ USDG token.
    /// @param owner_ Owner (timelock).
    /// @param keeper_ Buyback keeper.
    /// @param opsWallet_ Ops wallet.
    /// @param adapter_ Buyback swap adapter.
    constructor(
        IERC20 anyr_,
        IERC20 usdg_,
        address owner_,
        address keeper_,
        address opsWallet_,
        IBuybackAdapter adapter_
    ) Ownable(owner_) {
        if (
            address(anyr_) == address(0) || address(usdg_) == address(0) || keeper_ == address(0)
                || opsWallet_ == address(0) || address(adapter_) == address(0)
        ) revert ZeroAddress();
        anyr = anyr_;
        usdg = usdg_;
        keeper = keeper_;
        opsWallet = opsWallet_;
        adapter = adapter_;
        emit KeeperSet(keeper_);
        emit OpsWalletSet(opsWallet_);
        emit AdapterSet(address(adapter_));
        emit MaxDailyBuybackSet(10_000e6);
    }
}

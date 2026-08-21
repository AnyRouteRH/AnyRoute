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

    // ---------------------------------------------------------------------------------------------
    // Staking
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IAnyrStaking
    /// @dev A non-zero `providerId` attributes the account's whole stake to that provider; once set it
    /// is fixed (a different non-zero id reverts; zero keeps the existing attribution).
    function stake(uint256 amount, bytes32 providerId) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        address account = msg.sender;
        _updateReward(account);

        bytes32 pid = providerOf[account];
        if (providerId != bytes32(0)) {
            if (pid == bytes32(0)) {
                pid = providerId;
                providerOf[account] = pid;
                _providerStake[pid] += _staked[account];
            } else if (pid != providerId) {
                revert ProviderMismatch();
            }
        }

        _staked[account] += amount;
        totalStaked += amount;
        if (pid != bytes32(0)) _providerStake[pid] += amount;
        emit Staked(account, amount, pid);
        anyr.safeTransferFrom(account, address(this), amount);
    }

    /// @inheritdoc IAnyrStaking
    /// @dev The amount stops earning (and counting as provider stake) immediately. Adding to an
    /// existing cooldown restarts the cooldown for the whole pending amount.
    function requestUnstake(uint256 amount) external nonReentrant {
        address account = msg.sender;
        uint256 bal = _staked[account];
        if (amount == 0 || amount > bal) revert InvalidAmount();
        _updateReward(account);

        _staked[account] = bal - amount;
        totalStaked -= amount;
        bytes32 pid = providerOf[account];
        if (pid != bytes32(0)) _providerStake[pid] -= amount;

        Cooldown storage c = pendingUnstake[account];
        c.amount += amount;
        uint64 availableAt = uint64(block.timestamp) + COOLDOWN;
        c.availableAt = availableAt;
        totalCooldown += amount;
        emit UnstakeRequested(account, amount, availableAt);
    }

    /// @inheritdoc IAnyrStaking
    function unstake() external nonReentrant {
        Cooldown memory c = pendingUnstake[msg.sender];
        if (c.amount == 0) revert InvalidAmount();
        if (block.timestamp < c.availableAt) revert CooldownActive();
        delete pendingUnstake[msg.sender];
        totalCooldown -= c.amount;
        emit Unstaked(msg.sender, c.amount);
        anyr.safeTransfer(msg.sender, c.amount);
    }

    /// @inheritdoc IAnyrStaking
    /// @dev Returns 0 (no revert, no event) when nothing is owed.
    function claimRewards() external nonReentrant returns (uint256 reward) {
        _updateReward(msg.sender);
        reward = rewards[msg.sender];
        if (reward == 0) return 0;
        rewards[msg.sender] = 0;
        rewardReserve -= reward;
        emit RewardPaid(msg.sender, reward);
        anyr.safeTransfer(msg.sender, reward);
    }

    // ---------------------------------------------------------------------------------------------
    // Margin & buybacks
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IAnyrStaking
    /// @dev Permissionless (it only donates). Odd base units go to the buyback half.
    function notifyMargin(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 toOps = amount / 2;
        uint256 toBuyback = amount - toOps;
        buybackBalance += toBuyback;
        emit MarginNotified(amount, toBuyback, toOps);
        usdg.safeTransferFrom(msg.sender, address(this), toBuyback);
        if (toOps != 0) usdg.safeTransferFrom(msg.sender, opsWallet, toOps);
    }

    /// @inheritdoc IAnyrStaking
    /// @dev Output is measured by ANYR balance delta, never trusted from the adapter's return value.
    function executeBuyback(uint256 usdgIn, uint256 minAnyrOut) external nonReentrant returns (uint256 anyrOut) {
        if (msg.sender != keeper) revert NotKeeper();
        if (usdgIn == 0 || minAnyrOut == 0) revert InvalidAmount();
        if (usdgIn > buybackBalance) revert BuybackTooLarge();

        uint256 day = block.timestamp / 1 days;
        uint256 used = (day == buybackDay ? boughtOnDay : 0) + usdgIn;
        if (used > maxDailyBuyback) revert BuybackTooLarge();
        buybackDay = day;
        boughtOnDay = used;
        buybackBalance -= usdgIn;

        IBuybackAdapter a = adapter;
        uint256 balanceBefore = anyr.balanceOf(address(this));
        usdg.safeTransfer(address(a), usdgIn);
        a.swapExactIn(address(usdg), address(anyr), usdgIn, minAnyrOut, address(this));
        anyrOut = anyr.balanceOf(address(this)) - balanceBefore;
        if (anyrOut < minAnyrOut) revert InsufficientOutput();

        _distribute(anyrOut);
        emit BoughtBack(usdgIn, anyrOut);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Set the buyback keeper.
    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @notice Set the ops wallet.
    function setOpsWallet(address opsWallet_) external onlyOwner {
        if (opsWallet_ == address(0)) revert ZeroAddress();
        opsWallet = opsWallet_;
        emit OpsWalletSet(opsWallet_);
    }

    /// @notice Set the buyback adapter.
    function setAdapter(IBuybackAdapter adapter_) external onlyOwner {
        if (address(adapter_) == address(0)) revert ZeroAddress();
        adapter = adapter_;
        emit AdapterSet(address(adapter_));
    }

    /// @notice Set the per-UTC-day buyback cap in USDG base units (0 pauses buybacks).
    function setMaxDailyBuyback(uint256 maxDailyBuyback_) external onlyOwner {
        maxDailyBuyback = maxDailyBuyback_;
        emit MaxDailyBuybackSet(maxDailyBuyback_);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IAnyrStaking
    /// @dev Earning stake only (excludes principal in cooldown).
    function stakedOf(address account) external view returns (uint256) {
        return _staked[account];
    }

    /// @inheritdoc IAnyrStaking
    function providerStake(bytes32 providerId) external view returns (uint256) {
        return _providerStake[providerId];
    }

    /// @inheritdoc IAnyrStaking
    function earned(address account) external view returns (uint256) {
        return _earned(account);
    }

    /// @notice USDG that can still be swapped today under the daily cap.
    function buybackRemainingToday() external view returns (uint256) {
        uint256 used = block.timestamp / 1 days == buybackDay ? boughtOnDay : 0;
        return used >= maxDailyBuyback ? 0 : maxDailyBuyback - used;
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _earned(address account) private view returns (uint256) {
        return rewards[account]
            + (_staked[account] * (rewardPerTokenStored - userRewardPerTokenPaid[account])) / PRECISION;
    }

    function _updateReward(address account) private {
        rewards[account] = _earned(account);
        userRewardPerTokenPaid[account] = rewardPerTokenStored;
    }

    /// @dev Allocates `amount` plus any undistributed remainder to current stakers. The allocated part
    /// is rounded up so that the sum of all (rounded-down) individual accruals never exceeds it.
    function _distribute(uint256 amount) private {
        rewardReserve += amount;
        uint256 pending = undistributed + amount;
        uint256 staked = totalStaked;
        if (staked == 0) {
            undistributed = pending;
            return;
        }
        uint256 delta = (pending * PRECISION) / staked;
        if (delta == 0) {
            undistributed = pending;
            return;
        }
        rewardPerTokenStored += delta;
        undistributed = pending - Math.mulDiv(delta, staked, PRECISION, Math.Rounding.Ceil);
    }
}

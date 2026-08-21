// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice $ANYR staking. Protocol margin (USDG) arrives via notifyMargin: 50% funds TWAP-guarded
/// ANYR buybacks distributed to stakers, 50% goes to the attestor/canary ops wallet. A provider's
/// staked ANYR is a routing tie-break only (never a substitute for its USDG bond).
interface IAnyrStaking {
    event Staked(address indexed account, uint256 amount, bytes32 indexed providerId);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 availableAt);
    event Unstaked(address indexed account, uint256 amount);
    event MarginNotified(uint256 usdgIn, uint256 toBuyback, uint256 toOps);
    event BoughtBack(uint256 usdgIn, uint256 anyrOut);
    event RewardPaid(address indexed account, uint256 amount);
    event KeeperSet(address indexed keeper);

    error InvalidAmount();
    error NotKeeper();
    error CooldownActive();
    error BuybackTooLarge();
    error InsufficientOutput();

    function stake(uint256 amount, bytes32 providerId) external;
    function requestUnstake(uint256 amount) external;
    function unstake() external;
    function claimRewards() external returns (uint256);

    /// @notice Pulls `usdg` from msg.sender (settlement) and splits it 50/50.
    function notifyMargin(uint256 usdg) external;
    /// @notice Keeper swaps up to the daily cap of buyback USDG into ANYR with a TWAP-derived minOut.
    function executeBuyback(uint256 usdgIn, uint256 minAnyrOut) external returns (uint256 anyrOut);

    function stakedOf(address account) external view returns (uint256);
    function providerStake(bytes32 providerId) external view returns (uint256);
    function earned(address account) external view returns (uint256);
    function totalStaked() external view returns (uint256);
    function buybackBalance() external view returns (uint256);
}

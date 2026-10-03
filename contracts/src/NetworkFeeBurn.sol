// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IBuybackAdapter} from "./interfaces/IBuybackAdapter.sol";
import {IBuybackPriceOracle} from "./interfaces/IBuybackPriceOracle.sol";

interface INetworkBuybackConfig {
    function usdg() external view returns (IERC20);
    function anyr() external view returns (IERC20);
    function adapter() external view returns (IBuybackAdapter);
    function keeper() external view returns (address);
    function buybackPriceOracle() external view returns (IBuybackPriceOracle);
    function maxDailyBuyback() external view returns (uint256);
}

/// @notice Dedicated network-fee swaps using the staking buyback's adapter, oracle and daily limit.
/// Fund this contract with fee USDG. Its adapter must authorize this contract as a caller.
/// AnyrToken has no holder burn function: the output is transferred to the dead address.
contract NetworkFeeBurn is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    INetworkBuybackConfig public immutable staking;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    struct Operation { uint256 usdgIn; uint256 anyrOut; bool burned; }
    mapping(bytes32 => Operation) public operations;
    uint256 public day;
    uint256 public used;
    event Swapped(bytes32 indexed id, uint256 usdgIn, uint256 anyrOut);
    event Burned(bytes32 indexed id, uint256 anyrOut);
    error Refused();
    constructor(INetworkBuybackConfig staking_) { if (address(staking_) == address(0)) revert Refused(); staking = staking_; }
    function remainingToday() public view returns (uint256) {
        uint256 spent = day == block.timestamp / 1 days ? used : 0;
        uint256 cap = staking.maxDailyBuyback();
        return spent >= cap ? 0 : cap - spent;
    }
    // Slither 0.11.6 does not recognize the EIP-1153 mutex. Both entry points share it;
    // test_adapterKeeperCannotReenterSwapOrBurn checks an adapter that is also keeper.
    // slither-disable-start reentrancy-balance
    function swap(bytes32 id, uint256 amount, uint256 minimum) external nonReentrant {
        if (msg.sender != staking.keeper() || amount == 0 || minimum == 0 || operations[id].usdgIn != 0 || amount > remainingToday()) revert Refused();
        IERC20 input = staking.usdg(); IERC20 output = staking.anyr();
        IBuybackPriceOracle oracle = staking.buybackPriceOracle();
        if (address(oracle) == address(0)) revert Refused();
        (uint256 floor, uint256 updated) = oracle.minimumOutput(address(input), address(output), amount);
        if (floor == 0 || updated == 0 || updated > block.timestamp || block.timestamp - updated > 15 minutes || minimum < floor) revert Refused();
        if (day != block.timestamp / 1 days) { day = block.timestamp / 1 days; used = 0; }
        used += amount;
        IBuybackAdapter adapter = staking.adapter();
        uint256 beforeBalance = output.balanceOf(address(this));
        input.safeTransfer(address(adapter), amount);
        adapter.swapExactIn(address(input), address(output), amount, minimum, address(this));
        uint256 received = output.balanceOf(address(this)) - beforeBalance;
        if (received < minimum) revert Refused();
        operations[id] = Operation(amount, received, false);
        emit Swapped(id, amount, received);
    }
    // slither-disable-end reentrancy-balance
    function burn(bytes32 id) external nonReentrant {
        if (msg.sender != staking.keeper()) revert Refused();
        Operation storage op = operations[id];
        if (op.usdgIn == 0 || op.burned) revert Refused();
        op.burned = true;
        staking.anyr().safeTransfer(DEAD, op.anyrOut);
        emit Burned(id, op.anyrOut);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IBuybackAdapter} from "./interfaces/IBuybackAdapter.sol";
import {IBuybackPriceOracle} from "./interfaces/IBuybackPriceOracle.sol";

/// @notice Dedicated network-fee swaps with their own adapter, oracle and daily limit.
/// Fund this contract with fee USDG. Its adapter must authorize this contract as a caller.
/// The output is transferred to the dead address.
contract NetworkFeeBurn is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    IERC20 public immutable usdg;
    IERC20 public immutable anyr;
    IBuybackAdapter public adapter;
    IBuybackPriceOracle public buybackPriceOracle;
    address public keeper;
    uint256 public maxDailyBuyback;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    struct Operation { uint256 usdgIn; uint256 anyrOut; bool burned; }
    mapping(bytes32 => Operation) public operations;
    uint256 public day;
    uint256 public used;
    event Swapped(bytes32 indexed id, uint256 usdgIn, uint256 anyrOut);
    event Burned(bytes32 indexed id, uint256 anyrOut);
    error Refused();
    event AdapterSet(address indexed adapter);
    event BuybackPriceOracleSet(address indexed oracle);
    event KeeperSet(address indexed keeper);
    event MaxDailyBuybackSet(uint256 maxDailyBuyback);
    constructor(IERC20 anyr_, IERC20 usdg_, address owner_, address keeper_, IBuybackAdapter adapter_, uint256 cap_) Ownable(owner_) {
        if (address(anyr_) == address(0) || address(usdg_) == address(0) || address(anyr_) == address(usdg_) || keeper_ == address(0) || address(adapter_) == address(0)) revert Refused();
        anyr = anyr_; usdg = usdg_; keeper = keeper_; adapter = adapter_; maxDailyBuyback = cap_;
        emit KeeperSet(keeper_); emit AdapterSet(address(adapter_)); emit MaxDailyBuybackSet(cap_);
    }
    function setAdapter(IBuybackAdapter value) external onlyOwner {
        if (address(value) == address(0)) revert Refused();
        adapter = value; emit AdapterSet(address(value));
    }
    // A zero oracle disables swaps; burn of already acquired tokens remains possible.
    function setBuybackPriceOracle(IBuybackPriceOracle value) external onlyOwner {
        buybackPriceOracle = value; emit BuybackPriceOracleSet(address(value));
    }
    function setKeeper(address value) external onlyOwner {
        if (value == address(0)) revert Refused();
        keeper = value; emit KeeperSet(value);
    }
    // Zero disables swaps; reducing the cap never resets usage already recorded today.
    function setMaxDailyBuyback(uint256 value) external onlyOwner {
        maxDailyBuyback = value; emit MaxDailyBuybackSet(value);
    }
    function remainingToday() public view returns (uint256) {
        uint256 spent = day == block.timestamp / 1 days ? used : 0;
        uint256 cap = maxDailyBuyback;
        return spent >= cap ? 0 : cap - spent;
    }
    // Slither 0.11.6 does not recognize the EIP-1153 mutex. Both entry points share it;
    // test_adapterKeeperCannotReenterSwapOrBurn checks an adapter that is also keeper.
    // slither-disable-start reentrancy-balance
    function swap(bytes32 id, uint256 amount, uint256 minimum) external nonReentrant returns (uint256 received) {
        if (msg.sender != keeper || amount == 0 || minimum == 0 || operations[id].usdgIn != 0 || amount > remainingToday()) revert Refused();
        IERC20 input = usdg; IERC20 output = anyr;
        IBuybackPriceOracle oracle = buybackPriceOracle;
        if (address(oracle) == address(0)) revert Refused();
        (uint256 floor, uint256 updated) = oracle.minimumOutput(address(input), address(output), amount);
        if (floor == 0 || updated == 0 || updated > block.timestamp || block.timestamp - updated > 15 minutes || minimum < floor) revert Refused();
        if (day != block.timestamp / 1 days) { day = block.timestamp / 1 days; used = 0; }
        used += amount;
        IBuybackAdapter swapAdapter = adapter;
        uint256 beforeBalance = output.balanceOf(address(this));
        input.safeTransfer(address(swapAdapter), amount);
        swapAdapter.swapExactIn(address(input), address(output), amount, minimum, address(this));
        received = output.balanceOf(address(this)) - beforeBalance;
        if (received < minimum) revert Refused();
        operations[id] = Operation(amount, received, false);
        emit Swapped(id, amount, received);
    }
    // slither-disable-end reentrancy-balance
    function burn(bytes32 id) external nonReentrant {
        if (msg.sender != keeper) revert Refused();
        Operation storage op = operations[id];
        if (op.usdgIn == 0 || op.burned) revert Refused();
        op.burned = true;
        anyr.safeTransfer(DEAD, op.anyrOut);
        emit Burned(id, op.anyrOut);
    }
}

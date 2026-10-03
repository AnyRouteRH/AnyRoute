// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NetworkFeeBurn, INetworkBuybackConfig} from "../src/NetworkFeeBurn.sol";
import {AnyrToken} from "../src/AnyrToken.sol";
import {AnyrStaking} from "../src/AnyrStaking.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockBuybackAdapter} from "../src/mocks/MockBuybackAdapter.sol";
import {NetworkFloor} from "./NetworkFeeBurn.t.sol";
contract NetworkFeeConservationHandler is Test {
    NetworkFeeBurn public fee;
    MockUSDG public input;
    AnyrToken public output;
    NetworkFloor public floor;
    address public keeper;
    uint256 public funded;
    uint256 public spent;
    uint256 public received;
    uint256 public destroyed;
    uint256 public count;
    constructor(NetworkFeeBurn fee_, MockUSDG input_, AnyrToken output_, NetworkFloor floor_, address keeper_) {
        fee = fee_; input = input_; output = output_; floor = floor_; keeper = keeper_; fund(100_000e6);
    }
    function fund(uint256 amount) public { amount = 1 + amount % 1_000_000e6; input.mint(address(fee), amount); funded += amount; }
    function swap(uint256 amount) external {
        uint256 room = fee.remainingToday(); uint256 balance = input.balanceOf(address(fee)); if (room > balance) room = balance;
        // Adapter reserve is finite, so do not synthesize more output than its backing.
        uint256 reserve = output.balanceOf(address(fee.staking().adapter())) / 1e13;
        if (room > reserve) room = reserve; if (room == 0) return;
        amount = 1 + amount % room; floor.configure(1, block.timestamp, false);
        vm.prank(keeper); fee.swap(bytes32(++count), amount, 1);
        spent += amount; received += amount * 1e13;
    }
    function burn(uint256 selection) external {
        if (count == 0) return; bytes32 id = bytes32(1 + selection % count);
        (,uint256 bought,bool done) = fee.operations(id); if (done) return;
        vm.prank(keeper); fee.burn(id); destroyed += bought;
    }
    function advance(uint256 seconds_) external { vm.warp(block.timestamp + 1 + seconds_ % 2 days); }
    function assertConservation() external view {
        assertEq(input.balanceOf(address(fee)), funded - spent);
        assertEq(output.balanceOf(address(fee)), received - destroyed);
        assertEq(output.balanceOf(fee.DEAD()), destroyed);
        uint256 held;
        for (uint256 i = 1; i <= count; i++) { (,uint256 bought,bool done) = fee.operations(bytes32(i)); if (!done) held += bought; }
        assertEq(held, received - destroyed);
    }
}
contract NetworkFeeConservationTest is Test {
    NetworkFeeConservationHandler internal handler;
    function setUp() external {
        vm.warp(1_800_000_000); address keeper = makeAddr("keeper");
        AnyrToken output = new AnyrToken([address(this), makeAddr("team"), makeAddr("liquidity"), makeAddr("community")]);
        MockUSDG input = new MockUSDG(); MockBuybackAdapter adapter = new MockBuybackAdapter(10e18, 1e6);
        output.transfer(address(adapter), 100_000_000e18);
        AnyrStaking staking = new AnyrStaking(output, input, address(this), keeper, makeAddr("ops"), adapter);
        NetworkFloor floor = new NetworkFloor(); staking.setBuybackPriceOracle(floor);
        NetworkFeeBurn fee = new NetworkFeeBurn(INetworkBuybackConfig(address(staking)));
        handler = new NetworkFeeConservationHandler(fee, input, output, floor, keeper); targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.fund.selector; selectors[1] = handler.swap.selector; selectors[2] = handler.burn.selector; selectors[3] = handler.advance.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }
    function invariant_networkFeeCustodyMatchesUnburnedPurchases() external view { handler.assertConservation(); }
    function test_swapAndBurnExerciseBothBalances() external { handler.swap(1e6); handler.burn(0); handler.assertConservation(); assertGt(handler.destroyed(), 0); }
}

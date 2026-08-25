// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {PayWithStock} from "../src/PayWithStock.sol";
import {IPayWithStock} from "../src/interfaces/IPayWithStock.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IStockOracle} from "../src/interfaces/IStockOracle.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {ChainlinkStockOracle} from "../src/oracle/ChainlinkStockOracle.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockSwapAdapter} from "../src/mocks/MockSwapAdapter.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockCredits} from "./utils/MockCredits.sol";

/// @dev Adapter that, while acting as the router, re-enters payCall from inside the swap.
contract ReentrantAdapter is ISwapAdapter {
    PayWithStock public pws;
    bytes32 public key;

    function arm(PayWithStock pws_, bytes32 key_) external {
        pws = pws_;
        key = key_;
    }

    function start(uint256 usdgOwed) external returns (uint256) {
        return pws.payCall(key, usdgOwed, 100);
    }

    function swapExactOut(address, address, uint256 amountOut, uint256, address, address)
        external
        returns (uint256)
    {
        return pws.payCall(key, amountOut, 100); // must hit the reentrancy guard
    }
}

/// @dev Adapter that tries to call the self-only swap hook directly.
contract SneakyAdapter is ISwapAdapter {
    function swapExactOut(address tokenIn, address, uint256 amountOut, uint256 amountInMax, address, address)
        external
        returns (uint256)
    {
        PayWithStock(msg.sender).attemptSwap(address(this), tokenIn, amountOut, amountInMax);
        return 0;
    }
}

contract PayWithStockTest is Test {
    MockUSDG usdg;
    MockCredits credits;
    ChainlinkStockOracle oracle;
    MockAggregator feed;
    MockStockToken nvda;
    MockSwapAdapter primary;
    MockSwapAdapter fallbackAdapter;
    PayWithStock pws;

    address owner = makeAddr("owner");
    address router = makeAddr("router");
    address wallet = makeAddr("wallet");
    address other = makeAddr("other");
    bytes32 constant KEY = keccak256("api-key-1");

    uint256 constant PRICE18 = 180e18; // $180 per NVDA
    uint256 constant CAP = 10e18; // 10 NVDA / day
    uint256 constant T0 = 1_750_000_000; // mid-day UTC

    function setUp() public {
        vm.warp(T0);
        usdg = new MockUSDG();
        credits = new MockCredits(IERC20(address(usdg)));
        oracle = new ChainlinkStockOracle(owner);
        feed = new MockAggregator(8, 180e8, "NVDA / USD");
        nvda = new MockStockToken("NVIDIA xStock", "NVDAx", 18);
        primary = new MockSwapAdapter(PRICE18);
        fallbackAdapter = new MockSwapAdapter(PRICE18);
        pws = new PayWithStock(IERC20(address(usdg)), ICredits(address(credits)), oracle, router, owner);

        vm.startPrank(owner);
        oracle.setFeed(address(nvda), feed, 1 hours, true);
        pws.registerToken(address(nvda), address(primary), address(fallbackAdapter), true);
        vm.stopPrank();

        nvda.mint(wallet, 1000e18);
        vm.startPrank(wallet);
        nvda.approve(address(pws), type(uint256).max);
        pws.openSession(KEY, address(nvda), CAP);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _session(bytes32 key) internal view returns (IPayWithStock.Session memory s) {
        (s.wallet, s.token, s.capRawPerDay, s.spentRawToday, s.dayStart, s.active) = pws.sessions(key);
    }
}

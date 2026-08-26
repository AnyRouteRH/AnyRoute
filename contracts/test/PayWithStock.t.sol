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

    function _maxIn(uint256 usdgOwed, uint16 slip) internal view returns (uint256 maxIn, uint256 raw) {
        (raw,) = pws.quoteRaw(address(nvda), usdgOwed);
        maxIn = Math.mulDiv(raw, 10_000 + slip, 10_000, Math.Rounding.Ceil);
    }

    function _pay(uint256 usdgOwed, uint16 slip) internal returns (uint256) {
        vm.prank(router);
        return pws.payCall(KEY, usdgOwed, slip);
    }

    function _assertNoLeftovers() internal view {
        assertEq(nvda.balanceOf(address(pws)), 0, "pws holds stock");
        assertEq(usdg.balanceOf(address(pws)), 0, "pws holds usdg");
        assertEq(usdg.allowance(address(pws), address(credits)), 0, "dangling credits allowance");
    }

    function _today() internal view returns (uint64) {
        return uint64(block.timestamp - block.timestamp % 1 days);
    }

    // ------------------------------------------------------------------ construction / admin

    function test_constructorState() public view {
        assertEq(address(pws.usdg()), address(usdg));
        assertEq(address(pws.credits()), address(credits));
        assertEq(address(pws.oracle()), address(oracle));
        assertEq(pws.router(), router);
        assertEq(pws.owner(), owner);
        assertEq(pws.maxSlipCapBps(), 300);
        (bool enabled, address p, address f) = pws.tokens(address(nvda));
        assertTrue(enabled);
        assertEq(p, address(primary));
        assertEq(f, address(fallbackAdapter));
    }

    function test_constructorRejectsZeroAndBadUsdg() public {
        vm.expectRevert(PayWithStock.ZeroAddress.selector);
        new PayWithStock(IERC20(address(0)), ICredits(address(credits)), oracle, router, owner);
        vm.expectRevert(PayWithStock.ZeroAddress.selector);
        new PayWithStock(IERC20(address(usdg)), ICredits(address(credits)), oracle, address(0), owner);
        vm.expectRevert(PayWithStock.InvalidToken.selector);
        new PayWithStock(IERC20(address(nvda)), ICredits(address(credits)), oracle, router, owner); // 18 decimals
    }

    function test_registerToken() public {
        MockStockToken tsla = new MockStockToken("TSLA", "TSLAx", 8);
        vm.expectEmit(true, false, false, true);
        emit IPayWithStock.TokenRegistered(address(tsla), address(primary), address(0), true);
        vm.prank(owner);
        pws.registerToken(address(tsla), address(primary), address(0), true);
        (bool enabled, address p, address f) = pws.tokens(address(tsla));
        assertTrue(enabled);
        assertEq(p, address(primary));
        assertEq(f, address(0));
    }

    function test_registerTokenValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(PayWithStock.InvalidToken.selector);
        pws.registerToken(address(0), address(primary), address(0), true);
        vm.expectRevert(PayWithStock.InvalidToken.selector);
        pws.registerToken(address(usdg), address(primary), address(0), true);
        vm.expectRevert(PayWithStock.InvalidAdapter.selector);
        pws.registerToken(address(nvda), address(0), address(0), true);
        vm.expectRevert(PayWithStock.InvalidAdapter.selector);
        pws.registerToken(address(nvda), address(primary), address(primary), true);
        MockStockToken weird = new MockStockToken("W", "W", 37);
        vm.expectRevert(PayWithStock.InvalidToken.selector);
        pws.registerToken(address(weird), address(primary), address(0), true);
        // disabling without adapters is fine
        pws.registerToken(address(nvda), address(0), address(0), false);
        vm.stopPrank();
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        pws.registerToken(address(nvda), address(primary), address(0), true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        pws.setRouter(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        pws.setOracle(IStockOracle(other));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        pws.setMaxSlip(10);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        pws.rescue(IERC20(address(nvda)), other, 1);
        vm.stopPrank();
    }

    function test_setters() public {
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, false);
        emit IPayWithStock.RouterSet(other);
        pws.setRouter(other);
        assertEq(pws.router(), other);

        vm.expectEmit(true, false, false, false);
        emit IPayWithStock.OracleSet(other);
        pws.setOracle(IStockOracle(other));
        assertEq(address(pws.oracle()), other);

        vm.expectEmit(false, false, false, true);
        emit IPayWithStock.MaxSlipSet(1000);
        pws.setMaxSlip(1000);
        assertEq(pws.maxSlipCapBps(), 1000);

        vm.expectRevert(IPayWithStock.SlippageTooHigh.selector);
        pws.setMaxSlip(1001);
        vm.expectRevert(PayWithStock.ZeroAddress.selector);
        pws.setRouter(address(0));
        vm.expectRevert(PayWithStock.ZeroAddress.selector);
        pws.setOracle(IStockOracle(address(0)));
        vm.stopPrank();
    }

    function test_rescue() public {
        nvda.mint(address(pws), 5);
        vm.prank(owner);
        pws.rescue(IERC20(address(nvda)), owner, 5);
        assertEq(nvda.balanceOf(owner), 5);
    }

    // ------------------------------------------------------------------ sessions

    function test_openSessionState() public view {
        IPayWithStock.Session memory s = _session(KEY);
        assertEq(s.wallet, wallet);
        assertEq(s.token, address(nvda));
        assertEq(s.capRawPerDay, CAP);
        assertEq(s.spentRawToday, 0);
        assertEq(s.dayStart, _today());
        assertTrue(s.active);
        assertEq(pws.remainingToday(KEY), CAP);
    }

    function test_openSessionEmits() public {
        vm.expectEmit(true, true, true, true);
        emit IPayWithStock.SessionOpened(keccak256("k2"), other, address(nvda), 7);
        vm.prank(other);
        pws.openSession(keccak256("k2"), address(nvda), 7);
    }

    function test_openSessionWithPermit() public {
        (address permitWallet, uint256 pk) = makeAddrAndKey("permitWallet");
        bytes32 key2 = keccak256("k-permit");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                permitWallet,
                address(pws),
                5e18,
                nvda.nonces(permitWallet),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", nvda.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        // a front-run permit must not grief the session opening
        nvda.permit(permitWallet, address(pws), 5e18, deadline, v, r, s);
        vm.prank(permitWallet);
        pws.openSessionWithPermit(key2, address(nvda), 5e18, 5e18, deadline, v, r, s);
        assertEq(nvda.allowance(permitWallet, address(pws)), 5e18);
        assertEq(_session(key2).wallet, permitWallet);
        assertTrue(_session(key2).active);
    }

    function test_openSessionValidation() public {
        vm.startPrank(wallet);
        vm.expectRevert(IPayWithStock.TokenNotEnabled.selector);
        pws.openSession(KEY, address(usdg), 1);
        vm.expectRevert(IPayWithStock.InvalidAmount.selector);
        pws.openSession(KEY, address(nvda), 0);
        vm.stopPrank();
    }
}

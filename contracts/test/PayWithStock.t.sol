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

    function test_openSessionCannotHijackActive() public {
        vm.prank(other);
        vm.expectRevert(IPayWithStock.NotSessionWallet.selector);
        pws.openSession(KEY, address(nvda), 1);
    }

    function test_openSessionTakeoverAfterClose() public {
        vm.prank(wallet);
        pws.closeSession(KEY);
        vm.prank(other);
        pws.openSession(KEY, address(nvda), 5);
        IPayWithStock.Session memory s = _session(KEY);
        assertEq(s.wallet, other);
        assertEq(s.capRawPerDay, 5);
        assertEq(s.spentRawToday, 0);
    }

    function test_reopenSameDayKeepsSpend() public {
        uint256 spent = _pay(10e6, 100);
        vm.startPrank(wallet);
        pws.closeSession(KEY);
        pws.openSession(KEY, address(nvda), CAP * 2); // raise own cap
        vm.stopPrank();
        assertEq(_session(KEY).spentRawToday, spent);
        assertEq(_session(KEY).capRawPerDay, CAP * 2);
    }

    function test_reopenOtherTokenResetsSpend() public {
        _pay(10e6, 100);
        MockStockToken tsla = new MockStockToken("TSLA", "TSLAx", 8);
        vm.prank(owner);
        pws.registerToken(address(tsla), address(primary), address(0), true);
        vm.prank(wallet);
        pws.openSession(KEY, address(tsla), 1e8);
        assertEq(_session(KEY).spentRawToday, 0);
        assertEq(_session(KEY).token, address(tsla));
    }

    function test_closeSession() public {
        vm.prank(other);
        vm.expectRevert(IPayWithStock.NotSessionWallet.selector);
        pws.closeSession(KEY);

        vm.expectEmit(true, true, false, false);
        emit IPayWithStock.SessionClosed(KEY, wallet);
        vm.prank(wallet);
        pws.closeSession(KEY);
        assertFalse(_session(KEY).active);
        assertEq(pws.remainingToday(KEY), 0);

        vm.prank(wallet);
        vm.expectRevert(IPayWithStock.NoSession.selector);
        pws.closeSession(KEY);

        vm.prank(router);
        vm.expectRevert(IPayWithStock.NoSession.selector);
        pws.payCall(KEY, 1e6, 100);
    }

    function test_forceCloseSession() public {
        vm.prank(other);
        vm.expectRevert(IPayWithStock.NotRouter.selector);
        pws.forceCloseSession(KEY);

        vm.expectEmit(true, true, false, false);
        emit IPayWithStock.SessionClosed(KEY, wallet);
        vm.prank(router);
        pws.forceCloseSession(KEY);
        assertFalse(_session(KEY).active);
    }

    // ------------------------------------------------------------------ quoteRaw

    function test_quoteRawExample() public view {
        (uint256 raw, uint256 price) = pws.quoteRaw(address(nvda), 1e6); // $1 of NVDA at $180
        assertEq(price, PRICE18);
        assertEq(raw, 5_555_555_555_555_556); // ceil(1e18 / 180)
    }

    function test_quoteRawRevertsWhenOracleNotOk() public {
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(IPayWithStock.OracleNotOk.selector);
        pws.quoteRaw(address(nvda), 1e6);
    }

    function testFuzz_quoteRawMath(uint256 decSeed, uint256 answer, uint256 mult, uint256 usdgOwed) public {
        uint8[3] memory decs = [uint8(6), uint8(8), uint8(18)];
        uint8 dec = decs[decSeed % 3];
        answer = bound(answer, 1e2, 1e14); // $0.000001 .. $1,000,000 (8-dec feed)
        mult = bound(mult, 0.01e18, 100e18);
        usdgOwed = bound(usdgOwed, 1, 1e12); // up to $1M

        MockStockToken t = new MockStockToken("T", "T", dec);
        // forge-lint: disable-next-line(unsafe-typecast)
        MockAggregator f = new MockAggregator(8, int256(answer), "T/USD"); // answer bounded to 1e14
        t.setUiMultiplier(mult);
        vm.prank(owner);
        oracle.setFeed(address(t), f, 1 hours, true);

        (uint256 raw, uint256 price) = pws.quoteRaw(address(t), usdgOwed);
        (uint256 oraclePrice,) = oracle.fairPrice(address(t));
        assertEq(price, oraclePrice);
        assertEq(price, answer * 1e10 * mult / 1e18);

        // raw is the ceiling of usdgOwed * 10^dec * 1e18 / (price * 1e6)
        uint256 need = usdgOwed * 10 ** dec * 1e18;
        assertGe(raw * price * 1e6, need, "raw too small");
        assertLt((raw - 1) * price * 1e6, need, "raw not minimal");
    }

    // ------------------------------------------------------------------ payCall: happy path

    function test_payCallHappyPath() public {
        uint256 owed = 5e6;
        uint16 slip = 100;
        (uint256 maxIn, uint256 raw) = _maxIn(owed, slip);
        uint256 walletBefore = nvda.balanceOf(wallet);

        vm.expectEmit(true, true, false, true);
        emit IPayWithStock.PaidWithStock(KEY, address(nvda), raw, PRICE18, owed);
        uint256 spent = _pay(owed, slip);

        assertEq(spent, raw, "adapter at fair price spends exactly rawNeeded");
        assertLt(spent, maxIn);
        assertEq(walletBefore - nvda.balanceOf(wallet), spent, "wallet charged rawSpent only");
        assertEq(credits.credited(KEY), owed);
        assertEq(usdg.balanceOf(address(credits)), owed);
        assertEq(_session(KEY).spentRawToday, spent, "actual spend recorded");
        assertEq(nvda.balanceOf(address(primary)), 0, "adapter keeps nothing");
        assertEq(fallbackAdapter.calls(), 0);
        _assertNoLeftovers();
    }

    function test_payCallOnlyRouter() public {
        vm.prank(other);
        vm.expectRevert(IPayWithStock.NotRouter.selector);
        pws.payCall(KEY, 1e6, 100);
    }

    function test_payCallZeroAmount() public {
        vm.prank(router);
        vm.expectRevert(IPayWithStock.InvalidAmount.selector);
        pws.payCall(KEY, 0, 100);
    }

    function test_payCallNoSession() public {
        vm.prank(router);
        vm.expectRevert(IPayWithStock.NoSession.selector);
        pws.payCall(keccak256("nope"), 1e6, 100);
    }

    function test_payCallTokenDisabled() public {
        vm.prank(owner);
        pws.registerToken(address(nvda), address(primary), address(0), false);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.TokenNotEnabled.selector);
        pws.payCall(KEY, 1e6, 100);
    }

    function test_payCallOracleNotOk() public {
        vm.prank(owner);
        oracle.pause(address(nvda));
        vm.prank(router);
        vm.expectRevert(IPayWithStock.OracleNotOk.selector);
        pws.payCall(KEY, 1e6, 100);
    }

    function test_payCallOracleStale() public {
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.OracleNotOk.selector);
        pws.payCall(KEY, 1e6, 100);
    }

    function test_payCallWithoutAllowanceReverts() public {
        vm.prank(wallet);
        nvda.approve(address(pws), 0);
        (uint256 maxIn,) = _maxIn(1e6, 100);
        vm.prank(router);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(pws), 0, maxIn)
        );
        pws.payCall(KEY, 1e6, 100);
    }

    function test_payCallCreditsRevertIsAtomic() public {
        credits.setShouldRevert(true);
        uint256 walletBefore = nvda.balanceOf(wallet);
        vm.prank(router);
        vm.expectRevert(MockCredits.MockCreditsReverted.selector);
        pws.payCall(KEY, 1e6, 100);
        assertEq(nvda.balanceOf(wallet), walletBefore);
        assertEq(_session(KEY).spentRawToday, 0);
    }

    // ------------------------------------------------------------------ slippage

    function test_slippageAboveCapReverts() public {
        vm.prank(router);
        vm.expectRevert(IPayWithStock.SlippageTooHigh.selector);
        pws.payCall(KEY, 1e6, 301);
    }

    function test_slippageAtRaisedCap() public {
        vm.prank(owner);
        pws.setMaxSlip(1000);
        primary.setPrice(PRICE18 * 10_000 / 11_000 + 1); // pool 9.09% below fair: needs ~10% slippage
        _pay(1e6, 1000);
        assertEq(fallbackAdapter.calls(), 0);
    }

    function testFuzz_slippageBounds(uint256 owed, uint16 slip, uint256 adapterPrice) public {
        owed = bound(owed, 1, 1_000e6);
        slip = uint16(bound(slip, 0, 300));
        adapterPrice = bound(adapterPrice, PRICE18 / 2, PRICE18 * 2);
        primary.setPrice(adapterPrice);
        fallbackAdapter.setMode(MockSwapAdapter.Mode.Revert);
        vm.prank(wallet);
        pws.openSession(KEY, address(nvda), type(uint256).max);

        (uint256 maxIn,) = _maxIn(owed, slip);
        uint256 needed = primary.quoteIn(address(nvda), address(usdg), owed);
        uint256 walletBefore = nvda.balanceOf(wallet);

        vm.prank(router);
        if (needed > maxIn) {
            vm.expectRevert(IPayWithStock.SwapFailed.selector);
            pws.payCall(KEY, owed, slip);
            assertEq(nvda.balanceOf(wallet), walletBefore);
        } else {
            uint256 spent = pws.payCall(KEY, owed, slip);
            assertEq(spent, needed);
            assertLe(spent, maxIn);
            assertEq(walletBefore - nvda.balanceOf(wallet), spent);
        }
        _assertNoLeftovers();
    }

    // ------------------------------------------------------------------ cap & day rollover

    function test_capCheckedAgainstMaxInRecordsActual() public {
        (uint256 maxIn, uint256 raw) = _maxIn(5e6, 300);
        vm.prank(wallet);
        pws.openSession(KEY, address(nvda), maxIn - 1);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.CapExceeded.selector);
        pws.payCall(KEY, 5e6, 300);

        vm.prank(wallet);
        pws.openSession(KEY, address(nvda), maxIn);
        uint256 spent = _pay(5e6, 300);
        assertEq(spent, raw);
        assertEq(_session(KEY).spentRawToday, raw, "actual, not maxIn");
        assertEq(pws.remainingToday(KEY), maxIn - raw);
    }

    function test_dayRollover() public {
        // spend most of the cap
        uint256 owed = 1_700e6; // ~9.44 NVDA
        _pay(owed, 0);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.CapExceeded.selector);
        pws.payCall(KEY, owed, 0);

        // one second before midnight: still capped
        uint256 nextDay = _today() + 1 days;
        vm.warp(nextDay - 1);
        feed.setAnswer(180e8);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.CapExceeded.selector);
        pws.payCall(KEY, owed, 0);

        // at midnight UTC the window resets
        vm.warp(nextDay);
        feed.setAnswer(180e8);
        assertEq(pws.remainingToday(KEY), CAP);
        uint256 spent = _pay(owed, 0);
        IPayWithStock.Session memory s = _session(KEY);
        assertEq(s.dayStart, nextDay);
        assertEq(s.spentRawToday, spent);
    }
}

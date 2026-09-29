// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PayWithStock} from "../src/PayWithStock.sol";
import {IPayWithStock} from "../src/interfaces/IPayWithStock.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {ChainlinkStockOracle} from "../src/oracle/ChainlinkStockOracle.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockSwapAdapter} from "../src/mocks/MockSwapAdapter.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockCredits} from "./utils/MockCredits.sol";

/// @dev Drives PayWithStock as a fully compromised router would (replays, forgeries, tampered, stale, expired and
/// foreign charges, arbitrary allowance charges, junk calls) next to the honest flows (signed charges, allowances,
/// revocations, session re-opens, time passing), and keeps the ghost books the invariants check.
contract PayWithStockHandler is CommonBase, StdCheats, StdUtils {
    PayWithStock public immutable pws;
    MockStockToken public immutable nvda;
    MockAggregator public immutable feed;
    MockSwapAdapter public immutable adapter;
    MockCredits public immutable credits;
    address public immutable router;
    address public immutable wallet;
    uint256 internal immutable walletPk;
    uint256 internal immutable attackerPk;
    address internal immutable relayer;
    bytes32 public constant KEY = keccak256("invariant-key");
    uint256 public constant CAP = 3e18;

    // ghost books
    uint256 public pulled; // raw units that left the wallet through successful charges
    uint256 public usdgCredited; // USDG credited by successful charges
    uint256 public forgedSuccesses; // charges that went through without a fresh, matching wallet authorization
    uint256 public boundViolations; // charges that spent more than their signed / allowance limit
    uint256 public signedOk;
    uint256 public allowanceOk;
    uint256 public attacksRejected;

    IPayWithStock.ChargeAuthorization[] internal executed;
    bytes[] internal executedSigs;
    IPayWithStock.ChargeAuthorization[] internal revoked; // signed, never submitted, then revoked
    bytes[] internal revokedSigs;
    IPayWithStock.ChargeAuthorization[] internal pending; // signed, not yet submitted
    bytes[] internal pendingSigs;

    uint256[] public grantedNonces;
    mapping(uint256 nonce => uint256) public totalOf;
    mapping(uint256 nonce => uint256) public spentUnder;

    uint256 internal seq;

    constructor(
        PayWithStock pws_,
        MockStockToken nvda_,
        MockAggregator feed_,
        MockSwapAdapter adapter_,
        MockCredits credits_,
        address router_,
        address wallet_,
        uint256 walletPk_
    ) {
        pws = pws_;
        nvda = nvda_;
        feed = feed_;
        adapter = adapter_;
        credits = credits_;
        router = router_;
        wallet = wallet_;
        walletPk = walletPk_;
        (, attackerPk) = makeAddrAndKey("attacker");
        relayer = makeAddr("relayer");
    }

    // ------------------------------------------------------------------ helpers

    function _epoch() internal view returns (uint64 e) {
        (,,,,,, e) = pws.sessions(KEY);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _newAuth(uint256 owedSeed, uint256 maxRawSeed)
        internal
        returns (IPayWithStock.ChargeAuthorization memory a)
    {
        uint256 n = seq++;
        a = IPayWithStock.ChargeAuthorization({
            keyHash: KEY,
            token: address(nvda),
            usdgAmount: bound(owedSeed, 1, 60e6),
            maxRaw: maxRawSeed % 4 == 0 ? type(uint256).max : bound(maxRawSeed, 1, 1e18),
            usageCommitment: keccak256(abi.encode("usage", n)),
            nonce: n * 7 + 3, // unordered
            epoch: _epoch(),
            deadline: block.timestamp + 1 hours,
            router: router
        });
    }

    function _walletLoss() internal view returns (uint256) {
        return 1_000_000e18 - nvda.balanceOf(wallet);
    }

    /// @dev Submit as the router; `authorized` says whether a success is legitimate.
    function _submit(IPayWithStock.ChargeAuthorization memory a, bytes memory sig, bool authorized) internal {
        uint256 lossBefore = _walletLoss();
        vm.prank(router);
        try pws.payCall(a, sig, 300) returns (uint256 spent) {
            if (!authorized) forgedSuccesses++;
            if (spent > a.maxRaw || _walletLoss() - lossBefore != spent) boundViolations++;
            pulled += spent;
            usdgCredited += a.usdgAmount;
            signedOk++;
            executed.push(a);
            executedSigs.push(sig);
        } catch {
            if (!authorized) attacksRejected++;
        }
    }

    // ------------------------------------------------------------------ honest wallet / router

    function signedCharge(uint256 owedSeed, uint256 maxRawSeed) external {
        IPayWithStock.ChargeAuthorization memory a = _newAuth(owedSeed, maxRawSeed);
        _submit(a, _sign(walletPk, pws.hashCharge(a)), true);
    }

    function signLater(uint256 owedSeed, uint256 maxRawSeed) external {
        IPayWithStock.ChargeAuthorization memory a = _newAuth(owedSeed, maxRawSeed);
        pending.push(a);
        pendingSigs.push(_sign(walletPk, pws.hashCharge(a)));
    }

    function submitPending(uint256 idx) external {
        if (pending.length == 0) return;
        idx = bound(idx, 0, pending.length - 1);
        IPayWithStock.ChargeAuthorization memory a = pending[idx];
        bytes memory sig = pendingSigs[idx];
        pending[idx] = pending[pending.length - 1];
        pendingSigs[idx] = pendingSigs[pendingSigs.length - 1];
        pending.pop();
        pendingSigs.pop();
        // legitimate only while its epoch is current and it has not expired
        _submit(a, sig, a.epoch == _epoch() && block.timestamp <= a.deadline);
    }

    function grantAllowance(uint256 totalSeed, uint256 perSeed, uint256 validSeed) external {
        uint256 total = bound(totalSeed, 1, 2e18);
        IPayWithStock.AllowanceAuthorization memory al = IPayWithStock.AllowanceAuthorization({
            keyHash: KEY,
            token: address(nvda),
            maxRawTotal: total,
            maxRawPerCharge: bound(perSeed, 1, total),
            validUntil: block.timestamp + bound(validSeed, 1, 7 days),
            nonce: pws.allowanceNonces(KEY),
            epoch: _epoch(),
            router: router
        });
        bytes memory sig = _sign(walletPk, pws.hashAllowance(al));
        vm.prank(relayer);
        try pws.setAllowance(al, sig) {
            grantedNonces.push(al.nonce);
            totalOf[al.nonce] = total;
        } catch {}
    }

    function allowanceCharge(uint256 owedSeed, bool greedyAdapter) external {
        adapter.setMode(greedyAdapter ? MockSwapAdapter.Mode.NoRefund : MockSwapAdapter.Mode.Normal);
        (,, uint256 spentBefore, uint256 nonce,,,) = pws.allowances(KEY);
        (, uint256 perCharge,,,,,) = pws.allowances(KEY);
        uint256 lossBefore = _walletLoss();
        uint256 owed = bound(owedSeed, 1, 6e6); // sometimes above the $5 limit
        vm.prank(router);
        try pws.payCallWithAllowance(
            KEY, owed, keccak256(abi.encode("allowance-usage", seq++)), 300
        ) returns (
            uint256 spent
        ) {
            if (owed > 5e6) forgedSuccesses++;
            if (spent > perCharge || _walletLoss() - lossBefore != spent) boundViolations++;
            (,, uint256 spentAfter,,,,) = pws.allowances(KEY);
            if (spentAfter != spentBefore + spent) boundViolations++;
            spentUnder[nonce] += spent;
            pulled += spent;
            usdgCredited += owed;
            allowanceOk++;
        } catch {}
        adapter.setMode(MockSwapAdapter.Mode.Normal);
    }

    function revoke() external {
        vm.prank(wallet);
        pws.revokeAuthorizations(KEY);
        _killPending();
    }

    function closeAndReopen(uint256 capSeed) external {
        (,,,,, bool active,) = pws.sessions(KEY);
        vm.startPrank(wallet);
        if (active) pws.closeSession(KEY);
        pws.openSession(KEY, address(nvda), bound(capSeed, 1e17, CAP));
        vm.stopPrank();
        _killPending();
    }

    function _killPending() internal {
        while (pending.length > 0) {
            revoked.push(pending[pending.length - 1]);
            revokedSigs.push(pendingSigs[pendingSigs.length - 1]);
            pending.pop();
            pendingSigs.pop();
        }
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 30 hours));
        feed.setAnswer(180e8);
    }

    // ------------------------------------------------------------------ compromised router

    function replayExecuted(uint256 idx) external {
        if (executed.length == 0) return;
        idx = bound(idx, 0, executed.length - 1);
        _submit(executed[idx], executedSigs[idx], false);
    }

    function submitRevoked(uint256 idx) external {
        if (revoked.length == 0) return;
        idx = bound(idx, 0, revoked.length - 1);
        _submit(revoked[idx], revokedSigs[idx], false);
    }

    function forgeCharge(uint256 owedSeed, uint8 kind, uint256 tweak) external {
        IPayWithStock.ChargeAuthorization memory a = _newAuth(owedSeed, type(uint256).max);
        bytes memory sig = _sign(walletPk, pws.hashCharge(a));
        kind = uint8(bound(kind, 0, 7));
        tweak = bound(tweak, 1, type(uint64).max);
        if (kind == 0) {
            sig = _sign(attackerPk, pws.hashCharge(a)); // router's own / an attacker's key
        } else if (kind == 1) {
            a.usdgAmount += tweak; // inflate after signing
        } else if (kind == 2) {
            a.maxRaw = 0; // strip / change the bound
        } else if (kind == 3) {
            a.usageCommitment = keccak256(abi.encode(tweak)); // swap the usage
        } else if (kind == 4) {
            a.nonce += tweak; // fresh nonce for an old signature
        } else if (kind == 5) {
            a.router = address(uint160(tweak)); // charge meant for another router
        } else if (kind == 6) {
            sig = new bytes(65); // garbage
        } else {
            // a correctly signed charge for an epoch that is not current
            a.epoch = _epoch() + uint64(1 + tweak % 3);
            sig = _sign(walletPk, pws.hashCharge(a));
        }
        _submit(a, sig, false);
    }

    function junkCall(uint8 which, uint256 x, bytes32 y, bytes calldata junk) external {
        uint256 lossBefore = _walletLoss();
        which = uint8(bound(which, 0, 3));
        IPayWithStock.ChargeAuthorization memory a = _newAuth(x, x);
        bytes memory data;
        if (which == 0) {
            data = abi.encodeCall(PayWithStock.payCall, (a, junk, 300));
        } else if (which == 1) {
            data = abi.encodeCall(PayWithStock.attemptSwap, (address(adapter), address(nvda), x, x));
        } else if (which == 2) {
            data = abi.encodeCall(PayWithStock.revokeAuthorizations, (y));
        } else {
            data = bytes.concat(bytes4(uint32(x)), junk);
        }
        vm.prank(router);
        (bool ok,) = address(pws).call(data);
        if (_walletLoss() != lossBefore) forgedSuccesses++;
        if (ok && which < 3 && which != 2) forgedSuccesses++;
    }

    function grantedCount() external view returns (uint256) {
        return grantedNonces.length;
    }
}

contract PayWithStockInvariantTest is Test {
    PayWithStockHandler handler;
    PayWithStock pws;
    MockStockToken nvda;
    MockUSDG usdg;
    MockCredits credits;

    function setUp() public {
        vm.warp(1_750_000_000);
        address owner = makeAddr("owner");
        address router = makeAddr("router");
        (address wallet, uint256 walletPk) = makeAddrAndKey("wallet");
        usdg = new MockUSDG();
        credits = new MockCredits(IERC20(address(usdg)));
        ChainlinkStockOracle oracle = new ChainlinkStockOracle(owner);
        MockAggregator feed = new MockAggregator(8, 180e8, "NVDA / USD");
        nvda = new MockStockToken("NVIDIA xStock", "NVDAx", 18);
        MockSwapAdapter adapter = new MockSwapAdapter(180e18);
        pws = new PayWithStock(IERC20(address(usdg)), ICredits(address(credits)), oracle, router, owner);
        vm.startPrank(owner);
        oracle.setFeed(address(nvda), feed, 1 hours, true);
        pws.registerToken(address(nvda), address(adapter), address(0), true);
        vm.stopPrank();

        handler = new PayWithStockHandler(pws, nvda, feed, adapter, credits, router, wallet, walletPk);
        nvda.mint(wallet, 1_000_000e18);
        vm.startPrank(wallet);
        nvda.approve(address(pws), type(uint256).max);
        pws.openSession(handler.KEY(), address(nvda), handler.CAP());
        vm.stopPrank();

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = PayWithStockHandler.signedCharge.selector;
        selectors[1] = PayWithStockHandler.signLater.selector;
        selectors[2] = PayWithStockHandler.submitPending.selector;
        selectors[3] = PayWithStockHandler.grantAllowance.selector;
        selectors[4] = PayWithStockHandler.allowanceCharge.selector;
        selectors[5] = PayWithStockHandler.revoke.selector;
        selectors[6] = PayWithStockHandler.closeAndReopen.selector;
        selectors[7] = PayWithStockHandler.warp.selector;
        selectors[8] = PayWithStockHandler.replayExecuted.selector;
        selectors[9] = PayWithStockHandler.submitRevoked.selector;
        selectors[10] = PayWithStockHandler.forgeCharge.selector;
        selectors[11] = PayWithStockHandler.junkCall.selector;
        selectors[12] = PayWithStockHandler.allowanceCharge.selector; // weight the allowance path
        selectors[13] = PayWithStockHandler.signedCharge.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev Tokens leave the wallet only through charges it authorized, exactly as much as they spent.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_walletLossEqualsAuthorizedSpend() public view {
        assertEq(1_000_000e18 - nvda.balanceOf(handler.wallet()), handler.pulled());
    }

    /// @dev No replayed, revoked, forged, tampered, foreign or oversized charge ever succeeds.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnauthorizedCharge() public view {
        assertEq(handler.forgedSuccesses(), 0);
    }

    /// @dev No charge spends more than its signed maximum / the allowance's per-charge limit.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_chargesWithinTheirBounds() public view {
        assertEq(handler.boundViolations(), 0);
    }

    /// @dev Every allowance's charges together stay within its signed total.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_allowanceTotals() public view {
        uint256 n = handler.grantedCount();
        for (uint256 i; i < n; ++i) {
            uint256 nonce = handler.grantedNonces(i);
            assertLe(handler.spentUnder(nonce), handler.totalOf(nonce));
        }
        (uint256 total,, uint256 spent,,,,) = pws.allowances(handler.KEY());
        assertLe(spent, total);
    }

    /// @dev The daily cap holds and nothing is left in the contract; credits match what was paid for.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_capCustodyAndCredits() public view {
        (,,, uint256 spentToday, uint64 dayStart,,) = pws.sessions(handler.KEY());
        if (dayStart == block.timestamp - block.timestamp % 1 days) assertLe(spentToday, handler.CAP());
        assertEq(nvda.balanceOf(address(pws)), 0);
        assertEq(usdg.balanceOf(address(pws)), 0);
        assertEq(credits.credited(handler.KEY()), handler.usdgCredited());
    }

    /// @dev The handler really exercises the honest paths and the attacks (a scripted run of it).
    function test_handlerExercisesEveryPath() public {
        handler.signedCharge(5e6, 0);
        handler.signLater(2e6, 0);
        handler.submitPending(0);
        handler.grantAllowance(1e18, 1e17, 1 days);
        handler.allowanceCharge(3e6, false);
        handler.allowanceCharge(3e6, true);
        handler.allowanceCharge(6e6, false); // above $5: refused
        handler.replayExecuted(0);
        handler.signLater(2e6, 0);
        handler.revoke();
        handler.submitRevoked(0);
        handler.allowanceCharge(1e6, false); // allowance revoked with the epoch: refused
        for (uint8 kind; kind < 8; ++kind) {
            handler.forgeCharge(1e6, kind, 12345);
        }
        handler.junkCall(0, 1e6, bytes32(0), hex"deadbeef");
        handler.closeAndReopen(1e18);
        handler.warp(26 hours);
        handler.signedCharge(1e6, 0);
        assertEq(handler.signedOk(), 3);
        assertEq(handler.allowanceOk(), 2);
        assertEq(handler.attacksRejected(), 10);
        assertEq(handler.forgedSuccesses(), 0);
        assertEq(handler.boundViolations(), 0);
        invariant_walletLossEqualsAuthorizedSpend();
        invariant_allowanceTotals();
        invariant_capCustodyAndCredits();
    }
}

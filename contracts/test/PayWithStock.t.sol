// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
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

/// @dev Adapter that, while the swap runs, calls back into PayWithStock with arbitrary calldata (a payment as the
/// router, a relayed allowance, a session change) and bubbles the result.
contract ReentrantAdapter is ISwapAdapter {
    PayWithStock public pws;
    bytes public reentry;

    function arm(PayWithStock pws_, bytes calldata reentry_) external {
        pws = pws_;
        reentry = reentry_;
    }

    function start(IPayWithStock.ChargeAuthorization calldata auth, bytes calldata sig)
        external
        returns (uint256)
    {
        return pws.payCall(auth, sig, 100);
    }

    function swapExactOut(address, address, uint256, uint256, address, address) external returns (uint256) {
        (bool ok, bytes memory ret) = address(pws).call(reentry);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return 0;
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

/// @dev ERC-1271 smart wallet controlled by one EOA owner.
contract MockSmartWallet is IERC1271 {
    address public immutable owner;
    bool public reject;

    constructor(address owner_) {
        owner = owner_;
    }

    function setReject(bool r) external {
        reject = r;
    }

    function exec(address target, bytes calldata data) external returns (bytes memory ret) {
        require(msg.sender == owner, "not owner");
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address who, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return !reject && err == ECDSA.RecoverError.NoError && who == owner
            ? IERC1271.isValidSignature.selector
            : bytes4(0);
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
    address other = makeAddr("other");
    address relayer = makeAddr("relayer");
    address wallet;
    uint256 walletPk;
    uint256 attackerPk;
    bytes32 constant KEY = keccak256("api-key-1");

    uint256 constant PRICE18 = 180e18; // $180 per NVDA
    uint256 constant CAP = 10e18; // 10 NVDA / day
    uint256 constant T0 = 1_750_000_000; // mid-day UTC
    uint256 nonceSeq;

    function setUp() public {
        vm.warp(T0);
        (wallet, walletPk) = makeAddrAndKey("wallet");
        (, attackerPk) = makeAddrAndKey("attacker");
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
        (s.wallet, s.token, s.capRawPerDay, s.spentRawToday, s.dayStart, s.active, s.epoch) =
            pws.sessions(key);
    }

    function _allowanceOf(bytes32 key) internal view returns (IPayWithStock.Allowance memory a) {
        (a.maxRawTotal, a.maxRawPerCharge, a.spentRaw, a.nonce, a.validUntil, a.epoch, a.router) =
            pws.allowances(key);
    }

    function _maxIn(uint256 usdgOwed, uint16 slip) internal view returns (uint256 maxIn, uint256 raw) {
        (raw,) = pws.quoteRaw(address(nvda), usdgOwed);
        maxIn = Math.mulDiv(raw, 10_000 + slip, 10_000, Math.Rounding.Ceil);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev A fresh charge for `owed` USDG with no token maximum of its own (the oracle bound applies).
    function _auth(uint256 owed) internal returns (IPayWithStock.ChargeAuthorization memory a) {
        uint256 n = nonceSeq++;
        a = IPayWithStock.ChargeAuthorization({
            keyHash: KEY,
            token: address(nvda),
            usdgAmount: owed,
            maxRaw: type(uint256).max,
            usageCommitment: keccak256(abi.encode("usage", n)),
            nonce: n,
            epoch: _session(KEY).epoch,
            deadline: block.timestamp + 1 hours,
            router: router
        });
    }

    function _signCharge(uint256 pk, IPayWithStock.ChargeAuthorization memory a)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, pws.hashCharge(a));
    }

    function _submit(IPayWithStock.ChargeAuthorization memory a, bytes memory sig, uint16 slip)
        internal
        returns (uint256)
    {
        vm.prank(router);
        return pws.payCall(a, sig, slip);
    }

    function _expectChargeRevert(
        IPayWithStock.ChargeAuthorization memory a,
        bytes memory sig,
        bytes memory err
    ) internal {
        vm.prank(router);
        vm.expectRevert(err);
        pws.payCall(a, sig, 100);
    }

    function _pay(uint256 usdgOwed, uint16 slip) internal returns (uint256) {
        IPayWithStock.ChargeAuthorization memory a = _auth(usdgOwed);
        bytes memory sig = _signCharge(walletPk, a);
        return _submit(a, sig, slip);
    }

    function _allowanceAuth(uint256 total, uint256 perCharge, uint256 validFor)
        internal
        view
        returns (IPayWithStock.AllowanceAuthorization memory a)
    {
        a = IPayWithStock.AllowanceAuthorization({
            keyHash: KEY,
            token: address(nvda),
            maxRawTotal: total,
            maxRawPerCharge: perCharge,
            validUntil: block.timestamp + validFor,
            nonce: pws.allowanceNonces(KEY),
            epoch: _session(KEY).epoch,
            router: router
        });
    }

    function _grant(uint256 total, uint256 perCharge)
        internal
        returns (IPayWithStock.AllowanceAuthorization memory a)
    {
        a = _allowanceAuth(total, perCharge, 7 days);
        bytes memory sig = _sign(walletPk, pws.hashAllowance(a));
        vm.prank(relayer);
        pws.setAllowance(a, sig);
    }

    function _payA(uint256 usdgOwed, uint16 slip) internal returns (uint256) {
        vm.prank(router);
        return
            pws.payCallWithAllowance(
                KEY, usdgOwed, keccak256(abi.encode("allowance-usage", nonceSeq++)), slip
            );
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
        assertEq(pws.MAX_AUTHORIZATION_WINDOW(), 7 days);
        assertEq(pws.MAX_ALLOWANCE_CHARGE_USDG(), 5e6);
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

    // ------------------------------------------------------------------ EIP-712

    function test_digestsMatchEip712() public {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Anyroute PayWithStock"),
                keccak256("1"),
                block.chainid,
                address(pws)
            )
        );
        assertEq(pws.DOMAIN_SEPARATOR(), domain);
        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            pws.eip712Domain();
        assertEq(name, "Anyroute PayWithStock");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(pws));

        IPayWithStock.ChargeAuthorization memory c = _auth(7e6);
        c.maxRaw = 123;
        bytes32 chargeStruct = keccak256(
            abi.encode(
                keccak256(
                    "ChargeAuthorization(bytes32 keyHash,address token,uint256 usdgAmount,uint256 maxRaw,bytes32 usageCommitment,uint256 nonce,uint64 epoch,uint256 deadline,address router)"
                ),
                c.keyHash,
                c.token,
                c.usdgAmount,
                c.maxRaw,
                c.usageCommitment,
                c.nonce,
                c.epoch,
                c.deadline,
                c.router
            )
        );
        assertEq(pws.hashCharge(c), keccak256(abi.encodePacked("\x19\x01", domain, chargeStruct)));
        assertEq(
            pws.CHARGE_TYPEHASH(),
            keccak256(
                "ChargeAuthorization(bytes32 keyHash,address token,uint256 usdgAmount,uint256 maxRaw,bytes32 usageCommitment,uint256 nonce,uint64 epoch,uint256 deadline,address router)"
            )
        );

        IPayWithStock.AllowanceAuthorization memory a = _allowanceAuth(9, 3, 1 days);
        bytes32 allowanceStruct = keccak256(
            abi.encode(
                keccak256(
                    "AllowanceAuthorization(bytes32 keyHash,address token,uint256 maxRawTotal,uint256 maxRawPerCharge,uint256 validUntil,uint256 nonce,uint64 epoch,address router)"
                ),
                a.keyHash,
                a.token,
                a.maxRawTotal,
                a.maxRawPerCharge,
                a.validUntil,
                a.nonce,
                a.epoch,
                a.router
            )
        );
        assertEq(pws.hashAllowance(a), keccak256(abi.encodePacked("\x19\x01", domain, allowanceStruct)));
    }

    /// @dev The same vectors are asserted against the router's typed data (test/paywith-authorizations.test.ts).
    function test_digestVectorsMatchTheRouter() public {
        vm.chainId(4663);
        address at = 0x00000000000000000000000000000000000C0003;
        deployCodeTo(
            "PayWithStock.sol:PayWithStock",
            abi.encode(IERC20(address(usdg)), ICredits(address(credits)), oracle, router, owner),
            at
        );
        PayWithStock p = PayWithStock(at);
        bytes32 keyHash = keccak256("paywith-vector-key");
        address token = 0x00000000000000000000000000000000000000AA;
        address r = 0x0000000000000000000000000000000000000001;
        IPayWithStock.ChargeAuthorization memory c = IPayWithStock.ChargeAuthorization(
            keyHash, token, 1_234_567, 1e16, keccak256("paywith-vector-usage"), 42, 3, 1_750_003_600, r
        );
        assertEq(p.hashCharge(c), 0xb3896467a43aa95c5afb0f8589d61ba366a85e214243a9d5b7e18ba57b05b3d0);
        IPayWithStock.AllowanceAuthorization memory a =
            IPayWithStock.AllowanceAuthorization(keyHash, token, 1e18, 1e17, 1_750_600_000, 7, 3, r);
        assertEq(p.hashAllowance(a), 0x72db11d096021bf03310280ff75673569567a67f32b908c011e948434aa2a48c);
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
        assertEq(s.epoch, 1, "a new wallet binding starts a fresh epoch");
        assertEq(pws.remainingToday(KEY), CAP);
    }

    function test_openSessionEmits() public {
        vm.expectEmit(true, true, false, true);
        emit IPayWithStock.AuthorizationsRevoked(keccak256("k2"), other, 1);
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
        assertEq(s.epoch, 3, "close and the new wallet both bumped the epoch");
    }

    function test_reopenSameDayKeepsSpendAndEpochIsBumpedOnce() public {
        uint256 spent = _pay(10e6, 100);
        vm.startPrank(wallet);
        pws.closeSession(KEY);
        pws.openSession(KEY, address(nvda), CAP * 2); // raise own cap
        vm.stopPrank();
        assertEq(_session(KEY).spentRawToday, spent);
        assertEq(_session(KEY).capRawPerDay, CAP * 2);
        assertEq(_session(KEY).epoch, 2, "close revoked; re-opening the same binding does not");
    }

    function test_raiseCapKeepsAuthorizations() public {
        _grant(1e18, 1e17);
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.prank(wallet);
        pws.openSession(KEY, address(nvda), CAP * 2);
        assertEq(_session(KEY).epoch, 1);
        assertEq(_allowanceOf(KEY).maxRawTotal, 1e18);
        _submit(a, sig, 100);
        _payA(1e6, 100);
    }

    function test_reopenOtherTokenResetsSpendAndRevokes() public {
        _pay(10e6, 100);
        _grant(1e18, 1e17);
        MockStockToken tsla = new MockStockToken("TSLA", "TSLAx", 8);
        vm.prank(owner);
        pws.registerToken(address(tsla), address(primary), address(0), true);
        vm.prank(wallet);
        pws.openSession(KEY, address(tsla), 1e8);
        assertEq(_session(KEY).spentRawToday, 0);
        assertEq(_session(KEY).token, address(tsla));
        assertEq(_session(KEY).epoch, 2, "raw limits were in NVDA units: revoked");
        assertEq(_allowanceOf(KEY).validUntil, 0, "allowance deleted");
    }

    function test_closeSession() public {
        vm.prank(other);
        vm.expectRevert(IPayWithStock.NotSessionWallet.selector);
        pws.closeSession(KEY);

        vm.expectEmit(true, true, false, true);
        emit IPayWithStock.AuthorizationsRevoked(KEY, wallet, 2);
        vm.expectEmit(true, true, false, false);
        emit IPayWithStock.SessionClosed(KEY, wallet);
        vm.prank(wallet);
        pws.closeSession(KEY);
        assertFalse(_session(KEY).active);
        assertEq(pws.remainingToday(KEY), 0);

        vm.prank(wallet);
        vm.expectRevert(IPayWithStock.NoSession.selector);
        pws.closeSession(KEY);
    }

    function test_forceCloseSession() public {
        _grant(1e18, 1e17);
        vm.prank(other);
        vm.expectRevert(IPayWithStock.NotRouter.selector);
        pws.forceCloseSession(KEY);

        vm.expectEmit(true, true, false, false);
        emit IPayWithStock.SessionClosed(KEY, wallet);
        vm.prank(router);
        pws.forceCloseSession(KEY);
        assertFalse(_session(KEY).active);
        assertEq(_session(KEY).epoch, 2, "a forced close revokes too");
        assertEq(_allowanceOf(KEY).validUntil, 0);
    }

    function test_revokeAuthorizationsIsOneCall() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        _grant(1e18, 1e17);

        vm.prank(other);
        vm.expectRevert(IPayWithStock.NotSessionWallet.selector);
        pws.revokeAuthorizations(KEY);

        vm.expectEmit(true, true, false, true);
        emit IPayWithStock.AuthorizationsRevoked(KEY, wallet, 2);
        vm.prank(wallet);
        pws.revokeAuthorizations(KEY);
        assertTrue(_session(KEY).active, "the session stays open");
        assertEq(pws.allowanceRemaining(KEY), 0);

        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.StaleEpoch.selector));
        vm.prank(router);
        vm.expectRevert(IPayWithStock.NoAllowance.selector);
        pws.payCallWithAllowance(KEY, 1e6, keccak256("u"), 100);

        // new authorizations for the new epoch work
        _pay(1e6, 100);
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

    // ------------------------------------------------------------------ payCall (signed charge): happy path

    function test_payCallHappyPath() public {
        uint256 owed = 5e6;
        uint16 slip = 100;
        (uint256 maxIn, uint256 raw) = _maxIn(owed, slip);
        uint256 walletBefore = nvda.balanceOf(wallet);
        IPayWithStock.ChargeAuthorization memory a = _auth(owed);
        bytes memory sig = _signCharge(walletPk, a);

        vm.expectEmit(true, true, true, true);
        emit IPayWithStock.PaidWithStock(
            KEY, wallet, a.usageCommitment, address(nvda), raw, PRICE18, owed, a.nonce, false
        );
        uint256 spent = _submit(a, sig, slip);

        assertEq(spent, raw, "adapter at fair price spends exactly rawNeeded");
        assertLt(spent, maxIn);
        assertEq(walletBefore - nvda.balanceOf(wallet), spent, "wallet charged rawSpent only");
        assertEq(credits.credited(KEY), owed);
        assertEq(usdg.balanceOf(address(credits)), owed);
        assertEq(_session(KEY).spentRawToday, spent, "actual spend recorded");
        assertEq(nvda.balanceOf(address(primary)), 0, "adapter keeps nothing");
        assertEq(fallbackAdapter.calls(), 0);
        assertTrue(pws.isChargeNonceUsed(KEY, a.nonce));
        assertTrue(pws.commitmentCharged(KEY, a.usageCommitment));
        _assertNoLeftovers();
    }

    function test_payCallOnlyRouter() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.prank(other);
        vm.expectRevert(IPayWithStock.NotRouter.selector);
        pws.payCall(a, sig, 100);
        vm.prank(wallet);
        vm.expectRevert(IPayWithStock.NotRouter.selector);
        pws.payCall(a, sig, 100);
    }

    function test_payCallZeroAmounts() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(0);
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.InvalidAmount.selector));
        a = _auth(1e6);
        a.maxRaw = 0;
        sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.InvalidAmount.selector));
    }

    function test_payCallNoSession() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        a.keyHash = keccak256("nope");
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.NoSession.selector));

        IPayWithStock.ChargeAuthorization memory b = _auth(1e6);
        sig = _signCharge(walletPk, b);
        vm.prank(wallet);
        pws.closeSession(KEY);
        _expectChargeRevert(b, sig, abi.encodeWithSelector(IPayWithStock.NoSession.selector));
    }

    function test_payCallTokenDisabled() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.prank(owner);
        pws.registerToken(address(nvda), address(primary), address(0), false);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.TokenNotEnabled.selector));
    }

    function test_payCallOracleNotOk() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.prank(owner);
        oracle.pause(address(nvda));
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.OracleNotOk.selector));
    }

    function test_payCallOracleStale() public {
        vm.warp(block.timestamp + 1 hours + 1);
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.OracleNotOk.selector));
    }

    function test_payCallWithoutAllowanceReverts() public {
        vm.prank(wallet);
        nvda.approve(address(pws), 0);
        (uint256 maxIn,) = _maxIn(1e6, 100);
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(
            a,
            sig,
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(pws), 0, maxIn)
        );
    }

    function test_payCallCreditsRevertIsAtomic() public {
        credits.setShouldRevert(true);
        uint256 walletBefore = nvda.balanceOf(wallet);
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(MockCredits.MockCreditsReverted.selector));
        assertEq(nvda.balanceOf(wallet), walletBefore);
        assertEq(_session(KEY).spentRawToday, 0);
        assertFalse(pws.isChargeNonceUsed(KEY, a.nonce), "a reverted charge consumes nothing");
        credits.setShouldRevert(false);
        _submit(a, sig, 100); // and can be retried
    }

    // ------------------------------------------------------------------ payCall: authorization checks

    function test_payCallReplayReverts() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        _submit(a, sig, 100);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.NonceUsed.selector));
    }

    function test_payCallNonceIsSingleUseEvenForOtherUsage() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        _submit(a, _signCharge(walletPk, a), 100);
        a.usageCommitment = keccak256("different usage");
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.NonceUsed.selector));
    }

    function test_payCallCommitmentIsChargedOnce() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        _submit(a, _signCharge(walletPk, a), 100);
        IPayWithStock.ChargeAuthorization memory b = _auth(1e6);
        b.usageCommitment = a.usageCommitment;
        bytes memory sig = _signCharge(walletPk, b);
        _expectChargeRevert(b, sig, abi.encodeWithSelector(IPayWithStock.CommitmentUsed.selector));
        b.usageCommitment = bytes32(0);
        sig = _signCharge(walletPk, b);
        _expectChargeRevert(b, sig, abi.encodeWithSelector(IPayWithStock.InvalidCommitment.selector));
    }

    function test_payCallNoncesAreUnordered() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        a.nonce = 1000;
        IPayWithStock.ChargeAuthorization memory b = _auth(1e6);
        b.nonce = 3;
        IPayWithStock.ChargeAuthorization memory c = _auth(1e6);
        c.nonce = type(uint256).max;
        bytes memory sa = _signCharge(walletPk, a);
        bytes memory sb = _signCharge(walletPk, b);
        bytes memory sc = _signCharge(walletPk, c);
        _submit(a, sa, 100);
        _submit(b, sb, 100);
        _submit(c, sc, 100);
        assertTrue(pws.isChargeNonceUsed(KEY, 1000));
        assertTrue(pws.isChargeNonceUsed(KEY, 3));
        assertTrue(pws.isChargeNonceUsed(KEY, type(uint256).max));
        assertFalse(pws.isChargeNonceUsed(KEY, 1001));
        assertFalse(pws.isChargeNonceUsed(KEY, 4));
    }

    function test_payCallWrongSigner() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(attackerPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
        // the router's own key is not the wallet either
        (, uint256 routerPk) = makeAddrAndKey("router");
        sig = _signCharge(routerPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
    }

    /// @dev secp256k1 group order.
    uint256 constant SECP256K1_N =
        115792089237316195423570985008687907852837564279074904382605163141518161494337;

    function test_payCallMalformedSignatures() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory good = _signCharge(walletPk, a);
        bytes[4] memory bad = [bytes(""), new bytes(65), bytes.concat(good, hex"00"), _slice(good, 64)];
        for (uint256 i; i < bad.length; ++i) {
            _expectChargeRevert(a, bad[i], abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
        }
        // high-s (malleable) form of a valid signature is rejected
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk, pws.hashCharge(a));
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        bytes memory malleable = abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27));
        _expectChargeRevert(a, malleable, abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
        _submit(a, good, 100);
    }

    function _slice(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
    }

    function test_payCallExpired() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        a.deadline = block.timestamp - 1;
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.AuthorizationExpired.selector));

        IPayWithStock.ChargeAuthorization memory b = _auth(1e6);
        sig = _signCharge(walletPk, b);
        vm.warp(b.deadline + 1);
        feed.setAnswer(180e8);
        _expectChargeRevert(b, sig, abi.encodeWithSelector(IPayWithStock.AuthorizationExpired.selector));
    }

    function test_payCallDeadlineWindow() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        a.deadline = block.timestamp + 7 days + 1;
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.AuthorizationWindowTooLong.selector));
        // usable once it is within the window
        vm.warp(block.timestamp + 1);
        feed.setAnswer(180e8);
        _submit(a, sig, 100);

        IPayWithStock.ChargeAuthorization memory b = _auth(1e6);
        b.deadline = block.timestamp; // inclusive
        _submit(b, _signCharge(walletPk, b), 100);
    }

    function test_payCallWrongRouter() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        a.router = other;
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.WrongRouter.selector));
        // a charge signed for the router is useless once the owner rotates the router key
        IPayWithStock.ChargeAuthorization memory b = _auth(1e6);
        sig = _signCharge(walletPk, b);
        vm.prank(owner);
        pws.setRouter(other);
        vm.prank(other);
        vm.expectRevert(IPayWithStock.WrongRouter.selector);
        pws.payCall(b, sig, 100);
    }

    function test_payCallWrongChain() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        uint256 chainId = block.chainid;
        vm.chainId(chainId + 1);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
        vm.chainId(chainId);
        _submit(a, sig, 100);
    }

    function test_payCallWrongVerifyingContract() public {
        PayWithStock twin =
            new PayWithStock(IERC20(address(usdg)), ICredits(address(credits)), oracle, router, owner);
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _sign(walletPk, twin.hashCharge(a));
        assertTrue(twin.hashCharge(a) != pws.hashCharge(a));
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
    }

    function test_payCallWrongToken() public {
        MockStockToken tsla = new MockStockToken("TSLA", "TSLAx", 8);
        vm.prank(owner);
        pws.registerToken(address(tsla), address(primary), address(0), true);
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        a.token = address(tsla);
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.WrongToken.selector));
    }

    function test_payCallRevokedEpoch() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.startPrank(wallet);
        pws.closeSession(KEY);
        pws.openSession(KEY, address(nvda), CAP); // same wallet and token: session back, old signature still void
        vm.stopPrank();
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.StaleEpoch.selector));
        a.epoch = _session(KEY).epoch; // the router cannot bump it on the wallet's behalf
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
    }

    function test_payCallFutureEpochRejected() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        a.epoch += 1;
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.StaleEpoch.selector));
    }

    function test_payCallSessionOfAnotherWallet() public {
        // a signature by the wallet is only good for its own session binding
        vm.prank(wallet);
        pws.closeSession(KEY);
        vm.prank(other);
        pws.openSession(KEY, address(nvda), CAP);
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        _expectChargeRevert(a, sig, abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
    }

    /// @dev Any single field the router changes after signing invalidates the signature (or fails a binding).
    function testFuzz_payCallTamperedFieldRejected(uint8 field, uint256 delta) public {
        delta = bound(delta, 1, type(uint64).max);
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        a.maxRaw = 1e18;
        bytes memory sig = _signCharge(walletPk, a);
        field = uint8(bound(field, 0, 8));
        if (field == 0) a.keyHash = bytes32(uint256(a.keyHash) ^ delta);
        else if (field == 1) a.token = address(uint160(a.token) ^ uint160(delta));
        else if (field == 2) a.usdgAmount += delta;
        else if (field == 3) a.maxRaw += delta;
        else if (field == 4) a.usageCommitment = bytes32(uint256(a.usageCommitment) ^ delta);
        else if (field == 5) a.nonce += delta;
        else if (field == 6) a.epoch = uint64(a.epoch ^ uint64(delta));
        else if (field == 7) a.deadline -= Math.min(delta, 1 hours - 1);
        else a.router = address(uint160(a.router) ^ uint160(delta));
        uint256 walletBefore = nvda.balanceOf(wallet);
        vm.prank(router);
        vm.expectRevert();
        pws.payCall(a, sig, 100);
        assertEq(nvda.balanceOf(wallet), walletBefore);
    }

    function test_payCallMaxRawBoundsTheWallet() public {
        (uint256 maxIn, uint256 raw) = _maxIn(3e6, 300);
        // signed maximum below the oracle bound: pulled amount is clamped to it
        IPayWithStock.ChargeAuthorization memory a = _auth(3e6);
        a.maxRaw = raw + 1;
        bytes memory sig = _signCharge(walletPk, a);
        uint256 walletBefore = nvda.balanceOf(wallet);
        uint256 spent = _submit(a, sig, 300);
        assertEq(spent, raw);
        assertLe(walletBefore - nvda.balanceOf(wallet), a.maxRaw);
        assertLt(a.maxRaw, maxIn);

        // pool needs more than the signed maximum: the charge fails and nothing moves
        primary.setPrice(PRICE18 * 99 / 100);
        fallbackAdapter.setPrice(PRICE18 * 99 / 100);
        IPayWithStock.ChargeAuthorization memory b = _auth(3e6);
        b.maxRaw = raw;
        sig = _signCharge(walletPk, b);
        walletBefore = nvda.balanceOf(wallet);
        _expectChargeRevert(b, sig, abi.encodeWithSelector(IPayWithStock.SwapFailed.selector));
        assertEq(nvda.balanceOf(wallet), walletBefore);
    }

    function testFuzz_payCallNeverExceedsSignedMax(uint256 owed, uint256 maxRaw, uint256 priceBps) public {
        owed = bound(owed, 1, 1_000e6);
        maxRaw = bound(maxRaw, 1, 10e18);
        priceBps = bound(priceBps, 9_000, 12_000);
        primary.setPrice(PRICE18 * priceBps / 10_000);
        fallbackAdapter.setMode(MockSwapAdapter.Mode.NoRefund); // worst adapter: keeps everything it is given
        vm.prank(wallet);
        pws.openSession(KEY, address(nvda), type(uint256).max);
        IPayWithStock.ChargeAuthorization memory a = _auth(owed);
        a.maxRaw = maxRaw;
        bytes memory sig = _signCharge(walletPk, a);
        uint256 walletBefore = nvda.balanceOf(wallet);
        vm.prank(router);
        try pws.payCall(a, sig, 300) returns (uint256 spent) {
            assertEq(walletBefore - nvda.balanceOf(wallet), spent);
        } catch {
            assertEq(nvda.balanceOf(wallet), walletBefore);
        }
        (uint256 maxIn,) = _maxIn(owed, 300);
        assertLe(walletBefore - nvda.balanceOf(wallet), Math.min(maxRaw, maxIn));
        _assertNoLeftovers();
    }

    // ------------------------------------------------------------------ ERC-1271 smart wallets

    function _smartWalletSession() internal returns (MockSmartWallet sw, uint256 ownerPk, bytes32 key) {
        address swOwner;
        (swOwner, ownerPk) = makeAddrAndKey("smartOwner");
        sw = new MockSmartWallet(swOwner);
        key = keccak256("smart-key");
        nvda.mint(address(sw), 100e18);
        vm.startPrank(swOwner);
        sw.exec(address(nvda), abi.encodeCall(IERC20.approve, (address(pws), type(uint256).max)));
        sw.exec(address(pws), abi.encodeCall(PayWithStock.openSession, (key, address(nvda), CAP)));
        vm.stopPrank();
    }

    function test_payCallErc1271Wallet() public {
        (MockSmartWallet sw, uint256 ownerPk, bytes32 key) = _smartWalletSession();
        IPayWithStock.ChargeAuthorization memory a = _auth(2e6);
        a.keyHash = key;
        a.epoch = _session(key).epoch;
        bytes memory sig = _signCharge(ownerPk, a);
        uint256 before = nvda.balanceOf(address(sw));
        uint256 spent = _submit(a, sig, 100);
        assertEq(before - nvda.balanceOf(address(sw)), spent);
        assertEq(credits.credited(key), 2e6);

        // the wallet contract decides: once it rejects, the same kind of signature fails
        IPayWithStock.ChargeAuthorization memory b = _auth(2e6);
        b.keyHash = key;
        b.epoch = a.epoch;
        sig = _signCharge(ownerPk, b);
        sw.setReject(true);
        _expectChargeRevert(b, sig, abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
        // a signature from a key that is not the wallet's owner fails too
        sw.setReject(false);
        sig = _signCharge(attackerPk, b);
        _expectChargeRevert(b, sig, abi.encodeWithSelector(IPayWithStock.BadSignature.selector));
    }

    function test_allowanceErc1271Wallet() public {
        (MockSmartWallet sw, uint256 ownerPk, bytes32 key) = _smartWalletSession();
        IPayWithStock.AllowanceAuthorization memory a = _allowanceAuth(1e18, 1e17, 1 days);
        a.keyHash = key;
        a.epoch = _session(key).epoch;
        a.nonce = pws.allowanceNonces(key);
        bytes memory sig = _sign(ownerPk, pws.hashAllowance(a));
        sw.setReject(true);
        vm.prank(relayer);
        vm.expectRevert(IPayWithStock.BadSignature.selector);
        pws.setAllowance(a, sig);
        sw.setReject(false);
        vm.prank(relayer);
        pws.setAllowance(a, sig);
        vm.prank(router);
        pws.payCallWithAllowance(key, 1e6, keccak256("smart usage"), 100);
        assertEq(credits.credited(key), 1e6);
    }

    // ------------------------------------------------------------------ allowances

    function test_setAllowanceRelayedAndEmits() public {
        IPayWithStock.AllowanceAuthorization memory a = _allowanceAuth(2e18, 1e17, 7 days);
        bytes memory sig = _sign(walletPk, pws.hashAllowance(a));
        vm.expectEmit(true, true, false, true);
        emit IPayWithStock.AllowanceSet(KEY, wallet, 0, 2e18, 1e17, uint64(a.validUntil), 1);
        vm.prank(relayer);
        pws.setAllowance(a, sig);
        IPayWithStock.Allowance memory al = _allowanceOf(KEY);
        assertEq(al.maxRawTotal, 2e18);
        assertEq(al.maxRawPerCharge, 1e17);
        assertEq(al.spentRaw, 0);
        assertEq(al.nonce, 0);
        assertEq(al.validUntil, a.validUntil);
        assertEq(al.epoch, 1);
        assertEq(al.router, router);
        assertEq(pws.allowanceNonces(KEY), 1);
        assertEq(pws.allowanceRemaining(KEY), 2e18);
    }

    function test_setAllowanceDirectByWalletNeedsNoSignature() public {
        IPayWithStock.AllowanceAuthorization memory a = _allowanceAuth(2e18, 1e17, 1 days);
        vm.prank(relayer);
        vm.expectRevert(IPayWithStock.BadSignature.selector);
        pws.setAllowance(a, "");
        vm.prank(wallet);
        pws.setAllowance(a, "");
        assertEq(_allowanceOf(KEY).maxRawTotal, 2e18);
    }

    function test_setAllowanceValidation() public {
        IPayWithStock.AllowanceAuthorization memory a;

        a = _allowanceAuth(2e18, 1e17, 1 days);
        a.maxRawPerCharge = 0;
        _expectAllowanceRevert(a, walletPk, IPayWithStock.InvalidAllowance.selector);
        a = _allowanceAuth(2e18, 1e17, 1 days);
        a.maxRawPerCharge = a.maxRawTotal + 1;
        _expectAllowanceRevert(a, walletPk, IPayWithStock.InvalidAllowance.selector);
        a = _allowanceAuth(2e18, 1e17, 1 days);
        a.validUntil = block.timestamp - 1;
        _expectAllowanceRevert(a, walletPk, IPayWithStock.AuthorizationExpired.selector);
        a = _allowanceAuth(2e18, 1e17, 7 days + 1);
        _expectAllowanceRevert(a, walletPk, IPayWithStock.AuthorizationWindowTooLong.selector);
        a = _allowanceAuth(2e18, 1e17, 1 days);
        a.nonce = 1;
        _expectAllowanceRevert(a, walletPk, IPayWithStock.InvalidNonce.selector);
        a = _allowanceAuth(2e18, 1e17, 1 days);
        a.epoch = 0;
        _expectAllowanceRevert(a, walletPk, IPayWithStock.StaleEpoch.selector);
        a = _allowanceAuth(2e18, 1e17, 1 days);
        a.router = other;
        _expectAllowanceRevert(a, walletPk, IPayWithStock.WrongRouter.selector);
        a = _allowanceAuth(2e18, 1e17, 1 days);
        a.token = address(usdg);
        _expectAllowanceRevert(a, walletPk, IPayWithStock.WrongToken.selector);
        a = _allowanceAuth(2e18, 1e17, 1 days);
        a.keyHash = keccak256("nope");
        _expectAllowanceRevert(a, walletPk, IPayWithStock.NoSession.selector);
        _expectAllowanceRevert(
            _allowanceAuth(2e18, 1e17, 1 days), attackerPk, IPayWithStock.BadSignature.selector
        );
        assertEq(pws.allowanceNonces(KEY), 0, "nothing registered");
    }

    function _expectAllowanceRevert(IPayWithStock.AllowanceAuthorization memory a, uint256 pk, bytes4 err)
        internal
    {
        bytes memory sig = _sign(pk, pws.hashAllowance(a));
        vm.prank(relayer);
        vm.expectRevert(err);
        pws.setAllowance(a, sig);
    }

    function test_setAllowanceReplayAndStaleSignatures() public {
        IPayWithStock.AllowanceAuthorization memory a = _allowanceAuth(1e18, 1e17, 1 days);
        bytes memory sig = _sign(walletPk, pws.hashAllowance(a));
        vm.prank(relayer);
        pws.setAllowance(a, sig);
        _payA(1e6, 100);

        // replaying the same allowance cannot reset its spend
        vm.prank(relayer);
        vm.expectRevert(IPayWithStock.InvalidNonce.selector);
        pws.setAllowance(a, sig);

        // two allowances signed for the same nonce: only one can ever be registered
        IPayWithStock.AllowanceAuthorization memory b = _allowanceAuth(2e18, 1e17, 1 days);
        IPayWithStock.AllowanceAuthorization memory c = _allowanceAuth(3e18, 1e17, 1 days);
        bytes memory sb = _sign(walletPk, pws.hashAllowance(b));
        bytes memory sc = _sign(walletPk, pws.hashAllowance(c));
        vm.prank(relayer);
        pws.setAllowance(b, sb);
        vm.prank(relayer);
        vm.expectRevert(IPayWithStock.InvalidNonce.selector);
        pws.setAllowance(c, sc);
        assertEq(_allowanceOf(KEY).maxRawTotal, 2e18);
        assertEq(_allowanceOf(KEY).spentRaw, 0, "a new allowance is a new budget");

        // an unregistered allowance dies with the epoch
        IPayWithStock.AllowanceAuthorization memory d = _allowanceAuth(9e18, 1e17, 1 days);
        bytes memory sd = _sign(walletPk, pws.hashAllowance(d));
        vm.prank(wallet);
        pws.revokeAuthorizations(KEY);
        vm.prank(relayer);
        vm.expectRevert(IPayWithStock.StaleEpoch.selector);
        pws.setAllowance(d, sd);
    }

    function test_payCallWithAllowanceHappyPath() public {
        IPayWithStock.AllowanceAuthorization memory a = _grant(1e18, 5e16);
        (, uint256 raw) = _maxIn(5e6, 100);
        uint256 walletBefore = nvda.balanceOf(wallet);
        bytes32 usage = keccak256("batch-1");
        vm.expectEmit(true, true, true, true);
        emit IPayWithStock.PaidWithStock(KEY, wallet, usage, address(nvda), raw, PRICE18, 5e6, a.nonce, true);
        vm.prank(router);
        uint256 spent = pws.payCallWithAllowance(KEY, 5e6, usage, 100);
        assertEq(spent, raw);
        assertEq(walletBefore - nvda.balanceOf(wallet), spent);
        assertEq(_allowanceOf(KEY).spentRaw, spent, "actual, not the reservation");
        assertEq(_session(KEY).spentRawToday, spent);
        assertEq(pws.allowanceRemaining(KEY), 1e18 - spent);
        assertEq(credits.credited(KEY), 5e6);
        _assertNoLeftovers();

        vm.prank(router);
        vm.expectRevert(IPayWithStock.CommitmentUsed.selector);
        pws.payCallWithAllowance(KEY, 1e6, usage, 100);
    }

    function test_payCallWithAllowanceChecks() public {
        vm.prank(router);
        vm.expectRevert(IPayWithStock.NoAllowance.selector);
        pws.payCallWithAllowance(KEY, 1e6, keccak256("u"), 100);

        _grant(1e18, 5e16);
        vm.prank(other);
        vm.expectRevert(IPayWithStock.NotRouter.selector);
        pws.payCallWithAllowance(KEY, 1e6, keccak256("u"), 100);
        vm.startPrank(router);
        vm.expectRevert(IPayWithStock.InvalidAmount.selector);
        pws.payCallWithAllowance(KEY, 0, keccak256("u"), 100);
        vm.expectRevert(IPayWithStock.ChargeTooLarge.selector);
        pws.payCallWithAllowance(KEY, 5e6 + 1, keccak256("u"), 100);
        vm.expectRevert(IPayWithStock.InvalidCommitment.selector);
        pws.payCallWithAllowance(KEY, 1e6, bytes32(0), 100);
        vm.expectRevert(IPayWithStock.SlippageTooHigh.selector);
        pws.payCallWithAllowance(KEY, 1e6, keccak256("u"), 301);
        vm.stopPrank();
    }

    function test_payCallWithAllowanceExpires() public {
        IPayWithStock.AllowanceAuthorization memory a = _grant(1e18, 5e16);
        vm.warp(a.validUntil);
        feed.setAnswer(180e8);
        _payA(1e6, 100); // inclusive
        vm.warp(a.validUntil + 1);
        feed.setAnswer(180e8);
        assertEq(pws.allowanceRemaining(KEY), 0);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.AuthorizationExpired.selector);
        pws.payCallWithAllowance(KEY, 1e6, keccak256("late"), 100);
    }

    function test_payCallWithAllowanceRouterRotation() public {
        _grant(1e18, 5e16);
        vm.prank(owner);
        pws.setRouter(other);
        assertEq(pws.allowanceRemaining(KEY), 0);
        vm.prank(other);
        vm.expectRevert(IPayWithStock.WrongRouter.selector);
        pws.payCallWithAllowance(KEY, 1e6, keccak256("u"), 100);
    }

    function test_payCallWithAllowanceClosedOrRevoked() public {
        _grant(1e18, 5e16);
        vm.prank(wallet);
        pws.closeSession(KEY);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.NoAllowance.selector);
        pws.payCallWithAllowance(KEY, 1e6, keccak256("u"), 100);
        vm.prank(wallet);
        pws.openSession(KEY, address(nvda), CAP);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.NoAllowance.selector);
        pws.payCallWithAllowance(KEY, 1e6, keccak256("u"), 100);
    }

    function test_payCallWithAllowancePerChargeLimit() public {
        (, uint256 raw) = _maxIn(5e6, 300);
        _grant(1e18, raw); // enough for $5 at fair value, not for the slippage headroom
        primary.setPrice(PRICE18 * 99 / 100); // pool 1% below fair: needs more than `raw`
        fallbackAdapter.setPrice(PRICE18 * 99 / 100);
        uint256 walletBefore = nvda.balanceOf(wallet);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.SwapFailed.selector);
        pws.payCallWithAllowance(KEY, 5e6, keccak256("u"), 300);
        assertEq(nvda.balanceOf(wallet), walletBefore);
        assertEq(_allowanceOf(KEY).spentRaw, 0, "a failed charge reserves nothing");

        primary.setPrice(PRICE18);
        uint256 spent = _payA(5e6, 300);
        assertLe(spent, raw);
    }

    function test_payCallWithAllowanceTotalLimit() public {
        (, uint256 raw) = _maxIn(5e6, 0);
        _grant(raw * 2 + raw / 2, raw); // two and a half $5 charges
        _payA(5e6, 0);
        _payA(5e6, 0);
        // the remaining half charge cannot pay $5 (the pull is clamped to what is left)
        vm.prank(router);
        vm.expectRevert(IPayWithStock.SwapFailed.selector);
        pws.payCallWithAllowance(KEY, 5e6, keccak256("u3"), 0);
        // but $2 fits
        _payA(2e6, 0);
        assertLe(_allowanceOf(KEY).spentRaw, _allowanceOf(KEY).maxRawTotal);
    }

    function test_payCallWithAllowanceExhausted() public {
        (, uint256 raw) = _maxIn(5e6, 0);
        _grant(raw * 2, raw);
        _payA(5e6, 0);
        _payA(5e6, 0);
        assertEq(pws.allowanceRemaining(KEY), 0);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.AllowanceExceeded.selector);
        pws.payCallWithAllowance(KEY, 1, keccak256("u-last"), 0);
        // a signed charge is independent of the allowance budget
        _pay(1e6, 0);
    }

    function test_payCallWithAllowanceStillBoundedByDailyCap() public {
        (uint256 maxIn,) = _maxIn(5e6, 100);
        vm.prank(wallet);
        pws.openSession(KEY, address(nvda), maxIn - 1);
        _grant(1e18, 1e18);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.CapExceeded.selector);
        pws.payCallWithAllowance(KEY, 5e6, keccak256("u"), 100);
    }

    function testFuzz_allowanceLimits(uint256 seed, uint256 total, uint256 perCharge) public {
        total = bound(total, 1, 1e18);
        perCharge = bound(perCharge, 1, total);
        vm.prank(wallet);
        pws.openSession(KEY, address(nvda), type(uint256).max);
        _grant(total, perCharge);
        uint256 walletBefore = nvda.balanceOf(wallet);
        uint256 sum;
        for (uint256 i; i < 10; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 owed = 1 + seed % 5e6;
            if (seed & 1 == 1) primary.setMode(MockSwapAdapter.Mode.NoRefund);
            else primary.setMode(MockSwapAdapter.Mode.Normal);
            vm.prank(router);
            try pws.payCallWithAllowance(KEY, owed, keccak256(abi.encode("u", i)), 300) returns (
                uint256 spent
            ) {
                assertLe(spent, perCharge, "per-charge limit");
                sum += spent;
            } catch {}
            assertLe(sum, total, "total limit");
            assertEq(_allowanceOf(KEY).spentRaw, sum);
            assertEq(walletBefore - nvda.balanceOf(wallet), sum);
        }
        _assertNoLeftovers();
    }

    // ------------------------------------------------------------------ no router-only path

    /// @dev The router alone (no wallet signature, no allowance) cannot move a wallet's tokens through any function.
    function testFuzz_routerAloneCannotMoveTokens(uint8 which, uint256 x, bytes32 y, bytes memory junk)
        public
    {
        uint256 walletBefore = nvda.balanceOf(wallet);
        IPayWithStock.ChargeAuthorization memory c = _auth(bound(x, 1, 1e12));
        c.usageCommitment = y == bytes32(0) ? keccak256("y") : y;
        IPayWithStock.AllowanceAuthorization memory al = _allowanceAuth(bound(x, 1, 1e30), 1, 1 days);
        bytes memory forged = _signCharge(uint256(keccak256(abi.encode(y, "router-made-up"))) % 1e70 + 1, c);
        vm.startPrank(router);
        which = uint8(bound(which, 0, 8));
        bytes memory data;
        if (which == 0) {
            data = abi.encodeCall(PayWithStock.payCall, (c, junk, 100));
        } else if (which == 1) {
            data = abi.encodeCall(PayWithStock.payCall, (c, forged, 100));
        } else if (which == 2) {
            data = abi.encodeCall(PayWithStock.payCallWithAllowance, (KEY, bound(x, 1, 5e6), y, 100));
        } else if (which == 3) {
            data = abi.encodeCall(PayWithStock.setAllowance, (al, junk));
        } else if (which == 4) {
            data = abi.encodeCall(PayWithStock.attemptSwap, (address(primary), address(nvda), x, x));
        } else if (which == 5) {
            data = abi.encodeCall(PayWithStock.forceCloseSession, (KEY));
        } else if (which == 6) {
            data = abi.encodeCall(PayWithStock.revokeAuthorizations, (KEY));
        } else if (which == 7) {
            data = abi.encodeCall(PayWithStock.openSession, (KEY, address(nvda), x));
        } else {
            data = bytes.concat(bytes4(uint32(x)), junk);
        }
        (bool ok,) = address(pws).call(data);
        vm.stopPrank();
        if (which <= 4 || which == 6 || which == 7) assertFalse(ok, "router-only call succeeded");
        assertEq(nvda.balanceOf(wallet), walletBefore, "tokens moved without the wallet");
        // even after the router force-closes, it cannot pay itself
        if (which == 5) assertFalse(_session(KEY).active);
    }

    // ------------------------------------------------------------------ slippage

    function test_slippageAboveCapReverts() public {
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.SlippageTooHigh.selector);
        pws.payCall(a, sig, 301);
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
        IPayWithStock.ChargeAuthorization memory a = _auth(owed);
        bytes memory sig = _signCharge(walletPk, a);

        vm.prank(router);
        if (needed > maxIn) {
            vm.expectRevert(IPayWithStock.SwapFailed.selector);
            pws.payCall(a, sig, slip);
            assertEq(nvda.balanceOf(wallet), walletBefore);
        } else {
            uint256 spent = pws.payCall(a, sig, slip);
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
        IPayWithStock.ChargeAuthorization memory a = _auth(5e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.CapExceeded.selector);
        pws.payCall(a, sig, 300);

        vm.prank(wallet);
        pws.openSession(KEY, address(nvda), maxIn);
        uint256 spent = _submit(a, sig, 300);
        assertEq(spent, raw);
        assertEq(_session(KEY).spentRawToday, raw, "actual, not maxIn");
        assertEq(pws.remainingToday(KEY), maxIn - raw);
    }

    function test_dayRollover() public {
        // spend most of the cap
        uint256 owed = 1_700e6; // ~9.44 NVDA
        _pay(owed, 0);
        IPayWithStock.ChargeAuthorization memory a = _auth(owed);
        a.deadline = block.timestamp + 2 days;
        bytes memory sig = _signCharge(walletPk, a);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.CapExceeded.selector);
        pws.payCall(a, sig, 0);

        // one second before midnight: still capped
        uint256 nextDay = _today() + 1 days;
        vm.warp(nextDay - 1);
        feed.setAnswer(180e8);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.CapExceeded.selector);
        pws.payCall(a, sig, 0);

        // at midnight UTC the window resets
        vm.warp(nextDay);
        feed.setAnswer(180e8);
        assertEq(pws.remainingToday(KEY), CAP);
        uint256 spent = _submit(a, sig, 0);
        IPayWithStock.Session memory s = _session(KEY);
        assertEq(s.dayStart, nextDay);
        assertEq(s.spentRawToday, spent);
    }

    /// @dev Model-based: random payments at random times never let a day's recorded spend exceed the cap,
    /// and recorded spend always equals the sum of actual spends in the current UTC day.
    function testFuzz_capAndRollover(uint256 seed) public {
        uint256 modelDay = _today();
        uint256 modelSpent = 0;
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 dt = seed % 20 hours;
            uint256 owed = 1e6 + (seed >> 64) % 800e6; // $1 .. $801
            uint16 slip = uint16((seed >> 128) % 301);
            vm.warp(block.timestamp + dt);
            feed.setAnswer(180e8);

            uint256 today = _today();
            if (today > modelDay) {
                modelDay = today;
                modelSpent = 0;
            }
            (uint256 maxIn,) = _maxIn(owed, slip);
            IPayWithStock.ChargeAuthorization memory a = _auth(owed);
            bytes memory sig = _signCharge(walletPk, a);
            vm.prank(router);
            if (modelSpent + maxIn > CAP) {
                vm.expectRevert(IPayWithStock.CapExceeded.selector);
                pws.payCall(a, sig, slip);
            } else {
                modelSpent += pws.payCall(a, sig, slip);
            }
            IPayWithStock.Session memory s = _session(KEY);
            if (s.dayStart == modelDay) assertEq(s.spentRawToday, modelSpent);
            assertLe(modelSpent, CAP);
        }
        _assertNoLeftovers();
    }

    // ------------------------------------------------------------------ fallback

    function test_fallbackAfterPrimaryReverts() public {
        primary.setMode(MockSwapAdapter.Mode.Revert);
        uint256 walletBefore = nvda.balanceOf(wallet);
        IPayWithStock.ChargeAuthorization memory a = _auth(3e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.expectEmit(true, true, false, true);
        emit PayWithStock.SwapAttemptFailed(
            KEY, address(primary), abi.encodeWithSelector(MockSwapAdapter.MockSwapFailed.selector)
        );
        uint256 spent = _submit(a, sig, 100);

        assertEq(fallbackAdapter.calls(), 1);
        assertEq(walletBefore - nvda.balanceOf(wallet), spent);
        assertEq(nvda.balanceOf(address(primary)), 0, "failed attempt rolled back");
        assertEq(nvda.balanceOf(address(fallbackAdapter)), 0);
        assertEq(credits.credited(KEY), 3e6);
        _assertNoLeftovers();
    }

    function test_fallbackAfterPrimaryUnderDelivers() public {
        primary.setMode(MockSwapAdapter.Mode.ShortPay);
        IPayWithStock.ChargeAuthorization memory a = _auth(3e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.expectEmit(true, true, false, true);
        emit PayWithStock.SwapAttemptFailed(
            KEY, address(primary), abi.encodeWithSelector(PayWithStock.InsufficientUsdgOut.selector)
        );
        _submit(a, sig, 100);
        assertEq(fallbackAdapter.calls(), 1);
        assertEq(usdg.balanceOf(address(primary)), 0, "short-paid USDG rolled back");
        _assertNoLeftovers();
    }

    function test_fallbackAfterPrimaryExceedsSlippage() public {
        primary.setPrice(PRICE18 * 90 / 100); // pool 10% below fair: needs more than maxIn at 1%
        uint256 spent = _pay(3e6, 100);
        assertEq(fallbackAdapter.calls(), 1);
        (, uint256 raw) = _maxIn(3e6, 100);
        assertEq(spent, raw);
        _assertNoLeftovers();
    }

    function test_bothAdaptersFail() public {
        primary.setMode(MockSwapAdapter.Mode.Revert);
        fallbackAdapter.setMode(MockSwapAdapter.Mode.Revert);
        uint256 walletBefore = nvda.balanceOf(wallet);
        IPayWithStock.ChargeAuthorization memory a = _auth(3e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.SwapFailed.selector);
        pws.payCall(a, sig, 100);
        assertEq(nvda.balanceOf(wallet), walletBefore);
        assertEq(_session(KEY).spentRawToday, 0);
    }

    function test_noFallbackConfigured() public {
        vm.prank(owner);
        pws.registerToken(address(nvda), address(primary), address(0), true);
        primary.setMode(MockSwapAdapter.Mode.Revert);
        IPayWithStock.ChargeAuthorization memory a = _auth(3e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.prank(router);
        vm.expectRevert(IPayWithStock.SwapFailed.selector);
        pws.payCall(a, sig, 100);
        assertEq(fallbackAdapter.calls(), 0);
    }

    function test_adapterKeepingRefundIsChargedByBalanceDelta() public {
        primary.setMode(MockSwapAdapter.Mode.NoRefund);
        (uint256 maxIn,) = _maxIn(3e6, 200);
        uint256 walletBefore = nvda.balanceOf(wallet);
        uint256 spent = _pay(3e6, 200);
        assertEq(spent, maxIn, "whole maxIn consumed");
        assertEq(walletBefore - nvda.balanceOf(wallet), maxIn);
        assertEq(_session(KEY).spentRawToday, maxIn);
        _assertNoLeftovers();
    }

    function test_adapterReturnValueIsNotTrusted() public {
        primary.setMode(MockSwapAdapter.Mode.LieAboutAmount);
        (, uint256 raw) = _maxIn(3e6, 200);
        uint256 spent = _pay(3e6, 200);
        assertEq(spent, raw);
        assertEq(_session(KEY).spentRawToday, raw);
    }

    function test_attemptSwapIsSelfOnly() public {
        vm.expectRevert(PayWithStock.NotSelf.selector);
        pws.attemptSwap(address(primary), address(nvda), 1e6, 1e18);
        vm.prank(router);
        vm.expectRevert(PayWithStock.NotSelf.selector);
        pws.attemptSwap(address(primary), address(nvda), 1e6, 1e18);
    }

    function test_adapterCannotCallAttemptSwap() public {
        SneakyAdapter sneaky = new SneakyAdapter();
        vm.prank(owner);
        pws.registerToken(address(nvda), address(sneaky), address(fallbackAdapter), true);
        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        bytes memory sig = _signCharge(walletPk, a);
        vm.expectEmit(true, true, false, true);
        emit PayWithStock.SwapAttemptFailed(
            KEY, address(sneaky), abi.encodeWithSelector(PayWithStock.NotSelf.selector)
        );
        _submit(a, sig, 100);
        assertEq(fallbackAdapter.calls(), 1);
        _assertNoLeftovers();
    }

    // ------------------------------------------------------------------ reentrancy

    function _reenter(bytes memory reentry) internal {
        ReentrantAdapter evil = new ReentrantAdapter();
        evil.arm(pws, reentry);
        vm.startPrank(owner);
        pws.registerToken(address(nvda), address(evil), address(fallbackAdapter), true);
        pws.setRouter(address(evil));
        vm.stopPrank();

        IPayWithStock.ChargeAuthorization memory a = _auth(1e6);
        a.router = address(evil);
        bytes memory sig = _signCharge(walletPk, a);
        vm.expectEmit(true, true, false, true);
        emit PayWithStock.SwapAttemptFailed(
            KEY,
            address(evil),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        evil.start(a, sig);
        assertEq(fallbackAdapter.calls(), 1);
        assertEq(credits.credited(KEY), 1e6);
        _assertNoLeftovers();
    }

    function test_reentrancyIntoPayCallBlocked() public {
        IPayWithStock.ChargeAuthorization memory inner = _auth(1e6);
        _reenter(abi.encodeCall(PayWithStock.payCall, (inner, _signCharge(walletPk, inner), 100)));
    }

    function test_reentrancyIntoPayCallWithAllowanceBlocked() public {
        _grant(1e18, 1e17);
        _reenter(abi.encodeCall(PayWithStock.payCallWithAllowance, (KEY, 1e6, keccak256("inner"), 100)));
    }

    function test_reentrancyIntoSessionChangesBlocked() public {
        // a relayed allowance must not land mid-charge (it would rewrite the allowance being charged)
        IPayWithStock.AllowanceAuthorization memory al = _allowanceAuth(1e18, 1e17, 1 days);
        _reenter(abi.encodeCall(PayWithStock.setAllowance, (al, _sign(walletPk, pws.hashAllowance(al)))));
    }

    function test_reentrancyIntoOpenSessionBlocked() public {
        _reenter(abi.encodeCall(PayWithStock.openSession, (keccak256("other key"), address(nvda), 1)));
    }

    // ------------------------------------------------------------------ refund correctness (fuzz)

    function testFuzz_refundCorrectness(uint256 owed, uint16 slip, uint256 priceBps, bool usePrimaryFail)
        public
    {
        owed = bound(owed, 1, 1_500e6);
        slip = uint16(bound(slip, 0, 300));
        // adapter price between (fair / (1 + slip)) and 1.5 x fair => always fillable within maxIn
        priceBps = bound(priceBps, 10_000, 15_000);
        uint256 adapterPrice = Math.mulDiv(PRICE18, priceBps, 10_000 + slip, Math.Rounding.Ceil);
        MockSwapAdapter used = usePrimaryFail ? fallbackAdapter : primary;
        used.setPrice(adapterPrice);
        if (usePrimaryFail) primary.setMode(MockSwapAdapter.Mode.Revert);

        (uint256 maxIn,) = _maxIn(owed, slip);
        uint256 expected = used.quoteIn(address(nvda), address(usdg), owed);
        vm.assume(expected <= maxIn); // rounding at the edge
        uint256 walletBefore = nvda.balanceOf(wallet);

        uint256 spent = _pay(owed, slip);
        assertEq(spent, expected);
        assertEq(walletBefore - nvda.balanceOf(wallet), spent, "wallet refunded maxIn - spent");
        assertEq(nvda.balanceOf(address(0xdEaD)), spent, "adapter received exactly spent");
        assertEq(_session(KEY).spentRawToday, spent);
        assertEq(credits.credited(KEY), owed);
        _assertNoLeftovers();
    }
}

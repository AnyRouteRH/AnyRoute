// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IPayWithStock} from "./interfaces/IPayWithStock.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {IStockOracle} from "./interfaces/IStockOracle.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title PayWithStock
/// @notice Pay for inference with any registered Stock Token. A wallet opens a capped daily session for an API
/// key (`keyHash`) and approves this contract for the token. Every charge carries the wallet's own authorization:
///  - `payCall`: an EIP-712 ChargeAuthorization the wallet signed for exactly this charge (USDG amount, token
///    maximum, usage commitment, nonce, epoch, deadline, router), or
///  - `payCallWithAllowance`: a charge of at most $5 within the AllowanceAuthorization the wallet registered
///    (total and per-charge token limits, at most 7 days), tied to a fresh usage commitment.
/// A charge pulls at most min(authorized maximum, ceil(rawNeeded * (1 + slip))) tokens (fair value from the
/// IStockOracle), swaps exactly the USDG owed (primary adapter, then fallback), refunds the unused tokens to the
/// wallet and credits the key in Credits.
/// @dev Safety properties:
///  - No router-only path moves a wallet's tokens: both payment functions require an authorization from the session
///    wallet (ECDSA for EOAs, ERC-1271 for smart wallets) bound to this chain and contract (EIP-712 domain), the
///    calling router, the session's token and the session's current epoch. Charge nonces are single use; a usage
///    commitment can be charged once per key.
///  - `closeSession`, `revokeAuthorizations`, `forceCloseSession` and a change of session wallet or token bump the
///    epoch and delete the allowance, voiding every outstanding authorization in one call.
///  - Every charge is also bounded by the wallet's `capRawPerDay` per UTC day (checked against the worst case
///    `maxIn`, recorded at the actual amount spent), by the owner's slippage cap (<= 10%) around the oracle's fair
///    value, and - under an allowance - by its per-charge and total limits, which are reserved the same way.
///  - Each swap attempt runs in an external self-call (`attemptSwap`) wrapped in try/catch: if an adapter reverts
///    or under-delivers, the whole attempt (including the token transfer to the adapter) is rolled back, so the
///    tokens are still held here for the fallback attempt. Nothing is left behind between transactions.
///  - Amounts spent / received are measured by balance deltas; adapter return values are not trusted.
///  - Every state-changing session or payment function shares one reentrancy lock.
///  - Fee-on-transfer / rebasing stock tokens are not supported.
contract PayWithStock is IPayWithStock, Ownable2Step, ReentrancyGuardTransient, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice Hard upper bound for the owner-settable slippage cap (10%).
    uint16 public constant HARD_MAX_SLIP_BPS = 1000;
    /// @notice Initial slippage cap (3%).
    uint16 public constant DEFAULT_MAX_SLIP_BPS = 300;
    /// @notice Max supported stock-token decimals (keeps 10**(dec+12) far from overflow).
    uint8 public constant MAX_TOKEN_DECIMALS = 36;
    /// @notice Longest an authorization stays usable: its deadline / validUntil may be at most this far ahead of the
    /// current block. Checked on every use, so a signature naming a later time is refused until it is in range.
    uint256 public constant MAX_AUTHORIZATION_WINDOW = 7 days;
    /// @notice Largest USDG amount (6 decimals) one allowance charge may settle: $5. Signed charges name their own.
    uint256 public constant MAX_ALLOWANCE_CHARGE_USDG = 5e6;
    /// @notice EIP-712 type of a per-charge authorization.
    bytes32 public constant CHARGE_TYPEHASH = keccak256(
        "ChargeAuthorization(bytes32 keyHash,address token,uint256 usdgAmount,uint256 maxRaw,bytes32 usageCommitment,uint256 nonce,uint64 epoch,uint256 deadline,address router)"
    );
    /// @notice EIP-712 type of a bounded pre-authorization.
    bytes32 public constant ALLOWANCE_TYPEHASH = keccak256(
        "AllowanceAuthorization(bytes32 keyHash,address token,uint256 maxRawTotal,uint256 maxRawPerCharge,uint256 validUntil,uint256 nonce,uint64 epoch,address router)"
    );
    uint256 internal constant BPS = 10_000;
    uint8 internal constant USDG_DECIMALS = 6;

    /// @notice Settlement stablecoin (6 decimals).
    IERC20 public immutable usdg;
    /// @notice Credits ledger; `credit(keyHash, amount)` pulls USDG from this contract.
    ICredits public immutable credits;

    /// @notice Fair-value oracle (Chainlink x uiMultiplier).
    IStockOracle public oracle;
    /// @notice The only address allowed to submit charges (and named in every authorization).
    address public router;
    /// @notice Upper bound on the `maxSlipBps` argument of the payment functions.
    uint16 public maxSlipCapBps;

    /// @inheritdoc IPayWithStock
    mapping(bytes32 keyHash => Session) public sessions;
    /// @inheritdoc IPayWithStock
    mapping(address token => TokenConfig) public tokens;
    /// @inheritdoc IPayWithStock
    mapping(bytes32 keyHash => Allowance) public allowances;
    /// @notice Next AllowanceAuthorization nonce per key (sequential: each signed allowance registers once).
    mapping(bytes32 keyHash => uint256) public allowanceNonces;
    /// @notice Used ChargeAuthorization nonces per key: bit (nonce & 255) of word (nonce >> 8).
    mapping(bytes32 keyHash => mapping(uint256 word => uint256 bits)) public chargeNonceBitmap;
    /// @notice Usage commitments already charged per key (the same usage batch is never paid twice).
    mapping(bytes32 keyHash => mapping(bytes32 usageCommitment => bool)) public commitmentCharged;

    /// @notice Emitted when a swap attempt fails and (if available) the fallback adapter is tried next.
    event SwapAttemptFailed(bytes32 indexed keyHash, address indexed adapter, bytes reason);

    error ZeroAddress();
    error InvalidToken();
    error InvalidAdapter();
    error NotSelf();
    error InsufficientUsdgOut();

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    /// @param usdg_ USDG token (must report 6 decimals).
    /// @param credits_ Credits ledger (this contract must be an allowed creditor there).
    /// @param oracle_ Stock fair-value oracle.
    /// @param router_ Router service address allowed to submit authorized charges.
    /// @param owner_ Owner (timelock).
    constructor(IERC20 usdg_, ICredits credits_, IStockOracle oracle_, address router_, address owner_)
        Ownable(owner_)
        EIP712("Anyroute PayWithStock", "1")
    {
        if (
            address(usdg_) == address(0) || address(credits_) == address(0) || address(oracle_) == address(0)
                || router_ == address(0)
        ) revert ZeroAddress();
        if (IERC20Metadata(address(usdg_)).decimals() != USDG_DECIMALS) revert InvalidToken();
        usdg = usdg_;
        credits = credits_;
        oracle = oracle_;
        router = router_;
        maxSlipCapBps = DEFAULT_MAX_SLIP_BPS;
        emit OracleSet(address(oracle_));
        emit RouterSet(router_);
        emit MaxSlipSet(DEFAULT_MAX_SLIP_BPS);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    /// @notice Register / update a payable Stock Token and its swap adapters.
    /// @dev Adapters are freely assignable per token: on Robinhood Chain Uniswap V3 is usually far deeper for stock
    /// tokens than V4, so the V3 adapter may well be the primary and the V4 adapter the fallback (or vice versa).
    /// @param primaryAdapter Adapter tried first (required when enabling).
    /// @param fallbackAdapter Adapter tried if the primary fails (optional, may be zero).
    function registerToken(address token, address primaryAdapter, address fallbackAdapter, bool enabled)
        external
        onlyOwner
    {
        if (token == address(0) || token == address(usdg)) revert InvalidToken();
        if (IERC20Metadata(token).decimals() > MAX_TOKEN_DECIMALS) revert InvalidToken();
        if (enabled && primaryAdapter == address(0)) revert InvalidAdapter();
        if (fallbackAdapter != address(0) && fallbackAdapter == primaryAdapter) revert InvalidAdapter();
        tokens[token] =
            TokenConfig({enabled: enabled, primaryAdapter: primaryAdapter, fallbackAdapter: fallbackAdapter});
        emit TokenRegistered(token, primaryAdapter, fallbackAdapter, enabled);
    }

    /// @notice Set the router allowed to submit charges. Authorizations name the router they were signed for, so a
    /// new router cannot use any authorization signed for the previous one (wallets re-sign for the new router).
    function setRouter(address router_) external onlyOwner {
        if (router_ == address(0)) revert ZeroAddress();
        router = router_;
        emit RouterSet(router_);
    }

    /// @notice Set the fair-value oracle.
    function setOracle(IStockOracle oracle_) external onlyOwner {
        if (address(oracle_) == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }

    /// @notice Set the slippage cap for charges (<= HARD_MAX_SLIP_BPS).
    function setMaxSlip(uint16 maxSlipBps_) external onlyOwner {
        if (maxSlipBps_ > HARD_MAX_SLIP_BPS) revert SlippageTooHigh();
        maxSlipCapBps = maxSlipBps_;
        emit MaxSlipSet(maxSlipBps_);
    }

    /// @notice Recover tokens held by this contract (it never holds wallet funds between transactions).
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Sessions and authorizations
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IPayWithStock
    /// @dev msg.sender becomes the session wallet and must separately `approve` this contract for `token`.
    /// An active session can only be replaced by its own wallet. If the same wallet re-opens with the same token
    /// on the same UTC day, today's spend is preserved (closing/re-opening cannot reset the daily cap). A new
    /// wallet or token revokes every authorization signed for the previous one (their limits are in its units).
    function openSession(bytes32 keyHash, address token, uint256 capRawPerDay) external nonReentrant {
        _openSession(keyHash, token, capRawPerDay);
    }

    /// @notice openSession plus an EIP-2612 permit granting this contract `permitValue` of `token` (Stock Tokens
    /// support permit). The permit is best-effort (try/catch) so a front-run permit cannot grief the call; the
    /// resulting allowance is what the payment functions rely on.
    function openSessionWithPermit(
        bytes32 keyHash,
        address token,
        uint256 capRawPerDay,
        uint256 permitValue,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        try IERC20Permit(token).permit(msg.sender, address(this), permitValue, deadline, v, r, s) {} catch {}
        _openSession(keyHash, token, capRawPerDay);
    }

    function _openSession(bytes32 keyHash, address token, uint256 capRawPerDay) internal {
        if (!tokens[token].enabled) revert TokenNotEnabled();
        if (capRawPerDay == 0) revert InvalidAmount();
        Session storage s = sessions[keyHash];
        if (s.active && s.wallet != msg.sender) revert NotSessionWallet();

        uint64 today = _today();
        bool sameBinding = s.wallet == msg.sender && s.token == token;
        bool keepSpend = sameBinding && s.dayStart == today;
        s.wallet = msg.sender;
        s.token = token;
        s.capRawPerDay = capRawPerDay;
        if (!keepSpend) {
            s.spentRawToday = 0;
            s.dayStart = today;
        }
        s.active = true;
        if (!sameBinding) _revoke(keyHash, s);
        emit SessionOpened(keyHash, msg.sender, token, capRawPerDay);
    }

    /// @inheritdoc IPayWithStock
    function closeSession(bytes32 keyHash) external nonReentrant {
        Session storage s = sessions[keyHash];
        if (!s.active) revert NoSession();
        if (s.wallet != msg.sender) revert NotSessionWallet();
        s.active = false;
        _revoke(keyHash, s);
        emit SessionClosed(keyHash, msg.sender);
    }

    /// @inheritdoc IPayWithStock
    function revokeAuthorizations(bytes32 keyHash) external nonReentrant {
        Session storage s = sessions[keyHash];
        if (s.wallet != msg.sender) revert NotSessionWallet();
        _revoke(keyHash, s);
    }

    /// @notice Router can deactivate a session (e.g. one squatting a keyHash with a wallet the key's owner did not
    /// link off-chain). Moves no funds and revokes the session's authorizations; the wallet can re-open it.
    function forceCloseSession(bytes32 keyHash) external onlyRouter nonReentrant {
        Session storage s = sessions[keyHash];
        if (!s.active) revert NoSession();
        s.active = false;
        _revoke(keyHash, s);
        emit SessionClosed(keyHash, s.wallet);
    }

    /// @inheritdoc IPayWithStock
    /// @dev Checks: active session, the session's token and epoch, the current router, validUntil within
    /// MAX_AUTHORIZATION_WINDOW, 0 < maxRawPerCharge <= maxRawTotal, the next sequential nonce, and a valid wallet
    /// signature (skipped when the wallet itself calls). Replaces any previous allowance of the key.
    function setAllowance(AllowanceAuthorization calldata auth, bytes calldata signature)
        external
        nonReentrant
    {
        Session storage s = sessions[auth.keyHash];
        _checkBinding(s, auth.token, auth.epoch, auth.router);
        _checkWindow(auth.validUntil);
        if (auth.maxRawPerCharge == 0 || auth.maxRawPerCharge > auth.maxRawTotal) revert InvalidAllowance();
        uint256 nonce = allowanceNonces[auth.keyHash];
        if (auth.nonce != nonce) revert InvalidNonce();
        address wallet = s.wallet;
        if (
            msg.sender != wallet
                && !SignatureChecker.isValidSignatureNowCalldata(wallet, hashAllowance(auth), signature)
        ) revert BadSignature();

        allowanceNonces[auth.keyHash] = nonce + 1;
        // validUntil <= block.timestamp + 7 days (checked above), so it fits in 64 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 validUntil = uint64(auth.validUntil);
        allowances[auth.keyHash] = Allowance({
            maxRawTotal: auth.maxRawTotal,
            maxRawPerCharge: auth.maxRawPerCharge,
            spentRaw: 0,
            nonce: nonce,
            validUntil: validUntil,
            epoch: auth.epoch,
            router: auth.router
        });
        emit AllowanceSet(
            auth.keyHash, wallet, nonce, auth.maxRawTotal, auth.maxRawPerCharge, validUntil, auth.epoch
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Payment
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IPayWithStock
    /// @dev Checks: caller is the router named in `auth`, deadline within the window, active session with the
    /// signed token and epoch, a valid wallet signature (ECDSA or ERC-1271), an unused nonce and usage commitment.
    /// At most min(auth.maxRaw, oracle maxIn) tokens leave the wallet.
    function payCall(ChargeAuthorization calldata auth, bytes calldata signature, uint16 maxSlipBps)
        external
        onlyRouter
        nonReentrant
        returns (uint256 rawSpent)
    {
        Session storage s = _authorizeCharge(auth, signature);
        uint256 price18;
        (rawSpent, price18) = _chargeSigned(auth, s, maxSlipBps);
        emit PaidWithStock(
            auth.keyHash,
            s.wallet,
            auth.usageCommitment,
            auth.token,
            rawSpent,
            price18,
            auth.usdgAmount,
            auth.nonce,
            false
        );
    }

    /// @inheritdoc IPayWithStock
    /// @dev Checks: a registered allowance naming the caller, the session's current epoch and an unexpired
    /// validUntil; usdgOwed <= MAX_ALLOWANCE_CHARGE_USDG; an unused usage commitment. At most
    /// min(maxRawPerCharge, maxRawTotal - spentRaw, oracle maxIn) tokens leave the wallet.
    function payCallWithAllowance(
        bytes32 keyHash,
        uint256 usdgOwed,
        bytes32 usageCommitment,
        uint16 maxSlipBps
    ) external onlyRouter nonReentrant returns (uint256 rawSpent) {
        if (usdgOwed == 0) revert InvalidAmount();
        if (usdgOwed > MAX_ALLOWANCE_CHARGE_USDG) revert ChargeTooLarge();
        Allowance storage al = allowances[keyHash];
        if (al.validUntil == 0) revert NoAllowance();
        Session storage s = sessions[keyHash];
        _checkBinding(s, s.token, al.epoch, al.router);
        if (block.timestamp > al.validUntil) revert AuthorizationExpired();
        _useCommitment(keyHash, usageCommitment);

        uint256 price18;
        (rawSpent, price18) = _chargeAllowance(keyHash, s, al, usdgOwed, maxSlipBps);
        emit PaidWithStock(
            keyHash, s.wallet, usageCommitment, s.token, rawSpent, price18, usdgOwed, al.nonce, true
        );
    }

    /// @notice One swap attempt. External only so it can be wrapped in try/catch; callable only by this contract.
    /// @dev Sends `maxIn` to `adapter`, which must deliver >= `usdgOwed` USDG here and refund unused tokens here.
    /// Reverting (adapter failure, under-delivery, over-refund) rolls back the transfer to the adapter.
    /// @return rawSpent Tokens actually consumed (balance delta, <= maxIn).
    function attemptSwap(address adapter, address token, uint256 usdgOwed, uint256 maxIn)
        external
        returns (uint256 rawSpent)
    {
        if (msg.sender != address(this)) revert NotSelf();
        IERC20 t = IERC20(token);
        uint256 tokBefore = t.balanceOf(address(this));
        uint256 usdgBefore = usdg.balanceOf(address(this));

        t.safeTransfer(adapter, maxIn);
        ISwapAdapter(adapter)
            .swapExactOut(token, address(usdg), usdgOwed, maxIn, address(this), address(this));

        uint256 tokAfter = t.balanceOf(address(this));
        if (tokAfter > tokBefore) revert SwapFailed(); // adapter returned more than it was given
        rawSpent = tokBefore - tokAfter;
        if (rawSpent > maxIn) revert SwapFailed();
        if (usdg.balanceOf(address(this)) < usdgBefore + usdgOwed) revert InsufficientUsdgOut();
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice EIP-712 digest the session wallet signs for `auth`.
    function hashCharge(ChargeAuthorization calldata auth) public view returns (bytes32) {
        // Every member is a 32-byte static word, so abi.encode(TYPEHASH, auth) is exactly encodeData.
        return _hashTypedDataV4(keccak256(abi.encode(CHARGE_TYPEHASH, auth)));
    }

    /// @notice EIP-712 digest the session wallet signs for `auth`.
    function hashAllowance(AllowanceAuthorization calldata auth) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ALLOWANCE_TYPEHASH, auth)));
    }

    /// @notice The EIP-712 domain separator (name "Anyroute PayWithStock", version "1", chain id, this contract).
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Whether a ChargeAuthorization nonce of `keyHash` has been used.
    function isChargeNonceUsed(bytes32 keyHash, uint256 nonce) external view returns (bool) {
        return chargeNonceBitmap[keyHash][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    /// @notice Raw token units the key's allowance can still spend now (0 when absent, expired, revoked, for
    /// another router, or the session is closed). The daily cap applies on top.
    function allowanceRemaining(bytes32 keyHash) external view returns (uint256) {
        Allowance storage al = allowances[keyHash];
        Session storage s = sessions[keyHash];
        if (
            !s.active || al.validUntil < block.timestamp || al.epoch != s.epoch || al.router != router
                || al.spentRaw >= al.maxRawTotal
        ) return 0;
        return al.maxRawTotal - al.spentRaw;
    }

    /// @inheritdoc IPayWithStock
    /// @dev rawNeeded = ceil(usdgOwed * 10^dec * 1e18 / (fairPrice18 * 1e6)).
    function quoteRaw(address token, uint256 usdgOwed)
        external
        view
        returns (uint256 rawNeeded, uint256 fairPrice18)
    {
        bool ok;
        (fairPrice18, ok) = oracle.fairPrice(token);
        if (!ok || fairPrice18 == 0) revert OracleNotOk();
        uint8 dec = IERC20Metadata(token).decimals();
        if (dec > MAX_TOKEN_DECIMALS) revert InvalidToken();
        rawNeeded = _rawFor(usdgOwed, dec, fairPrice18);
    }

    /// @notice Worst-case raw amount a charge would pull (before the authorization's own maximum) for `usdgOwed`
    /// at `slipBps`.
    function quoteMaxIn(address token, uint256 usdgOwed, uint16 slipBps)
        external
        view
        returns (uint256 maxIn, uint256 rawNeeded, uint256 fairPrice18)
    {
        bool ok;
        (fairPrice18, ok) = oracle.fairPrice(token);
        if (!ok || fairPrice18 == 0) revert OracleNotOk();
        uint8 dec = IERC20Metadata(token).decimals();
        if (dec > MAX_TOKEN_DECIMALS) revert InvalidToken();
        rawNeeded = _rawFor(usdgOwed, dec, fairPrice18);
        maxIn = Math.mulDiv(rawNeeded, BPS + slipBps, BPS, Math.Rounding.Ceil);
    }

    /// @notice Raw token units the session can still spend today (accounts for the UTC day rollover).
    function remainingToday(bytes32 keyHash) external view returns (uint256) {
        Session storage s = sessions[keyHash];
        if (!s.active) return 0;
        uint256 spent = s.dayStart < _today() ? 0 : s.spentRawToday;
        return spent >= s.capRawPerDay ? 0 : s.capRawPerDay - spent;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev An authorization applies only to an active session with the same token and epoch, and to the current
    /// router (msg.sender for the payment functions).
    function _checkBinding(Session storage s, address token, uint64 epoch, address router_) internal view {
        if (!s.active) revert NoSession();
        if (token != s.token) revert WrongToken();
        if (epoch != s.epoch) revert StaleEpoch();
        if (router_ != router) revert WrongRouter();
    }

    function _checkWindow(uint256 until) internal view {
        if (block.timestamp > until) revert AuthorizationExpired();
        if (until > block.timestamp + MAX_AUTHORIZATION_WINDOW) revert AuthorizationWindowTooLong();
    }

    function _revoke(bytes32 keyHash, Session storage s) internal {
        uint64 epoch = s.epoch + 1;
        s.epoch = epoch;
        delete allowances[keyHash];
        emit AuthorizationsRevoked(keyHash, s.wallet, epoch);
    }

    function _useChargeNonce(bytes32 keyHash, uint256 nonce) internal {
        uint256 bit = 1 << (nonce & 0xff);
        mapping(uint256 => uint256) storage words = chargeNonceBitmap[keyHash];
        uint256 word = words[nonce >> 8];
        if (word & bit != 0) revert NonceUsed();
        words[nonce >> 8] = word | bit;
    }

    function _useCommitment(bytes32 keyHash, bytes32 usageCommitment) internal {
        if (usageCommitment == bytes32(0)) revert InvalidCommitment();
        if (commitmentCharged[keyHash][usageCommitment]) revert CommitmentUsed();
        commitmentCharged[keyHash][usageCommitment] = true;
    }

    /// @dev Pull `maxIn` (reserved against the daily cap), swap exactly `usdgOwed`, record and refund the unused
    /// tokens, credit the key.
    function _settle(
        bytes32 keyHash,
        Session storage s,
        address wallet,
        address token,
        uint256 usdgOwed,
        uint256 maxIn
    ) internal returns (uint256 rawSpent) {
        // reserve the worst case against the daily cap (CEI); trimmed to the actual spend below
        uint256 spentBefore = _reserveCap(s, maxIn);

        IERC20(token).safeTransferFrom(wallet, address(this), maxIn);
        rawSpent = _swapWithFallback(keyHash, token, usdgOwed, maxIn);

        s.spentRawToday = spentBefore + rawSpent;
        if (maxIn > rawSpent) IERC20(token).safeTransfer(wallet, maxIn - rawSpent);

        usdg.forceApprove(address(credits), usdgOwed);
        credits.credit(keyHash, usdgOwed);
    }

    /// @dev Every check of a signed charge; consumes its nonce and usage commitment. Returns the session.
    function _authorizeCharge(ChargeAuthorization calldata auth, bytes calldata signature)
        internal
        returns (Session storage s)
    {
        if (auth.usdgAmount == 0 || auth.maxRaw == 0) revert InvalidAmount();
        _checkWindow(auth.deadline);
        s = sessions[auth.keyHash];
        _checkBinding(s, auth.token, auth.epoch, auth.router);
        if (!SignatureChecker.isValidSignatureNowCalldata(s.wallet, hashCharge(auth), signature)) {
            revert BadSignature();
        }
        _useChargeNonce(auth.keyHash, auth.nonce);
        _useCommitment(auth.keyHash, auth.usageCommitment);
    }

    /// @dev Pull at most min(auth.maxRaw, oracle maxIn).
    function _chargeSigned(ChargeAuthorization calldata auth, Session storage s, uint16 maxSlipBps)
        internal
        returns (uint256 rawSpent, uint256 price18)
    {
        uint256 maxIn;
        (maxIn, price18) = _maxIn(auth.token, auth.usdgAmount, maxSlipBps);
        if (maxIn > auth.maxRaw) maxIn = auth.maxRaw;
        rawSpent = _settle(auth.keyHash, s, s.wallet, auth.token, auth.usdgAmount, maxIn);
    }

    /// @dev Pull at most min(maxRawPerCharge, what is left of maxRawTotal, oracle maxIn): reserved against the
    /// allowance first (CEI) and trimmed to the actual spend afterwards, like the daily cap.
    function _chargeAllowance(
        bytes32 keyHash,
        Session storage s,
        Allowance storage al,
        uint256 usdgOwed,
        uint16 maxSlipBps
    ) internal returns (uint256 rawSpent, uint256 price18) {
        uint256 allowanceSpent = al.spentRaw;
        uint256 bound = Math.min(al.maxRawPerCharge, al.maxRawTotal - allowanceSpent);
        if (bound == 0) revert AllowanceExceeded();
        address token = s.token;
        uint256 maxIn;
        (maxIn, price18) = _maxIn(token, usdgOwed, maxSlipBps);
        if (maxIn > bound) maxIn = bound;
        al.spentRaw = allowanceSpent + maxIn;
        rawSpent = _settle(keyHash, s, s.wallet, token, usdgOwed, maxIn);
        al.spentRaw = allowanceSpent + rawSpent;
    }

    function _swapWithFallback(bytes32 keyHash, address token, uint256 usdgOwed, uint256 maxIn)
        internal
        returns (uint256)
    {
        TokenConfig memory cfg = tokens[token];
        try this.attemptSwap(cfg.primaryAdapter, token, usdgOwed, maxIn) returns (uint256 spent) {
            return spent;
        } catch (bytes memory reason) {
            emit SwapAttemptFailed(keyHash, cfg.primaryAdapter, reason);
        }
        if (cfg.fallbackAdapter != address(0)) {
            try this.attemptSwap(cfg.fallbackAdapter, token, usdgOwed, maxIn) returns (uint256 spent) {
                return spent;
            } catch (bytes memory reason) {
                emit SwapAttemptFailed(keyHash, cfg.fallbackAdapter, reason);
            }
        }
        revert SwapFailed();
    }

    /// @dev Fair-value quote plus slippage: maxIn = ceil(rawNeeded * (10000 + slipBps) / 10000). Also checks the
    /// slippage argument against the owner's cap and that the token is enabled.
    function _maxIn(address token, uint256 usdgOwed, uint16 slipBps)
        internal
        view
        returns (uint256 maxIn, uint256 price18)
    {
        if (slipBps > maxSlipCapBps) revert SlippageTooHigh();
        if (!tokens[token].enabled) revert TokenNotEnabled();
        bool ok;
        (price18, ok) = oracle.fairPrice(token);
        if (!ok || price18 == 0) revert OracleNotOk();
        uint256 rawNeeded = _rawFor(usdgOwed, IERC20Metadata(token).decimals(), price18);
        maxIn = Math.mulDiv(rawNeeded, BPS + slipBps, BPS, Math.Rounding.Ceil);
    }

    /// @dev Roll the UTC day window, check `spent + maxIn <= cap`, reserve maxIn. Returns spend before this call.
    function _reserveCap(Session storage s, uint256 maxIn) internal returns (uint256 spentBefore) {
        uint64 today = _today();
        if (s.dayStart < today) {
            s.dayStart = today;
            s.spentRawToday = 0;
        }
        spentBefore = s.spentRawToday;
        if (spentBefore + maxIn > s.capRawPerDay) revert CapExceeded();
        s.spentRawToday = spentBefore + maxIn;
    }

    /// @dev ceil(usdgOwed * 10^dec * 1e18 / (price18 * 10^6)) == ceil(usdgOwed * 10^(dec + 12) / price18).
    function _rawFor(uint256 usdgOwed, uint8 dec, uint256 price18) internal pure returns (uint256) {
        return Math.mulDiv(usdgOwed, 10 ** (uint256(dec) + 18 - USDG_DECIMALS), price18, Math.Rounding.Ceil);
    }

    function _today() internal view returns (uint64) {
        return uint64(block.timestamp - (block.timestamp % 1 days));
    }
}

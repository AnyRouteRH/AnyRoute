// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPayWithStock} from "./interfaces/IPayWithStock.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {IStockOracle} from "./interfaces/IStockOracle.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title PayWithStock
/// @notice Pay for inference with any registered Stock Token. A wallet opens a capped daily session for an API
/// key (`keyHash`) and approves this contract for the token. The router batches the key's micro-debts and calls
/// `payCall`, which pulls at most `ceil(rawNeeded * (1 + slip))` tokens (fair value from the IStockOracle),
/// swaps exactly the USDG owed (primary adapter, then fallback), refunds the unused tokens to the wallet and
/// credits the key in Credits.
/// @dev Safety properties:
///  - Only `payCall` (router-only, nonReentrant) can move a wallet's tokens, bounded per UTC day by the wallet's
///    own `capRawPerDay` (checked against the worst case `maxIn`, recorded at the actual amount spent).
///  - Each swap attempt runs in an external self-call (`attemptSwap`) wrapped in try/catch: if an adapter reverts
///    or under-delivers, the whole attempt (including the token transfer to the adapter) is rolled back, so the
///    tokens are still held here for the fallback attempt. Nothing is left behind between transactions.
///  - Amounts spent / received are measured by balance deltas; adapter return values are not trusted.
///  - Fee-on-transfer / rebasing stock tokens are not supported.
contract PayWithStock is IPayWithStock, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Hard upper bound for the owner-settable slippage cap (10%).
    uint16 public constant HARD_MAX_SLIP_BPS = 1000;
    /// @notice Initial slippage cap (3%).
    uint16 public constant DEFAULT_MAX_SLIP_BPS = 300;
    /// @notice Max supported stock-token decimals (keeps 10**(dec+12) far from overflow).
    uint8 public constant MAX_TOKEN_DECIMALS = 36;
    uint256 internal constant BPS = 10_000;
    uint8 internal constant USDG_DECIMALS = 6;

    /// @notice Settlement stablecoin (6 decimals).
    IERC20 public immutable usdg;
    /// @notice Credits ledger; `credit(keyHash, amount)` pulls USDG from this contract.
    ICredits public immutable credits;

    /// @notice Fair-value oracle (Chainlink x uiMultiplier).
    IStockOracle public oracle;
    /// @notice The only address allowed to call `payCall`.
    address public router;
    /// @notice Upper bound on the `maxSlipBps` argument of `payCall`.
    uint16 public maxSlipCapBps;

    /// @inheritdoc IPayWithStock
    mapping(bytes32 keyHash => Session) public sessions;
    /// @inheritdoc IPayWithStock
    mapping(address token => TokenConfig) public tokens;

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
    /// @param router_ Router service address allowed to call payCall.
    /// @param owner_ Owner (timelock).
    constructor(IERC20 usdg_, ICredits credits_, IStockOracle oracle_, address router_, address owner_)
        Ownable(owner_)
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
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Pay for inference with any registered Stock Token. A wallet opens a capped daily session for an API key
/// and authorizes every charge itself: either one EIP-712 ChargeAuthorization per settlement (exact USDG amount,
/// token maximum, usage commitment, nonce, deadline) or one bounded AllowanceAuthorization (total and per-charge
/// token limits, at most 7 days, at most $5 per charge). The router batches the key's micro-debts (>= $1 or 24h)
/// and settles them with payCall / payCallWithAllowance, which swaps exactly the USDG owed at Chainlink x
/// uiMultiplier fair value (slippage-bounded) and credits the key in Credits.
interface IPayWithStock {
    struct Session {
        address wallet;
        address token;
        uint256 capRawPerDay;
        uint256 spentRawToday;
        uint64 dayStart;
        bool active;
        /// @dev Authorization epoch: every charge / allowance signature names it. Closing, revoking, a router force
        /// close or a change of wallet or token bumps it, which invalidates all outstanding authorizations.
        uint64 epoch;
    }

    struct TokenConfig {
        bool enabled;
        address primaryAdapter;
        address fallbackAdapter; // may be zero
    }

    /// @notice One settlement signed by the session wallet (EIP-712; chain id and this contract are in the domain).
    struct ChargeAuthorization {
        bytes32 keyHash;
        address token;
        uint256 usdgAmount; // exact USDG credited to keyHash (6 decimals)
        uint256 maxRaw; // most raw token units that may leave the wallet
        bytes32 usageCommitment; // Merkle root of the receipt leaves this charge pays for
        uint256 nonce; // unordered, single use per keyHash
        uint64 epoch; // must equal the session's current epoch
        uint256 deadline; // unix seconds; usable only while now <= deadline <= now + MAX_AUTHORIZATION_WINDOW
        address router; // the only caller that may submit it
    }

    /// @notice A bounded pre-authorization signed once by the session wallet (EIP-712).
    struct AllowanceAuthorization {
        bytes32 keyHash;
        address token;
        uint256 maxRawTotal; // most raw token units all charges under this allowance may spend together
        uint256 maxRawPerCharge; // most raw token units one charge may spend
        uint256 validUntil; // unix seconds; at most MAX_AUTHORIZATION_WINDOW ahead when registered
        uint256 nonce; // sequential per keyHash (allowanceNonces)
        uint64 epoch; // must equal the session's current epoch
        address router; // the only caller that may charge against it
    }

    /// @notice The registered allowance of a key (at most one; a new one replaces it).
    struct Allowance {
        uint256 maxRawTotal;
        uint256 maxRawPerCharge;
        uint256 spentRaw;
        uint256 nonce;
        uint64 validUntil;
        uint64 epoch;
        address router;
    }

    event TokenRegistered(
        address indexed token, address primaryAdapter, address fallbackAdapter, bool enabled
    );
    event SessionOpened(
        bytes32 indexed keyHash, address indexed wallet, address indexed token, uint256 capRawPerDay
    );
    event SessionClosed(bytes32 indexed keyHash, address indexed wallet);
    /// @notice Every outstanding charge signature and the allowance of `keyHash` are void; new ones name `epoch`.
    event AuthorizationsRevoked(bytes32 indexed keyHash, address indexed wallet, uint64 epoch);
    event AllowanceSet(
        bytes32 indexed keyHash,
        address indexed wallet,
        uint256 nonce,
        uint256 maxRawTotal,
        uint256 maxRawPerCharge,
        uint64 validUntil,
        uint64 epoch
    );
    /// @notice Charge notice: what the wallet paid, for which usage, at which fair price, under which nonce
    /// (the charge nonce, or the allowance nonce when `viaAllowance`).
    event PaidWithStock(
        bytes32 indexed keyHash,
        address indexed wallet,
        bytes32 indexed usageCommitment,
        address token,
        uint256 rawSpent,
        uint256 fairPrice18,
        uint256 usdgOwed,
        uint256 nonce,
        bool viaAllowance
    );
    event RouterSet(address indexed router);
    event OracleSet(address indexed oracle);
    event MaxSlipSet(uint16 maxSlipBps);

    error TokenNotEnabled();
    error NoSession();
    error NotSessionWallet();
    error OracleNotOk();
    error CapExceeded();
    error SlippageTooHigh();
    error SwapFailed();
    error NotRouter();
    error InvalidAmount();
    error BadSignature();
    error WrongRouter();
    error WrongToken();
    error StaleEpoch();
    error AuthorizationExpired();
    error AuthorizationWindowTooLong();
    error NonceUsed();
    error InvalidNonce();
    error InvalidCommitment();
    error CommitmentUsed();
    error NoAllowance();
    error InvalidAllowance();
    error AllowanceExceeded();
    error ChargeTooLarge();

    function openSession(bytes32 keyHash, address token, uint256 capRawPerDay) external;
    /// @notice Deactivate the session and revoke every outstanding authorization (one call).
    function closeSession(bytes32 keyHash) external;
    /// @notice Revoke every outstanding charge signature and the allowance, keeping the session open.
    function revokeAuthorizations(bytes32 keyHash) external;

    /// @notice Register a signed allowance (anyone may relay it; the wallet itself may call without a signature).
    function setAllowance(AllowanceAuthorization calldata auth, bytes calldata signature) external;

    /// @notice Router only: settle one charge the session wallet signed. Returns raw token units spent.
    function payCall(ChargeAuthorization calldata auth, bytes calldata signature, uint16 maxSlipBps)
        external
        returns (uint256 rawSpent);

    /// @notice Router only: settle one charge (<= $5) within the key's registered allowance.
    function payCallWithAllowance(
        bytes32 keyHash,
        uint256 usdgOwed,
        bytes32 usageCommitment,
        uint16 maxSlipBps
    ) external returns (uint256 rawSpent);

    /// @notice Raw units needed for `usdgOwed` at fair value before slippage, and the fair price used.
    function quoteRaw(address token, uint256 usdgOwed)
        external
        view
        returns (uint256 rawNeeded, uint256 fairPrice18);

    function sessions(bytes32 keyHash)
        external
        view
        returns (
            address wallet,
            address token,
            uint256 capRawPerDay,
            uint256 spentRawToday,
            uint64 dayStart,
            bool active,
            uint64 epoch
        );
    function allowances(bytes32 keyHash)
        external
        view
        returns (
            uint256 maxRawTotal,
            uint256 maxRawPerCharge,
            uint256 spentRaw,
            uint256 nonce,
            uint64 validUntil,
            uint64 epoch,
            address router
        );
    function tokens(address token)
        external
        view
        returns (bool enabled, address primaryAdapter, address fallbackAdapter);
}

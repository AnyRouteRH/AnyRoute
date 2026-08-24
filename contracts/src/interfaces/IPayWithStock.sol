// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Pay for inference with any registered Stock Token. A wallet opens a capped daily
/// session for an API key; the router batches that key's micro-debts (>= $1 or 24h) and calls
/// payCall, which swaps exactly the USDG owed at Chainlink x uiMultiplier fair value
/// (slippage-bounded, Uniswap V4 first then V3) and credits the key in Credits.
interface IPayWithStock {
    struct Session {
        address wallet;
        address token;
        uint256 capRawPerDay;
        uint256 spentRawToday;
        uint64 dayStart;
        bool active;
    }

    struct TokenConfig {
        bool enabled;
        address primaryAdapter; // Uniswap V4
        address fallbackAdapter; // Uniswap V3 (may be zero)
    }

    event TokenRegistered(address indexed token, address primaryAdapter, address fallbackAdapter, bool enabled);
    event SessionOpened(bytes32 indexed keyHash, address indexed wallet, address indexed token, uint256 capRawPerDay);
    event SessionClosed(bytes32 indexed keyHash, address indexed wallet);
    event PaidWithStock(
        bytes32 indexed keyHash, address indexed token, uint256 rawSpent, uint256 fairPrice18, uint256 usdgOwed
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

    function openSession(bytes32 keyHash, address token, uint256 capRawPerDay) external;
    function closeSession(bytes32 keyHash) external;

    /// @notice Router only. Returns raw token units spent.
    function payCall(bytes32 keyHash, uint256 usdgOwed, uint16 maxSlipBps) external returns (uint256 rawSpent);

    /// @notice Raw units needed for `usdgOwed` at fair value before slippage, and the fair price used.
    function quoteRaw(address token, uint256 usdgOwed) external view returns (uint256 rawNeeded, uint256 fairPrice18);

    function sessions(bytes32 keyHash)
        external
        view
        returns (
            address wallet,
            address token,
            uint256 capRawPerDay,
            uint256 spentRawToday,
            uint64 dayStart,
            bool active
        );
    function tokens(address token) external view returns (bool enabled, address primaryAdapter, address fallbackAdapter);
}

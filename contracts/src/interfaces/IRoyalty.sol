// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Creator royalties for open-weights fine-tunes. The registrar records a creator after
/// the off-chain claim check (Hugging Face attestation / weight fingerprint). Settlement streams
/// USDG per model each period; creators claim any time.
interface IRoyalty {
    event Registered(bytes32 indexed modelId, address indexed creator, uint16 bps);
    event CreatorUpdated(bytes32 indexed modelId, address indexed creator);
    event Streamed(bytes32 indexed modelId, address indexed creator, uint256 amount);
    event Claimed(address indexed creator, address indexed to, uint256 amount);

    error NotRegistrar();
    error NotSettlement();
    error BpsTooHigh();
    error UnknownModel();
    error NotCreator();
    error NothingToClaim();

    function MAX_BPS() external view returns (uint16);
    function register(bytes32 modelId, address creator, uint16 bps) external;
    /// @notice Current creator may hand the royalty to a new address.
    function transferCreator(bytes32 modelId, address newCreator) external;
    /// @notice Pulls `usdg` from msg.sender (settlement).
    function stream(bytes32 modelId, uint256 usdg) external;
    function claim(address to) external returns (uint256);

    function models(bytes32 modelId) external view returns (address creator, uint16 bps, uint256 totalStreamed);
    function claimable(address creator) external view returns (uint256);
}

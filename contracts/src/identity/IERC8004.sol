// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ERC-8004 Identity Registry, as specified (the specification is CC0). The canonical deployment on Robinhood
/// Chain (4663) is an upgradeable proxy at 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 (name "AgentIdentity", symbol
/// "AGENT", version "2.0.0"), checked read-only on 2026-10-02. Anyroute does not own or operate it.
/// @dev Identities are ERC-721 tokens; `register` mints to msg.sender and agent ids start at 0.
interface IERC8004Identity {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );

    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId);
    function register(string calldata agentURI) external returns (uint256 agentId);
    function register() external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata newURI) external;
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);
    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external;
    function getAgentWallet(uint256 agentId) external view returns (address);

    // ERC-721 surface the other registries rely on.
    function ownerOf(uint256 agentId) external view returns (address);
    function getApproved(uint256 agentId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function tokenURI(uint256 agentId) external view returns (string memory);
}

/// @notice ERC-8004 Reputation Registry, as specified. Canonical on Robinhood Chain (4663):
/// 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63, bound to the identity registry above. Anyroute does not operate it.
interface IERC8004Reputation {
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    function getIdentityRegistry() external view returns (address);
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
}

/// @notice ERC-8004 Validation Registry, as specified. The specification marks this part as still under discussion,
/// and no canonical deployment exists on Robinhood Chain (4663) as of 2026-10-02.
interface IERC8004Validation {
    event ValidationRequest(
        address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash
    );
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    function getIdentityRegistry() external view returns (address);
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash)
        external;
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        );
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse);
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes);
    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes);
}

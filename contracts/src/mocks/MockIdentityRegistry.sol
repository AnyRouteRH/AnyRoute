// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC8004Identity} from "../identity/IERC8004.sol";

/// @notice Local and test stand-in for the canonical ERC-8004 identity registry: ERC-721 identities, ids from 0,
/// the same register overloads and events. Not for deployment on a public chain (the canonical one exists there).
contract MockIdentityRegistry is ERC721 {
    uint256 public nextId;
    mapping(uint256 => string) private _uris;
    mapping(uint256 => mapping(string => bytes)) private _metadata;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );

    constructor() ERC721("AgentIdentity", "AGENT") {}

    function register(string calldata agentURI, IERC8004Identity.MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        agentId = _register(agentURI);
        for (uint256 i; i < metadata.length; ++i) {
            require(keccak256(bytes(metadata[i].metadataKey)) != keccak256("agentWallet"), "reserved key");
            _metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
            emit MetadataSet(agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _register(agentURI);
    }

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][metadataKey];
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        return _uris[agentId];
    }

    function _register(string calldata agentURI) private returns (uint256 agentId) {
        agentId = nextId++;
        _mint(msg.sender, agentId);
        _uris[agentId] = agentURI;
        emit Registered(agentId, agentURI, msg.sender);
    }
}

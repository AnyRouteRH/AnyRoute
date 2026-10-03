// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC8004Identity, IERC8004Validation} from "./IERC8004.sol";

/// @title ValidationRegistry
/// @notice An implementation of the ERC-8004 Validation Registry interface (the specification is CC0) for chains where
/// no canonical one is deployed, such as Robinhood Chain on 2026-10-02. Written against the specification's function,
/// event and access rules; the canonical identity registry is the source of agent ownership.
/// @dev No owner, upgrade path, pause or fee. The identity registry is immutable. Only an agent's owner or an
/// ERC-721 approved operator may request validation; only the named validator may respond, with 0..100, any number
/// of times (progressive validation). A request hash names one request forever.
contract ValidationRegistry is IERC8004Validation {
    uint8 public constant MAX_RESPONSE = 100;

    struct Status {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bool responded;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
    }

    IERC8004Identity public immutable identityRegistry;

    mapping(bytes32 requestHash => Status) private _status;
    mapping(uint256 agentId => bytes32[]) private _agentValidations;
    mapping(address validator => bytes32[]) private _validatorRequests;

    error ZeroAddress();
    error NotAContract();
    error ZeroRequestHash();
    error RequestExists();
    error UnknownRequest();
    error NotAgentOperator();
    error NotValidator();
    error ResponseOutOfRange();

    constructor(address identityRegistry_) {
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        if (identityRegistry_.code.length == 0) revert NotAContract();
        identityRegistry = IERC8004Identity(identityRegistry_);
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    /// @notice Ask `validatorAddress` to validate agent `agentId`. `requestURI` points at the data to check (off chain)
    /// and `requestHash` commits to it. Reverts for an unknown agent id (ownerOf reverts).
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash)
        external
    {
        if (validatorAddress == address(0)) revert ZeroAddress();
        if (requestHash == bytes32(0)) revert ZeroRequestHash();
        if (_status[requestHash].validatorAddress != address(0)) revert RequestExists();
        address owner = identityRegistry.ownerOf(agentId);
        if (
            msg.sender != owner && !identityRegistry.isApprovedForAll(owner, msg.sender)
                && identityRegistry.getApproved(agentId) != msg.sender
        ) revert NotAgentOperator();
        Status storage s = _status[requestHash];
        s.validatorAddress = validatorAddress;
        s.agentId = agentId;
        s.lastUpdate = block.timestamp;
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);
        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    /// @notice The named validator's answer: 0 (failed) to 100 (passed). Later calls replace the stored answer.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Status storage s = _status[requestHash];
        if (s.validatorAddress == address(0)) revert UnknownRequest();
        if (msg.sender != s.validatorAddress) revert NotValidator();
        if (response > MAX_RESPONSE) revert ResponseOutOfRange();
        s.response = response;
        s.responded = true;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;
        emit ValidationResponse(s.validatorAddress, s.agentId, requestHash, response, responseURI, responseHash, tag);
    }

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
        )
    {
        Status storage s = _status[requestHash];
        if (s.validatorAddress == address(0)) revert UnknownRequest();
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    /// @notice Whether the validator has answered at least once (a stored 0 is then a real "failed").
    function hasResponse(bytes32 requestHash) external view returns (bool) {
        return _status[requestHash].responded;
    }

    /// @notice Count and integer average of answered validations of `agentId`, optionally limited to the listed
    /// validators and to one tag (an empty tag matches every tag). Unanswered requests are not counted.
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse)
    {
        bytes32[] storage hashes = _agentValidations[agentId];
        bool anyTag = bytes(tag).length == 0;
        bytes32 tagHash = keccak256(bytes(tag));
        uint256 sum;
        for (uint256 i; i < hashes.length; ++i) {
            Status storage s = _status[hashes[i]];
            if (!s.responded) continue;
            if (validatorAddresses.length != 0 && !_listed(validatorAddresses, s.validatorAddress)) continue;
            if (!anyTag && keccak256(bytes(s.tag)) != tagHash) continue;
            ++count;
            sum += s.response;
        }
        if (count != 0) averageResponse = uint8(sum / count);
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    function _listed(address[] calldata list, address who) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == who) return true;
        }
        return false;
    }
}

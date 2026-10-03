// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC8004Identity, IERC8004Reputation} from "../../src/identity/IERC8004.sol";
import {ValidationRegistry} from "../../src/identity/ValidationRegistry.sol";
import {DeployIdentity} from "../../script/DeployIdentity.s.sol";

interface IVersioned {
    function getVersion() external view returns (string memory);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
}

/// @notice Read-only checks of the canonical ERC-8004 registries on Robinhood Chain (skipped without RHC_RPC_URL),
/// and the ValidationRegistry bound to the real identity registry on a fork.
contract Erc8004ForkTest is Test {
    DeployIdentity script;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        script = new DeployIdentity();
    }

    function test_canonicalRegistriesExist() public view {
        assertEq(block.chainid, 4663);
        address identity = script.CANONICAL_IDENTITY_REGISTRY();
        address reputation = script.CANONICAL_REPUTATION_REGISTRY();
        assertGt(identity.code.length, 0);
        assertGt(reputation.code.length, 0);
        assertEq(IVersioned(identity).name(), "AgentIdentity");
        assertEq(IVersioned(identity).symbol(), "AGENT");
        assertEq(IERC8004Reputation(reputation).getIdentityRegistry(), identity);
        assertGt(bytes(IVersioned(identity).getVersion()).length, 0);
    }

    function test_validationAgainstTheCanonicalIdentityRegistry() public {
        IERC8004Identity identity = IERC8004Identity(script.CANONICAL_IDENTITY_REGISTRY());
        ValidationRegistry registry = new ValidationRegistry(address(identity));
        address agentOwner = makeAddr("fork-agent-owner");
        vm.prank(agentOwner);
        uint256 agentId = identity.register("https://anyroute.example/api/v1/agents/identity/fork.json");
        assertEq(identity.ownerOf(agentId), agentOwner);
        address validator = makeAddr("validator");
        vm.prank(agentOwner);
        registry.validationRequest(validator, agentId, "https://anyroute.example/t/1", keccak256("fork"));
        vm.prank(validator);
        registry.validationResponse(keccak256("fork"), 100, "", bytes32(0), "anyroute-track-record");
        (,, uint8 response,,,) = registry.getValidationStatus(keccak256("fork"));
        assertEq(response, 100);
    }
}

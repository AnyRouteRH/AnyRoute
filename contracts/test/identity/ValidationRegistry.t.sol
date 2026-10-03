// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ValidationRegistry} from "../../src/identity/ValidationRegistry.sol";
import {IERC8004Identity, IERC8004Validation} from "../../src/identity/IERC8004.sol";
import {MockIdentityRegistry} from "../../src/mocks/MockIdentityRegistry.sol";
import {DeployIdentity} from "../../script/DeployIdentity.s.sol";

contract ValidationRegistryTest is Test {
    MockIdentityRegistry identity;
    ValidationRegistry registry;
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address validator = makeAddr("validator");
    address other = makeAddr("other");
    uint256 agentId;

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

    function setUp() public {
        identity = new MockIdentityRegistry();
        registry = new ValidationRegistry(address(identity));
        vm.prank(owner);
        agentId = identity.register("https://anyroute.example/api/v1/agents/identity/a.json");
    }

    function _request(bytes32 h) internal {
        vm.prank(owner);
        registry.validationRequest(validator, agentId, "https://anyroute.example/track-record/1", h);
    }

    function test_constructorRejectsZeroAndCodeless() public {
        vm.expectRevert(ValidationRegistry.ZeroAddress.selector);
        new ValidationRegistry(address(0));
        vm.expectRevert(ValidationRegistry.NotAContract.selector);
        new ValidationRegistry(other);
        assertEq(registry.getIdentityRegistry(), address(identity));
    }

    function test_ownerRequestIsRecordedAndIndexed() public {
        bytes32 h = keccak256("request-1");
        vm.expectEmit(address(registry));
        emit ValidationRequest(validator, agentId, "https://anyroute.example/track-record/1", h);
        _request(h);
        (address v, uint256 id, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate) =
            registry.getValidationStatus(h);
        assertEq(v, validator);
        assertEq(id, agentId);
        assertEq(response, 0);
        assertEq(responseHash, bytes32(0));
        assertEq(tag, "");
        assertEq(lastUpdate, block.timestamp);
        assertFalse(registry.hasResponse(h));
        assertEq(registry.getAgentValidations(agentId).length, 1);
        assertEq(registry.getValidatorRequests(validator)[0], h);
    }

    function test_onlyOwnerOrApprovedOperatorMayRequest() public {
        vm.prank(other);
        vm.expectRevert(ValidationRegistry.NotAgentOperator.selector);
        registry.validationRequest(validator, agentId, "uri", keccak256("x"));

        vm.prank(owner);
        identity.setApprovalForAll(operator, true);
        vm.prank(operator);
        registry.validationRequest(validator, agentId, "uri", keccak256("by-operator"));

        vm.prank(owner);
        identity.approve(other, agentId);
        vm.prank(other);
        registry.validationRequest(validator, agentId, "uri", keccak256("by-approved"));
        assertEq(registry.getAgentValidations(agentId).length, 2);
    }

    function test_requestRejectsUnknownAgentDuplicateZeroHashAndZeroValidator() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        registry.validationRequest(validator, 99, "uri", keccak256("x"));

        vm.prank(owner);
        vm.expectRevert(ValidationRegistry.ZeroRequestHash.selector);
        registry.validationRequest(validator, agentId, "uri", bytes32(0));

        vm.prank(owner);
        vm.expectRevert(ValidationRegistry.ZeroAddress.selector);
        registry.validationRequest(address(0), agentId, "uri", keccak256("x"));

        _request(keccak256("dup"));
        vm.prank(owner);
        vm.expectRevert(ValidationRegistry.RequestExists.selector);
        registry.validationRequest(other, agentId, "uri", keccak256("dup"));
    }

    function test_onlyTheNamedValidatorRespondsWithinRange() public {
        bytes32 h = keccak256("r");
        vm.expectRevert(ValidationRegistry.UnknownRequest.selector);
        registry.validationResponse(h, 100, "", bytes32(0), "");
        _request(h);
        vm.prank(owner);
        vm.expectRevert(ValidationRegistry.NotValidator.selector);
        registry.validationResponse(h, 100, "", bytes32(0), "");
        vm.prank(validator);
        vm.expectRevert(ValidationRegistry.ResponseOutOfRange.selector);
        registry.validationResponse(h, 101, "", bytes32(0), "");

        vm.expectEmit(address(registry));
        emit ValidationResponse(validator, agentId, h, 100, "https://r", keccak256("doc"), "anyroute-track-record");
        vm.prank(validator);
        registry.validationResponse(h, 100, "https://r", keccak256("doc"), "anyroute-track-record");
        assertTrue(registry.hasResponse(h));

        vm.warp(block.timestamp + 1 days);
        vm.prank(validator);
        registry.validationResponse(h, 40, "https://r2", keccak256("doc2"), "anyroute-track-record");
        (,, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate) = registry.getValidationStatus(h);
        assertEq(response, 40);
        assertEq(responseHash, keccak256("doc2"));
        assertEq(tag, "anyroute-track-record");
        assertEq(lastUpdate, block.timestamp);
    }

    function test_unknownStatusReverts() public {
        vm.expectRevert(ValidationRegistry.UnknownRequest.selector);
        registry.getValidationStatus(keccak256("missing"));
    }

    function test_summaryCountsAnsweredRequestsByValidatorAndTag() public {
        address second = makeAddr("second");
        _request(keccak256("a"));
        _request(keccak256("b"));
        vm.prank(owner);
        registry.validationRequest(second, agentId, "uri", keccak256("c"));
        _request(keccak256("unanswered"));
        vm.prank(validator);
        registry.validationResponse(keccak256("a"), 100, "", bytes32(0), "track");
        vm.prank(validator);
        registry.validationResponse(keccak256("b"), 51, "", bytes32(0), "other");
        vm.prank(second);
        registry.validationResponse(keccak256("c"), 0, "", bytes32(0), "track");

        address[] memory none = new address[](0);
        (uint64 count, uint8 avg) = registry.getSummary(agentId, none, "");
        assertEq(count, 3);
        assertEq(avg, 50); // (100 + 51 + 0) / 3
        (count, avg) = registry.getSummary(agentId, none, "track");
        assertEq(count, 2);
        assertEq(avg, 50);
        address[] memory only = new address[](1);
        only[0] = validator;
        (count, avg) = registry.getSummary(agentId, only, "");
        assertEq(count, 2);
        assertEq(avg, 75);
        (count, avg) = registry.getSummary(agentId + 1, none, "");
        assertEq(count, 0);
        assertEq(avg, 0);
    }

    function testFuzz_responseRange(uint8 response) public {
        bytes32 h = keccak256(abi.encode(response));
        _request(h);
        vm.prank(validator);
        if (response > 100) vm.expectRevert(ValidationRegistry.ResponseOutOfRange.selector);
        registry.validationResponse(h, response, "", bytes32(0), "");
        if (response <= 100) {
            (,, uint8 stored,,,) = registry.getValidationStatus(h);
            assertEq(stored, response);
        }
    }

    function test_transferredIdentityMovesRequestRights() public {
        vm.prank(owner);
        identity.transferFrom(owner, other, agentId);
        vm.prank(owner);
        vm.expectRevert(ValidationRegistry.NotAgentOperator.selector);
        registry.validationRequest(validator, agentId, "uri", keccak256("old-owner"));
        vm.prank(other);
        registry.validationRequest(validator, agentId, "uri", keccak256("new-owner"));
    }
}

contract DeployIdentityTest is Test {
    DeployIdentity script;
    MockIdentityRegistry identity;
    TimelockController timelock;
    address safe = makeAddr("ownerSafe");

    function setUp() public {
        script = new DeployIdentity();
        identity = new MockIdentityRegistry();
        address[] memory roles = new address[](1);
        roles[0] = safe;
        timelock = new TimelockController(1 days, roles, roles, address(0));
        // Foundry provides the deterministic deployment proxy; install the same runtime code if it is absent.
        if (script.CREATE2_DEPLOYER().code.length == 0) {
            vm.etch(
                script.CREATE2_DEPLOYER(),
                hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
            );
        }
    }

    function test_timelockPlanDeploysTheOwnerlessRegistryAfterTheDelay() public {
        DeployIdentity.Plan memory p = script.plan(address(identity), address(timelock), safe);
        assertEq(p.delay, 1 days);
        assertEq(p.predicted.code.length, 0);
        (bool ok,) = address(timelock).call(p.scheduleCall);
        assertFalse(ok, "only the Safe may schedule");
        vm.prank(safe);
        (ok,) = address(timelock).call(p.scheduleCall);
        assertTrue(ok);
        assertTrue(timelock.isOperationPending(p.operationId));
        vm.prank(safe);
        (ok,) = address(timelock).call(p.executeCall);
        assertFalse(ok, "not before the delay");
        vm.warp(block.timestamp + 1 days);
        vm.prank(safe);
        (ok,) = address(timelock).call(p.executeCall);
        assertTrue(ok);
        assertGt(p.predicted.code.length, 0);
        assertEq(ValidationRegistry(p.predicted).getIdentityRegistry(), address(identity));
        vm.expectRevert("DeployIdentity: registry already deployed");
        script.plan(address(identity), address(timelock), safe);
    }

    function test_planRefusesWeakGovernance() public {
        vm.expectRevert("DeployIdentity: OWNER_SAFE is not a timelock proposer");
        script.plan(address(identity), address(timelock), makeAddr("stranger"));
        address[] memory roles = new address[](1);
        roles[0] = safe;
        TimelockController fast = new TimelockController(1 hours, roles, roles, address(0));
        vm.expectRevert("DeployIdentity: timelock delay below one day");
        script.plan(address(identity), address(fast), safe);
        vm.expectRevert("DeployIdentity: identity registry has no code");
        script.plan(makeAddr("nothing"), address(timelock), safe);
    }

    function test_batchFilesNameTheTimelockCalls() public {
        DeployIdentity.Plan memory p = script.plan(address(identity), address(timelock), safe);
        string memory path = "deployments/test-validation-registry.json";
        vm.createDir("deployments", true);
        script.writeBatch(p, path);
        string memory schedule = vm.readFile(path);
        assertEq(vm.parseJsonAddress(schedule, ".transactions[0].to"), address(timelock));
        assertEq(vm.parseJsonBytes(schedule, ".transactions[0].data"), p.scheduleCall);
        assertEq(vm.parseJsonAddress(schedule, ".anyroute.validationRegistry"), p.predicted);
        assertEq(vm.parseJsonAddress(schedule, ".meta.createdFromSafeAddress"), safe);
        string memory execute = vm.readFile("deployments/test-validation-registry-execute.json");
        assertEq(vm.parseJsonBytes(execute, ".transactions[0].data"), p.executeCall);
        vm.removeFile(path);
        vm.removeFile("deployments/test-validation-registry-execute.json");
    }

    function test_localRunRequiresTheFlagAndRefusesRobinhoodChain() public {
        vm.setEnv("AGENT_IDENTITY_ENABLED", "false");
        vm.expectRevert("AGENT_IDENTITY_ENABLED is false");
        script.run();
        vm.setEnv("AGENT_IDENTITY_ENABLED", "true");
        address registry = script.run();
        assertGt(registry.code.length, 0);
        vm.chainId(4663);
        vm.expectRevert("Robinhood Chain deployments go through IDENTITY_TIMELOCK");
        script.run();
        vm.setEnv("AGENT_IDENTITY_ENABLED", "false");
    }
}

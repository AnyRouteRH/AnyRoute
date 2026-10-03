// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ValidationRegistry} from "../src/identity/ValidationRegistry.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";

/// @title DeployIdentity
/// @notice Opt-in deployment of the ERC-8004 ValidationRegistry. Nothing here touches the canonical identity and
/// reputation registries, which already exist on Robinhood Chain (4663) and are not Anyroute's.
///
/// Robinhood Chain (timelock mode, IDENTITY_TIMELOCK set): no transaction is sent. The script checks the existing
/// TimelockController (OWNER_SAFE must hold the proposer and executor roles, delay at least one day) and writes a
/// Safe Transaction Builder batch: OWNER_SAFE -> timelock.schedule(CREATE2 deployer, salt || initcode), and an
/// "-execute" batch for after the delay. The registry address is fixed by the salt and is printed and recorded.
///   AGENT_IDENTITY_ENABLED=true IDENTITY_TIMELOCK=0x... OWNER_SAFE=0x... \
///   forge script script/DeployIdentity.s.sol --rpc-url rhc
///   Optional: IDENTITY_REGISTRY (default the canonical 0x8004A169...a432), IDENTITY_BATCH_PATH (under ./deployments).
///
/// Local (no IDENTITY_TIMELOCK, any chain but 4663): deploys a MockIdentityRegistry unless IDENTITY_REGISTRY is set,
/// then the ValidationRegistry. It records transactions only when IDENTITY_BROADCAST=true.
contract DeployIdentity is Script {
    address public constant CANONICAL_IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address public constant CANONICAL_REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    /// @dev The deterministic deployment proxy (present on 4663; checked with eth_getCode on 2026-10-02).
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 public constant SALT = keccak256("anyroute.erc8004.validation-registry.v1");
    uint256 public constant RHC_CHAIN_ID = 4663;
    uint256 public constant MIN_DELAY = 1 days;

    struct Plan {
        address identity;
        address timelock;
        address ownerSafe;
        uint256 delay;
        address predicted;
        bytes payload; // salt || initcode, the CREATE2 deployer's calldata
        bytes32 operationId;
        bytes scheduleCall; // timelock.schedule(...)
        bytes executeCall; // timelock.execute(...)
    }

    function run() external returns (address registry) {
        require(vm.envOr("AGENT_IDENTITY_ENABLED", false), "AGENT_IDENTITY_ENABLED is false");
        address timelock = vm.envOr("IDENTITY_TIMELOCK", address(0));
        if (timelock != address(0)) {
            address identity = vm.envOr("IDENTITY_REGISTRY", CANONICAL_IDENTITY_REGISTRY);
            Plan memory p = plan(identity, timelock, vm.envAddress("OWNER_SAFE"));
            string memory path = vm.envOr(
                "IDENTITY_BATCH_PATH",
                string.concat("deployments/", vm.toString(block.chainid), "-validation-registry.json")
            );
            writeBatch(p, path);
            console2.log("ValidationRegistry (after the timelock executes)", p.predicted);
            return p.predicted;
        }
        require(block.chainid != RHC_CHAIN_ID, "Robinhood Chain deployments go through IDENTITY_TIMELOCK");
        bool broadcast = vm.envOr("IDENTITY_BROADCAST", false);
        address existing = vm.envOr("IDENTITY_REGISTRY", address(0));
        if (broadcast) vm.startBroadcast();
        address identityRegistry = existing == address(0) ? address(new MockIdentityRegistry()) : existing;
        registry = address(new ValidationRegistry(identityRegistry));
        if (broadcast) vm.stopBroadcast();
        console2.log("IdentityRegistry", identityRegistry);
        console2.log("ValidationRegistry", registry);
    }

    /// @notice The timelock operation that deploys the registry, after checking the timelock and the identity registry.
    function plan(address identity, address timelock, address ownerSafe) public view returns (Plan memory p) {
        require(identity.code.length != 0, "DeployIdentity: identity registry has no code");
        require(CREATE2_DEPLOYER.code.length != 0, "DeployIdentity: CREATE2 deployer missing");
        require(timelock.code.length != 0, "DeployIdentity: timelock has no code");
        require(ownerSafe != address(0), "DeployIdentity: OWNER_SAFE required");
        TimelockController t = TimelockController(payable(timelock));
        require(t.hasRole(t.PROPOSER_ROLE(), ownerSafe), "DeployIdentity: OWNER_SAFE is not a timelock proposer");
        require(
            t.hasRole(t.EXECUTOR_ROLE(), ownerSafe) || t.hasRole(t.EXECUTOR_ROLE(), address(0)),
            "DeployIdentity: OWNER_SAFE cannot execute"
        );
        p.delay = t.getMinDelay();
        require(p.delay >= MIN_DELAY, "DeployIdentity: timelock delay below one day");
        p.identity = identity;
        p.timelock = timelock;
        p.ownerSafe = ownerSafe;
        bytes memory initCode = abi.encodePacked(type(ValidationRegistry).creationCode, abi.encode(identity));
        p.payload = abi.encodePacked(SALT, initCode);
        p.predicted = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, SALT, keccak256(initCode)))))
        );
        require(p.predicted.code.length == 0, "DeployIdentity: registry already deployed");
        p.operationId = t.hashOperation(CREATE2_DEPLOYER, 0, p.payload, bytes32(0), SALT);
        p.scheduleCall = abi.encodeCall(TimelockController.schedule, (CREATE2_DEPLOYER, 0, p.payload, bytes32(0), SALT, p.delay));
        p.executeCall = abi.encodeCall(TimelockController.execute, (CREATE2_DEPLOYER, 0, p.payload, bytes32(0), SALT));
    }

    /// @notice Write the schedule batch to `path` and the execute batch beside it (`-execute.json`).
    function writeBatch(Plan memory p, string memory path) public {
        vm.writeFile(path, _batch(p, "step 1/2: schedule", p.scheduleCall, true));
        vm.writeFile(_executePath(path), _batch(p, "step 2/2: execute", p.executeCall, false));
    }

    function _batch(Plan memory p, string memory step, bytes memory call, bool withRecord)
        internal
        view
        returns (string memory)
    {
        return string.concat(
            "{",
            _kvS("version", "1.0"),
            ",",
            _kvS("chainId", vm.toString(block.chainid)),
            ",\"meta\":",
            _meta(p, step),
            ",\"transactions\":[",
            _tx(p.timelock, call),
            "]",
            withRecord ? _record(p) : "",
            "}"
        );
    }

    function _meta(Plan memory p, string memory step) internal pure returns (string memory) {
        string memory description = string.concat(
            "OWNER_SAFE schedules, then executes no earlier than ",
            vm.toString(p.delay),
            "s later, a CREATE2 deployment of the ownerless ValidationRegistry bound to identity registry ",
            vm.toString(p.identity),
            "."
        );
        return string.concat(
            "{",
            _kvS("name", string.concat("Anyroute: deploy the ERC-8004 ValidationRegistry (", step, ")")),
            ",",
            _kvS("description", description),
            ",",
            _kvS("txBuilderVersion", "1.16.5"),
            ",",
            _kvS("createdFromSafeAddress", vm.toString(p.ownerSafe)),
            ",",
            _kvS("createdFromOwnerAddress", ""),
            "}"
        );
    }

    function _tx(address to, bytes memory call) internal pure returns (string memory) {
        return string.concat(
            "{",
            _kvS("to", vm.toString(to)),
            ",",
            _kvS("value", "0"),
            ",",
            _kvS("data", vm.toString(call)),
            ",\"contractMethod\":null,\"contractInputsValues\":null}"
        );
    }

    function _record(Plan memory p) internal pure returns (string memory) {
        string memory addresses = string.concat(
            _kvS("validationRegistry", vm.toString(p.predicted)),
            ",",
            _kvS("identityRegistry", vm.toString(p.identity)),
            ",",
            _kvS("timelock", vm.toString(p.timelock)),
            ",",
            _kvS("create2Deployer", vm.toString(CREATE2_DEPLOYER))
        );
        return string.concat(
            ",\"anyroute\":{",
            addresses,
            ",",
            _kvS("salt", vm.toString(SALT)),
            ",",
            _kvS("operationId", vm.toString(p.operationId)),
            ",\"minDelay\":",
            vm.toString(p.delay),
            "}"
        );
    }

    function _executePath(string memory batchPath) internal pure returns (string memory) {
        bytes memory b = bytes(batchPath);
        require(b.length > 5, "DeployIdentity: batch path must end in .json");
        bytes memory stem = new bytes(b.length - 5);
        for (uint256 i; i < stem.length; ++i) {
            stem[i] = b[i];
        }
        return string.concat(string(stem), "-execute.json");
    }

    function _kvS(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":\"", v, "\"");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgreementEscrow} from "../src/agents/AgreementEscrow.sol";
import {DisputeOracle} from "../src/agents/DisputeOracle.sol";

/// @notice Opt-in deployment. Broadcasting is an explicit operator choice outside this script.
contract DeployAgreements is Script {
    function run() external returns (AgreementEscrow escrow, DisputeOracle oracle) {
        require(vm.envOr("AGENT_AGREEMENTS_ENABLED", false), "AGENT_AGREEMENTS_ENABLED is false");
        address owner = vm.envAddress("OWNER");
        address[] memory signers = vm.envAddress("JURY_SIGNERS", ",");
        address panel = vm.envAddress("PANEL");
        IERC20 usdg = IERC20(vm.envAddress("USDG"));
        uint256 theta = vm.envOr("JURY_THRESHOLD", signers.length / 2 + 1);
        uint256 reviewWindow = vm.envOr("AGREEMENT_REVIEW_WINDOW", uint256(3 days));
        uint256 timeoutDays = vm.envOr("DISPUTE_TIMEOUT_DAYS", uint256(30));
        require(timeoutDays >= 7 && timeoutDays <= 180, "DISPUTE_TIMEOUT_DAYS must be 7..180");
        bool broadcast = vm.envOr("AGREEMENTS_BROADCAST", false);
        if (broadcast) vm.startBroadcast();
        oracle = new DisputeOracle(owner, signers, theta, panel);
        escrow = new AgreementEscrow(usdg, reviewWindow, timeoutDays * 1 days);
        if (broadcast) vm.stopBroadcast();
        console2.log("AgreementEscrow", address(escrow));
        console2.log("DisputeOracle", address(oracle));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {Credits} from "../src/Credits.sol";
import {CallPay} from "../src/CallPay.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {Royalty} from "../src/Royalty.sol";
import {ProviderBond} from "../src/ProviderBond.sol";
import {AnyrStaking} from "../src/AnyrStaking.sol";
import {PayWithStock} from "../src/PayWithStock.sol";
import {AnyrPaymaster} from "../src/AnyrPaymaster.sol";
import {ChainlinkStockOracle} from "../src/oracle/ChainlinkStockOracle.sol";
import {UniswapV4Adapter} from "../src/adapters/UniswapV4Adapter.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";

/// @notice Runs the MOCK=1 (local) deployment in-process and checks every piece of wiring.
contract DeployLocalTest is Test {
    Deploy script;
    Deploy.Deployed d;
    Deploy.Roles r;
    address deployer;

    function setUp() public {
        script = new Deploy();
        Deploy.Params memory p = script.localParams();
        p.outPath = ""; // artifacts are exercised in test_localArtifact
        deployer = vm.addr(p.deployerKey);
        vm.deal(deployer, 100 ether);
        script.deployLocal(p, script.localRoles());
        d = script.deployed();
        r = script.roles();
    }

    function _owned() internal view returns (address[] memory) {
        return script.ownedContracts();
    }

    function test_ownershipIsDeployerWithoutTimelock() public view {
        address[] memory owned = _owned();
        assertEq(owned.length, 10);
        for (uint256 i; i < owned.length; ++i) {
            assertEq(Ownable2Step(owned[i]).owner(), deployer, "owner");
            assertEq(Ownable2Step(owned[i]).pendingOwner(), address(0), "no pending owner");
        }
        assertEq(d.timelock, address(0));
        assertEq(d.uniswapV3Adapter, address(0));
    }

    function test_rolesAreAnvilAccounts() public view {
        Deploy.Roles memory def = script.localRoles();
        assertEq(r.router, def.router);
        assertEq(r.router, 0x70997970C51812dc3A010C7d01b50e0d17dc79C8); // anvil #1
        assertEq(r.settlement, 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC); // anvil #2
        assertEq(r.anchorer, 0x90F79bf6EB2c4f870365E785982E1f101E93b906); // anvil #3
        assertEq(r.slasher, 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65); // anvil #4
        assertEq(r.paymasterSigner, 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc); // anvil #5
        assertEq(r.keeper, 0x976EA74026E726554dB657fA54763abd0C3a0aa9); // anvil #6
        assertEq(deployer, 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266); // anvil #0
    }

    function test_roleWiring() public view {
        assertTrue(Credits(d.credits).isCreditor(d.payWithStock), "creditor");
        assertEq(Credits(d.credits).settlement(), r.settlement);
        assertEq(Credits(d.credits).usdg(), d.usdg);
        assertEq(CallPay(d.callPay).treasury(), r.callPayTreasury);
        assertEq(ReceiptAnchor(d.receiptAnchor).anchorer(), r.anchorer);
        assertEq(Royalty(d.royalty).registrar(), r.registrar);
        assertEq(Royalty(d.royalty).settlement(), r.settlement);
        assertEq(ProviderBond(d.providerBond).slasher(), r.slasher);
        assertEq(ProviderBond(d.providerBond).refundPool(), r.refundPool);
        assertEq(AnyrStaking(d.anyrStaking).keeper(), r.keeper);
        assertEq(AnyrStaking(d.anyrStaking).opsWallet(), r.opsWallet);
        assertEq(address(AnyrStaking(d.anyrStaking).adapter()), d.buybackAdapter);
        assertEq(address(AnyrStaking(d.anyrStaking).anyr()), d.anyrToken);
        assertEq(PayWithStock(d.payWithStock).router(), r.router);
        assertEq(address(PayWithStock(d.payWithStock).credits()), d.credits);
        assertEq(address(PayWithStock(d.payWithStock).oracle()), d.stockOracle);
        assertEq(address(PayWithStock(d.payWithStock).usdg()), d.usdg);
        assertEq(ChainlinkStockOracle(d.stockOracle).guardian(), deployer);
        assertEq(AnyrPaymaster(payable(d.paymaster)).verifyingSigner(), r.paymasterSigner);
        assertEq(address(AnyrPaymaster(payable(d.paymaster)).entryPoint()), d.entryPoint);
        assertEq(AnyrPaymaster(payable(d.paymaster)).getDeposit(), 10 ether);
    }
}

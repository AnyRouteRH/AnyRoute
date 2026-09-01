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

    function test_adapterCallers() public view {
        UniswapV4Adapter v4 = UniswapV4Adapter(payable(d.uniswapV4Adapter));
        assertTrue(v4.isCaller(d.payWithStock));
        assertTrue(v4.isCaller(d.anyrStaking));
        assertFalse(v4.isCaller(deployer));
        assertEq(address(v4.poolManager()), d.poolManager);
    }

    function test_tokenRegisteredAndOracleOk() public view {
        (bool enabled, address primary, address fallbackAdapter) =
            PayWithStock(d.payWithStock).tokens(d.mockNvda);
        assertTrue(enabled);
        assertEq(primary, d.mockSwapAdapter);
        assertEq(fallbackAdapter, address(0));
        (uint256 price, bool ok) = ChainlinkStockOracle(d.stockOracle).fairPrice(d.mockNvda);
        assertTrue(ok);
        assertEq(price, 225e18);
        ChainlinkStockOracle.FeedConfig memory c = ChainlinkStockOracle(d.stockOracle).configOf(d.mockNvda);
        assertEq(c.maxStaleness, 302_400);
        assertFalse(c.applyMultiplier);
        assertEq(script.stockCount(), 1);
    }

    function test_balancesFunded() public view {
        assertEq(IERC20(d.usdg).balanceOf(d.mockSwapAdapter), 10_000_000e6);
        assertEq(IERC20(d.anyrToken).balanceOf(d.buybackAdapter), 10_000_000e18);
        address[3] memory funded = [
            0x14dC79964da2C08b23698B3D3cc7Ca32193d9955, // anvil #7
            0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f, // anvil #8
            0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 // anvil #9
        ];
        for (uint256 i; i < 3; ++i) {
            assertEq(IERC20(d.usdg).balanceOf(funded[i]), 1_000_000e6);
            assertEq(IERC20(d.mockNvda).balanceOf(funded[i]), 1_000e18);
        }
    }

    /// @dev The local stack is usable end-to-end: session -> router payCall -> Credits balance.
    function test_localPayWithStockEndToEnd() public {
        address wallet = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955; // anvil #7
        bytes32 keyHash = keccak256(abi.encodePacked(makeAddr("apiKeyAddress")));
        vm.startPrank(wallet);
        IERC20(d.mockNvda).approve(d.payWithStock, type(uint256).max);
        PayWithStock(d.payWithStock).openSession(keyHash, d.mockNvda, 10e18);
        vm.stopPrank();

        vm.prank(r.router);
        uint256 spent = PayWithStock(d.payWithStock).payCall(keyHash, 5e6, 100);
        assertEq(spent, uint256(5e18) / 225 + 1); // ceil(5 / 225 NVDA)
        assertEq(Credits(d.credits).deposited(keyHash), 5e6);
        assertEq(IERC20(d.usdg).balanceOf(d.credits), 5e6);
    }

    function test_localArtifact() public {
        Deploy s2 = new Deploy();
        Deploy.Params memory p = s2.localParams();
        p.outPath = "deployments/test-local-artifact.json";
        s2.deployLocal(p, s2.localRoles());
        Deploy.Deployed memory d2 = s2.deployed();

        string memory json = vm.readFile(p.outPath);
        vm.removeFile(p.outPath);
        assertEq(vm.parseJsonString(json, ".schema"), "anyroute.deployments/v1");
        assertEq(vm.parseJsonString(json, ".mode"), "local");
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonAddress(json, ".owner"), deployer);
        assertEq(vm.parseJsonAddress(json, ".pendingOwner"), address(0));
        assertEq(vm.parseJsonAddress(json, ".contracts.credits"), d2.credits);
        assertEq(vm.parseJsonAddress(json, ".contracts.payWithStock"), d2.payWithStock);
        assertEq(vm.parseJsonAddress(json, ".contracts.paymaster"), d2.paymaster);
        assertEq(vm.parseJsonAddress(json, ".contracts.entryPoint"), d2.entryPoint);
        assertEq(vm.parseJsonAddress(json, ".contracts.usdg"), d2.usdg);
        assertEq(vm.parseJsonAddress(json, ".roles.router"), r.router);
        assertEq(vm.parseJsonAddress(json, ".roles.adapterCallers[1]"), d2.anyrStaking);
        assertEq(vm.parseJsonAddress(json, ".roles.creditors[0]"), d2.payWithStock);
        assertEq(vm.parseJsonString(json, ".stockTokens[0].symbol"), "NVDA");
        assertEq(vm.parseJsonAddress(json, ".stockTokens[0].address"), d2.mockNvda);
        assertEq(vm.parseJsonUint(json, ".stockTokens[0].decimals"), 18);
        assertEq(vm.parseJsonAddress(json, ".mocks.nvdaFeed"), d2.mockNvdaFeed);
        assertEq(vm.parseJsonAddress(json, ".mocks.swapAdapter"), d2.mockSwapAdapter);
        assertEq(vm.parseJsonString(json, ".params.paymasterDeposit"), "10000000000000000000");
    }
}

/// @notice Production-mode deployment against a Robinhood Chain fork (skipped unless RHC_RPC_URL is set), including
/// the Safe -> timelock acceptOwnership batch replayed from the written JSON.
contract DeployProductionForkTest is Test {
    Deploy script;
    Deploy.Deployed d;
    Deploy.Roles r;
    address deployer;
    string constant OUT = "deployments/test-fork-prod.json";
    string constant BATCH = "deployments/test-fork-prod-accept.json";

    function setUp() public {
        string memory rpc = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        script = new Deploy();

        Deploy.Params memory p;
        p.deployerKey = uint256(keccak256("anyroute.fork.deployer"));
        p.configPath = "../config/rhc-mainnet.json";
        // artifacts are written by test_fork_productionWiringAndTimelockHandover only (tests run in parallel)
        p.paymasterDailyCap = 0.01 ether;
        p.paymasterDeposit = 0.05 ether;
        p.paymasterStake = 0.05 ether;
        p.paymasterUnstakeDelay = 1 days;
        p.wethUsdgFee = 100;
        deployer = vm.addr(p.deployerKey);
        vm.deal(deployer, 1 ether);

        Deploy.Roles memory roles;
        roles.ownerSafe = makeAddr("ownerSafe");
        roles.slasher = makeAddr("slasherSafe");
        roles.router = makeAddr("router");
        roles.settlement = makeAddr("settlement");
        roles.anchorer = makeAddr("anchorer");
        roles.registrar = roles.router;
        roles.keeper = makeAddr("keeper");
        roles.opsWallet = makeAddr("ops");
        roles.paymasterSigner = makeAddr("pmSigner");
        roles.refundPool = makeAddr("refundPool");
        roles.callPayTreasury = makeAddr("treasury");
        roles.guardian = roles.ownerSafe;
        roles.anyrRecipients = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];

        script.deployProduction(p, roles);
        d = script.deployed();
        r = script.roles();
    }
}

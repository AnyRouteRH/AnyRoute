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
import {PayWithStock} from "../src/PayWithStock.sol";
import {IPayWithStock} from "../src/interfaces/IPayWithStock.sol";
import {AnyrPaymaster} from "../src/AnyrPaymaster.sol";
import {ChainlinkStockOracle} from "../src/oracle/ChainlinkStockOracle.sol";
import {UniswapV4Adapter} from "../src/adapters/UniswapV4Adapter.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {SealMeasurementRegistry} from "../src/seal/SealMeasurementRegistry.sol";
import {PolicyRegistry} from "../src/seal/PolicyRegistry.sol";
import {KmsGovernance} from "../src/seal/KmsGovernance.sol";
import {HostBond} from "../src/seal/HostBond.sol";
import {CreditMintEvents} from "../src/seal/CreditMintEvents.sol";
import {SkillRegistry} from "../src/seal/SkillRegistry.sol";

contract DeploymentSafeFixture {
    address public immutable masterCopy;
    address[] private _owners;
    uint256 private _threshold;

    constructor(address singleton_, address[] memory owners_, uint256 threshold_) {
        masterCopy = singleton_;
        _owners = owners_;
        _threshold = threshold_;
    }

    function getOwners() external view returns (address[] memory) { return _owners; }
    function getThreshold() external view returns (uint256) { return _threshold; }
}

contract DeploymentPreflightHarness is Deploy {
    function checkOwnerSafe(string memory cfg, Roles memory roles_) external view {
        _requireOwnerSafe(cfg, roles_);
    }
}

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
        assertEq(owned.length, 15);
        for (uint256 i; i < owned.length; ++i) {
            assertEq(Ownable2Step(owned[i]).owner(), deployer, "owner");
            assertEq(Ownable2Step(owned[i]).pendingOwner(), address(0), "no pending owner");
        }
        assertEq(d.timelock, address(0));
        assertEq(d.uniswapV3Adapter, address(0));
    }

    function test_productionRejectsEoaOwnerSafe() public {
        Deploy.Params memory p = script.localParams();
        p.mock = false;
        p.paymasterDeposit = 0.02 ether;
        p.paymasterStake = 0.01 ether;
        Deploy.Roles memory prodRoles = script.localRoles();
        prodRoles.ownerSafe = makeAddr("owner-safe-eoa");
        vm.chainId(4663);
        vm.expectRevert(bytes("Deploy: OWNER_SAFE must be a deployed Safe"));
        script.deployProduction(p, prodRoles);
    }

    function test_ownerSafePreflightChecksSingletonThresholdAndWorkerSeparation() public {
        DeploymentPreflightHarness harness = new DeploymentPreflightHarness();
        string memory cfg = vm.readFile("../config/rhc-mainnet.json");
        address singleton = vm.parseJsonAddress(cfg, ".safe141.singleton");
        Deploy.Roles memory roles_ = script.localRoles();
        address[] memory signers = new address[](2);
        signers[0] = makeAddr("owner-signer-a");
        signers[1] = makeAddr("owner-signer-b");

        roles_.ownerSafe = address(new DeploymentSafeFixture(makeAddr("wrong-singleton"), signers, 2));
        vm.expectRevert(bytes("Deploy: OWNER_SAFE is not configured Safe 1.4.1"));
        harness.checkOwnerSafe(cfg, roles_);

        roles_.ownerSafe = address(new DeploymentSafeFixture(singleton, signers, 1));
        vm.expectRevert(bytes("Deploy: OWNER_SAFE must have a valid threshold multisig"));
        harness.checkOwnerSafe(cfg, roles_);

        signers[1] = roles_.settlement;
        roles_.ownerSafe = address(new DeploymentSafeFixture(singleton, signers, 2));
        vm.expectRevert(bytes("Deploy: OWNER_SAFE signer overlaps worker"));
        harness.checkOwnerSafe(cfg, roles_);

        signers[1] = makeAddr("owner-signer-b");
        roles_.ownerSafe = address(new DeploymentSafeFixture(singleton, signers, 2));
        harness.checkOwnerSafe(cfg, roles_);
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
        assertEq(PayWithStock(d.payWithStock).router(), r.router);
        assertEq(address(PayWithStock(d.payWithStock).credits()), d.credits);
        assertEq(address(PayWithStock(d.payWithStock).oracle()), d.stockOracle);
        assertEq(address(PayWithStock(d.payWithStock).usdg()), d.usdg);
        assertEq(ChainlinkStockOracle(d.stockOracle).guardian(), deployer);
        assertEq(AnyrPaymaster(payable(d.paymaster)).verifyingSigner(), r.paymasterSigner);
        assertEq(address(AnyrPaymaster(payable(d.paymaster)).entryPoint()), d.entryPoint);
        assertEq(AnyrPaymaster(payable(d.paymaster)).getDeposit(), 10 ether);
    }

    function test_sealWiring() public view {
        SealMeasurementRegistry mreg = SealMeasurementRegistry(d.sealMeasurementRegistry);
        assertEq(mreg.publisher(), r.sealPublisher);
        assertEq(mreg.guardian(), r.guardian);
        PolicyRegistry preg = PolicyRegistry(d.policyRegistry);
        assertEq(preg.publisher(), r.sealPublisher);
        assertEq(preg.guardian(), r.guardian);
        assertEq(KmsGovernance(d.kmsGovernance).epoch(), 1);
        HostBond hb = HostBond(d.hostBond);
        assertEq(address(hb.usdg()), d.usdg);
        assertEq(hb.slasher(), r.slasher);
        assertEq(hb.refundPool(), r.refundPool);
        assertEq(hb.minBond(), 5_000e6);
        assertEq(CreditMintEvents(d.creditMintEvents).mintSigner(), r.mintSigner);
        assertEq(r.sealPublisher, r.anchorer);
        assertEq(r.mintSigner, r.anchorer);

        address[] memory owned = _owned();
        assertEq(owned[9], d.sealMeasurementRegistry);
        assertEq(owned[10], d.policyRegistry);
        assertEq(owned[11], d.kmsGovernance);
        assertEq(owned[12], d.hostBond);
        assertEq(owned[13], d.creditMintEvents);
        assertEq(owned[14], d.skillRegistry);
        SkillRegistry sreg = SkillRegistry(d.skillRegistry);
        assertEq(sreg.publisher(), r.sealPublisher);
        assertEq(sreg.guardian(), r.guardian);
        assertEq(sreg.skillCount(), 0);
    }

    function test_adapterCallers() public view {
        UniswapV4Adapter v4 = UniswapV4Adapter(payable(d.uniswapV4Adapter));
        assertTrue(v4.isCaller(d.payWithStock));
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
        // The wallet authorizes the router's charges itself (a bounded allowance, set directly here).
        PayWithStock(d.payWithStock)
            .setAllowance(
                IPayWithStock.AllowanceAuthorization(
                    keyHash, d.mockNvda, 1e18, 1e18, block.timestamp + 1 days, 0, 1, r.router
                ),
                ""
            );
        vm.stopPrank();

        vm.prank(r.router);
        uint256 spent =
            PayWithStock(d.payWithStock).payCallWithAllowance(keyHash, 5e6, keccak256("usage"), 100);
        assertEq(spent, uint256(5e18) / 225 + 1); // ceil(5 / 225 NVDA)
        assertEq(Credits(d.credits).deposited(keyHash), 5e6);
        assertEq(IERC20(d.usdg).balanceOf(d.credits), 5e6);
    }

    function test_productionRejectsUnfundedPaymaster() public {
        Deploy fresh = new Deploy();
        Deploy.Params memory p = fresh.localParams();
        Deploy.Roles memory roles = fresh.localRoles();
        p.paymasterDeposit = 0;
        vm.expectRevert("Deploy: paymaster deposit must cover two daily caps");
        fresh.deployProduction(p, roles);
    }

    function test_productionRejectsUnstakedPaymaster() public {
        Deploy fresh = new Deploy();
        Deploy.Params memory p = fresh.localParams();
        Deploy.Roles memory roles = fresh.localRoles();
        p.paymasterStake = 0;
        vm.expectRevert("Deploy: paymaster needs stake >= 0.01 ETH and delay >= 1 day");
        fresh.deployProduction(p, roles);
    }

    function test_localArtifact() public {
        Deploy s2 = new Deploy();
        Deploy.Params memory p = s2.localParams();
        vm.createDir("deployments", true);
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
        assertEq(vm.parseJsonAddress(json, ".roles.creditors[0]"), d2.payWithStock);
        assertEq(vm.parseJsonString(json, ".stockTokens[0].symbol"), "NVDA");
        assertEq(vm.parseJsonAddress(json, ".stockTokens[0].address"), d2.mockNvda);
        assertEq(vm.parseJsonUint(json, ".stockTokens[0].decimals"), 18);
        assertEq(vm.parseJsonAddress(json, ".mocks.nvdaFeed"), d2.mockNvdaFeed);
        assertEq(vm.parseJsonAddress(json, ".mocks.swapAdapter"), d2.mockSwapAdapter);
        assertEq(vm.parseJsonString(json, ".params.paymasterDeposit"), "10000000000000000000");
        assertEq(vm.parseJsonAddress(json, ".contracts.sealMeasurementRegistry"), d2.sealMeasurementRegistry);
        assertEq(vm.parseJsonAddress(json, ".contracts.policyRegistry"), d2.policyRegistry);
        assertEq(vm.parseJsonAddress(json, ".contracts.kmsGovernance"), d2.kmsGovernance);
        assertEq(vm.parseJsonAddress(json, ".contracts.hostBond"), d2.hostBond);
        assertEq(vm.parseJsonAddress(json, ".contracts.creditMintEvents"), d2.creditMintEvents);
        assertEq(vm.parseJsonAddress(json, ".contracts.skillRegistry"), d2.skillRegistry);
        assertEq(vm.parseJsonAddress(json, ".roles.sealPublisher"), r.sealPublisher);
        assertEq(vm.parseJsonAddress(json, ".roles.mintSigner"), r.mintSigner);
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
        string memory config = vm.readFile("../config/rhc-mainnet.json");
        address singleton = vm.parseJsonAddress(config, ".safe141.singleton");
        address[] memory safeOwners = new address[](2);
        safeOwners[0] = makeAddr("ownerSafeSigner0");
        safeOwners[1] = makeAddr("ownerSafeSigner1");
        roles.ownerSafe = address(new DeploymentSafeFixture(singleton, safeOwners, 2));
        roles.slasher = makeAddr("slasherSafe");
        roles.router = makeAddr("router");
        roles.settlement = makeAddr("settlement");
        roles.anchorer = makeAddr("anchorer");
        roles.registrar = roles.router;
        roles.keeper = makeAddr("keeper");
        roles.paymasterSigner = makeAddr("pmSigner");
        roles.refundPool = makeAddr("refundPool");
        roles.callPayTreasury = makeAddr("treasury");
        roles.guardian = roles.ownerSafe;
        roles.anyrRecipients = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        roles.sealPublisher = makeAddr("sealPublisher");
        roles.mintSigner = makeAddr("mintSigner");

        script.deployProduction(p, roles);
        d = script.deployed();
        r = script.roles();
    }

    function test_fork_productionWiringAndTimelockHandover() public {
        // --- wiring
        assertTrue(Credits(d.credits).isCreditor(d.payWithStock));
        assertEq(ProviderBond(d.providerBond).slasher(), r.slasher);
        assertEq(HostBond(d.hostBond).slasher(), r.slasher);
        assertEq(SealMeasurementRegistry(d.sealMeasurementRegistry).guardian(), r.ownerSafe);
        assertEq(CreditMintEvents(d.creditMintEvents).mintSigner(), r.mintSigner);
        // buybacks route through the V3 pool whose TWAP sets the floor
        assertTrue(UniswapV4Adapter(payable(d.uniswapV4Adapter)).isCaller(d.payWithStock));
        assertTrue(UniswapV3Adapter(d.uniswapV3Adapter).isCaller(d.payWithStock));
        assertEq(AnyrPaymaster(payable(d.paymaster)).verifyingSigner(), r.paymasterSigner);
        assertEq(AnyrPaymaster(payable(d.paymaster)).getDeposit(), 0.05 ether);
        assertEq(IERC20(d.anyrToken).balanceOf(r.anyrRecipients[0]), 800_000_000e18);

        uint256 n = script.stockCount();
        assertEq(n, 13);
        for (uint256 i; i < n; ++i) {
            Deploy.StockEntry memory e = script.stock(i);
            (bool enabled, address primary, address fb) = PayWithStock(d.payWithStock).tokens(e.token);
            assertTrue(enabled);
            assertEq(primary, d.uniswapV3Adapter);
            assertEq(fb, address(0));
            (bytes memory path,) = UniswapV3Adapter(d.uniswapV3Adapter).getPath(e.token, d.usdg);
            assertEq(path, e.v3Path);
            assertFalse(ChainlinkStockOracle(d.stockOracle).configOf(e.token).applyMultiplier);
            (uint256 price, bool ok) = ChainlinkStockOracle(d.stockOracle).fairPrice(e.token);
            if (ok) emit log_named_decimal_uint(e.symbol, price, 18);
            else emit log_named_string("oracle not ok", e.symbol);
            if (keccak256(bytes(e.symbol)) == keccak256("COIN")) assertEq(path.length, 20 + 23 * 2); // via WETH
        }
        (, bool nvdaOk) =
            ChainlinkStockOracle(d.stockOracle).fairPrice(0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC);
        assertTrue(nvdaOk);

        // --- timelock configuration
        TimelockController tl = TimelockController(payable(d.timelock));
        assertEq(tl.getMinDelay(), 1 days);
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), r.ownerSafe));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), r.ownerSafe));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), r.ownerSafe));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), deployer));
        assertFalse(tl.hasRole(tl.PROPOSER_ROLE(), deployer));

        // --- pending ownership
        address[] memory owned = script.ownedContracts();
        assertEq(owned.length, 16);
        for (uint256 i; i < owned.length; ++i) {
            assertEq(Ownable2Step(owned[i]).owner(), deployer);
            assertEq(Ownable2Step(owned[i]).pendingOwner(), d.timelock);
        }

        // --- replay the Safe batch JSON: schedule, wait 24h, execute
        script.writeArtifacts(OUT, BATCH);
        string memory batch = vm.readFile(BATCH);
        string memory execFile = vm.readFile(script.executeBatchPath());
        assertEq(vm.parseJsonString(batch, ".chainId"), "4663");
        assertEq(vm.parseJsonAddress(batch, ".meta.createdFromSafeAddress"), r.ownerSafe);
        address to = vm.parseJsonAddress(batch, ".transactions[0].to");
        assertEq(to, d.timelock);
        bytes memory scheduleData = vm.parseJsonBytes(batch, ".transactions[0].data");
        bytes memory executeData = vm.parseJsonBytes(batch, ".anyroute.executeTransactions[0].data");
        assertEq(executeData, vm.parseJsonBytes(execFile, ".transactions[0].data"));
        bytes32 opId = vm.parseJsonBytes32(batch, ".anyroute.operationId");

        vm.prank(r.ownerSafe);
        (bool ok,) = to.call(scheduleData);
        assertTrue(ok, "schedule");
        assertTrue(tl.isOperationPending(opId));

        vm.prank(r.ownerSafe);
        (ok,) = to.call(executeData);
        assertFalse(ok, "cannot execute before the delay");

        vm.warp(block.timestamp + 1 days);
        vm.prank(r.ownerSafe);
        (ok,) = to.call(executeData);
        assertTrue(ok, "execute");
        assertTrue(tl.isOperationDone(opId));
        for (uint256 i; i < owned.length; ++i) {
            assertEq(Ownable2Step(owned[i]).owner(), d.timelock, "timelock owns");
        }

        // --- deployments JSON
        string memory json = vm.readFile(OUT);
        assertEq(vm.parseJsonString(json, ".mode"), "production");
        assertEq(vm.parseJsonAddress(json, ".pendingOwner"), d.timelock);
        assertEq(vm.parseJsonAddress(json, ".contracts.timelock"), d.timelock);
        assertEq(vm.parseJsonAddress(json, ".roles.ownerSafe"), r.ownerSafe);
        assertEq(vm.parseJsonAddress(json, ".stockTokens[12].primaryAdapter"), d.uniswapV3Adapter);
        assertEq(vm.parseJsonUint(json, ".params.timelockMinDelay"), 1 days);

        vm.removeFile(OUT);
        vm.removeFile(BATCH);
        vm.removeFile(script.executeBatchPath());
    }

    /// @dev The freshly deployed production stack pays for a call with real NVDA through the real V3 pool.
    function test_fork_productionPayWithStockNvda() public {
        address nvda = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
        address wallet = makeAddr("nvdaHolder");
        deal(nvda, wallet, 1e18);
        bytes32 keyHash = keccak256(abi.encodePacked(makeAddr("forkKey")));
        vm.startPrank(wallet);
        IERC20(nvda).approve(d.payWithStock, type(uint256).max);
        PayWithStock(d.payWithStock).openSession(keyHash, nvda, 1e18);
        PayWithStock(d.payWithStock)
            .setAllowance(
                IPayWithStock.AllowanceAuthorization(
                    keyHash, nvda, 1e18, 1e18, block.timestamp + 1 days, 0, 1, r.router
                ),
                ""
            );
        vm.stopPrank();
        vm.prank(r.router);
        uint256 spent =
            PayWithStock(d.payWithStock).payCallWithAllowance(keyHash, 1e6, keccak256("usage"), 300);
        assertGt(spent, 0);
        assertEq(Credits(d.credits).deposited(keyHash), 1e6);
    }
}

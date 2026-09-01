// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";

import {AnyrToken} from "../src/AnyrToken.sol";
import {Credits} from "../src/Credits.sol";
import {CallPay} from "../src/CallPay.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {Royalty} from "../src/Royalty.sol";
import {ProviderBond} from "../src/ProviderBond.sol";
import {AnyrStaking} from "../src/AnyrStaking.sol";
import {PayWithStock} from "../src/PayWithStock.sol";
import {AnyrPaymaster} from "../src/AnyrPaymaster.sol";
import {ChainlinkStockOracle, AggregatorV3Interface} from "../src/oracle/ChainlinkStockOracle.sol";
import {UniswapV4Adapter} from "../src/adapters/UniswapV4Adapter.sol";
import {UniswapV3Adapter, ISwapRouter02} from "../src/adapters/UniswapV3Adapter.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IBuybackAdapter} from "../src/interfaces/IBuybackAdapter.sol";
import {IStockOracle} from "../src/interfaces/IStockOracle.sol";
import {MockUSDG3009} from "../src/mocks/MockUSDG3009.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockSwapAdapter} from "../src/mocks/MockSwapAdapter.sol";
import {MockBuybackAdapter} from "../src/mocks/MockBuybackAdapter.sol";

interface IUniswapV3FactoryLike {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

/// @title Deploy
/// @notice Deploys and wires every Anyroute contract.
///
/// Production (MOCK unset):
///   DEPLOYER_PRIVATE_KEY=... OWNER_SAFE=... SLASHER_SAFE=... ROUTER=... SETTLEMENT=... ANCHORER=... KEEPER=...
///   OPS_WALLET=... PAYMASTER_SIGNER=... REFUND_POOL=... CALLPAY_TREASURY=... ANYR_RECIPIENTS=a,b,c,d \
///   forge script script/Deploy.s.sol --rpc-url rhc --broadcast
///   Optional: USDG (default config), REGISTRAR (default ROUTER), GUARDIAN (default OWNER_SAFE), CONFIG_PATH,
///   PAYMASTER_DAILY_CAP (wei, default 0.01 ether), PAYMASTER_DEPOSIT / PAYMASTER_STAKE (wei, default 0),
///   PAYMASTER_UNSTAKE_DELAY (s, default 86400), WETH_USDG_V3_FEE (default 100), DEPLOYMENTS_PATH,
///   SAFE_BATCH_PATH (must stay under ./deployments, see fs_permissions).
///   Every contract is deployed with the deployer as owner, configured, then `transferOwnership(timelock)`.
///   The deployer stays owner until the timelock (24h, proposer/executor = OWNER_SAFE) executes the
///   acceptOwnership batch written to deployments/<chainid>-accept-ownership.json (Safe Transaction Builder).
///
/// Local (MOCK=1): mocks for USDG (EIP-3009), NVDA, its feed, the swap venue and the buyback venue; a local
/// EntryPoint v0.7 and PoolManager; owner = deployer (no timelock). Role addresses default to anvil accounts
/// #1..#6 (mnemonic "test test ... junk"), accounts #7..#9 are funded with mock USDG and NVDA.
///   MOCK=1 forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8546 --broadcast
///
/// Output: deployments/<chainid>.json (production) or deployments/<chainid>-local.json (local), schema
/// "anyroute.deployments/v1" (see `_writeDeployments`).
contract Deploy is Script {
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    string internal constant DEFAULT_CONFIG = "../config/rhc-mainnet.json";
    uint32 public constant MAX_STALENESS = 302_400; // 3.5 days: Chainlink stock feeds are 24/5
    uint256 public constant TIMELOCK_DELAY = 1 days;
    bytes32 internal constant ACCEPT_SALT_TAG = keccak256("anyroute.accept-ownership.v1");

    struct Params {
        bool mock;
        uint256 deployerKey;
        address usdg; // production only (0 = from config)
        string configPath;
        string outPath; // deployments JSON
        string safeBatchPath; // production only
        uint256 paymasterDailyCap;
        uint256 paymasterDeposit;
        uint256 paymasterStake;
        uint32 paymasterUnstakeDelay;
        uint24 wethUsdgFee;
    }

    struct Roles {
        address ownerSafe; // timelock proposer/executor (production); 0 locally
        address slasher;
        address router;
        address settlement;
        address anchorer;
        address registrar;
        address keeper;
        address opsWallet;
        address paymasterSigner;
        address refundPool;
        address callPayTreasury;
        address guardian;
        address[4] anyrRecipients;
    }

    struct Deployed {
        address deployer;
        address usdg;
        address anyrToken;
        address credits;
        address callPay;
        address receiptAnchor;
        address royalty;
        address providerBond;
        address anyrStaking;
        address payWithStock;
        address stockOracle;
        address uniswapV4Adapter;
        address uniswapV3Adapter;
        address paymaster;
        address entryPoint;
        address poolManager;
        address swapRouter02;
        address timelock;
        address buybackAdapter;
        // local mocks
        address mockNvda;
        address mockNvdaFeed;
        address mockSwapAdapter;
        uint256 blockNumber;
        uint256 timestamp;
    }

    struct StockEntry {
        string symbol;
        address token;
        uint8 decimals;
        address feed;
        address primaryAdapter;
        address fallbackAdapter;
        bytes v3Path;
    }

    Deployed internal _d;
    Roles internal _r;
    Params internal _p;
    StockEntry[] internal _stocks;

    // =============================================================================================
    // Entry points
    // =============================================================================================

    function run() external {
        Params memory p = _paramsFromEnv();
        if (p.mock) {
            deployLocal(p, _localRolesFromEnv());
        } else {
            deployProduction(p, _prodRolesFromEnv(p));
        }
    }

    /// @notice Default parameters for local mode (no env). Used by tests.
    function localParams() public view returns (Params memory p) {
        p.mock = true;
        p.deployerKey = vm.deriveKey(ANVIL_MNEMONIC, 0);
        p.configPath = DEFAULT_CONFIG;
        p.outPath = string.concat("deployments/", vm.toString(block.chainid), "-local.json");
        p.paymasterDailyCap = 0.01 ether;
        p.paymasterDeposit = 10 ether;
        p.paymasterUnstakeDelay = 1 days;
        p.wethUsdgFee = 100;
    }

    /// @notice Default local roles: anvil accounts #1..#6.
    function localRoles() public pure returns (Roles memory r) {
        address deployer = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, 0));
        r.router = _anvil(1);
        r.registrar = r.router;
        r.settlement = _anvil(2);
        r.refundPool = r.settlement;
        r.callPayTreasury = r.settlement;
        r.anchorer = _anvil(3);
        r.slasher = _anvil(4);
        r.paymasterSigner = _anvil(5);
        r.keeper = _anvil(6);
        r.opsWallet = _anvil(6);
        r.guardian = deployer;
        r.anyrRecipients = [deployer, deployer, deployer, deployer];
    }

    function deployed() external view returns (Deployed memory) {
        return _d;
    }

    function roles() external view returns (Roles memory) {
        return _r;
    }

    function stockCount() external view returns (uint256) {
        return _stocks.length;
    }

    function stock(uint256 i) external view returns (StockEntry memory) {
        return _stocks[i];
    }

    // =============================================================================================
    // Production
    // =============================================================================================

    function deployProduction(Params memory p, Roles memory r) public {
        _p = p;
        _r = r;
        string memory cfg = vm.readFile(p.configPath);
        require(vm.parseJsonUint(cfg, ".chainId") == block.chainid, "Deploy: config chainId != block.chainid");
        _requireRoles(r, true);

        address deployer = vm.addr(p.deployerKey);
        _d.deployer = deployer;
        _d.blockNumber = block.number;
        _d.timestamp = block.timestamp;
        _d.usdg = p.usdg != address(0) ? p.usdg : vm.parseJsonAddress(cfg, ".usdg.address");
        _d.entryPoint = vm.parseJsonAddress(cfg, ".entryPointV07");
        _d.poolManager = vm.parseJsonAddress(cfg, ".uniswap.v4PoolManager");
        _d.swapRouter02 = vm.parseJsonAddress(cfg, ".uniswap.v3SwapRouter02");
        require(_d.usdg.code.length != 0 && _d.entryPoint.code.length != 0, "Deploy: USDG/EntryPoint missing");
        require(
            _d.poolManager.code.length != 0 && _d.swapRouter02.code.length != 0, "Deploy: Uniswap missing"
        );

        vm.startBroadcast(p.deployerKey);

        address[] memory safe = new address[](1);
        safe[0] = r.ownerSafe;
        _d.timelock = address(new TimelockController(TIMELOCK_DELAY, safe, safe, address(0)));

        _d.uniswapV4Adapter = address(new UniswapV4Adapter(IPoolManager(_d.poolManager), deployer));
        _d.uniswapV3Adapter = address(new UniswapV3Adapter(ISwapRouter02(_d.swapRouter02), deployer));
        _d.anyrToken = address(new AnyrToken(r.anyrRecipients));
        // Buybacks go through the V4 adapter; the USDG->ANYR route is registered once the ANYR pool exists.
        _d.buybackAdapter = _d.uniswapV4Adapter;

        _deployCore(deployer);

        UniswapV4Adapter(payable(_d.uniswapV4Adapter)).setCaller(_d.payWithStock, true);
        UniswapV4Adapter(payable(_d.uniswapV4Adapter)).setCaller(_d.anyrStaking, true);
        UniswapV3Adapter(_d.uniswapV3Adapter).setCaller(_d.payWithStock, true);
        UniswapV3Adapter(_d.uniswapV3Adapter).setCaller(_d.anyrStaking, true);

        _configureStockTokens(cfg);

        if (p.paymasterDeposit != 0) {
            AnyrPaymaster(payable(_d.paymaster)).deposit{value: p.paymasterDeposit}();
        }
        if (p.paymasterStake != 0) {
            AnyrPaymaster(payable(_d.paymaster)).addStake{value: p.paymasterStake}(p.paymasterUnstakeDelay);
        }

        address[] memory owned = _ownedContracts();
        for (uint256 i; i < owned.length; ++i) {
            Ownable2Step(owned[i]).transferOwnership(_d.timelock);
        }

        vm.stopBroadcast();

        _writeDeployments();
        _writeSafeBatch();
    }

    /// @dev Oracle feed + V3 path + PayWithStock registration for every token in the config.
    function _configureStockTokens(string memory cfg) internal {
        address usdg = _d.usdg;
        address weth = vm.parseJsonAddress(cfg, ".weth");
        IUniswapV3FactoryLike factory = IUniswapV3FactoryLike(vm.parseJsonAddress(cfg, ".uniswap.v3Factory"));
        ChainlinkStockOracle oracle = ChainlinkStockOracle(_d.stockOracle);
        UniswapV3Adapter v3 = UniswapV3Adapter(_d.uniswapV3Adapter);
        PayWithStock pws = PayWithStock(_d.payWithStock);

        for (uint256 i; vm.keyExistsJson(cfg, _idx(i)); ++i) {
            string memory b = _idx(i);
            StockEntry memory e;
            e.symbol = vm.parseJsonString(cfg, string.concat(b, ".symbol"));
            e.token = vm.parseJsonAddress(cfg, string.concat(b, ".address"));
            e.decimals = uint8(vm.parseJsonUint(cfg, string.concat(b, ".decimals")));
            e.feed = vm.parseJsonAddress(cfg, string.concat(b, ".feed"));
            string memory pair = vm.parseJsonString(cfg, string.concat(b, ".v3Pool.pair"));
            uint24 fee = uint24(vm.parseJsonUint(cfg, string.concat(b, ".v3Pool.fee")));
            address pool = vm.parseJsonAddress(cfg, string.concat(b, ".v3Pool.address"));

            if (_eq(pair, "USDG")) {
                require(
                    factory.getPool(e.token, usdg, fee) == pool,
                    string.concat("Deploy: v3 pool mismatch ", e.symbol)
                );
                e.v3Path = abi.encodePacked(e.token, fee, usdg);
            } else if (_eq(pair, "WETH")) {
                require(
                    factory.getPool(e.token, weth, fee) == pool,
                    string.concat("Deploy: v3 pool mismatch ", e.symbol)
                );
                require(
                    factory.getPool(weth, usdg, _p.wethUsdgFee) != address(0), "Deploy: no WETH/USDG v3 pool"
                );
                e.v3Path = abi.encodePacked(e.token, fee, weth, _p.wethUsdgFee, usdg);
            } else {
                revert(string.concat("Deploy: unsupported v3 pair for ", e.symbol));
            }

            e.primaryAdapter = _d.uniswapV3Adapter;
            // No sane Uniswap v4 stock routes exist on RHC yet (thin/spam pools): fallback left empty. Register a
            // V4 route + set the fallback later through the timelock.
            e.fallbackAdapter = address(0);

            oracle.setFeed(e.token, AggregatorV3Interface(e.feed), MAX_STALENESS, false);
            v3.setPath(e.token, usdg, e.v3Path);
            pws.registerToken(e.token, e.primaryAdapter, e.fallbackAdapter, true);
            _stocks.push(e);
        }
        require(_stocks.length != 0, "Deploy: no stock tokens in config");
    }

    // =============================================================================================
    // Local (MOCK=1)
    // =============================================================================================

    function deployLocal(Params memory p, Roles memory r) public {
        _p = p;
        _r = r;
        _requireRoles(r, false);
        address deployer = vm.addr(p.deployerKey);
        _d.deployer = deployer;
        _d.blockNumber = block.number;
        _d.timestamp = block.timestamp;

        vm.startBroadcast(p.deployerKey);

        MockUSDG3009 usdg = new MockUSDG3009();
        _d.usdg = address(usdg);
        MockStockToken nvda = new MockStockToken("NVIDIA (mock)", "NVDA", 18);
        _d.mockNvda = address(nvda);
        _d.mockNvdaFeed = address(new MockAggregator(8, 225e8, "NVDA / USD"));
        _d.mockSwapAdapter = address(new MockSwapAdapter(225e18)); // fills exact-out at $225 / NVDA
        usdg.mint(_d.mockSwapAdapter, 10_000_000e6);

        _d.entryPoint = address(new EntryPoint());
        _d.poolManager = address(new PoolManager(deployer));
        _d.uniswapV4Adapter = address(new UniswapV4Adapter(IPoolManager(_d.poolManager), deployer));

        AnyrToken anyr = new AnyrToken(r.anyrRecipients);
        _d.anyrToken = address(anyr);
        _d.buybackAdapter = address(new MockBuybackAdapter(100e18, 1e6)); // 1 USDG = 100 ANYR
        if (anyr.balanceOf(deployer) >= 10_000_000e18) {
            require(anyr.transfer(_d.buybackAdapter, 10_000_000e18));
        }

        _deployCore(deployer);

        UniswapV4Adapter(payable(_d.uniswapV4Adapter)).setCaller(_d.payWithStock, true);
        UniswapV4Adapter(payable(_d.uniswapV4Adapter)).setCaller(_d.anyrStaking, true);

        ChainlinkStockOracle(_d.stockOracle)
            .setFeed(address(nvda), AggregatorV3Interface(_d.mockNvdaFeed), MAX_STALENESS, false);
        PayWithStock(_d.payWithStock).registerToken(address(nvda), _d.mockSwapAdapter, address(0), true);
        _stocks.push(
            StockEntry({
                symbol: "NVDA",
                token: address(nvda),
                decimals: 18,
                feed: _d.mockNvdaFeed,
                primaryAdapter: _d.mockSwapAdapter,
                fallbackAdapter: address(0),
                v3Path: ""
            })
        );

        if (p.paymasterDeposit != 0) {
            AnyrPaymaster(payable(_d.paymaster)).deposit{value: p.paymasterDeposit}();
        }

        for (uint32 i = 7; i <= 9; ++i) {
            usdg.mint(_anvil(i), 1_000_000e6);
            nvda.mint(_anvil(i), 1_000e18);
        }

        vm.stopBroadcast();

        _writeDeployments();
    }

    // =============================================================================================
    // Shared
    // =============================================================================================

    /// @dev Core protocol contracts (owner = deployer) + role wiring that does not depend on the mode.
    function _deployCore(address deployer) internal {
        Roles memory r = _r;
        IERC20 usdg = IERC20(_d.usdg);

        _d.credits = address(new Credits(usdg, deployer, r.settlement));
        _d.callPay = address(new CallPay(usdg, r.callPayTreasury, deployer));
        _d.receiptAnchor = address(new ReceiptAnchor(deployer, r.anchorer));
        _d.royalty = address(new Royalty(usdg, deployer, r.registrar, r.settlement));
        _d.providerBond = address(new ProviderBond(usdg, deployer, r.slasher, r.refundPool));
        _d.anyrStaking = address(
            new AnyrStaking(
                IERC20(_d.anyrToken),
                usdg,
                deployer,
                r.keeper,
                r.opsWallet,
                IBuybackAdapter(_d.buybackAdapter)
            )
        );
        _d.stockOracle = address(new ChainlinkStockOracle(deployer));
        _d.payWithStock = address(
            new PayWithStock(usdg, ICredits(_d.credits), IStockOracle(_d.stockOracle), r.router, deployer)
        );
        _d.paymaster = address(
            new AnyrPaymaster(IEntryPoint(_d.entryPoint), r.paymasterSigner, _p.paymasterDailyCap, deployer)
        );

        Credits(_d.credits).setCreditor(_d.payWithStock, true);
        ChainlinkStockOracle(_d.stockOracle).setGuardian(r.guardian);
    }

    /// @notice Every Ownable2Step contract handed to the timelock (order = accept batch order).
    function _ownedContracts() internal view returns (address[] memory a) {
        uint256 n = _d.uniswapV3Adapter == address(0) ? 10 : 11;
        a = new address[](n);
        a[0] = _d.credits;
        a[1] = _d.callPay;
        a[2] = _d.receiptAnchor;
        a[3] = _d.royalty;
        a[4] = _d.providerBond;
        a[5] = _d.anyrStaking;
        a[6] = _d.payWithStock;
        a[7] = _d.stockOracle;
        a[8] = _d.paymaster;
        a[9] = _d.uniswapV4Adapter;
        if (n == 11) a[10] = _d.uniswapV3Adapter;
    }

    function ownedContracts() external view returns (address[] memory) {
        return _ownedContracts();
    }

    /// @notice The timelock batch that makes it accept ownership of every contract.
    function acceptBatch()
        public
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads, bytes32 salt)
    {
        targets = _ownedContracts();
        values = new uint256[](targets.length);
        payloads = new bytes[](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            payloads[i] = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        }
        salt = keccak256(abi.encode(ACCEPT_SALT_TAG, block.chainid, _d.timelock));
    }

    // =============================================================================================
    // Env
    // =============================================================================================

    function _paramsFromEnv() internal view returns (Params memory p) {
        string memory mock = vm.envOr("MOCK", string(""));
        p.mock = _eq(mock, "1") || _eq(mock, "true");
        if (p.mock) {
            p = localParams();
            p.deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", p.deployerKey);
            p.paymasterDeposit = vm.envOr("PAYMASTER_DEPOSIT", p.paymasterDeposit);
        } else {
            p.deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
            p.usdg = vm.envOr("USDG", address(0));
            p.outPath = string.concat("deployments/", vm.toString(block.chainid), ".json");
            p.safeBatchPath =
                string.concat("deployments/", vm.toString(block.chainid), "-accept-ownership.json");
            p.paymasterDailyCap = 0.01 ether;
            p.paymasterDeposit = vm.envOr("PAYMASTER_DEPOSIT", uint256(0));
            p.paymasterStake = vm.envOr("PAYMASTER_STAKE", uint256(0));
            p.paymasterUnstakeDelay = uint32(vm.envOr("PAYMASTER_UNSTAKE_DELAY", uint256(1 days)));
            p.wethUsdgFee = uint24(vm.envOr("WETH_USDG_V3_FEE", uint256(100)));
            p.configPath = DEFAULT_CONFIG;
        }
        p.configPath = vm.envOr("CONFIG_PATH", p.configPath);
        p.outPath = vm.envOr("DEPLOYMENTS_PATH", p.outPath);
        if (!p.mock) p.safeBatchPath = vm.envOr("SAFE_BATCH_PATH", p.safeBatchPath);
        p.paymasterDailyCap = vm.envOr("PAYMASTER_DAILY_CAP", p.paymasterDailyCap);
    }

    function _prodRolesFromEnv(Params memory) internal view returns (Roles memory r) {
        r.ownerSafe = vm.envAddress("OWNER_SAFE");
        r.slasher = vm.envAddress("SLASHER_SAFE");
        r.router = vm.envAddress("ROUTER");
        r.settlement = vm.envAddress("SETTLEMENT");
        r.anchorer = vm.envAddress("ANCHORER");
        r.keeper = vm.envAddress("KEEPER");
        r.opsWallet = vm.envAddress("OPS_WALLET");
        r.paymasterSigner = vm.envAddress("PAYMASTER_SIGNER");
        r.refundPool = vm.envAddress("REFUND_POOL");
        r.callPayTreasury = vm.envAddress("CALLPAY_TREASURY");
        r.registrar = vm.envOr("REGISTRAR", r.router);
        r.guardian = vm.envOr("GUARDIAN", r.ownerSafe);
        address[] memory rec = vm.envAddress("ANYR_RECIPIENTS", ",");
        require(rec.length == 4, "Deploy: ANYR_RECIPIENTS needs 4 addresses (80/10/5/5)");
        r.anyrRecipients = [rec[0], rec[1], rec[2], rec[3]];
    }

    function _localRolesFromEnv() internal view returns (Roles memory r) {
        r = localRoles();
        r.router = vm.envOr("ROUTER", r.router);
        r.registrar = vm.envOr("REGISTRAR", r.router);
        r.settlement = vm.envOr("SETTLEMENT", r.settlement);
        r.refundPool = vm.envOr("REFUND_POOL", r.settlement);
        r.callPayTreasury = vm.envOr("CALLPAY_TREASURY", r.settlement);
        r.anchorer = vm.envOr("ANCHORER", r.anchorer);
        r.slasher = vm.envOr("SLASHER", r.slasher);
        r.paymasterSigner = vm.envOr("PAYMASTER_SIGNER", r.paymasterSigner);
        r.keeper = vm.envOr("KEEPER", r.keeper);
        r.opsWallet = vm.envOr("OPS_WALLET", r.opsWallet);
        r.guardian = vm.envOr("GUARDIAN", r.guardian);
        address[] memory none = new address[](0);
        address[] memory rec = vm.envOr("ANYR_RECIPIENTS", ",", none);
        if (rec.length == 4) r.anyrRecipients = [rec[0], rec[1], rec[2], rec[3]];
    }

    function _requireRoles(Roles memory r, bool prod) internal pure {
        require(
            r.slasher != address(0) && r.router != address(0) && r.settlement != address(0)
                && r.anchorer != address(0) && r.registrar != address(0) && r.keeper != address(0)
                && r.opsWallet != address(0) && r.paymasterSigner != address(0) && r.refundPool != address(0)
                && r.callPayTreasury != address(0) && r.guardian != address(0),
            "Deploy: missing role address"
        );
        if (prod) require(r.ownerSafe != address(0), "Deploy: OWNER_SAFE required");
    }

    // =============================================================================================
    // Output
    // =============================================================================================

    /// @dev Schema "anyroute.deployments/v1":
    /// { schema, chainId, mode, blockNumber, timestamp, deployer, owner, pendingOwner,
    ///   contracts: { usdg, anyrToken, credits, callPay, receiptAnchor, royalty, providerBond, anyrStaking,
    ///                payWithStock, stockOracle, uniswapV4Adapter, uniswapV3Adapter, paymaster, entryPoint,
    ///                poolManager, swapRouter02, timelock, buybackAdapter },
    ///   roles: { ownerSafe, slasher, router, settlement, anchorer, registrar, keeper, opsWallet, paymasterSigner,
    ///            refundPool, callPayTreasury, guardian, anyrRecipients[4], creditors[], adapterCallers[] },
    ///   params: { timelockMinDelay, maxStaleness, applyUiMultiplier, payWithStockMaxSlipBps,
    ///             paymasterDailyCap, paymasterDeposit, paymasterStake },
    ///   stockTokens: [ { symbol, address, decimals, feed, primaryAdapter, fallbackAdapter, v3Path } ],
    ///   mocks: { nvda, nvdaFeed, swapAdapter, buybackAdapter } | null }
    /// Addresses are checksummed strings (0x0 when not deployed in this mode); wei amounts are decimal strings.
    function _writeDeployments() internal {
        if (bytes(_p.outPath).length == 0) return; // tests may skip artifacts
        bool prod = !_p.mock;
        string[] memory f = new string[](14);
        f[0] = _kvS("schema", "anyroute.deployments/v1");
        f[1] = _kvU("chainId", block.chainid);
        f[2] = _kvS("mode", prod ? "production" : "local");
        f[3] = _kvU("blockNumber", _d.blockNumber);
        f[4] = _kvU("timestamp", _d.timestamp);
        f[5] = _kvA("deployer", _d.deployer);
        f[6] = _kvA("owner", _d.deployer);
        f[7] = _kvA("pendingOwner", prod ? _d.timelock : address(0));
        f[8] = _kv("contracts", _contractsJson());
        f[9] = _kv("roles", _rolesJson());
        f[10] = _kv("params", _paramsJson());
        f[11] = _kv("stockTokens", _stocksJson());
        f[12] = _kv("mocks", prod ? "null" : _mocksJson());
        f[13] = _kvS("generator", "contracts/script/Deploy.s.sol");
        vm.writeFile(_p.outPath, _obj(f));
    }

    function _contractsJson() internal view returns (string memory) {
        Deployed memory d = _d;
        string[] memory f = new string[](18);
        f[0] = _kvA("usdg", d.usdg);
        f[1] = _kvA("anyrToken", d.anyrToken);
        f[2] = _kvA("credits", d.credits);
        f[3] = _kvA("callPay", d.callPay);
        f[4] = _kvA("receiptAnchor", d.receiptAnchor);
        f[5] = _kvA("royalty", d.royalty);
        f[6] = _kvA("providerBond", d.providerBond);
        f[7] = _kvA("anyrStaking", d.anyrStaking);
        f[8] = _kvA("payWithStock", d.payWithStock);
        f[9] = _kvA("stockOracle", d.stockOracle);
        f[10] = _kvA("uniswapV4Adapter", d.uniswapV4Adapter);
        f[11] = _kvA("uniswapV3Adapter", d.uniswapV3Adapter);
        f[12] = _kvA("paymaster", d.paymaster);
        f[13] = _kvA("entryPoint", d.entryPoint);
        f[14] = _kvA("poolManager", d.poolManager);
        f[15] = _kvA("swapRouter02", d.swapRouter02);
        f[16] = _kvA("timelock", d.timelock);
        f[17] = _kvA("buybackAdapter", d.buybackAdapter);
        return _obj(f);
    }
}

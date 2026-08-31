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
}

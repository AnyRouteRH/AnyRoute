// Local end-to-end deployment for the router:
//   1. starts `anvil --port 8546 --chain-id 4663 --block-time 1` (only if nothing listens on 8546),
//   2. runs `forge script script/Deploy.s.sol --broadcast` in MOCK=1 mode with anvil's default keys,
//   3. writes .env.local (contract addresses + role keys + PAYWITH_TOKENS) for the router,
//   4. smoke-checks a few getters over JSON-RPC.
// Usage: bun scripts/deploy-local.ts [--keep]
//   --keep   leave the anvil we started running (otherwise it is stopped; its state is saved to
//            .data/anvil-4663.json so `anvil ... --state .data/anvil-4663.json` brings the deployment back).
// The keys written to .env.local are anvil's public development keys (mnemonic "test test ... junk").
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { createPublicClient, http, parseAbi, toHex, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const ROOT = resolve(import.meta.dir, "..");
const CONTRACTS = resolve(ROOT, "contracts");
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? `${process.env.HOME}/.foundry/bin`;
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 4663;
const MNEMONIC = "test test test test test test test test test test test junk";
const STATE_FILE = resolve(ROOT, ".data/anvil-4663.json");
const ANVIL_LOG = resolve(ROOT, ".data/anvil-4663.log");
const DEPLOYMENTS = resolve(CONTRACTS, `deployments/${CHAIN_ID}-local.json`);
const ENV_FILE = resolve(ROOT, ".env.local");
const keep = process.argv.includes("--keep");

// Role env vars the forge script would otherwise pick up from the caller's shell (local defaults must win,
// because the keys written to .env.local are derived from anvil's mnemonic).
const ROLE_VARS = [
  "ROUTER", "SETTLEMENT", "ANCHORER", "KEEPER", "OPS_WALLET", "PAYMASTER_SIGNER", "REFUND_POOL", "CALLPAY_TREASURY",
  "REGISTRAR", "GUARDIAN", "SLASHER", "SLASHER_SAFE", "OWNER_SAFE", "ANYR_RECIPIENTS", "USDG", "DEPLOYMENTS_PATH",
  "CONFIG_PATH", "PAYMASTER_DAILY_CAP", "PAYMASTER_DEPOSIT", "PAYMASTER_STAKE",
];

const log = (msg: string) => console.log(`[deploy-local] ${msg}`);

function anvilAccount(index: number): { address: Address; key: Hex } {
  const acct = mnemonicToAccount(MNEMONIC, { addressIndex: index });
  const pk = acct.getHdKey().privateKey;
  if (!pk) throw new Error(`cannot derive key #${index}`);
  return { address: acct.address, key: toHex(pk) };
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function isListening(): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: PORT,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function remoteChainId(): Promise<number | null> {
  try {
    return Number(await rpc<string>("eth_chainId"));
  } catch {
    return null;
  }
}

async function startAnvil(): Promise<Subprocess> {
  mkdirSync(resolve(ROOT, ".data"), { recursive: true });
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE); // fresh chain every run
  const proc = Bun.spawn(
    [
      `${FOUNDRY_BIN}/anvil`,
      "--port", String(PORT),
      "--chain-id", String(CHAIN_ID),
      "--block-time", "1",
      "--state", STATE_FILE,
    ],
    { stdout: Bun.file(ANVIL_LOG), stderr: "inherit", stdin: "ignore" },
  );
  for (let i = 0; i < 100; i++) {
    if ((await remoteChainId()) === CHAIN_ID) return proc;
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}; see ${ANVIL_LOG}`);
    await Bun.sleep(200);
  }
  proc.kill();
  throw new Error(`anvil did not come up on ${RPC}; see ${ANVIL_LOG}`);
}

async function forgeDeploy(deployerKey: Hex): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !ROLE_VARS.includes(k)) env[k] = v;
  env.MOCK = "1";
  env.DEPLOYER_PRIVATE_KEY = deployerKey;
  env.PATH = `${FOUNDRY_BIN}:${env.PATH ?? ""}`;
  const proc = Bun.spawn(
    // --slow: one tx per receipt (a burst of ~33 txs > 1 block of gas gets partially dropped by anvil)
    [`${FOUNDRY_BIN}/forge`, "script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--slow"],
    { cwd: CONTRACTS, env, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`forge script failed with exit code ${code}`);
}

type Deployments = {
  chainId: number;
  mode: string;
  blockNumber: number;
  contracts: Record<string, Address>;
  roles: Record<string, Address | Address[]>;
  stockTokens: { symbol: string; address: Address; decimals: number; feed: Address }[];
  mocks: Record<string, Address> | null;
};

function writeEnvLocal(d: Deployments, accts: ReturnType<typeof anvilAccount>[]): Record<string, string> {
  const payWith = d.stockTokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals, feed: t.feed }));
  const vars: Record<string, string> = {
    RHC_RPC_URL: RPC,
    CHAIN_ID: String(CHAIN_ID),
    CHAIN_CONFIRMATIONS: "1",
    USDG_ADDRESS: d.contracts.usdg,
    CREDITS_ADDRESS: d.contracts.credits,
    CALLPAY_ADDRESS: d.contracts.callPay,
    PAYWITHSTOCK_ADDRESS: d.contracts.payWithStock,
    PROVIDER_BOND_ADDRESS: d.contracts.providerBond,
    RECEIPT_ANCHOR_ADDRESS: d.contracts.receiptAnchor,
    ROYALTY_ADDRESS: d.contracts.royalty,
    ANYR_STAKING_ADDRESS: d.contracts.anyrStaking,
    PAYMASTER_ADDRESS: d.contracts.paymaster,
    CALLPAY_TREASURY: d.roles.callPayTreasury as Address,
    ROUTER_PRIVATE_KEY: accts[1].key,
    SETTLEMENT_PRIVATE_KEY: accts[2].key,
    ANCHORER_PRIVATE_KEY: accts[3].key,
    SLASHER_PRIVATE_KEY: accts[4].key,
    PAYMASTER_SIGNER_KEY: accts[5].key,
    PAYWITH_TOKENS: `'${JSON.stringify(payWith)}'`,
    // extras (not read by the router config today, handy for E2E tooling)
    ENTRY_POINT_ADDRESS: d.contracts.entryPoint,
    ANYR_TOKEN_ADDRESS: d.contracts.anyrToken,
    STOCK_ORACLE_ADDRESS: d.contracts.stockOracle,
    KEEPER_PRIVATE_KEY: accts[6].key,
    DEPLOY_BLOCK: String(d.blockNumber),
  };
  // keep unrelated lines of an existing .env.local
  const kept: string[] = [];
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const key = line.split("=")[0]?.trim();
      if (line.startsWith("# generated by scripts/deploy-local.ts")) continue;
      if (key && key in vars) continue;
      if (line.trim() !== "") kept.push(line);
    }
  }
  const body = [
    `# generated by scripts/deploy-local.ts at ${new Date().toISOString()} (anvil dev keys, chain ${CHAIN_ID})`,
    ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
    ...kept,
    "",
  ].join("\n");
  writeFileSync(ENV_FILE, body);
  return vars;
}

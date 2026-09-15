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

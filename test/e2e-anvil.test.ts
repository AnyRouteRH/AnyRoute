// End-to-end against real contracts on a local anvil chain (chain id 4663), deployed by
// contracts/script/Deploy.s.sol in MOCK mode. Run with:  E2E_ANVIL=1 bun test test/e2e-anvil.test.ts
// Setup starts its own anvil on :8547 and deploys fresh, so it never touches a running dev chain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { eq } from "drizzle-orm";
import { createPublicClient, createWalletClient, decodeFunctionData, http, parseUnits, type Hex, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.ts";
import { runRegistry } from "../src/services/registry.ts";
import { pollChain } from "../src/chain/indexer.ts";
import { runAnchor, runKeyRotation } from "../src/services/anchor.ts";
import { postSpentRoot } from "../src/services/settlement.ts";
import { runPaywithAggregator, clearFairCache } from "../src/pay/paywith.ts";
import { runSlasher } from "../src/services/slasher.ts";
import { providers, keys, paywithDebts } from "../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { serveMockProvider } from "../src/providers/mock.ts";
import { deriveKey } from "../src/chain/keys.ts";
import { CreditsAbi, CallPayAbi, ProviderBondAbi, erc20Abi } from "../src/chain/abis.ts";
import { MODELS, sse } from "./helpers.ts";

const RUN = process.env.E2E_ANVIL === "1";
const ROOT = resolve(import.meta.dir, "..");
const RPC = "http://127.0.0.1:8547";
const PK = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  router: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  settlement: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  anchorer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  slasher: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  paymaster: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  userA: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  userB: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  userC: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
} as const;
const LLAMA = "meta-llama/llama-3.3-70b-instruct";

describe.skipIf(!RUN)("E2E on anvil with the real contracts", () => {
  let anvil: ReturnType<typeof Bun.spawn> | null = null;
  let dep: any;
  let app: Awaited<ReturnType<typeof createApp>>;
  let mock: ReturnType<typeof serveMockProvider>;
  const pub = createPublicClient({ transport: http(RPC) });
  const wallet = (pk: Hex) => createWalletClient({ account: privateKeyToAccount(pk), transport: http(RPC), chain: { id: 4663, name: "anvil-rhc", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } });
  const send = async (pk: Hex, to: Hex, abi: any, functionName: string, args: unknown[]) => {
    const w = wallet(pk);
    const hash = await w.writeContract({ address: to, abi, functionName, args } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return hash;
  };
  const req = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return app.app.request(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
});

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

  beforeAll(async () => {
    const forge = `${process.env.HOME}/.foundry/bin`;
    anvil = Bun.spawn([`${forge}/anvil`, "--port", "8547", "--chain-id", "4663", "--silent"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    await $`${forge}/forge script script/Deploy.s.sol --rpc-url ${RPC} --broadcast --slow --private-key ${PK.deployer}`.cwd(resolve(ROOT, "contracts")).env({ ...process.env, MOCK: "1", DEPLOYER_PRIVATE_KEY: PK.deployer, DEPLOYMENTS_PATH: "deployments/4663-e2e.json" }).quiet();
    const outFile = resolve(ROOT, "contracts/deployments/4663-e2e.json");
    dep = JSON.parse(readFileSync(outFile, "utf8"));
    const C = dep.contracts;
    // USDG's EIP-712 domain name (the mock's differs from mainnet's "Global Dollar").
    void (await pub.readContract({ address: C.usdg, abi: [{ type: "function", name: "eip712Domain", stateMutability: "view", inputs: [], outputs: [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }] }], functionName: "eip712Domain" })) as unknown[];
    mock = serveMockProvider({ name: "Alpha", models: [MODELS.llama] });
    app = await createApp({
      startJobs: false,
      env: {
        ANYROUTE_ENV: "test",
        DATABASE_URL: "pglite://memory",
        LOG_LEVEL: "error",
        APP_SECRET: "e2e-secret-e2e-secret-e2e-secret-1234",
        ADMIN_TOKEN: "e2e-admin-token-0123456789",
        RHC_RPC_URL: RPC,
        CHAIN_ID: "4663",
        CHAIN_CONFIRMATIONS: "1",
        CHAIN_START_BLOCK: "0",
        USDG_ADDRESS: C.usdg,
        // USDG_EIP712_NAME deliberately unset: the router must read the mock domain from the chain.
        CREDITS_ADDRESS: C.credits,
        CALLPAY_ADDRESS: C.callPay,
        PAYWITHSTOCK_ADDRESS: C.payWithStock,
        PROVIDER_BOND_ADDRESS: C.providerBond,
        RECEIPT_ANCHOR_ADDRESS: C.receiptAnchor,
        ROYALTY_ADDRESS: C.royalty,
        ANYR_STAKING_ADDRESS: C.anyrStaking,
        PAYMASTER_ADDRESS: C.paymaster,
        CALLPAY_TREASURY: dep.roles.callPayTreasury,
        ROUTER_PRIVATE_KEY: PK.router,
        SETTLEMENT_PRIVATE_KEY: PK.settlement,
        ANCHORER_PRIVATE_KEY: PK.anchorer,
        SLASHER_PRIVATE_KEY: PK.slasher,
        PAYMASTER_SIGNER_KEY: PK.paymaster,
        PAYWITH_TOKENS: JSON.stringify([{ symbol: "NVDA", address: dep.mocks.nvda, decimals: 18 }]),
        PAYWITH_THRESHOLD_USD: "0.000001",
        PAYMENT_WAIT_MS: "5000",
        NEW_KEYS_PER_HOUR: "1000",
        DEV_FAUCET: "true",
        DEV_FAUCET_PRIVATE_KEY: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // anvil #6
      },
    });
    await app.ctx.db.insert(providers).values({ id: "alpha", name: "Alpha", baseUrl: mock.url, status: "live", dataPolicy: { training: false, retains_prompts: false, zdr: true } });
    await runRegistry(app.ctx);
    // Test wallets approve Credits once so every test stands alone.
    for (const pk of [PK.userA, PK.userC]) await send(pk, C.usdg, erc20Abi, "approve", [C.credits, 2n ** 255n]);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    mock?.stop();
    anvil?.kill();
  });

  const newKey = async () => {
    const r = await req("/api/v1/keys", { method: "POST", json: {} });
    const j = (await r.json()) as any;
    return { secret: j.key as string, hash: j.data.hash as string, chainKeyHash: j.data.chain_key_hash as Hex, auth: { authorization: `Bearer ${j.key}` } };
  };

  test("prepaid: approve + deposit on-chain -> indexer credits the key -> chat -> receipt", async () => {
    const k = await newKey();
    const C = dep.contracts;
    await send(PK.userA, C.credits, CreditsAbi, "deposit", [k.chainKeyHash, parseUnits("10", 6)]);
    await pollChain(app.ctx);
    const credits = await (await req("/api/v1/credits", { headers: k.auth })).json();
    expect(credits.data.available).toBe(10);
    const r = await req("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, messages: [{ role: "user", content: "on-chain funded" }] } });
    expect(r.status).toBe(200);
    expect((await r.json()).receipt.payload.payer).toBe(k.chainKeyHash);
  }, 60_000);

  test("receipts: signing key registered on-chain, hourly anchor posted, proof verifies against chain", async () => {
    const k = await newKey();
    const C = dep.contracts;
    await send(PK.userA, C.credits, CreditsAbi, "deposit", [k.chainKeyHash, parseUnits("1", 6)]);
    await pollChain(app.ctx);
    const j = await (await req("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, messages: [{ role: "user", content: "anchor me" }] } })).json();
    const rot = await runKeyRotation(app.ctx);
    expect(rot.published).toBeGreaterThan(0);
    const a = await runAnchor(app.ctx);
    expect(a.status).toBe("confirmed");
    const g = (await (await req(`/api/v1/generation?id=${j.id}`, { headers: k.auth })).json()).data;
    const v = await (await req("/api/v1/receipts/verify", { method: "POST", json: { payload: g.receipt, sig: g.receipt_sig, key_id: g.receipt_key_id, anchor: { root: g.anchor.root, proof: g.anchor.proof, index: g.anchor.index } } })).json();
    expect(v.data).toMatchObject({ signature_valid: true, key_source: "chain", inclusion_valid: true, valid: true });
    expect(v.data.onchain_root.toLowerCase()).toBe(g.anchor.root.toLowerCase());
  }, 60_000);

  test("402 per-call: gasless EIP-3009 authorization relayed by the router", async () => {
    const body = { model: LLAMA, max_tokens: 40, messages: [{ role: "user", content: "gasless" }] };
    const r = await req("/api/v1/chat/completions", { method: "POST", json: body });
    expect(r.status).toBe(402);
    const m = (await r.json()).error.metadata;
    const payer = privateKeyToAccount(PK.userB);
    const td = m.eip3009;
    const signature = await payer.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: { ...td.message, from: payer.address, value: BigInt(td.message.value), validAfter: 0n, validBefore: BigInt(td.message.validBefore) } });
    const header = Buffer.from(JSON.stringify({ scheme: "eip3009", from: payer.address, value: td.message.value, validAfter: "0", validBefore: td.message.validBefore, nonce: m.nonce, signature })).toString("base64");
    const before = (await pub.readContract({ address: dep.contracts.usdg, abi: erc20Abi, functionName: "balanceOf", args: [dep.roles.callPayTreasury] })) as bigint;
    const paid = await req("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": header }, json: body });
    expect(paid.status).toBe(200);
    const j = await paid.json();
    expect(j.receipt.payload.mode).toBe("per_call");
    expect(j.receipt.payload.payment_tx).toMatch(/^0x[0-9a-f]{64}$/);
    const after = (await pub.readContract({ address: dep.contracts.usdg, abi: erc20Abi, functionName: "balanceOf", args: [dep.roles.callPayTreasury] })) as bigint;
    expect(after - before).toBe(BigInt(m.price_usdg_units));
  }, 60_000);

  test("402 per-call: CallPay.pay transaction + X-Payment: <txHash>", async () => {
    const body = { model: LLAMA, max_tokens: 40, messages: [{ role: "user", content: "tx hash" }] };
    const m = (await (await req("/api/v1/chat/completions", { method: "POST", json: body })).json()).error.metadata;
    await send(PK.userC, dep.contracts.usdg, erc20Abi, "approve", [dep.contracts.callPay, BigInt(m.price_usdg_units)]);
    const tx = await send(PK.userC, dep.contracts.callPay, CallPayAbi, "pay", [m.nonce, BigInt(m.price_usdg_units), BigInt(m.expiry)]);
    const r = await req("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": tx }, json: body });
    expect(r.status).toBe(200);
    // A payment authorizes exactly one request.
    const reuse = await req("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": tx }, json: { ...body, stream: true } });
    expect(reuse.status).toBe(409);
    void sse;
  }, 60_000);

  test("pay with NVDA: session opened on-chain -> calls accrue -> real payCall swap -> credited + allocated", async () => {
    clearFairCache();
    const k = await newKey();
    const userA = privateKeyToAccount(PK.userA).address;
    const open = await (await req("/api/v1/paywith/open", { method: "POST", headers: k.auth, json: { token: "NVDA", cap_raw_per_day: parseUnits("1", 18).toString(), wallet: userA } })).json();
    for (const t of open.data.transactions) {
      const hash = await wallet(PK.userA).sendTransaction({ to: t.to, data: t.data } as never);
      expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    }
    await pollChain(app.ctx);
    const s = await (await req("/api/v1/paywith/session", { headers: k.auth })).json();
    expect(s.data.active).toBe(true);
    const nvdaBefore = (await pub.readContract({ address: dep.mocks.nvda, abi: erc20Abi, functionName: "balanceOf", args: [userA] })) as bigint;
    for (let i = 0; i < 2; i++) {
      const r = await req("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: { model: LLAMA, max_tokens: 30, messages: [{ role: "user", content: `nvda pays ${i}` }] } });
      expect(r.status).toBe(200);
      expect((await r.json()).receipt.paid_with.token).toBe("NVDA");
    }
    const res = await runPaywithAggregator(app.ctx);
    expect((res.settled as any[])[0].tx).toMatch(/^0x/);
    const nvdaAfter = (await pub.readContract({ address: dep.mocks.nvda, abi: erc20Abi, functionName: "balanceOf", args: [userA] })) as bigint;
    expect(nvdaAfter).toBeLessThan(nvdaBefore);
    const debts = await app.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    expect(debts.every((d) => d.swapId && d.rawAllocated != null)).toBe(true);
    expect(debts.reduce((a, d) => a + (d.rawAllocated ?? 0n), 0n)).toBe(nvdaBefore - nvdaAfter);
    const [key] = await app.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    expect((await balanceOf(app.ctx.db, key.accountId)).balance >= 0n).toBe(true);
  }, 90_000);

  test("self-custodial withdrawal: request (key signature) -> spent root -> finalize with proof -> USDG out", async () => {
    const k = await newKey();
    const C = dep.contracts;
    await send(PK.userA, C.credits, CreditsAbi, "deposit", [k.chainKeyHash, parseUnits("5", 6)]);
    await pollChain(app.ctx);
    await req("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, messages: [{ role: "user", content: "spend a little first" }] } });
    const d = deriveKey(k.secret);
    const to = "0x000000000000000000000000000000000000dEaD" as Hex;
    const nonce = (await pub.readContract({ address: C.credits, abi: CreditsAbi, functionName: "nonces", args: [k.chainKeyHash] })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const amount = parseUnits("4", 6);
    const sig = await d.account.signTypedData({
      domain: { name: "Anyroute Credits", version: "1", chainId: 4663, verifyingContract: C.credits },
      types: { WithdrawRequest: [{ name: "keyHash", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "WithdrawRequest",
      message: { keyHash: k.chainKeyHash, amount, to, nonce, deadline },
    });
    await send(PK.userC, C.credits, CreditsAbi, "requestWithdrawal", [d.keyAddress, amount, to, deadline, sig]); // anyone can submit
    await pollChain(app.ctx);
    const [key] = await app.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    const locked = await balanceOf(app.ctx.db, key.accountId);
    expect(locked.balance).toBeLessThan(parseUnits("1", 6) * 1_000_000n + 1n); // 4 of ~5 USDG locked
    // Let chain time pass the request, then settlement posts a root covering it.
    await pub.request({ method: "evm_increaseTime" as never, params: [5] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
    await Bun.sleep(1100);
    const root = await postSpentRoot(app.ctx);
    expect(root.posted).toBe(true);
    const proof = (await (await req("/api/v1/credits/withdrawal-proof", { headers: k.auth })).json()).data;
    const before = (await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "balanceOf", args: [to] })) as bigint;
    await send(PK.userC, C.credits, CreditsAbi, "finalizeWithdrawal", [k.chainKeyHash, BigInt(proof.cumulative_spent_usdg), proof.proof]);
    const after = (await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "balanceOf", args: [to] })) as bigint;
    expect(after - before).toBe(amount);
    await pollChain(app.ctx);
    expect((await verifyInvariants(app.ctx.db)).ok).toBe(true);
  }, 90_000);

  test("local faucet deposits test USDG; a pending withdrawal can be cancelled and the lock is released", async () => {
    const k = await newKey();
    expect((await (await req("/api/v1/status")).json()).data.dev_faucet).toBe(true);
    const f = await req("/api/v1/dev/faucet", { method: "POST", headers: k.auth, json: { amount: "3" } });
    expect(f.status).toBe(201);
    const credits = async () => (await (await req("/api/v1/credits", { headers: k.auth })).json()).data;
    expect((await credits()).available).toBe(3); // the faucet indexes its own deposit
    const to = "0x000000000000000000000000000000000000dEaD";
    const w = (await (await req("/api/v1/credits/withdraw-request", { method: "POST", headers: k.auth, json: { amount: "2", to } })).json()).data;
    await send(PK.userC, w.transactions[0].to, CreditsAbi, "requestWithdrawal", decodeFunctionData({ abi: CreditsAbi, data: w.transactions[0].data }).args as unknown[]);
    await pollChain(app.ctx);
    let c = await credits();
    expect(c.available).toBe(1);
    expect(c.pending_withdrawal.amount_usdg_units).toBe("2000000");
    const cancel = await req("/api/v1/credits/withdraw-cancel", { method: "POST", headers: k.auth });
    expect(cancel.status).toBe(200);
    const tx = (await cancel.json()).data.transactions[0];
    await send(PK.userC, tx.to, CreditsAbi, "cancelWithdrawal", decodeFunctionData({ abi: CreditsAbi, data: tx.data }).args as unknown[]);
    await pollChain(app.ctx);
    c = await credits();
    expect(c.available).toBe(3);
    expect(c.pending_withdrawal).toBeNull();
    expect((await req("/api/v1/credits/withdraw-cancel", { method: "POST", headers: k.auth })).status).toBe(409);
    expect((await verifyInvariants(app.ctx.db)).ok).toBe(true);
  }, 90_000);

  test("provider bond on-chain is indexed; slash proposed on-chain by the slasher", async () => {
    const C = dep.contracts;
    const operator = PK.userA;
    await send(operator, C.usdg, erc20Abi, "approve", [C.providerBond, parseUnits("10000", 6)]);
    await send(operator, C.providerBond, ProviderBondAbi, "bond", [keccak256(toBytes("alpha")), parseUnits("10000", 6)]);
    await pollChain(app.ctx);
    const [p] = await app.ctx.db.select().from(providers).where(eq(providers.id, "alpha"));
    expect(p.bondUsdg).toBe(parseUnits("10000", 6));
    // Force an empty-200 streak (evidence) and run the slasher: proposal lands on-chain.
    for (let i = 0; i < 60; i++) app.ctx.health.record({ modelId: LLAMA, providerId: "alpha", ok: i >= 5, empty200: i < 5, errorKind: i < 5 ? "empty200" : null, source: "traffic", caller: `caller-${i}` });
    await app.ctx.health.flush(app.ctx.db);
    const r = await runSlasher(app.ctx);
    const prop = (r.proposed as any[]).find((x) => x.provider === "alpha");
    expect(prop.chain.submitted).toBe(true);
    const pending = (await pub.readContract({ address: C.providerBond, abi: ProviderBondAbi, functionName: "pendingSlashes", args: [keccak256(toBytes("alpha"))] })) as bigint;
    expect(pending).toBe(1n);
  }, 60_000);
});

// End-to-end against real contracts on a local anvil chain (chain id 4663), deployed by
// contracts/script/Deploy.s.sol in MOCK mode. Run with:  E2E_ANVIL=1 bun test test/e2e-anvil.test.ts
// Setup starts its own anvil on :8547 and deploys fresh, so it never touches a running dev chain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { eq } from "drizzle-orm";
import { createPublicClient, createWalletClient, decodeFunctionData, http, parseUnits, type Hex, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import { EIP3009_TYPES } from "../src/facilitator/verify.ts";
import { readFileSync, mkdirSync } from "node:fs";
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
import { MODELS, signApiTypedData, sse } from "./helpers.ts";

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
// The hosted facilitator's relay key: its own key with no other role, funded with gas only (anvil_setBalance below).
const FAC_RELAY = generatePrivateKey();

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
    const forge = process.env.FOUNDRY_BIN ? `${process.env.FOUNDRY_BIN}/forge` : Bun.which("forge") ?? `${process.env.HOME}/.foundry/bin/forge`;
    const anvilBin = process.env.FOUNDRY_BIN ? `${process.env.FOUNDRY_BIN}/anvil` : Bun.which("anvil") ?? `${process.env.HOME}/.foundry/bin/anvil`;
    anvil = Bun.spawn([anvilBin, "--port", "8547", "--chain-id", "4663", "--silent"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    mkdirSync(resolve(ROOT, "contracts/deployments"), { recursive: true });
    await $`${forge} script script/Deploy.s.sol --rpc-url ${RPC} --broadcast --slow --private-key ${PK.deployer}`.cwd(resolve(ROOT, "contracts")).env({ ...process.env, MOCK: "1", DEPLOYER_PRIVATE_KEY: PK.deployer, DEPLOYMENTS_PATH: "deployments/4663-e2e.json" }).quiet();
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
        FACILITATOR_ENABLED: "true",
        FACILITATOR_RELAY_PRIVATE_KEY: FAC_RELAY,
      },
    });
    await pub.request({ method: "anvil_setBalance" as never, params: [privateKeyToAccount(FAC_RELAY).address, "0xde0b6b3a7640000"] as never }); // 1 ETH of gas
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
    await Bun.sleep(1100); // allow the receipt's second to close before anchoring
    await pub.request({ method: "evm_mine" as never, params: [] as never });
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

  test("facilitator: a payer pays a third-party seller straight on chain; the facilitator's relay key pays the gas", async () => {
    const usdg = dep.contracts.usdg as Hex;
    const payer = privateKeyToAccount(PK.userB);
    const seller = privateKeyToAccount(generatePrivateKey()).address;
    const relay = privateKeyToAccount(FAC_RELAY).address;
    const supported = await (await req("/facilitator/supported")).json();
    expect(supported.signers["eip155:4663"]).toEqual([relay]);
    const { name, version } = supported.policy.asset; // the mock's domain, read from the chain
    const balance = (who: Hex) => pub.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
    const block = await pub.getBlock();
    const auth = { from: payer.address, to: seller, value: 250_000n, validAfter: 0n, validBefore: block.timestamp + 600n, nonce: keccak256(toBytes(`facilitator-e2e-${Date.now()}`)) };
    const signature = await payer.signTypedData({ domain: { name, version, chainId: 4663, verifyingContract: usdg }, types: EIP3009_TYPES, primaryType: "TransferWithAuthorization", message: auth });
    const requirements = { scheme: "exact", network: "eip155:4663", amount: "250000", asset: usdg, payTo: seller, maxTimeoutSeconds: 300, extra: { name, version } };
    const body = { paymentPayload: { x402Version: 2, resource: { url: "https://seller.example/data" }, accepted: requirements, payload: { signature, authorization: { ...auth, value: "250000", validAfter: "0", validBefore: auth.validBefore.toString() } } }, paymentRequirements: requirements };
    expect(await (await req("/facilitator/verify", { method: "POST", json: body })).json()).toEqual({ isValid: true, payer: payer.address });
    const [payerBefore, sellerBefore, relayGasBefore, payerGasBefore] = [await balance(payer.address), await balance(seller), await pub.getBalance({ address: relay }), await pub.getBalance({ address: payer.address })];
    const settled = await (await req("/facilitator/settle", { method: "POST", json: body })).json();
    expect(settled).toMatchObject({ success: true, network: "eip155:4663", payer: payer.address });
    const receipt = await pub.getTransactionReceipt({ hash: settled.transaction });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(relay.toLowerCase()); // the relay key sent it and paid for it
    expect(await balance(seller)).toBe(sellerBefore + 250_000n); // payer -> seller, nothing in between
    expect(await balance(payer.address)).toBe(payerBefore - 250_000n);
    expect(await pub.getBalance({ address: relay })).toBeLessThan(relayGasBefore);
    expect(await pub.getBalance({ address: payer.address })).toBe(payerGasBefore);
    // The authorization is spent on chain and here: a replay settles nothing.
    expect((await (await req("/facilitator/settle", { method: "POST", json: body })).json()).errorReason).toBe("invalid_exact_evm_payload_authorization_nonce_used");
    // The receipt joins the next anchor and its proof checks against the root posted on chain.
    await Bun.sleep(1100);
    await pub.request({ method: "evm_mine" as never, params: [] as never });
    const anchor = await runAnchor(app.ctx);
    expect(anchor.status).toBe("confirmed");
    const r = (await (await req(`/facilitator/receipts/${settled.receipt.id}`)).json()).data;
    expect(r.claims).toMatchObject({ kind: "facilitator.settle", tx: settled.transaction, value: "250000" });
    const v = (await (await req("/api/v1/receipts/verify", { method: "POST", json: { cose: r.cose, anchor: { root: r.anchor.root, proof: r.anchor.proof, index: r.anchor.index } } })).json()).data;
    expect(v).toMatchObject({ signature_valid: true, inclusion_valid: true });
    expect(v.onchain_root.toLowerCase()).toBe(r.anchor.root.toLowerCase());
  }, 60_000);

  const openNvdaSession = async (k: Awaited<ReturnType<typeof newKey>>) => {
    const userA = privateKeyToAccount(PK.userA).address;
    const open = await (await req("/api/v1/paywith/open", { method: "POST", headers: k.auth, json: { token: "NVDA", cap_raw_per_day: parseUnits("1", 18).toString(), wallet: userA } })).json();
    for (const t of open.data.transactions) {
      const hash = await wallet(PK.userA).sendTransaction({ to: t.to, data: t.data } as never);
      expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    }
    await pollChain(app.ctx);
    const s = await (await req("/api/v1/paywith/session", { headers: k.auth })).json();
    expect(s.data.active).toBe(true);
    return userA;
  };
  const nvdaOf = async (who: Hex) => (await pub.readContract({ address: dep.mocks.nvda, abi: erc20Abi, functionName: "balanceOf", args: [who] })) as bigint;
  const payWithNvda = async (k: Awaited<ReturnType<typeof newKey>>, n: number) => {
    for (let i = 0; i < n; i++) {
      const r = await req("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: { model: LLAMA, max_tokens: 30, messages: [{ role: "user", content: `nvda pays ${k.hash} ${i}` }] } });
      expect(r.status).toBe(200);
      expect((await r.json()).receipt.paid_with.token).toBe("NVDA");
    }
  };

  test("pay with NVDA: session opened on-chain -> wallet signs an allowance -> calls accrue -> real allowance charge -> credited + allocated", async () => {
    clearFairCache();
    const k = await newKey();
    const userA = await openNvdaSession(k);
    // The wallet signs a bounded EIP-712 allowance; the router registers it with the first charge.
    const td = (await (await req("/api/v1/paywith/allowance/typed-data", { method: "POST", headers: k.auth, json: {} })).json()).data.typed_data;
    const signature = await signApiTypedData(privateKeyToAccount(PK.userA), td);
    expect((await req("/api/v1/paywith/allowance", { method: "POST", headers: k.auth, json: { message: td.message, signature } })).status).toBe(201);
    const nvdaBefore = await nvdaOf(userA);
    await payWithNvda(k, 2);
    const res = await runPaywithAggregator(app.ctx);
    const mine = (res.settled as any[]).find((r) => r.key === k.chainKeyHash);
    expect(mine.tx).toMatch(/^0x/);
    expect(mine.mode).toBe("allowance");
    const nvdaAfter = await nvdaOf(userA);
    expect(nvdaAfter).toBeLessThan(nvdaBefore);
    const debts = await app.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    expect(debts.every((d) => d.swapId && d.rawAllocated != null)).toBe(true);
    expect(debts.reduce((a, d) => a + (d.rawAllocated ?? 0n), 0n)).toBe(nvdaBefore - nvdaAfter);
    // On-chain: the allowance is registered and accounts for exactly what left the wallet; the usage batch is spent.
    const al = await app.ctx.chain.allowance(k.chainKeyHash);
    expect(al.spentRaw).toBe(nvdaBefore - nvdaAfter);
    expect(al.maxRawTotal).toBe(BigInt(td.message.maxRawTotal));
    expect(await app.ctx.chain.commitmentCharged(k.chainKeyHash, mine.usage_commitment)).toBe(true);
    const [key] = await app.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    expect((await balanceOf(app.ctx.db, key.accountId)).balance >= 0n).toBe(true);
  }, 90_000);

  test("pay with NVDA without an allowance: the router proposes, the wallet signs, the signed charge settles on-chain once", async () => {
    clearFairCache();
    const k = await newKey();
    const userA = await openNvdaSession(k);
    await payWithNvda(k, 2);
    const nvdaBefore = await nvdaOf(userA);
    const proposed = (await runPaywithAggregator(app.ctx)).settled as any[];
    expect(proposed.find((r) => r.key === k.chainKeyHash).awaiting_signature).toMatch(/^swap_/);
    expect(await nvdaOf(userA)).toBe(nvdaBefore); // nothing moves without the wallet
    const [c] = (await (await req("/api/v1/paywith/charges", { headers: k.auth })).json()).data;
    const signature = await signApiTypedData(privateKeyToAccount(PK.userA), c.typed_data);
    expect((await req(`/api/v1/paywith/charges/${c.id}/signature`, { method: "POST", headers: k.auth, json: { signature } })).status).toBe(200);
    const res = await runPaywithAggregator(app.ctx);
    const mine = (res.settled as any[]).find((r) => r.key === k.chainKeyHash);
    expect(mine.mode).toBe("signature");
    const spent = nvdaBefore - (await nvdaOf(userA));
    expect(spent > 0n && spent <= BigInt(c.max_raw)).toBe(true);
    const debts = await app.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    expect(debts.every((d) => d.swapId === c.id && d.rawAllocated != null)).toBe(true);
    // The same signature cannot be charged twice, not even by the router key.
    const m = c.typed_data.message;
    const auth = { keyHash: m.keyHash, token: m.token, usdgAmount: BigInt(m.usdgAmount), maxRaw: BigInt(m.maxRaw), usageCommitment: m.usageCommitment, nonce: BigInt(m.nonce), epoch: BigInt(m.epoch), deadline: BigInt(m.deadline), router: m.router };
    await expect(app.ctx.chain.payCall(auth, signature, 100)).rejects.toThrow();
    expect(await nvdaOf(userA)).toBe(nvdaBefore - spent);
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
    const candidate = await postSpentRoot(app.ctx);
    expect(candidate.posted).toBe(false);
    if (!("approval" in candidate) || !candidate.approval) throw new Error("missing independent approval request");
    const approvalHash = await wallet(PK.deployer).sendTransaction({ to: candidate.approval.to, data: candidate.approval.data });
    expect((await pub.waitForTransactionReceipt({ hash: approvalHash })).status).toBe("success");
    const root = await postSpentRoot(app.ctx);
    expect(root.posted).toBe(true);
    const proof = (await (await req("/api/v1/credits/withdrawal-proof", { headers: k.auth })).json()).data;
    expect(proof.kind).toBe("inclusion");
    const before = (await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "balanceOf", args: [to] })) as bigint;
    await send(PK.userC, C.credits, CreditsAbi, "finalizeWithdrawal", [k.chainKeyHash, BigInt(proof.cumulative_spent_usdg), BigInt(proof.index), BigInt(proof.leaf_count), proof.proof]);
    const after = (await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "balanceOf", args: [to] })) as bigint;
    expect(after - before).toBe(amount);
    await pollChain(app.ctx);
    expect((await verifyInvariants(app.ctx.db)).ok).toBe(true);
  }, 90_000);

  test("absence exit: a funded key the latest root leaves out proves it with the adjacent leaves and gets everything back", async () => {
    const k = await newKey();
    const other = await newKey();
    const C = dep.contracts;
    // Another key's indexed deposit changes the next root; this key's deposit lands after that indexing,
    // so settlement computes the root without it: no leaf for this key.
    await send(PK.userA, C.credits, CreditsAbi, "deposit", [other.chainKeyHash, parseUnits("1", 6)]);
    await pollChain(app.ctx);
    await send(PK.userA, C.credits, CreditsAbi, "deposit", [k.chainKeyHash, parseUnits("5", 6)]);
    const d = deriveKey(k.secret);
    const to = "0x000000000000000000000000000000000000bEEF" as Hex;
    const nonce = (await pub.readContract({ address: C.credits, abi: CreditsAbi, functionName: "nonces", args: [k.chainKeyHash] })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const amount = parseUnits("5", 6);
    const sig = await d.account.signTypedData({
      domain: { name: "Anyroute Credits", version: "1", chainId: 4663, verifyingContract: C.credits },
      types: { WithdrawRequest: [{ name: "keyHash", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "WithdrawRequest",
      message: { keyHash: k.chainKeyHash, amount, to, nonce, deadline },
    });
    const requestTx = await send(PK.userC, C.credits, CreditsAbi, "requestWithdrawal", [d.keyAddress, amount, to, deadline, sig]);
    // Roots are dated min(wall clock, chain clock); earlier tests moved anvil's clock ahead of the wall.
    const requestedAt = Number((await pub.getBlock({ blockNumber: (await pub.getTransactionReceipt({ hash: requestTx })).blockNumber })).timestamp);
    while (Math.floor(Date.now() / 1000) <= requestedAt) await Bun.sleep(250);
    const postApprovedRoot = async () => {
      await pub.request({ method: "evm_increaseTime" as never, params: [5] as never });
      await pub.request({ method: "evm_mine" as never, params: [] as never });
      await Bun.sleep(1100);
      const candidate = await postSpentRoot(app.ctx);
      if (!("approval" in candidate) || !candidate.approval) throw new Error("missing independent approval request");
      const approvalHash = await wallet(PK.deployer).sendTransaction({ to: candidate.approval.to, data: candidate.approval.data });
      expect((await pub.waitForTransactionReceipt({ hash: approvalHash })).status).toBe("success");
      const root = await postSpentRoot(app.ctx);
      expect(root.posted).toBe(true);
      return root;
    };
    const root = await postApprovedRoot();
    const proof = (await (await req("/api/v1/credits/withdrawal-proof", { headers: k.auth })).json()).data;
    expect(proof).toMatchObject({ kind: "absence", root: root.root, cumulative_spent_usdg: "0" });
    expect(proof.leaf_count).toBeGreaterThan(0);
    // The contract's own verifier agrees before anything is sent.
    const nb = (n: any) => (n ? { keyHash: n.key_hash, cumulativeSpent: BigInt(n.cumulative_spent_usdg), proof: n.proof } : { keyHash: `0x${"00".repeat(32)}`, cumulativeSpent: 0n, proof: [] });
    const verified = await pub.readContract({ address: C.credits, abi: CreditsAbi, functionName: "verifySpentAbsence", args: [root.root as Hex, k.chainKeyHash, BigInt(proof.leaf_count), BigInt(proof.gap), nb(proof.below), nb(proof.above)] });
    expect(verified).toBe(true);
    const before = (await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "balanceOf", args: [to] })) as bigint;
    const hash = await wallet(PK.userC).sendTransaction({ to: proof.transactions[0].to, data: proof.transactions[0].data });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    const after = (await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "balanceOf", args: [to] })) as bigint;
    expect(after - before).toBe(amount);
    await pollChain(app.ctx);
    expect((await verifyInvariants(app.ctx.db)).ok).toBe(true);
    // The next root counts the withdrawal: the key's leaf is capped at deposited - withdrawn = 0.
    const next = await postApprovedRoot();
    const again = (await (await req("/api/v1/credits/withdrawal-proof", { headers: k.auth })).json()).data;
    expect(again).toMatchObject({ kind: "inclusion", root: next.root, cumulative_spent_usdg: "0" });
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
    const id = BigInt(prop.chain.slashId);
    expect((await app.ctx.chain.executeSlash(id)).submitted).toBe(false);
    await send(PK.deployer, C.providerBond, ProviderBondAbi, "approveSlash", [id, "0x" + "00".repeat(32)]);
    const dispute = keccak256(toBytes("operator counter-evidence"));
    await send(operator, C.providerBond, ProviderBondAbi, "disputeSlash", [id, dispute]);
    expect((await app.ctx.chain.executeSlash(id)).submitted).toBe(false);
    await send(PK.deployer, C.providerBond, ProviderBondAbi, "approveSlash", [id, dispute]);
    await pub.request({ method: "evm_increaseTime" as never, params: [72 * 3600 + 1] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
    expect((await app.ctx.chain.executeSlash(id)).submitted).toBe(true);
    expect(await pub.readContract({ address: C.providerBond, abi: ProviderBondAbi, functionName: "pendingSlashes", args: [keccak256(toBytes("alpha"))] })).toBe(0n);
    expect(await app.ctx.chain.custodyControlsReady()).toBe(true);
  }, 60_000);
});

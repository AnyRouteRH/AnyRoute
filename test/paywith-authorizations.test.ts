// PayWithStock charge authorizations (audit M-06): the router settles a wallet's Stock Tokens only with
// the wallet's EIP-712 authorization - a bounded allowance, or a signature per proposed charge - and every
// charge is bound to the Merkle root of the receipts it pays.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, hashTypedData, keccak256, toBytes, type Hex } from "viem";
import { paywithKey, signAllowance, signApiTypedData, startRouter, type Harness } from "./helpers.ts";
import { generations, kv, paywithDebts, paywithSwaps } from "../src/db/schema.ts";
import { ALLOWANCE_TYPES, CHARGE_TYPES, allowanceTypedData, chargeTypedData, clearFairCache, runPaywithAggregator } from "../src/pay/paywith.ts";
import { PayWithStockAbi } from "../src/chain/abis.ts";
import { MerkleTree } from "../src/receipts/merkle.ts";
import { verifyInvariants } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";

describe("PayWithStock charge authorizations", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  const chat = (k: { auth: Record<string, string> }, n = 0) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: `authorized ${n}` }] } });
  // Shift rather than overwrite, so debts keep their call order (equal timestamps would sort arbitrarily).
  const ageDebts = () => h.ctx.db.execute(sql`UPDATE paywith_debts SET created_at = created_at - interval '25 hours' WHERE swap_id IS NULL`);
  const charges = async (k: { auth: Record<string, string> }) => (await (await h.request("/api/v1/paywith/charges", { headers: k.auth })).json()).data as any[];
  const postSignature = (k: { auth: Record<string, string> }, id: string, signature: Hex) => h.request(`/api/v1/paywith/charges/${id}/signature`, { method: "POST", headers: k.auth, json: { signature } });

  test("typed data matches the contract's EIP-712 types and domain", async () => {
    clearFairCache();
    const k = await paywithKey(h);
    const td = (await (await h.request("/api/v1/paywith/allowance/typed-data", { method: "POST", headers: k.auth, json: {} })).json()).data.typed_data;
    expect(td.domain).toEqual({ name: "Anyroute PayWithStock", version: "1", chainId: h.ctx.cfg.chain.id, verifyingContract: h.chain.address("payWithStock") });
    expect(td.primaryType).toBe("AllowanceAuthorization");
    expect(td.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);
    expect(td.types.AllowanceAuthorization).toEqual(ALLOWANCE_TYPES.AllowanceAuthorization);
    const m = td.message;
    expect(m.keyHash).toBe(k.chainKeyHash.toLowerCase());
    expect(m.router).toBe(h.chain.roleAddress("router").toLowerCase());
    expect(m.epoch).toBe("1");
    expect(m.nonce).toBe("0");
    expect(BigInt(m.maxRawTotal)).toBe(10n ** 18n); // one day of the session's cap
    expect(BigInt(m.maxRawPerCharge)).toBeLessThan(BigInt(m.maxRawTotal)); // about one $5 charge
    const validFor = Number(m.validUntil) - Date.now() / 1000;
    expect(validFor).toBeGreaterThan(6 * 86_400);
    expect(validFor).toBeLessThanOrEqual(7 * 86_400);
    // Exact type strings (the contract's CHARGE_TYPEHASH / ALLOWANCE_TYPEHASH)
    const typeString = (name: string, fields: readonly { name: string; type: string }[]) => `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(typeString("ChargeAuthorization", CHARGE_TYPES.ChargeAuthorization)).toBe(
      "ChargeAuthorization(bytes32 keyHash,address token,uint256 usdgAmount,uint256 maxRaw,bytes32 usageCommitment,uint256 nonce,uint64 epoch,uint256 deadline,address router)",
    );
    expect(typeString("AllowanceAuthorization", ALLOWANCE_TYPES.AllowanceAuthorization)).toBe(
      "AllowanceAuthorization(bytes32 keyHash,address token,uint256 maxRawTotal,uint256 maxRawPerCharge,uint256 validUntil,uint256 nonce,uint64 epoch,address router)",
    );
  });

  test("digests match the contract's (same vectors as PayWithStock.t.sol test_digestVectorsMatchTheRouter)", () => {
    expect(h.ctx.cfg.chain.id).toBe(4663);
    expect(h.chain.address("payWithStock")).toBe("0x00000000000000000000000000000000000c0003");
    const keyHash = keccak256(toBytes("paywith-vector-key"));
    const token = "0x00000000000000000000000000000000000000aa";
    const router = "0x0000000000000000000000000000000000000001";
    const charge = { keyHash, token, usdgAmount: 1_234_567n, maxRaw: 10n ** 16n, usageCommitment: keccak256(toBytes("paywith-vector-usage")), nonce: 42n, epoch: 3n, deadline: 1_750_003_600n, router } as const;
    expect(hashTypedData(chargeTypedData(h.ctx, charge))).toBe("0xb3896467a43aa95c5afb0f8589d61ba366a85e214243a9d5b7e18ba57b05b3d0");
    const allowance = { keyHash, token, maxRawTotal: 10n ** 18n, maxRawPerCharge: 10n ** 17n, validUntil: 1_750_600_000n, nonce: 7n, epoch: 3n, router } as const;
    expect(hashTypedData(allowanceTypedData(h.ctx, allowance))).toBe("0x72db11d096021bf03310280ff75673569567a67f32b908c011e948434aa2a48c");
  });

  test("allowances are refused unless the session wallet signed exactly what the contract will accept", async () => {
    clearFairCache();
    const k = await paywithKey(h);
    const td = (await (await h.request("/api/v1/paywith/allowance/typed-data", { method: "POST", headers: k.auth, json: {} })).json()).data.typed_data;
    const post = async (message: Record<string, string>, signer = k.account) => {
      const signature = await signApiTypedData(signer, { ...td, message });
      return h.request("/api/v1/paywith/allowance", { method: "POST", headers: k.auth, json: { message, signature } });
    };
    // another wallet's signature
    const stranger = privateKeyToAccount(generatePrivateKey());
    const r1 = await post(td.message, stranger);
    expect(r1.status).toBe(403);
    expect((await r1.json()).error.type).toBe("bad_signature");
    // longer than 7 days, a foreign router, a future epoch, a reused nonce, per-charge above total
    for (const change of [
      { validUntil: String(Math.floor(Date.now() / 1000) + 8 * 86_400) },
      { router: "0x000000000000000000000000000000000000beef" },
      { epoch: "2" },
      { nonce: "1" },
      { maxRawPerCharge: (BigInt(td.message.maxRawTotal) + 1n).toString() },
    ]) {
      const r = await post({ ...td.message, ...change });
      expect(r.status).toBe(400);
      expect((await r.json()).error.type).toBe("invalid_authorization");
    }
    // a signature over different limits than the message sent
    const signature = await signApiTypedData(k.account, td);
    const r2 = await h.request("/api/v1/paywith/allowance", { method: "POST", headers: k.auth, json: { message: { ...td.message, maxRawTotal: (BigInt(td.message.maxRawTotal) * 2n).toString() }, signature } });
    expect(r2.status).toBe(403);
    // revoked on-chain since it was prepared: stale
    h.chain.revoke(k.chainKeyHash as Hex);
    const r3 = await h.request("/api/v1/paywith/allowance", { method: "POST", headers: k.auth, json: { message: td.message, signature } });
    expect(r3.status).toBe(400);
    // a fresh one for the new epoch is accepted
    const fresh = await signAllowance(h, k, k.account);
    expect(fresh.message.epoch).toBe("2");
    const s = (await (await h.request("/api/v1/paywith/session", { headers: k.auth })).json()).data;
    expect(s.epoch).toBe("2");
    expect(s.allowance).toMatchObject({ registered: false, max_raw_total: fresh.message.maxRawTotal });
  });

  test("without an allowance the router only proposes: the charge settles once the wallet signs it", async () => {
    clearFairCache();
    const k = await paywithKey(h);
    for (let i = 0; i < 2; i++) expect((await chat(k, i)).status).toBe(200);
    await ageDebts();
    const sent = h.chain.payCalls.length;
    const res = await runPaywithAggregator(h.ctx);
    const proposed = (res.settled as any[]).find((r) => r.key === k.chainKeyHash);
    expect(proposed.awaiting_signature).toMatch(/^swap_/);
    expect(h.chain.payCalls.length).toBe(sent); // nothing moved
    // A second run neither re-proposes nor charges.
    await runPaywithAggregator(h.ctx);
    expect(h.chain.payCalls.length).toBe(sent);
    const [c] = await charges(k);
    expect(c.status).toBe("awaiting_signature");
    // The proposal names exactly the receipts it pays.
    const leaves = await Promise.all(c.generations.map(async (id: string) => (await h.ctx.db.select().from(generations).where(eq(generations.id, id)))[0].receiptLeaf));
    expect(c.receipt_leaves).toEqual(leaves);
    expect(c.usage_commitment).toBe(new MerkleTree(leaves).root);
    expect(c.typed_data.message.usageCommitment).toBe(c.usage_commitment);
    expect(BigInt(c.typed_data.message.usdgAmount)).toBe(BigInt(c.usdg_units));
    expect((await (await h.request("/api/v1/paywith/session", { headers: k.auth })).json()).data.charges_awaiting_signature).toBe(1);

    // Signatures by anyone else, or over an altered charge, are refused.
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect((await postSignature(k, c.id, await signApiTypedData(stranger, c.typed_data))).status).toBe(403);
    const inflated = { ...c.typed_data, message: { ...c.typed_data.message, usdgAmount: (BigInt(c.usdg_units) * 100n).toString() } };
    expect((await postSignature(k, c.id, await signApiTypedData(k.account, inflated))).status).toBe(403);
    // Another key cannot sign (or see) it.
    const other = await h.newKey();
    expect((await postSignature(other, c.id, await signApiTypedData(k.account, c.typed_data))).status).toBe(404);

    const ok = await postSignature(k, c.id, await signApiTypedData(k.account, c.typed_data));
    expect(ok.status).toBe(200);
    expect((await postSignature(k, c.id, await signApiTypedData(k.account, c.typed_data))).status).toBe(409);

    const settled = await runPaywithAggregator(h.ctx);
    const done = (settled.settled as any[]).find((r) => r.key === k.chainKeyHash);
    expect(done.mode).toBe("signature");
    const call = h.chain.payCalls.at(-1)!;
    expect(call).toMatchObject({ keyHash: k.chainKeyHash, mode: "signature", usageCommitment: c.usage_commitment, usdg: BigInt(c.usdg_units) });
    const [swap] = await h.ctx.db.select().from(paywithSwaps).where(eq(paywithSwaps.id, c.id));
    expect(swap.status).toBe("confirmed");
    const debts = await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    expect(debts.every((d) => d.swapId === c.id && d.rawAllocated != null)).toBe(true);
    const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, `paywith-charge:${c.id}`));
    expect((row.value as { signature: string }).signature).toMatch(/^0x/);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
    expect(await charges(k)).toEqual([]);
  });

  test("the wallet's signature covers the domain: another chain or contract does not verify", async () => {
    clearFairCache();
    const k = await paywithKey(h);
    await chat(k);
    await ageDebts();
    await runPaywithAggregator(h.ctx);
    const [c] = await charges(k);
    for (const domain of [{ ...c.typed_data.domain, chainId: 1 }, { ...c.typed_data.domain, verifyingContract: "0x000000000000000000000000000000000000dead" }]) {
      expect((await postSignature(k, c.id, await signApiTypedData(k.account, { ...c.typed_data, domain }))).status).toBe(403);
    }
  });

  test("an unsigned proposal expires and releases its debts; a signed one dies with a revocation", async () => {
    clearFairCache();
    const k = await paywithKey(h);
    await chat(k);
    await ageDebts();
    await runPaywithAggregator(h.ctx);
    let [c] = await charges(k);
    // Past its deadline without a signature: expired, the debt is open again.
    const expire = async (id: string) => {
      const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, `paywith-charge:${id}`));
      const v = row.value as { message: Record<string, string> };
      await h.ctx.db.update(kv).set({ value: { ...v, message: { ...v.message, deadline: "1" } } }).where(eq(kv.key, row.key));
    };
    await expire(c.id);
    const res = await runPaywithAggregator(h.ctx);
    expect((res.settled as any[]).some((r) => r.expired === c.id)).toBe(true);
    expect((await h.ctx.db.select().from(paywithSwaps).where(eq(paywithSwaps.id, c.id)))[0].status).toBe("expired");
    // The same run proposes a fresh charge for the released debt (new nonce).
    const [next] = await charges(k);
    expect(next.id).not.toBe(c.id);
    expect(next.typed_data.message.nonce).not.toBe(c.typed_data.message.nonce);
    c = next;
    // Signed, then the wallet revokes on-chain before it settles: dropped, the debt is open again.
    expect((await postSignature(k, c.id, await signApiTypedData(k.account, c.typed_data))).status).toBe(200);
    h.chain.revoke(k.chainKeyHash as Hex);
    const sent = h.chain.payCalls.length;
    await runPaywithAggregator(h.ctx);
    expect(h.chain.payCalls.length).toBe(sent);
    expect((await h.ctx.db.select().from(paywithSwaps).where(eq(paywithSwaps.id, c.id)))[0].status).toBe("expired");
    // Signing a stale proposal is refused too.
    const [fresh] = await charges(k);
    h.chain.revoke(k.chainKeyHash as Hex);
    const stale = await postSignature(k, fresh.id, await signApiTypedData(k.account, fresh.typed_data));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.type).toBe("charge_stale");
  });

  test("a signed charge whose send fails keeps its debts and retries until it lands", async () => {
    clearFairCache();
    const k = await paywithKey(h);
    await chat(k);
    await ageDebts();
    await runPaywithAggregator(h.ctx);
    const [c] = await charges(k);
    await postSignature(k, c.id, await signApiTypedData(k.account, c.typed_data));
    h.chain.failPayCall = true;
    const r = await runPaywithAggregator(h.ctx);
    h.chain.failPayCall = false;
    expect((r.settled as any[]).some((x) => x.retry)).toBe(true);
    const debts = await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    expect(debts.every((d) => d.swapId === c.id)).toBe(true); // never released while its signature can still land
    await runPaywithAggregator(h.ctx);
    expect((await h.ctx.db.select().from(paywithSwaps).where(eq(paywithSwaps.id, c.id)))[0].status).toBe("confirmed");
  });

  test("a charge that landed but whose receipt was lost is matched by its usage commitment", async () => {
    clearFairCache();
    const k = await paywithKey(h, { allowance: true });
    await chat(k);
    await ageDebts();
    const orig = h.chain.payCallWithAllowance.bind(h.chain);
    let landed: Awaited<ReturnType<typeof orig>> | null = null;
    h.chain.payCallWithAllowance = (async (...a: Parameters<typeof orig>) => {
      landed = await orig(...a);
      throw new Error("timed out waiting for the receipt");
    }) as typeof orig;
    await runPaywithAggregator(h.ctx);
    h.chain.payCallWithAllowance = orig;
    const debts = await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    expect(debts.every((d) => d.swapId !== null)).toBe(true); // not released: it was charged
    // The indexer later sees the PaidWithStock event and confirms the claiming swap.
    const { recordEvents, processEvents } = await import("../src/chain/indexer.ts");
    await recordEvents(h.ctx, landed!.logs);
    await processEvents(h.ctx);
    const [swap] = await h.ctx.db.select().from(paywithSwaps).where(eq(paywithSwaps.id, debts[0].swapId!));
    expect(swap).toMatchObject({ status: "confirmed", tx: landed!.hash });
    expect((await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash))).every((d) => d.rawAllocated != null)).toBe(true);
  });

  test("allowance charges stay within the signed per-charge limit; larger calls are proposed to the wallet", async () => {
    clearFairCache();
    const k = await paywithKey(h);
    for (let i = 0; i < 3; i++) expect((await chat(k, i)).status).toBe(200);
    const debts = await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    const biggest = debts.reduce((a, d) => (d.amount > a ? d.amount : a), 0n);
    // The mock provider's completion lengths vary, so make the three calls cost the same: then no two fit
    // one charge, whatever order the debts are claimed in.
    await h.ctx.db.update(paywithDebts).set({ amount: biggest }).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
    // Per-charge limit worth about 1.5 calls (at fair value, plus the slippage headroom the router uses).
    const fair = 225n * 10n ** 18n;
    const raw = (biggest * 3n * 10n ** 36n) / (2n * fair * 10n ** 12n);
    await signAllowance(h, k, k.account, { max_raw_per_charge: ((raw * 10_300n) / 10_000n).toString() });
    await ageDebts();
    const before = h.chain.payCalls.length;
    for (let i = 0; i < 3; i++) await runPaywithAggregator(h.ctx);
    const made = h.chain.payCalls.slice(before).filter((c) => c.keyHash === k.chainKeyHash);
    expect(made.length).toBe(3); // one call per charge
    expect(made.every((c) => c.mode === "allowance")).toBe(true);
    expect(new Set(made.map((c) => c.usageCommitment)).size).toBe(3);
    expect((await h.ctx.db.select().from(paywithDebts).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash))).every((d) => d.rawAllocated != null)).toBe(true);

    // A per-charge limit smaller than one call: that call is proposed to the wallet instead.
    const k2 = await paywithKey(h);
    await signAllowance(h, k2, k2.account, { max_raw_per_charge: "1" });
    await chat(k2);
    await ageDebts();
    const r = await runPaywithAggregator(h.ctx);
    expect((r.settled as any[]).find((x) => x.key === k2.chainKeyHash).awaiting_signature).toMatch(/^swap_/);
  });

  test("allowance charges never exceed $5 each on-chain", async () => {
    clearFairCache();
    // A router with a larger debt line than the contract's $5 allowance charge.
    const big = await startRouter({ env: { PAYWITH_MAX_DEBT_USD: "20" } });
    try {
      const k = await paywithKey(big, { allowance: true });
      for (let i = 0; i < 3; i++)
        await big.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-pay-with": "NVDA" }, json: { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: `big ${i}` }] } });
      // Pretend each call accrued $4: $12 in total, more than two $5 allowance charges.
      await big.ctx.db.update(paywithDebts).set({ amount: usdToPico(4), createdAt: new Date(Date.now() - 26 * 3_600_000) }).where(eq(paywithDebts.chainKeyHash, k.chainKeyHash));
      for (let i = 0; i < 3; i++) await runPaywithAggregator(big.ctx);
      const made = big.chain.payCalls.filter((c) => c.keyHash === k.chainKeyHash);
      expect(made.length).toBe(3);
      expect(made.every((c) => c.mode === "allowance" && c.usdg <= 5_000_000n)).toBe(true);
    } finally {
      await big.close();
    }
  });

  test("revoke and close return the wallet's transaction and stop automatic charges at once", async () => {
    clearFairCache();
    const k = await paywithKey(h, { allowance: true });
    const rev = (await (await h.request("/api/v1/paywith/revoke", { method: "POST", headers: k.auth })).json()).data;
    expect(rev.transactions).toHaveLength(1);
    const call = decodeFunctionData({ abi: PayWithStockAbi, data: rev.transactions[0].data });
    expect(call).toMatchObject({ functionName: "revokeAuthorizations", args: [k.chainKeyHash] });
    // The router forgot the allowance even before the transaction lands: the next charge is a proposal.
    await chat(k);
    await ageDebts();
    const r = await runPaywithAggregator(h.ctx);
    expect((r.settled as any[]).find((x) => x.key === k.chainKeyHash).awaiting_signature).toMatch(/^swap_/);
    const close = (await (await h.request("/api/v1/paywith/close", { method: "POST", headers: k.auth })).json()).data;
    expect(decodeFunctionData({ abi: PayWithStockAbi, data: close.transactions[0].data }).functionName).toBe("closeSession");
  });
});

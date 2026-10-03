import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { facilitatorSellers, facilitatorSettlements, sanctionsAddresses, sanctionsMeta, sellerGasFloats } from "../src/db/schema.ts";
import { EIP3009_TYPES } from "../src/facilitator/verify.ts";
import { LISTING_TYPES, listingDomain } from "../src/facilitator/discovery.ts";
import { runAnchor } from "../src/services/anchor.ts";
import { X402_TYPES } from "../src/pay/x402.ts";
import { xPayment, type Req } from "./support/x402-client.ts";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Hex;
const NETWORK = "eip155:4663";
const DOMAIN = { name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: USDG };
const TREASURY = "0x00000000000000000000000000000000000fee01" as Hex;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const nonce = () => `0x${randomBytes(32).toString("hex")}` as Hex;
const seller = () => privateKeyToAccount(generatePrivateKey());

type Auth = { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
const str = (a: Auth) => ({ ...a, value: String(a.value), validAfter: String(a.validAfter), validBefore: String(a.validBefore) });

/** Sign an EIP-3009 authorization the way an x402 client does. */
async function sign(signer: PrivateKeyAccount, o: Partial<Auth> & { to: Hex; value: bigint }) {
  const auth: Auth = { from: signer.address, validAfter: 0n, validBefore: now() + 300n, nonce: nonce(), ...o };
  const signature = await signer.signTypedData({ domain: DOMAIN, types: EIP3009_TYPES, primaryType: "TransferWithAuthorization", message: auth });
  return { auth, signature };
}

/** The same payment as a v1 and a v2 facilitator body. */
async function payment(o: { payer?: PrivateKeyAccount; payTo: Hex; amount: bigint; value?: bigint; to?: Hex; validBefore?: bigint; validAfter?: bigint; nonce?: Hex; resource?: string; fee?: { amount: bigint; payTo: Hex; signed?: boolean } }) {
  const payer = o.payer ?? privateKeyToAccount(generatePrivateKey());
  const main = await sign(payer, { to: o.to ?? o.payTo, value: o.value ?? o.amount, ...(o.validBefore !== undefined ? { validBefore: o.validBefore } : {}), ...(o.validAfter !== undefined ? { validAfter: o.validAfter } : {}), ...(o.nonce ? { nonce: o.nonce } : {}) });
  const fee = o.fee && o.fee.signed !== false ? await sign(payer, { to: o.fee.payTo, value: o.fee.amount }) : null;
  const inner = { signature: main.signature, authorization: str(main.auth), ...(fee ? { facilitatorFee: { signature: fee.signature, authorization: str(fee.auth) } } : {}) };
  const extra = { name: "Global Dollar", version: "1", ...(o.fee ? { facilitatorFee: { amount: String(o.fee.amount), payTo: o.fee.payTo } } : {}) };
  const resource = o.resource ?? "https://seller.example/api/data";
  const v1Req = { scheme: "exact", network: NETWORK, maxAmountRequired: String(o.amount), resource, description: "data", mimeType: "application/json", payTo: getAddress(o.payTo), maxTimeoutSeconds: 300, asset: USDG, extra };
  const v2Req = { scheme: "exact", network: NETWORK, amount: String(o.amount), asset: USDG, payTo: getAddress(o.payTo), maxTimeoutSeconds: 300, extra };
  return {
    payer,
    main,
    v1: { x402Version: 1, paymentPayload: { x402Version: 1, scheme: "exact", network: NETWORK, payload: inner }, paymentRequirements: v1Req },
    v2: { paymentPayload: { x402Version: 2, resource: { url: resource, description: "data", mimeType: "application/json" }, accepted: v2Req, payload: inner }, paymentRequirements: v2Req },
  };
}

const facilitatorEnv = (extra: Record<string, string> = {}) => ({ FACILITATOR_ENABLED: "true", FACILITATOR_RELAY_PRIVATE_KEY: generatePrivateKey(), FACILITATOR_TREASURY: TREASURY, FACILITATOR_ETH_USDG: "2500", ...extra });

describe("hosted x402 facilitator (eip155:4663)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: facilitatorEnv() });
  });
  afterAll(async () => h.close());
  const post = (path: string, json: unknown) => h.request(path, { method: "POST", json });

  test("/supported lists x402 v1 and v2 exact on eip155:4663, the relay signer and the screening policy", async () => {
    const r = await h.request("/facilitator/supported");
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.kinds).toEqual(expect.arrayContaining([{ x402Version: 1, scheme: "exact", network: NETWORK }, { x402Version: 2, scheme: "exact", network: NETWORK }]));
    expect(s.signers[NETWORK]).toEqual([getAddress("0x0000000000000000000000000000000000000001")]);
    expect(s.policy.custody).toBe("none");
    expect(s.policy.screening).toMatchObject({ listings: "off", payers: "not_screened", settlements: "not_screened" });
    expect(s.policy.fee).toMatchObject({ bps: 0, waived: true });
    expect(s.policy.minSettleUnits).toBe("10000");
    expect(s.policy.listing.primaryType).toBe("SellerListing");
    const status = (await (await h.request("/api/v1/status")).json()).data.facilitator;
    expect(status).toMatchObject({ enabled: true, networks: [NETWORK], fee_bps: 0, min_settle_units: "10000", gas_floats: true });
  });

  test("v1 and v2 payloads verify the same way, and verify moves nothing", async () => {
    const payTo = seller().address;
    const p = await payment({ payTo, amount: 50_000n });
    const relays = h.chain.x402Relays.length;
    const one = await (await post("/facilitator/verify", p.v1)).json();
    const two = await (await post("/facilitator/verify", p.v2)).json();
    expect(one).toEqual({ isValid: true, payer: p.payer.address });
    expect(two).toEqual(one);
    expect(h.chain.x402Relays.length).toBe(relays);
    // The same faults give the same reasons in both versions.
    const cases: [Parameters<typeof payment>[0], string][] = [
      [{ payTo, amount: 50_000n, value: 49_999n }, "invalid_exact_evm_payload_authorization_value"],
      [{ payTo, amount: 50_000n, to: seller().address }, "invalid_exact_evm_payload_recipient_mismatch"],
      [{ payTo, amount: 50_000n, validAfter: now() + 3600n }, "invalid_exact_evm_payload_authorization_valid_after"],
      [{ payTo, amount: 5_000n }, "payment_below_facilitator_minimum"],
    ];
    for (const [o, reason] of cases) {
      const c = await payment(o);
      for (const body of [c.v1, c.v2]) expect(await (await post("/facilitator/verify", body)).json()).toEqual({ isValid: false, invalidReason: reason, payer: c.payer.address });
    }
    const poor = await payment({ payTo, amount: 50_000n });
    h.chain.usdgBalances.set(poor.payer.address.toLowerCase(), 10n);
    for (const body of [poor.v1, poor.v2]) expect((await (await post("/facilitator/verify", body)).json()).invalidReason).toBe("insufficient_funds");
  });

  test("settle relays payer to payTo with the facilitator key, records the claim and signs a facilitator.settle receipt", async () => {
    const payTo = seller().address;
    const p = await payment({ payTo, amount: 25_000n });
    const r = await post("/facilitator/settle", p.v2);
    expect(r.status).toBe(200);
    const j = await r.json();
    const relay = h.chain.x402Relays.at(-1)!;
    expect(relay).toMatchObject({ from: p.payer.address, to: payTo, value: 25_000n, nonce: p.main.auth.nonce, role: "facilitator" });
    expect(j).toMatchObject({ success: true, transaction: relay.hash, network: NETWORK, payer: p.payer.address });
    const [row] = await h.ctx.db.select().from(facilitatorSettlements).where(eq(facilitatorSettlements.id, j.receipt.id));
    expect(row).toMatchObject({ status: "settled", payer: p.payer.address.toLowerCase(), payTo: payTo.toLowerCase(), value: 25_000n, txHash: relay.hash, x402Version: 2, kind: "payment" });
    const rec = (await (await h.request(`/facilitator/receipts/${j.receipt.id}`)).json()).data;
    expect(rec.claims).toMatchObject({ v: 2, kind: "facilitator.settle", rid: j.receipt.id, tx: relay.hash, value: "25000", pay_to: payTo.toLowerCase(), network: NETWORK });
    expect(rec.claims.payer).toBeUndefined();
    expect(rec.anchor).toBeNull();
    // The hourly anchor roots it with the generations, and the proof checks against the root.
    await Bun.sleep(1100);
    const a = await runAnchor(h.ctx);
    expect(a.settlements).toBeGreaterThan(0);
    const anchored = (await (await h.request(`/facilitator/receipts/${j.receipt.id}`)).json()).data;
    expect(anchored.anchor.root).toBe(a.root);
    const v = (await (await post("/api/v1/receipts/verify", { cose: anchored.cose, anchor: { root: anchored.anchor.root, proof: anchored.anchor.proof } })).json()).data;
    expect(v).toMatchObject({ signature_valid: true, inclusion_valid: true });
  });

  test("a replayed nonce is rejected and settles nothing twice, even before the chain shows it used", async () => {
    const p = await payment({ payTo: seller().address, amount: 20_000n });
    expect((await (await post("/facilitator/settle", p.v1)).json()).success).toBe(true);
    const relays = h.chain.x402Relays.length;
    const again = await (await post("/facilitator/settle", p.v1)).json();
    expect(again).toMatchObject({ success: false, errorReason: "invalid_exact_evm_payload_authorization_nonce_used", transaction: "" });
    h.chain.usedAuthorizations.clear(); // the durable (payer, nonce) claim alone refuses it
    expect((await (await post("/facilitator/settle", p.v2)).json()).errorReason).toBe("invalid_exact_evm_payload_authorization_nonce_used");
    expect((await (await post("/facilitator/verify", p.v1)).json()).invalidReason).toBe("invalid_exact_evm_payload_authorization_nonce_used");
    expect(h.chain.x402Relays.length).toBe(relays);
  });

  test("a mismatched payTo is rejected, in the authorization or in what a v2 payer accepted", async () => {
    const payTo = seller().address;
    const p = await payment({ payTo, amount: 20_000n, to: seller().address });
    expect((await (await post("/facilitator/settle", p.v1)).json()).errorReason).toBe("invalid_exact_evm_payload_recipient_mismatch");
    const q = await payment({ payTo, amount: 20_000n });
    const swapped = { ...q.v2, paymentRequirements: { ...q.v2.paymentRequirements, payTo: getAddress(seller().address) } };
    expect((await (await post("/facilitator/settle", swapped)).json()).errorReason).toBe("invalid_exact_evm_payload_recipient_mismatch");
    expect(h.chain.x402Relays.some((x) => x.nonce === p.main.auth.nonce || x.nonce === q.main.auth.nonce)).toBe(false);
  });

  test("validBefore must outlive the relay by at least 6 seconds", async () => {
    const payTo = seller().address;
    const short = await payment({ payTo, amount: 20_000n, validBefore: now() + 5n });
    expect((await (await post("/facilitator/settle", short.v1)).json()).errorReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
    const enough = await payment({ payTo, amount: 20_000n, validBefore: now() + 30n });
    expect((await (await post("/facilitator/settle", enough.v1)).json()).success).toBe(true);
  });

  test("below the relay's balance floor it refuses with facilitator_unavailable and never queues", async () => {
    const p = await payment({ payTo: seller().address, amount: 20_000n });
    const relays = h.chain.x402Relays.length;
    h.chain.relayBalanceWei = h.ctx.cfg.facilitator.relayFloorWei - 1n;
    try {
      const v = await post("/facilitator/verify", p.v1);
      expect(v.status).toBe(503);
      expect(await v.json()).toMatchObject({ isValid: false, invalidReason: "facilitator_unavailable" });
      const s = await post("/facilitator/settle", p.v1);
      expect(s.status).toBe(503);
      expect(s.headers.get("retry-after")).toBe("60");
      expect(await s.json()).toMatchObject({ success: false, errorReason: "facilitator_unavailable", transaction: "" });
      expect((await (await h.request("/api/v1/status")).json()).data.facilitator.relay.above_floor).toBe(false);
    } finally {
      h.chain.relayBalanceWei = 10n ** 18n;
    }
    expect(h.chain.x402Relays.length).toBe(relays);
    expect(await h.ctx.db.select().from(facilitatorSettlements).where(eq(facilitatorSettlements.nonce, p.main.auth.nonce))).toHaveLength(0);
    // Once funded again, the same authorization settles.
    expect((await (await post("/facilitator/settle", p.v1)).json()).success).toBe(true);
  });

  test("a failed relay is recorded as failed and the unused authorization can be settled again", async () => {
    const p = await payment({ payTo: seller().address, amount: 20_000n });
    h.chain.failX402Relay = true;
    const failed = await (await post("/facilitator/settle", p.v1)).json();
    h.chain.failX402Relay = false;
    expect(failed).toMatchObject({ success: false, errorReason: "unexpected_settle_error" });
    const [row] = await h.ctx.db.select().from(facilitatorSettlements).where(eq(facilitatorSettlements.nonce, p.main.auth.nonce));
    expect(row).toMatchObject({ status: "failed", error: "relay_failed" });
    expect((await (await post("/facilitator/settle", p.v1)).json()).success).toBe(true);
  });

  test("malformed bodies are 400 with an x402 reason; the facilitator has its own error shape", async () => {
    const bad = await post("/facilitator/verify", { paymentPayload: { x402Version: 1, scheme: "exact", network: NETWORK, payload: { signature: "0x12", authorization: { from: "nope" } } }, paymentRequirements: {} });
    expect(bad.status).toBe(400);
    expect((await bad.json()).invalidReason).toBe("invalid_payload");
    const version = await post("/facilitator/settle", { paymentPayload: { x402Version: 3 }, paymentRequirements: {} });
    expect((await version.json()).errorReason).toBe("invalid_x402_version");
    const p = await payment({ payTo: seller().address, amount: 20_000n });
    const otherAsset = { ...p.v1, paymentRequirements: { ...p.v1.paymentRequirements, asset: getAddress(seller().address) } };
    expect((await (await post("/facilitator/verify", otherAsset)).json()).invalidReason).toBe("invalid_payment_requirements");
    const otherChain = { ...p.v1, paymentRequirements: { ...p.v1.paymentRequirements, network: "eip155:8453" } };
    expect((await (await post("/facilitator/verify", otherChain)).json()).invalidReason).toBe("invalid_network");
  });

  // ---- listings and discovery -----------------------------------------------------------------------------------

  const listing = async (account: PrivateKeyAccount, o: { resource?: string; priceHint?: string; outputSchema?: string; tags?: string[]; listed?: boolean; issuedAt?: number; signer?: PrivateKeyAccount; payTo?: Hex } = {}) => {
    const message = { payTo: o.payTo ?? account.address, resource: o.resource ?? `https://seller-${randomBytes(4).toString("hex")}.example/api`, priceHint: BigInt(o.priceHint ?? "20000"), outputSchema: o.outputSchema ?? JSON.stringify({ type: "object", properties: { price: { type: "number" } } }), tags: o.tags ?? ["prices", "stocks"], listed: o.listed ?? true, issuedAt: BigInt(o.issuedAt ?? Number(now())) };
    const signature = await (o.signer ?? account).signTypedData({ domain: listingDomain(4663), types: LISTING_TYPES, primaryType: "SellerListing", message });
    return { ...message, priceHint: String(message.priceHint), issuedAt: Number(message.issuedAt), signature };
  };

  test("a listing signed by the payTo key is listed and shows in the Bazaar-shaped index; anything else is refused", async () => {
    const s = seller();
    const body = await listing(s);
    const r = await post("/facilitator/sellers", body);
    expect(r.status).toBe(201);
    const created = (await r.json()).data;
    expect(created).toMatchObject({ payTo: s.address, resource: body.resource, priceHint: "20000", tags: ["prices", "stocks"], listed: true });
    const found = await (await h.request(`/facilitator/discovery/resources?type=http&network=${NETWORK}&tag=stocks`)).json();
    expect(found.x402Version).toBe(2);
    const item = found.items.find((i: { resource: string }) => i.resource === body.resource);
    expect(item).toMatchObject({ type: "http", x402Version: 2, accepts: [{ scheme: "exact", network: NETWORK, amount: "20000", asset: USDG, payTo: s.address }], metadata: { sellerId: created.id, tags: ["prices", "stocks"] } });
    const v1 = await (await h.request(`/facilitator/discovery/resources?type=http&x402Version=1`)).json();
    expect(v1.items.find((i: { resource: string }) => i.resource === body.resource).accepts[0]).toMatchObject({ maxAmountRequired: "20000", resource: body.resource, outputSchema: { type: "object" } });
    expect((await (await h.request(`/facilitator/discovery/resources?network=eip155:1`)).json()).items).toEqual([]);
    // Signed by another key, or changed after signing: refused.
    expect((await post("/facilitator/sellers", await listing(s, { signer: seller() }))).status).toBe(401);
    expect((await post("/facilitator/sellers", { ...(await listing(s)), priceHint: "1" })).status).toBe(401);
    // Another payTo cannot take the resource; an older signature cannot replace a newer one.
    const other = seller();
    expect((await post("/facilitator/sellers", await listing(other, { resource: body.resource }))).status).toBe(409);
    expect((await post("/facilitator/sellers", await listing(s, { resource: body.resource, issuedAt: body.issuedAt - 10 }))).status).toBe(409);
    expect((await post("/facilitator/sellers", await listing(s, { resource: body.resource, issuedAt: Number(now()) - 3600 }))).status).toBe(400);
    // The owner unlists it with a later signature.
    const off = await post("/facilitator/sellers", await listing(s, { resource: body.resource, listed: false, issuedAt: body.issuedAt + 1 }));
    expect(off.status).toBe(200);
    const after = await (await h.request(`/facilitator/discovery/resources?tag=stocks`)).json();
    expect(after.items.some((i: { resource: string }) => i.resource === body.resource)).toBe(false);
  });

  test("below the minimum, a seller's prepaid gas float pays for the relay and is debited at measured gas x buffer", async () => {
    const s = seller();
    const resource = `https://float-${randomBytes(3).toString("hex")}.example/tick`;
    const sellerId = (await (await post("/facilitator/sellers", await listing(s, { resource, priceHint: "1000" }))).json()).data.id;
    const tiny = await payment({ payTo: s.address, amount: 1_000n, resource });
    expect((await (await post("/facilitator/settle", tiny.v1)).json()).errorReason).toBe("payment_below_facilitator_minimum");
    // Fund the float: any wallet signs an exact payment to the treasury.
    const funder = privateKeyToAccount(generatePrivateKey());
    const top = await sign(funder, { to: TREASURY, value: 50_000n });
    const funded = await (await post(`/facilitator/sellers/${sellerId}/gas-float`, { paymentPayload: { x402Version: 1, scheme: "exact", network: NETWORK, payload: { signature: top.signature, authorization: str(top.auth) } } })).json();
    expect(funded.success).toBe(true);
    expect(h.chain.x402Relays.at(-1)).toMatchObject({ from: funder.address, to: TREASURY, value: 50_000n, role: "facilitator" });
    expect((await (await h.request(`/facilitator/sellers/${sellerId}`)).json()).data.gasFloat).toEqual({ balance: "50000", funded: "50000", debited: "0" });
    const again = await payment({ payTo: s.address, amount: 1_000n, resource });
    const settled = await (await post("/facilitator/settle", again.v1)).json();
    expect(settled).toMatchObject({ success: true });
    // 80,000 gas x 0.01 gwei x 2500 USDG/ETH x 1.5 = 0.003 USDG.
    const [row] = await h.ctx.db.select().from(facilitatorSettlements).where(eq(facilitatorSettlements.id, settled.receipt.id));
    expect(row.gasDebit).toBe(3_000n);
    expect(row.sellerId).toBe(sellerId);
    const [float] = await h.ctx.db.select().from(sellerGasFloats).where(eq(sellerGasFloats.sellerId, sellerId));
    expect(float).toMatchObject({ balance: 47_000n, funded: 50_000n, debited: 3_000n });
    // A float too small for the next settle's estimate (120,000 gas: 0.0045 USDG) no longer covers it.
    await h.ctx.db.update(sellerGasFloats).set({ balance: 4_000n }).where(eq(sellerGasFloats.sellerId, sellerId));
    expect((await (await post("/facilitator/verify", (await payment({ payTo: s.address, amount: 1_000n, resource })).v1)).json()).invalidReason).toBe("payment_below_facilitator_minimum");
  });
});

describe("facilitator rate limits", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: facilitatorEnv({ FACILITATOR_PAYER_PER_MIN: "2", FACILITATOR_SELLER_PER_MIN: "3", FACILITATOR_RPM: "8", FACILITATOR_LISTINGS_PER_HOUR: "1" }) });
  });
  afterAll(async () => h.close());
  const post = (path: string, json: unknown) => h.request(path, { method: "POST", json });

  test("per payer, per seller and per address buckets refuse with 429 and Retry-After", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const payTo = seller().address;
    const first = await payment({ payer, payTo, amount: 20_000n });
    expect((await post("/facilitator/verify", first.v1)).status).toBe(200);
    expect((await post("/facilitator/verify", first.v1)).status).toBe(200);
    const third = await post("/facilitator/verify", first.v1);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await third.json()).toMatchObject({ isValid: false, invalidReason: "rate_limited", payer: payer.address });
    // A different payer still gets through until the seller's bucket (3 per minute) is spent.
    expect((await post("/facilitator/verify", (await payment({ payTo, amount: 20_000n })).v1)).status).toBe(200);
    const s = await post("/facilitator/settle", (await payment({ payTo, amount: 20_000n })).v1);
    expect(s.status).toBe(429);
    expect((await s.json()).errorReason).toBe("rate_limited");
    expect(h.chain.x402Relays).toHaveLength(0);
    // The caller's address bucket (8 per minute) covers every facilitator route.
    let last = 200;
    for (let i = 0; i < 6 && last !== 429; i++) last = (await h.request("/facilitator/supported")).status;
    expect(last).toBe(429);
  });

  test("listing updates are limited per payTo", async () => {
    const h2 = await startRouter({ env: facilitatorEnv({ FACILITATOR_LISTINGS_PER_HOUR: "1" }) });
    try {
      const s = seller();
      const sign1 = async (resource: string) => {
        const message = { payTo: s.address, resource, priceHint: 0n, outputSchema: "", tags: [] as string[], listed: true, issuedAt: now() };
        return { ...message, priceHint: "0", issuedAt: Number(message.issuedAt), signature: await s.signTypedData({ domain: listingDomain(4663), types: LISTING_TYPES, primaryType: "SellerListing", message }) };
      };
      expect((await h2.request("/facilitator/sellers", { method: "POST", json: await sign1("https://a.example/x") })).status).toBe(201);
      expect((await h2.request("/facilitator/sellers", { method: "POST", json: await sign1("https://a.example/y") })).status).toBe(429);
    } finally {
      await h2.close();
    }
  });
});

describe("facilitator fee and screening", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: facilitatorEnv({ FACILITATOR_FEE_BPS: "100", SANCTIONS_SCREENING_ENABLED: "true" }) });
    const listDate = new Date(Date.now() - 86_400_000);
    await h.ctx.db.insert(sanctionsMeta).values({ id: 1, listDate, sourceHash: "fixture", entryCount: 1, ignoredCount: 0, refreshedAt: new Date() });
  });
  afterAll(async () => h.close());
  const post = (path: string, json: unknown) => h.request(path, { method: "POST", json });

  test("with a fee, a second authorization to the treasury is required and relayed after the payment", async () => {
    const payTo = seller().address;
    const none = await payment({ payTo, amount: 100_000n });
    expect((await (await post("/facilitator/verify", none.v2)).json()).invalidReason).toBe("facilitator_fee_required");
    const short = await payment({ payTo, amount: 100_000n, fee: { amount: 999n, payTo: TREASURY } });
    expect((await (await post("/facilitator/verify", short.v2)).json()).invalidReason).toBe("facilitator_fee_required");
    const p = await payment({ payTo, amount: 100_000n, fee: { amount: 1_000n, payTo: TREASURY } });
    const j = await (await post("/facilitator/settle", p.v2)).json();
    expect(j.success).toBe(true);
    const [main, fee] = h.chain.x402Relays.slice(-2);
    expect(main).toMatchObject({ from: p.payer.address, to: payTo, value: 100_000n });
    expect(fee).toMatchObject({ from: p.payer.address, to: TREASURY, value: 1_000n, role: "facilitator" });
    const claims = (await (await h.request(`/facilitator/receipts/${j.receipt.id}`)).json()).data.claims;
    expect(claims.fee).toEqual({ value: "1000", tx: fee.hash });
    expect((await (await h.request("/facilitator/supported")).json()).policy.screening.listings).toBe("ofac_sdn");
  });

  test("a sanctioned payTo cannot be listed; payers are not screened", async () => {
    const s = seller();
    await h.ctx.db.insert(sanctionsAddresses).values({ address: s.address.toLowerCase(), listDate: new Date(Date.now() - 86_400_000), sourceHash: "fixture" });
    const message = { payTo: s.address, resource: "https://listed.example/x", priceHint: 0n, outputSchema: "", tags: [] as string[], listed: true, issuedAt: now() };
    const signature = await s.signTypedData({ domain: listingDomain(4663), types: LISTING_TYPES, primaryType: "SellerListing", message });
    const r = await post("/facilitator/sellers", { ...message, priceHint: "0", issuedAt: Number(message.issuedAt), signature });
    expect(r.status).toBe(403);
    expect((await r.json()).error.type).toBe("sanctioned_address");
    expect(await h.ctx.db.select().from(facilitatorSellers).where(eq(facilitatorSellers.payTo, s.address.toLowerCase()))).toHaveLength(0);
    // The same address can still pay through the facilitator: settlement screens nobody.
    const p = await payment({ payer: s, payTo: seller().address, amount: 100_000n, fee: { amount: 1_000n, payTo: TREASURY } });
    expect((await (await post("/facilitator/verify", p.v1)).json()).isValid).toBe(true);
  });
});

describe("one code path: the router's own x402 and the facilitator", () => {
  test("the router's x402 payment is checked by the facilitator's code and relayed with the router key; the same authorization is then spent for both", async () => {
    const payTo = "0x00000000000000000000000000000000000d0402";
    const h = await startRouter({ env: { ...facilitatorEnv(), X402_PAY_TO: payTo } });
    h.chain.noCallPay = true;
    try {
      expect(X402_TYPES).toBe(EIP3009_TYPES);
      const json = { model: "meta-llama/llama-3.3-70b-instruct", max_tokens: 50, messages: [{ role: "user", content: "one path" }] };
      const req = (await (await h.request("/api/v1/chat/completions", { method: "POST", json })).json()).accepts[0] as Req;
      const late = await xPayment(req, { validBefore: now() + 5n });
      expect((await (await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": late.header }, json })).json()).error).toBe("invalid_exact_evm_payload_authorization_valid_before");
      const pay = await xPayment(req);
      expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-payment": pay.header }, json })).status).toBe(200);
      expect(h.chain.x402Relays.at(-1)).toMatchObject({ nonce: pay.authorization.nonce, role: "router" });
      // Offered to the facilitator afterwards, the spent authorization is refused there too.
      const signature = JSON.parse(Buffer.from(pay.header, "base64").toString()).payload.signature;
      const body = { paymentPayload: { x402Version: 1, scheme: "exact", network: NETWORK, payload: { signature, authorization: str(pay.authorization as Auth) } }, paymentRequirements: { ...req, network: NETWORK } };
      expect((await (await h.request("/facilitator/verify", { method: "POST", json: body })).json()).invalidReason).toBe("invalid_exact_evm_payload_authorization_nonce_used");
    } finally {
      await h.close();
    }
  });
});

describe("facilitator configuration", () => {
  test("off by default, and every route says so", async () => {
    expect(loadConfig({}).facilitator).toMatchObject({ enabled: false, feeBps: 0, minSettle: 10_000n, gasFloat: null });
    const h = await startRouter();
    try {
      const r = await h.request("/facilitator/supported");
      expect(r.status).toBe(503);
      expect((await r.json()).error.type).toBe("facilitator_disabled");
      expect((await (await h.request("/api/v1/status")).json()).data.facilitator).toMatchObject({ enabled: false, url: null, relay: null });
    } finally {
      await h.close();
    }
  });

  test("the relay key is required, must hold no other role, and fees and floats need a treasury", () => {
    const key = generatePrivateKey();
    expect(() => loadConfig({ FACILITATOR_ENABLED: "true" })).toThrow(/FACILITATOR_RELAY_PRIVATE_KEY/);
    expect(() => loadConfig({ FACILITATOR_ENABLED: "true", FACILITATOR_RELAY_PRIVATE_KEY: key, ROUTER_PRIVATE_KEY: key })).toThrow(/no other signing role/);
    expect(() => loadConfig({ FACILITATOR_ENABLED: "true", FACILITATOR_RELAY_PRIVATE_KEY: key, FACILITATOR_FEE_BPS: "50" })).toThrow(/FACILITATOR_TREASURY/);
    expect(() => loadConfig({ FACILITATOR_ENABLED: "true", FACILITATOR_RELAY_PRIVATE_KEY: key, FACILITATOR_ETH_USDG: "2500" })).toThrow(/FACILITATOR_TREASURY/);
    expect(() => loadConfig({ FACILITATOR_MIN_SETTLE: "0.0000001" })).toThrow();
    expect(loadConfig({ FACILITATOR_MIN_SETTLE: "0.05" }).facilitator.minSettle).toBe(50_000n);
    const c = loadConfig({ FACILITATOR_ENABLED: "true", FACILITATOR_RELAY_PRIVATE_KEY: key });
    expect(c.facilitator.relayAddress).toBe(privateKeyToAccount(key).address.toLowerCase() as Hex);
  });
});

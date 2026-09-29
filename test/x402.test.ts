import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { startRouter, type Harness } from "./helpers.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { quotes } from "../src/db/schema.ts";
import { X402_TYPES } from "../src/pay/x402.ts";
import { usdgToPico } from "../src/lib/money.ts";
import { loadConfig } from "../src/config.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const PAY_TO = "0x00000000000000000000000000000000000d0402";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const CHAT = "/api/v1/chat/completions";
const acct = (a: string) => `w_${a.slice(2).toLowerCase()}`;
const chatBody = (content: string, extra: Record<string, unknown> = {}) => ({ model: LLAMA, max_tokens: 50, messages: [{ role: "user", content }], ...extra });

type Req = { scheme: string; network: string; maxAmountRequired: string; resource: string; description: string; mimeType: string; payTo: Hex; maxTimeoutSeconds: number; asset: Hex; extra: { name: string; version: string; chainId: number } };

/** What an x402 client does: sign the requirement's EIP-3009 authorization and base64 it into X-PAYMENT. */
async function xPayment(req: Req, o: { signer?: PrivateKeyAccount; from?: Hex; to?: Hex; value?: bigint; validAfter?: bigint; validBefore?: bigint; nonce?: Hex; network?: string; version?: number } = {}) {
  const signer = o.signer ?? privateKeyToAccount(generatePrivateKey());
  const authorization = {
    from: o.from ?? signer.address,
    to: o.to ?? req.payTo,
    value: o.value ?? BigInt(req.maxAmountRequired),
    validAfter: o.validAfter ?? 0n,
    validBefore: o.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds),
    nonce: o.nonce ?? (`0x${randomBytes(32).toString("hex")}` as Hex),
  };
  const signature = await signer.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: req.extra.chainId, verifyingContract: req.asset },
    types: X402_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const payload = { x402Version: o.version ?? 1, scheme: "exact", network: o.network ?? req.network, payload: { signature, authorization: { ...authorization, value: String(authorization.value), validAfter: String(authorization.validAfter), validBefore: String(authorization.validBefore) } } };
  return { header: Buffer.from(JSON.stringify(payload)).toString("base64"), signer, authorization };
}

describe("x402 (exact scheme, USDG on Robinhood Chain)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { X402_PAY_TO: PAY_TO } });
    h.chain.noCallPay = true;
  });
  afterAll(async () => h.close());

  const unpaid = async (path = CHAT, json: unknown = chatBody("x402 " + randomBytes(4).toString("hex"))) => {
    const r = await h.request(path, { method: "POST", json });
    expect(r.status).toBe(402);
    const body = await r.json();
    return { json, body, req: body.accepts[0] as Req };
  };
  const send = (json: unknown, header: string, path = CHAT) => h.request(path, { method: "POST", headers: { "x-payment": header }, json });

  test("/status reports x402 as configured with its network name", async () => {
    const per = (await (await h.request("/api/v1/status")).json()).data.per_call;
    expect(per.configured).toBe(true);
    expect(per.x402.configured).toBe(true);
    expect(per.x402.network).toBe("robinhood-chain");
  });

  test("unpaid request -> 402 x402 body with one exact requirement priced by the per-call logic", async () => {
    const r = await h.request(CHAT, { method: "POST", json: chatBody("shape") });
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(body.x402Version).toBe(1);
    expect(typeof body.error).toBe("string");
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toEqual({
      scheme: "exact",
      network: "robinhood-chain",
      maxAmountRequired: expect.stringMatching(/^[1-9]\d*$/),
      resource: `${h.ctx.cfg.publicUrl}${CHAT}`,
      description: expect.stringContaining("inference"),
      mimeType: "application/json",
      payTo: getAddress(PAY_TO),
      maxTimeoutSeconds: 300,
      asset: USDG,
      extra: { name: "Global Dollar", version: "1", chainId: 4663 },
    });
    // The /v1 alias resolves to its own resource.
    expect((await (await h.request("/v1/chat/completions", { method: "POST", json: chatBody("alias") })).json()).accepts[0].resource).toBe(`${h.ctx.cfg.publicUrl}/v1/chat/completions`);
    // Nothing is quoted or settled for an unpaid call.
    expect(h.chain.x402Relays).toHaveLength(0);
  });

  test("a valid X-PAYMENT is verified, settled to payTo, served with X-PAYMENT-RESPONSE and a receipt showing payment_tx", async () => {
    const { json, req } = await unpaid();
    const pay = await xPayment(req);
    const r = await send(json, pay.header);
    expect(r.status).toBe(200);
    const settled = h.chain.x402Relays.at(-1)!;
    expect(settled).toMatchObject({ from: pay.signer.address, to: req.payTo, value: BigInt(req.maxAmountRequired), nonce: pay.authorization.nonce });
    const resp = JSON.parse(Buffer.from(r.headers.get("x-payment-response")!, "base64").toString());
    expect(resp).toEqual({ success: true, transaction: settled.hash, network: "robinhood-chain", payer: pay.signer.address.toLowerCase() });
    const j = await r.json();
    expect(j.receipt.payload.mode).toBe("per_call");
    expect(j.receipt.payload.payment_tx).toBe(settled.hash);
    expect(j.receipt.payload.payer).toBe(pay.signer.address.toLowerCase());
    expect(j.usage.cost_details.margin).toBeGreaterThan(0);
    // The whole payment is credited to the payer's wallet account; the call spent `cost`, the rest is change.
    const cost = BigInt(Math.round(j.usage.cost * 1e12));
    expect((await balanceOf(h.ctx.db, acct(pay.signer.address))).balance).toBe(usdgToPico(BigInt(req.maxAmountRequired)) - cost);
    const [claim] = await h.ctx.db.select().from(quotes).where(eq(quotes.txHash, settled.hash));
    expect(claim).toMatchObject({ status: "used", payer: pay.signer.address.toLowerCase() });
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("the eip155:<chain id> network name is accepted too, and a streamed call carries the header", async () => {
    const { json, req } = await unpaid(CHAT, chatBody("stream me", { stream: true }));
    const r = await send(json, (await xPayment(req, { network: "eip155:4663" })).header);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(JSON.parse(Buffer.from(r.headers.get("x-payment-response")!, "base64").toString()).success).toBe(true);
    await r.text();
  });

  test("overpayment is credited in full as wallet change", async () => {
    const { json, req } = await unpaid();
    const pay = await xPayment(req, { value: BigInt(req.maxAmountRequired) + 5_000n });
    const r = await send(json, pay.header);
    expect(r.status).toBe(200);
    const cost = BigInt(Math.round((await r.json()).usage.cost * 1e12));
    expect((await balanceOf(h.ctx.db, acct(pay.signer.address))).balance).toBe(usdgToPico(BigInt(req.maxAmountRequired) + 5_000n) - cost);
  });

  test("a replayed authorization is rejected and settles nothing twice", async () => {
    const { json, req } = await unpaid();
    const pay = await xPayment(req);
    expect((await send(json, pay.header)).status).toBe(200);
    const relays = h.chain.x402Relays.length;
    const again = await send(json, pay.header);
    expect(again.status).toBe(402);
    const b = await again.json();
    expect(b.error).toBe("invalid_exact_evm_payload_authorization_nonce_used");
    expect(b.x402Version).toBe(1);
    expect(b.accepts).toHaveLength(1);
    // Even if the chain has not caught up, the durable claim on (payer, nonce) refuses a second settlement.
    h.chain.usedAuthorizations.clear();
    const raced = await send(json, pay.header);
    expect(raced.status).toBe(402);
    expect((await raced.json()).error).toBe("invalid_exact_evm_payload_authorization_nonce_used");
    expect(h.chain.x402Relays.length).toBe(relays);
  });

  test("underpayment is rejected before anything moves", async () => {
    const { json, req } = await unpaid();
    const pay = await xPayment(req, { value: BigInt(req.maxAmountRequired) - 1n });
    const r = await send(json, pay.header);
    expect(r.status).toBe(402);
    const b = await r.json();
    expect(b.error).toBe("invalid_exact_evm_payload_authorization_value");
    expect(b.accepts[0].maxAmountRequired).toBe(req.maxAmountRequired);
    expect(h.chain.x402Relays.some((x) => x.nonce === pay.authorization.nonce)).toBe(false);
    expect((await balanceOf(h.ctx.db, acct(pay.signer.address))).balance).toBe(0n);
  });

  test("a payment to the wrong payTo is rejected", async () => {
    const { json, req } = await unpaid();
    const pay = await xPayment(req, { to: "0x000000000000000000000000000000000000dEaD" });
    const r = await send(json, pay.header);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("invalid_exact_evm_payload_recipient_mismatch");
    expect(h.chain.x402Relays.some((x) => x.nonce === pay.authorization.nonce)).toBe(false);
  });

  test("bad signature, expired window, wrong network and insufficient funds are rejected", async () => {
    const { json, req } = await unpaid();
    const reasons: [Awaited<ReturnType<typeof xPayment>>, string][] = [
      [await xPayment(req, { from: privateKeyToAccount(generatePrivateKey()).address }), "invalid_exact_evm_payload_signature"], // signed by someone else
      [await xPayment(req, { validBefore: BigInt(Math.floor(Date.now() / 1000) - 5) }), "invalid_exact_evm_payload_authorization_valid_before"],
      [await xPayment(req, { validAfter: BigInt(Math.floor(Date.now() / 1000) + 3600) }), "invalid_exact_evm_payload_authorization_valid_after"],
      [await xPayment(req, { network: "base" }), "invalid_network"],
      [await xPayment(req, { version: 2 }), "invalid_x402_version"],
    ];
    const poor = await xPayment(req);
    h.chain.usdgBalances.set(poor.signer.address.toLowerCase(), 0n);
    reasons.push([poor, "insufficient_funds"]);
    for (const [pay, reason] of reasons) {
      const r = await send(json, pay.header);
      expect(r.status).toBe(402);
      expect((await r.json()).error).toBe(reason);
    }
    expect(h.chain.x402Relays.some((x) => reasons.some(([p]) => p.authorization.nonce === x.nonce))).toBe(false);
  });

  test("a failed settlement is a 402 and burns the authorization; malformed headers are 400", async () => {
    const { json, req } = await unpaid();
    const pay = await xPayment(req);
    h.chain.failX402Relay = true;
    const failed = await send(json, pay.header);
    h.chain.failX402Relay = false;
    expect(failed.status).toBe(402);
    expect((await failed.json()).error).toBe("settle_exact_failed");
    const [row] = await h.ctx.db.select().from(quotes).where(eq(quotes.nonce, `x402:${pay.authorization.from}:${pay.authorization.nonce}`.toLowerCase()));
    expect(row.status).toBe("failed");
    expect((await send(json, pay.header)).status).toBe(402);
    expect((await balanceOf(h.ctx.db, acct(pay.signer.address))).balance).toBe(0n);
    const bad = await send(json, Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "robinhood-chain", payload: { signature: "0x12", authorization: { from: "nope" } } })).toString("base64"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.type).toBe("invalid_payment");
  });

  test("embeddings: 402 with x402 requirements, then a paid call with a receipt", async () => {
    const { json, req, body } = await unpaid("/api/v1/embeddings", { model: "acme/embed-small", input: ["pay per embedding"] });
    expect(body.x402Version).toBe(1);
    expect(req.resource).toBe(`${h.ctx.cfg.publicUrl}/api/v1/embeddings`);
    const pay = await xPayment(req);
    const r = await send(json, pay.header, "/api/v1/embeddings");
    expect(r.status).toBe(200);
    const settled = h.chain.x402Relays.at(-1)!;
    expect(JSON.parse(Buffer.from(r.headers.get("x-payment-response")!, "base64").toString())).toMatchObject({ success: true, transaction: settled.hash, payer: pay.signer.address.toLowerCase() });
    const j = await r.json();
    expect(j.data.length).toBeGreaterThan(0);
    expect(j.receipt.payload).toMatchObject({ mode: "per_call", payment_tx: settled.hash, payer: pay.signer.address.toLowerCase() });
    // Replaying the payment on embeddings is refused too.
    expect((await send(json, pay.header, "/api/v1/embeddings")).status).toBe(402);
  });
});

describe("x402 beside the CallPay flow", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter({ env: { X402_PAY_TO: PAY_TO } })));
  afterAll(async () => h.close());

  test("the 402 keeps the CallPay envelope and adds the x402 fields; both are priced identically", async () => {
    const r = await h.request(CHAT, { method: "POST", json: chatBody("both flows") });
    expect(r.status).toBe(402);
    const b = await r.json();
    const units = b.error.metadata.price_usdg_units;
    expect(b.error.type).toBe("payment_required");
    expect(units).toMatch(/^\d+$/);
    expect(b.error.metadata.pay_to).toMatch(/^0x/);
    expect(b.x402Version).toBe(1);
    expect(b.accepts[0].maxAmountRequired).toBe(units);
    expect(b.accepts[0].payTo).toBe(getAddress(PAY_TO));
    expect(r.headers.get("x-payment-required")).toBe("usdg");
  });

  test("a CallPay tx hash still pays, and an x402 payment works on the same router", async () => {
    const body = chatBody("mixed");
    const b = await (await h.request(CHAT, { method: "POST", json: body })).json();
    const paid = await h.request(CHAT, { method: "POST", headers: { "x-payment": (await xPayment(b.accepts[0])).header }, json: body });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("x-payment-response")).toBeTruthy();
    expect((await paid.json()).receipt.payload.payment_tx).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("x402 off", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("without X402_PAY_TO the 402 is the plain CallPay quote and an x402 payment is refused", async () => {
    const body = chatBody("off");
    const r = await h.request(CHAT, { method: "POST", json: body });
    expect(r.status).toBe(402);
    const b = await r.json();
    expect(b.x402Version).toBeUndefined();
    expect(b.accepts).toBeUndefined();
    expect((await (await h.request("/api/v1/status")).json()).data.per_call.x402.configured).toBe(false);
    const req = { scheme: "exact", network: "robinhood-chain", maxAmountRequired: "1", resource: "", description: "", mimeType: "", payTo: PAY_TO as Hex, maxTimeoutSeconds: 300, asset: USDG as Hex, extra: { name: "Global Dollar", version: "1", chainId: 4663 } };
    const x = await h.request(CHAT, { method: "POST", headers: { "x-payment": (await xPayment(req)).header }, json: body });
    expect(x.status).toBe(400);
    expect((await x.json()).error.type).toBe("x402_unavailable");
  });
});

describe("x402 configuration", () => {
  const address = "0x" + "1".repeat(40);
  const prod = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64) };

  test("x402 is off by default, needs a real payTo, and a production API needs the router role to relay", () => {
    expect(loadConfig({}).x402).toEqual({ payTo: undefined, network: "robinhood-chain" });
    expect(loadConfig({ X402_PAY_TO: PAY_TO.toUpperCase().replace("0X", "0x") }).x402.payTo).toBe(PAY_TO);
    expect(() => loadConfig({ X402_PAY_TO: "0x" + "0".repeat(40) })).toThrow(/zero address/);
    expect(loadConfig({ ...prod, X402_PAY_TO: PAY_TO }).x402.payTo).toBe(PAY_TO);
    expect(() => loadConfig({ ...prod, X402_PAY_TO: PAY_TO, ROUTER_PRIVATE_KEY: "" })).toThrow();
  });
});

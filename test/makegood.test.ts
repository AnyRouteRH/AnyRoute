import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADMIN, MODELS, sse, startRouter, type Harness } from "./helpers.ts";
import { generations, keys, ledger, providers } from "../src/db/schema.ts";
import { makegoodPayouts, makegoodRefunds } from "../src/services/makegood-schema.ts";
import { ISSUE_DELAY_MS, issueRefund, makegoodStatus, noteUnparseableRepair, runMakegood, runMakegoodPayouts, servedRules, type RefundTransport, type ServedFacts } from "../src/services/makegood.ts";
import { hostSlashEvidence } from "../src/network/bond-schema.ts";
import { webhookDeliveries } from "../src/webhooks/schema.ts";
import { runWebhooks } from "../src/webhooks/worker.ts";
import { verifyWebhook } from "../src/webhooks/signature.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { X402_TYPES } from "../src/pay/x402.ts";
import { usdgToPico } from "../src/lib/money.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { loadConfig } from "../src/config.ts";

// V6 R: make-good refunds. One test per rule, plus idempotency, the charge cap, the signed webhook and the refund receipt.

const LLAMA = MODELS.llama.slug;
const QWEN = MODELS.qwen.slug;
const ENCLAVE = { id: "enclave-model", slug: "makegood/enclave-model", prompt: "0.0000002", completion: "0.0000005" };
const CHAT = "/api/v1/chat/completions";
const PAY_TO = "0x00000000000000000000000000000000000d0402";
const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };
const later = () => new Date(Date.now() + ISSUE_DELAY_MS + 60_000);
let reply: ((prompt: string) => string | undefined) | null = null;

let h: Harness;
beforeAll(async () => {
  h = await startRouter({
    env: { MAKEGOOD_ENABLED: "true", WEBHOOK_SIGNING_ENABLED: "true", ROUTE_EXPLAIN_ENABLED: "true", STRUCTURED_OUTPUT_CHECK_ENABLED: "true", X402_PAY_TO: PAY_TO, NETWORK_BONDS_ENABLED: "true", HOST_BOND_ADDRESS: `0x${"1".repeat(40)}`, HOST_BOND_START_BLOCK: "1" },
    providers: [
      { id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.qwen], reply: (prompt) => reply?.(prompt) },
      { id: "beta", name: "Beta", models: [MODELS.llamaPricey] },
      { id: "enclave", name: "Enclave", models: [ENCLAVE], tee: "dev" },
    ],
  });
  h.chain.noCallPay = true;
});
afterAll(async () => h.close());
afterEach(() => {
  reply = null;
  for (const m of Object.values(h.mocks)) Object.assign(m.cfg, { behaviour: "ok", delayMs: 0 });
});

const chat = (key: { auth: Record<string, string> }, json: Record<string, unknown>) => h.request(CHAT, { method: "POST", headers: key.auth, json: { messages: [{ role: "user", content: "make good " + randomBytes(4).toString("hex") }], max_tokens: 50, ...json } });
const refundFor = async (source: string) => (await h.ctx.db.select().from(makegoodRefunds).where(eq(makegoodRefunds.sourceId, source)))[0];
const makegoodLines = (source: string) => h.ctx.db.select().from(ledger).where(like(ledger.ref, `makegood%:${source}`));
const generation = async (id: string) => (await h.ctx.db.select().from(generations).where(eq(generations.id, id)))[0]!;

/** A failover from alpha (cheap, failing) to beta (pricier). */
async function fallbackCall(key: { auth: Record<string, string> }) {
  // Earlier failures would mark alpha as down, and a provider skipped for health is no failover.
  (h.ctx.health as unknown as { recent: Map<string, unknown> }).recent.clear();
  h.mocks.alpha.cfg.behaviour = "error500";
  const r = await chat(key, { model: LLAMA, provider: { order: ["alpha", "beta"] } });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.receipt.payload.provider).toBe("beta");
  expect(j.receipt.payload.route.reason).toBe("fallback");
  h.mocks.alpha.cfg.behaviour = "ok";
  return j;
}

describe("rule: failover to a pricier provider refunds the price difference", () => {
  let key: Awaited<ReturnType<Harness["fundedKey"]>>;
  let id = "";
  let secret = "";
  let destination = "";
  beforeAll(async () => {
    key = await h.fundedKey(10n);
    const d = await (await h.request("/api/v1/webhooks", { method: "POST", headers: key.auth, json: { webhook_url: "https://hooks.example.com/refunds", events: ["refund.issued"] } })).json();
    secret = d.signing_secret;
    destination = d.data.id;
    id = (await fallbackCall(key)).id;
  });

  test("the difference for the same tokens, credited, linked to the generation and capped by the charge", async () => {
    const g = await generation(id);
    const pending = await refundFor(id);
    expect(pending).toMatchObject({ rule: "fallback_price", status: "pending", generationId: id, providerId: "alpha", strike: false });
    // Prepaid calls carry no margin: beta charges 0.4/0.8 and alpha 0.1/0.32 micro-USD per prompt/completion token.
    const expected = BigInt(g.tokensIn) * 300_000n + BigInt(g.tokensOut) * 480_000n;
    expect(pending.amount).toBe(expected);
    expect(g.cost).toBe(BigInt(g.tokensIn) * 400_000n + BigInt(g.tokensOut) * 800_000n);
    // Not issued before the delay that lets a later rule upgrade it.
    expect(await runMakegood(h.ctx)).toMatchObject({ issued: 0 });
    const before = await balanceOf(h.ctx.db, g.accountId!);
    expect(await runMakegood(h.ctx, later())).toMatchObject({ issued: 1 });
    const issued = await refundFor(id);
    expect(issued).toMatchObject({ status: "issued", amount: expected, charged: g.cost, payoutStatus: "none" });
    const lines = await makegoodLines(id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "refund", amount: expected, generationId: id, keyHash: g.keyHash });
    expect((await balanceOf(h.ctx.db, g.accountId!)).balance).toBe(before.balance + expected);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("the signed refund receipt names the original receipt and verifies like any receipt", async () => {
    const m = await refundFor(id);
    const r = await (await h.request(`/api/v1/receipts/${m.id}`)).json();
    expect(r.data.payload).toMatchObject({ v: 1, kind: "refund", id: m.id, original_receipt_id: id, generation_id: id, rule: "fallback_price", settlement: "credit", strike: false });
    expect(r.data.payload.amount).toBe(String(Number(m.amount) / 1e12));
    const v = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: r.data.payload, sig: r.data.sig, key_id: r.data.key_id } })).json();
    expect(v.data.signature_valid).toBe(true);
    // The original receipt is untouched and still resolves.
    expect((await (await h.request(`/api/v1/receipts/${id}`)).json()).data.payload.id).toBe(id);
  });

  test("refund.issued is queued with the refund for the account's destination, and delivered signed over the exact bytes", async () => {
    const m = await refundFor(id);
    const [d] = await h.ctx.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.destinationId, destination), eq(webhookDeliveries.event, "refund.issued")));
    expect(d).toMatchObject({ eventId: `refund:${m.id}`, reference: m.id, eventStatus: "fallback_price", status: "pending" });
    // The webhook worker signs and sends the queued reference, once.
    const sent: { body: string; headers: Headers }[] = [];
    const send = async (_url: string, init: RequestInit) => { sent.push({ body: String(init.body), headers: new Headers(init.headers) }); return new Response(null, { status: 204 }); };
    await runWebhooks(h.ctx, { send });
    await runWebhooks(h.ctx, { send });
    expect(sent).toHaveLength(1);
    expect((await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, d.id)))[0].status).toBe("delivered");
    expect(verifyWebhook(secret, sent[0].body, sent[0].headers.get("x-anyroute-signature")!)).toBe(true);
    expect(JSON.parse(sent[0].body)).toEqual({ id: `refund:${m.id}`, type: "refund.issued", at: m.issuedAt!.toISOString(), reference: m.id, status: "fallback_price", event_id: `refund:${m.id}` });
    expect(sent[0].headers.get("x-anyroute-event-id")).toBe(`refund:${m.id}`);
    // Only this account's destination hears about it.
    expect((await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.event, "refund.issued"))).every((x) => x.destinationId === destination)).toBe(true);
  });

  test("no double refund: a second run, a direct reissue, concurrent issues and a late rule change nothing", async () => {
    const before = await refundFor(id);
    expect(await runMakegood(h.ctx, later())).toMatchObject({ issued: 0 });
    expect(await issueRefund(h.ctx, before.id, later())).toBeNull();
    // A later, larger rule for the same call cannot reopen an issued refund.
    await noteUnparseableRepair(h.ctx, id, "not JSON", null);
    expect(await refundFor(id)).toEqual(before);
    await runMakegood(h.ctx, later());
    expect(await makegoodLines(id)).toHaveLength(1);
    // While still pending, the larger rule replaces the smaller one: still one refund for the call.
    const second = (await fallbackCall(key)).id;
    expect(await refundFor(second)).toMatchObject({ rule: "fallback_price", status: "pending" });
    await noteUnparseableRepair(h.ctx, second, "not JSON", null);
    const row = await refundFor(second);
    expect(row).toMatchObject({ rule: "structured_output", amount: (await generation(second)).cost, status: "pending" });
    // Two settlement workers racing on the same candidate issue it once.
    const results = await Promise.all([issueRefund(h.ctx, row.id, later()), issueRefund(h.ctx, row.id, later())]);
    expect(results.filter((r) => r?.status === "issued")).toHaveLength(1);
    expect(await makegoodLines(second)).toHaveLength(1);
  });

  test("the refund shows in activity next to the call, with its receipt", async () => {
    const m = await refundFor(id);
    const rows = (await (await h.request("/api/v1/activity?kind=balance", { headers: key.auth })).json()).data;
    const row = rows.find((r: any) => r.receipt_id === m.id);
    expect(row).toMatchObject({ title: "Make-good refund", kind: "balance", reference: "refund", model: LLAMA, receipt_url: `/api/v1/receipts/${m.id}` });
    const list = (await (await h.request("/api/v1/refunds", { headers: key.auth })).json()).data;
    expect(list.find((r: any) => r.id === m.id)).toMatchObject({ rule: "fallback_price", status: "issued", generation_id: id, settlement: "credit" });
  });
});

test("never refunds more than the ledger charged", async () => {
  const key = await h.fundedKey(10n);
  const id = (await fallbackCall(key)).id;
  const g = await generation(id);
  // Whatever a candidate claims, the issued amount is capped by the settlement line.
  await h.ctx.db.update(makegoodRefunds).set({ amount: g.cost * 10n }).where(eq(makegoodRefunds.sourceId, id));
  await runMakegood(h.ctx, later());
  const m = await refundFor(id);
  expect(m.amount).toBe(g.cost);
  expect(m.charged).toBe(g.cost);
  // The pure rules cap too.
  const offers = h.ctx.catalog.offers(g.modelId);
  const beta = offers.find((o) => o.providerId === "beta")!;
  const facts = { id, accountId: "a", keyHash: null, billingMode: "prepaid", paymentTx: null, payer: null, candidate: beta, model: h.ctx.catalog.resolve(LLAMA)!.model, attempts: [{ provider: "alpha", model: g.modelId, ok: false, error_kind: "http_5xx", latency_ms: 1 }, { provider: "beta", model: g.modelId, ok: true, latency_ms: 1 }], usage: { prompt: 1000, completion: 1000, reasoning: 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: false }, cost: {} as never, charged: 5n, priceMode: "prepaid", fees: { royaltyBps: 0, perCallMarginBps: 0, byokFeeBps: 0 }, isByok: false, batchDiscountBps: null, servedClass: "vendor-forwarded", upstreamAttested: null, attestedLane: false, lane: "public", finishReason: "stop", cancelled: false, stream: false } satisfies ServedFacts;
  expect(servedRules(facts, offers)).toEqual([expect.objectContaining({ rule: "fallback_price", amount: 5n })]);
});

test("rule: a stream the upstream ends before finish_reason refunds the billed output tokens it never delivered", async () => {
  const key = await h.fundedKey(10n);
  reply = () => "y".repeat(400);
  h.mocks.alpha.cfg.behaviour = "truncate_after_usage";
  const r = await chat(key, { model: QWEN, stream: true, max_tokens: 200 });
  const events = (await sse(r)).events;
  const id = events.find((e: any) => e.receipt)!.receipt.id;
  const g = await generation(id);
  // The provider reported usage for the whole answer; the router delivered two 6-character parts (3 tokens).
  expect(g.tokensOut).toBe(100);
  expect(g.finishReason).toBeNull();
  const m = await refundFor(id);
  expect(m).toMatchObject({ rule: "truncated_stream", providerId: "alpha", evidence: { billed_completion_tokens: 100, delivered_completion_tokens: 3, finish: null, provider_usage: true } });
  expect(m.amount).toBe(97n * 600_000n);
  await runMakegood(h.ctx, later());
  expect((await makegoodLines(id))[0]).toMatchObject({ kind: "refund", amount: 97n * 600_000n });
  // A stream billed only for what it delivered (no provider usage) has nothing undelivered to refund.
  h.mocks.alpha.cfg.behaviour = "midstream_error";
  const r2 = await chat(key, { model: QWEN, stream: true });
  const id2 = (await sse(r2)).events.find((e: any) => e.receipt)!.receipt.id;
  expect((await generation(id2)).finishReason).toBe("error");
  expect(await refundFor(id2)).toBeUndefined();
});

test("rule: JSON that still does not parse after the one repair refunds that repair call in full", async () => {
  const key = await h.fundedKey(10n);
  reply = () => "this is not JSON";
  const r = await chat(key, { model: QWEN, response_format: { type: "json_object" }, anyroute: { json_check: "repair" } });
  const j = await r.json();
  const calls = j.receipt.structured_output.calls;
  expect(calls).toHaveLength(2);
  expect(j.receipt.structured_output.valid).toBe(false);
  const [first, repair] = calls.map((c: any) => c.receipt.id);
  expect(await refundFor(first)).toBeUndefined();
  const m = await refundFor(repair);
  expect(m).toMatchObject({ rule: "structured_output", providerId: null, evidence: { check: "unparseable", first_call: first } });
  await runMakegood(h.ctx, later());
  expect(await refundFor(repair)).toMatchObject({ status: "issued", amount: (await generation(repair)).cost });
  // Valid JSON after a schema miss is not a parse failure.
  reply = () => '{"different": true}';
  const ok = await (await chat(key, { model: QWEN, response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object", required: ["a"], properties: { a: { type: "string" } } } } }, anyroute: { json_check: "repair" } })).json();
  expect(await refundFor(ok.receipt.structured_output.calls[1].receipt.id)).toBeUndefined();
});

test("rule: an attested-lane call settled without a fresh attestation refunds 100% and strikes the host", async () => {
  const key = await h.fundedKey(10n);
  expect((await h.request("/api/v1/disclosure/enclave", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } })).status).toBe(200);
  await runAttestor(h.ctx);
  const model = h.ctx.catalog.resolve(ENCLAVE.slug)!.model.id;
  // A fresh call in the attested lane is not made good.
  const fresh = await (await chat(key, { model: ENCLAVE.slug, provider: { lane: "attested" } })).json();
  expect(fresh.receipt.payload.disclosure).toBe("attested");
  expect(await refundFor(fresh.id)).toBeUndefined();
  // The attestation lapses while the call is in flight: selection was fail-closed, settlement is the belt and braces.
  h.mocks.enclave.cfg.delayMs = 300;
  const before = h.mocks.enclave.stats.requests;
  const pending = chat(key, { model: ENCLAVE.slug, provider: { lane: "attested" } });
  while (h.mocks.enclave.stats.requests === before) await new Promise((r) => setTimeout(r, 5));
  const cand = h.ctx.catalog.offers(model).find((o) => o.providerId === "enclave")!;
  const attestedAt = cand.provider.attestedAt;
  cand.provider.attestedAt = new Date(0);
  const j = await (await pending).json();
  cand.provider.attestedAt = attestedAt;
  expect(j.receipt.payload.lane).toBe("attested");
  expect(j.receipt.payload.disclosure).not.toBe("attested");
  const g = await generation(j.id);
  expect(await refundFor(j.id)).toMatchObject({ rule: "unattested_lane", amount: g.cost, strike: true, providerId: "enclave", evidence: { lane: "attested", upstream_attested: null } });
  // A host that causes a refund feeds the slashing evidence, for review only.
  await h.ctx.db.update(providers).set({ networkHost: true }).where(eq(providers.id, "enclave"));
  try { await runMakegood(h.ctx, later()); }
  finally { await h.ctx.db.update(providers).set({ networkHost: false }).where(eq(providers.id, "enclave")); }
  const m = await refundFor(j.id);
  expect(m).toMatchObject({ status: "issued", amount: g.cost, strike: true });
  const evidence = await h.ctx.db.select().from(hostSlashEvidence).where(eq(hostSlashEvidence.providerId, "enclave"));
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({ status: "review", reason: -1 });
  expect(JSON.parse(evidence[0].canonical)).toMatchObject({ kind: "makegood_refund", provider_id: "enclave", reason: null });
  const status = (await (await h.request("/api/v1/status")).json()).data.makegood;
  expect(status).toMatchObject({ enabled: true, host_strikes: 1 });
});

describe("rule: a per-call payment for a request no provider served is refunded in full, on-chain", () => {
  type Req = { maxAmountRequired: string; payTo: Hex; maxTimeoutSeconds: number; asset: Hex; network: string; extra: { name: string; version: string; chainId: number } };
  const signer = privateKeyToAccount(generatePrivateKey());
  const wallet = signer.address.toLowerCase();
  let paid = 0n;
  let source = "";
  const transfers: { to: Hex; units: bigint }[] = [];
  const broadcasts: Hex[] = [];
  let mined: "success" | "reverted" | null = "success";
  const transport: RefundTransport = {
    prepare: async (to, units) => { transfers.push({ to, units }); const raw = `0x${randomBytes(40).toString("hex")}` as Hex; return { raw, hash: `0x${randomBytes(32).toString("hex")}` as Hex }; },
    broadcast: async (raw) => { broadcasts.push(raw); },
    outcome: async (_hash, waitMs) => (waitMs === 0 && mined === null ? null : mined),
  };

  beforeAll(async () => {
    const body = { model: LLAMA, max_tokens: 50, messages: [{ role: "user", content: "pay " + randomBytes(4).toString("hex") }] };
    const req = (await (await h.request(CHAT, { method: "POST", json: body })).json()).accepts[0] as Req;
    const authorization = { from: signer.address, to: req.payTo, value: BigInt(req.maxAmountRequired), validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds), nonce: `0x${randomBytes(32).toString("hex")}` as Hex };
    const signature = await signer.signTypedData({ domain: { name: req.extra.name, version: req.extra.version, chainId: req.extra.chainId, verifyingContract: req.asset }, types: X402_TYPES, primaryType: "TransferWithAuthorization", message: authorization });
    const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization: { ...authorization, value: String(authorization.value), validAfter: "0", validBefore: String(authorization.validBefore) } } })).toString("base64");
    h.mocks.alpha.cfg.behaviour = "error500";
    h.mocks.beta.cfg.behaviour = "error500";
    const r = await h.request(CHAT, { method: "POST", headers: { "x-payment": header }, json: body });
    expect(r.status).toBe(502);
    paid = BigInt(req.maxAmountRequired);
    source = `payment:${h.chain.x402Relays.at(-1)!.hash}`;
  });

  test("the payment sat as change; the refund moves all of it back on-chain and records the obligation", async () => {
    const account = `w_${wallet.slice(2)}`;
    expect((await balanceOf(h.ctx.db, account)).balance).toBe(usdgToPico(paid));
    expect(await refundFor(source)).toMatchObject({ rule: "upstream_failure", status: "pending", payer: wallet, evidence: { error_classes: { http_5xx: expect.any(Number) } } });
    await runMakegood(h.ctx, later());
    const m = await refundFor(source);
    expect(m).toMatchObject({ status: "issued", amount: usdgToPico(paid), charged: usdgToPico(paid), onchainUsdg: paid, payoutStatus: "owed" });
    expect((m.receipt as any)).toMatchObject({ kind: "refund", settlement: "onchain", payer: wallet, onchain_usdg: paid.toString(), original_receipt_id: null });
    const lines = await makegoodLines(source);
    expect(lines.map((l) => [l.kind, l.amount])).toEqual([["refund_onchain", -usdgToPico(paid)]]);
    expect((await balanceOf(h.ctx.db, account)).balance).toBe(0n);
    // The status section is cached for 30 seconds; read it fresh here.
    expect(((await makegoodStatus(h.ctx, 0)) as { onchain: unknown }).onchain).toMatchObject({ owed_refunds: 1, owed_usdg_units: paid.toString(), last_paid_at: null });
  });

  test("the payout job refuses without the treasury key, then pays once per payer and never twice", async () => {
    expect(await runMakegoodPayouts(h.ctx)).toEqual({ refused: "MAKEGOOD_REFUND_PRIVATE_KEY is not set; on-chain refunds stay owed" });
    // The first attempt is not seen mined yet: it stays signed and is only ever resent as the same bytes.
    mined = null;
    expect(await runMakegoodPayouts(h.ctx, transport, { waitMs: 0 })).toMatchObject({ paid: 0, pending: expect.any(String) });
    expect(transfers).toEqual([{ to: wallet as Hex, units: paid }]);
    expect((await refundFor(source)).payoutStatus).toBe("batched");
    mined = "success";
    expect(await runMakegoodPayouts(h.ctx, transport, { waitMs: 0 })).toMatchObject({ paid: 1 });
    expect(transfers).toHaveLength(1);
    expect(new Set(broadcasts).size).toBe(1);
    expect((await refundFor(source)).payoutStatus).toBe("paid");
    const [payout] = await h.ctx.db.select().from(makegoodPayouts).where(eq(makegoodPayouts.payer, wallet));
    expect(payout).toMatchObject({ status: "paid", usdg: paid });
    expect(await runMakegoodPayouts(h.ctx, transport, { waitMs: 0 })).toMatchObject({ paid: 0 });
    expect(transfers).toHaveLength(1);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("a reverted transfer leaves the refund owed for the next run instead of retrying in a loop", async () => {
    const m = await refundFor(source);
    const payer = `0x${"7".repeat(40)}`;
    await h.ctx.db.insert(makegoodRefunds).values({ id: "rf_revert", sourceId: "payment:0xrevert", accountId: m.accountId, rule: "upstream_failure", status: "issued", amount: usdgToPico(5n), charged: usdgToPico(5n), evidence: {}, payer, onchainUsdg: 5n, payoutStatus: "owed" });
    mined = "reverted";
    const before = transfers.length;
    expect(await runMakegoodPayouts(h.ctx, transport, { waitMs: 0 })).toMatchObject({ failed: expect.any(String) });
    expect(transfers.length).toBe(before + 1);
    expect((await refundFor("payment:0xrevert")).payoutStatus).toBe("owed");
    mined = "success";
    expect(await runMakegoodPayouts(h.ctx, transport, { waitMs: 0 })).toMatchObject({ paid: 1 });
    expect(transfers.slice(before)).toEqual([{ to: payer as Hex, units: 5n }, { to: payer as Hex, units: 5n }]);
    expect((await refundFor("payment:0xrevert")).payoutStatus).toBe("paid");
  });
});

test("with MAKEGOOD_ENABLED off nothing is recorded, issued or reported", async () => {
  expect(loadConfig({}).makegood).toEqual({ enabled: false, refundKey: undefined });
  h.ctx.cfg.makegood.enabled = false;
  try {
    const key = await h.fundedKey(10n);
    const id = (await fallbackCall(key)).id;
    expect(await refundFor(id)).toBeUndefined();
    expect(await runMakegood(h.ctx, later())).toEqual({ skipped: "disabled" });
    expect((await (await h.request("/api/v1/status")).json()).data.makegood).toEqual({ enabled: false });
    expect((await h.request("/api/v1/refunds", { headers: key.auth })).status).toBe(404);
  } finally { h.ctx.cfg.makegood.enabled = true; }
});

test("production: the refund key lives only on the worker that runs makegood-payouts", () => {
  const address = "0x" + "1".repeat(40);
  const env = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), MAKEGOOD_ENABLED: "true" };
  const refundKey = "0x" + "5".repeat(64);
  expect(loadConfig(env).makegood.enabled).toBe(true);
  expect(() => loadConfig({ ...env, MAKEGOOD_REFUND_PRIVATE_KEY: refundKey })).toThrow(/isolated/);
  const worker = { ...env, RUNTIME_ROLE: "worker", ROUTER_PRIVATE_KEY: undefined };
  expect(loadConfig({ ...worker, WORKER_JOBS: "makegood-payouts", MAKEGOOD_REFUND_PRIVATE_KEY: refundKey }).makegood.refundKey).toBe(refundKey);
  expect(() => loadConfig({ ...worker, WORKER_JOBS: "makegood-payouts" })).toThrow(/needs MAKEGOOD_ENABLED and MAKEGOOD_REFUND_PRIVATE_KEY/);
  expect(() => loadConfig({ ...worker, WORKER_JOBS: "makegood-payouts", MAKEGOOD_ENABLED: "false", MAKEGOOD_REFUND_PRIVATE_KEY: refundKey })).toThrow(/needs MAKEGOOD_ENABLED/);
  expect(() => loadConfig({ ...worker, WORKER_JOBS: "settlement", SETTLEMENT_PRIVATE_KEY: "0x" + "4".repeat(64), MAKEGOOD_REFUND_PRIVATE_KEY: refundKey })).toThrow(/isolated/);
  expect(loadConfig({ ...worker, WORKER_JOBS: "settlement", SETTLEMENT_PRIVATE_KEY: "0x" + "4".repeat(64) }).makegood.refundKey).toBeUndefined();
});

test("a candidate whose settlement line is on another account is voided, not refunded", async () => {
  const key = await h.fundedKey(10n), other = await h.fundedKey(1n);
  const id = (await fallbackCall(key)).id;
  const [o] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, other.hash));
  await h.ctx.db.update(makegoodRefunds).set({ accountId: o.accountId }).where(eq(makegoodRefunds.sourceId, id));
  await runMakegood(h.ctx, later());
  expect(await refundFor(id)).toMatchObject({ status: "void", amount: 0n });
  expect(await makegoodLines(id)).toHaveLength(0);
});

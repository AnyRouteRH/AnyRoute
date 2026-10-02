import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { startRouter, MODELS, sse, type Harness } from "./helpers.ts";
import { generations, keys } from "../src/db/schema.ts";
import { usdToPico, picoToUsdString } from "../src/lib/money.ts";
import { verifyInvariants } from "../src/ledger/ledger.ts";
import { captureStructuredOutput, structuredOutputMiddleware } from "../src/structured-output/chat.ts";
import { loadConfig } from "../src/config.ts";
import { applyPreset, normalizePreset, presetDocSchema } from "../src/routing/presets.ts";

const model = MODELS.llama.slug;
const request = (mode?: string, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: "user", content: "Return JSON." }], max_tokens: 200, response_format: { type: "json_object" }, ...(mode ? { anyroute: { json_check: mode } } : {}), ...extra });
let h: Harness;
let replies: string[] = [], bodies: any[] = [];
const received = () => bodies.length;
beforeAll(async () => {
  h = await startRouter({ env: { STRUCTURED_OUTPUT_CHECK_ENABLED: "true" }, providers: [{ id: "json-provider", name: "JSON Provider", models: [MODELS.llama], reply: (_prompt, body) => { bodies.push(structuredClone(body)); return replies.shift() ?? "broken"; }, usage: { prompt_tokens: 10, completion_tokens: 5 } }] });
});
afterAll(async () => { if (h) await h.close(); });
async function chat(mode?: string, extra: Record<string, unknown> = {}, path = "/api/v1/chat/completions") {
  const key = await h.fundedKey();
  const res = await h.request(path, { method: "POST", headers: key.auth, json: request(mode, extra) });
  return { res, key };
}
async function checkReceipt(receipt: any) {
  expect(await h.ctx.signer.verify(receipt.payload, receipt.sig, receipt.key_id)).toBe(true);
  expect(receipt.v2).toBeDefined();
}

describe("structured-output real router with fake provider", () => {
  test("validate leaves a valid answer unchanged and carries one signed call receipt", async () => {
    replies = ['{"ok":true}']; const before = received();
    const { res } = await chat("validate");
    expect(res.status).toBe(200); expect(res.headers.get("x-anyroute-json-check")).toBe("valid");
    const json: any = await res.json(); const check = json.receipt.structured_output;
    expect(json.choices[0].message.content).toBe('{"ok":true}'); expect(check.valid).toBe(true);
    expect(check.errors).toEqual([]); expect(check.calls.length).toBe(1); expect(check.retry_attempted).toBe(false);
    expect(check.total_cost).toBe(json.receipt.payload.cost); expect(received() - before).toBe(1);
    expect(bodies.at(-1).anyroute).toBeUndefined(); await checkReceipt(json.receipt);
  });
  test("invalid validate returns the original text without a second call", async () => {
    replies = ["broken"]; const before = received(); const { res } = await chat("validate");
    expect(res.headers.get("x-anyroute-json-check")).toBe("invalid");
    const json: any = await res.json(); expect(json.choices[0].message.content).toBe("broken");
    expect(json.receipt.structured_output.errors).toEqual([{ path: "", reason: "message is not valid JSON" }]);
    expect(received() - before).toBe(1);
  });
  test("valid first repair makes no correction and no extra charge", async () => {
    replies = ['{"ok":true}']; const before = received(); const { res } = await chat("repair");
    const json: any = await res.json(); expect(json.receipt.structured_output.calls.length).toBe(1);
    expect(json.receipt.structured_output.retry_attempted).toBe(false); expect(received() - before).toBe(1);
  });
  test("repair fixes output once, pins the actual model/provider and bills both calls", async () => {
    replies = ["broken", '{"ok":true}']; const before = received(); const { res, key } = await chat("repair", { models: [model, MODELS.qwen.slug] });
    expect(res.status).toBe(200); expect(res.headers.get("x-anyroute-json-check")).toBe("valid");
    const json: any = await res.json(); const check = json.receipt.structured_output;
    expect(json.choices[0].message.content).toBe('{"ok":true}'); expect(check.valid).toBe(true); expect(check.retry_attempted).toBe(true);
    expect(check.calls.map((c: any) => c.attempt)).toEqual([1, 2]); expect(check.initial_errors.length).toBe(1);
    expect(check.calls[0].receipt.id).not.toBe(check.calls[1].receipt.id); expect(check.calls[1].receipt.id).toBe(json.receipt.id);
    expect(res.headers.get("x-receipt-id")).toBe(json.receipt.id); expect(received() - before).toBe(2);
    for (const call of check.calls) { expect(call.cost).toBe(call.receipt.payload.cost); expect(call.receipt.payload.provider).toBe("json-provider"); await checkReceipt(call.receipt); }
    expect(check.total_cost).toBe(picoToUsdString(check.calls.reduce((v: bigint, c: any) => v + usdToPico(c.cost), 0n)));
    const rows = await h.ctx.db.select().from(generations).where(eq(generations.keyHash, key.hash));
    expect(rows.length).toBe(2); expect(rows.reduce((v, r) => v + r.cost, 0n)).toBe(usdToPico(check.total_cost));
    expect(rows.every(r => (r.receipt as any).structured_output === undefined)).toBe(true);
    expect(bodies.at(-1).model).toBe(bodies.at(-2).model);
    expect(bodies.at(-1).messages.at(-2).content).toBe("broken"); expect(bodies.at(-1).messages.at(-1).content).toContain("Validation errors");
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });
  test("key aliases cannot redirect a correction away from the serving fallback model", async () => {
    const key = await h.fundedKey();
    await h.ctx.db.update(keys).set({ routing: { aliases: { [model]: { model: MODELS.qwen.slug } } } }).where(eq(keys.keyHash, key.hash));
    replies = ["broken", '{"ok":true}']; const before = received();
    const res = await h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth, json: request("repair", { model: "unavailable/model", models: [model] }) });
    const json: any = await res.json(); expect(res.status).toBe(200); expect(json.receipt.structured_output.valid).toBe(true);
    expect(json.receipt.structured_output.calls.length).toBe(2); expect(received() - before).toBe(2);
    expect(bodies.at(-1).model).toBe(bodies.at(-2).model);
  });
  test("models without response_format support keep the existing MUST_SUPPORT refusal", async () => {
    const offer = h.ctx.catalog.offers(model)[0]; const supported = offer.supportedParameters;
    offer.supportedParameters = ["temperature"]; const before = received();
    try { const { res } = await chat("validate"); expect(res.status).toBe(404); expect(received()).toBe(before); }
    finally { offer.supportedParameters = supported; }
  });
  test("routing modifiers remain on the correction request", async () => {
    replies = ["broken", '{"ok":true}']; const { res } = await chat("repair", { model: model + ":floor" });
    const json: any = await res.json(); expect(json.receipt.structured_output.valid).toBe(true);
    expect(json.receipt.structured_output.calls.length).toBe(2);
  });
  test("still broken returns the last output and never retries a second time", async () => {
    replies = ["broken", "still broken", '{"unexpected":true}']; const before = received(); const { res } = await chat("repair");
    const json: any = await res.json(); expect(json.choices[0].message.content).toBe("still broken");
    expect(json.receipt.structured_output.valid).toBe(false); expect(json.receipt.structured_output.calls.length).toBe(2);
    expect(received() - before).toBe(2); expect(res.headers.get("x-anyroute-json-check")).toBe("invalid");
  });
  test("schema failure includes its path and is fixed on one correction", async () => {
    replies = ['{"age":"wrong"}', '{"age":7}']; const { res } = await chat("repair", { response_format: { type: "json_schema", json_schema: { name: "person", strict: true, schema: { type: "object", properties: { age: { type: "integer", minimum: 0 } }, required: ["age"], additionalProperties: false } } } });
    const json: any = await res.json(); expect(json.receipt.structured_output.valid).toBe(true);
    expect(json.receipt.structured_output.initial_errors[0].path).toBe("/age");
  });
  test("streams validate only and preserve the signed chunk chain", async () => {
    replies = ['{"ok":true}']; const before = received(); const { res } = await chat("validate", { stream: true });
    expect(res.headers.get("x-anyroute-json-check")).toBe("pending");
    const data = await sse(res); expect(data.done).toBe(true); const final = data.events.find((e: any) => e.receipt);
    expect(final.receipt.structured_output.valid).toBe(true); expect(received() - before).toBe(1); await checkReceipt(final.receipt);
    const chunks = data.events.filter((e: any) => !e.receipt).map(e => JSON.stringify(e));
    const verified = await h.request("/api/v1/receipts/verify", { method: "POST", json: { cose: final.receipt.v2.cose, chunks } });
    expect((await verified.json() as any).data.chain_valid).toBe(true);
  });
  test("streaming repair advertises unsupported repair and bills only once", async () => {
    replies = ["broken", '{"ok":true}']; const before = received(); const { res } = await chat("repair", { stream: true });
    expect(res.headers.get("x-anyroute-json-check")).toBe("pending; repair-unsupported");
    const data = await sse(res); const check = data.events.find((e: any) => e.receipt).receipt.structured_output;
    expect(check.valid).toBe(false); expect(check.repair_supported).toBe(false); expect(check.retry_attempted).toBe(false);
    expect(check.calls.length).toBe(1); expect(received() - before).toBe(1);
  });
  test("streamed schema failures name the invalid field", async () => {
    replies = ['{"age":"wrong"}']; const { res } = await chat("validate", { stream: true, response_format: { type: "json_schema", json_schema: { name: "person", schema: { type: "object", properties: { age: { type: "integer" } } } } } });
    const data = await sse(res); const check = data.events.find((e: any) => e.receipt).receipt.structured_output;
    expect(check.valid).toBe(false); expect(check.errors[0].path).toBe("/age");
  });
  test("a blocked correction returns the charged first answer and exposes the failed retry", async () => {
    replies = ["broken", '{"ok":true}']; const original = h.app.request.bind(h.app); let blocked = false;
    h.app.request = ((input: any, ...args: any[]) => { if (input instanceof Request && input.method === "POST") { blocked = true; return Promise.resolve(new Response("", { status: 402 })); } return original(input, ...args); }) as typeof h.app.request;
    try {
      const { res } = await chat("repair"); const json: any = await res.json(); const check = json.receipt.structured_output;
      expect(blocked).toBe(true); expect(check.retry_error.status).toBe(402); expect(check.retry_attempted).toBe(true);
      expect(check.calls.length).toBe(1); expect(check.valid).toBe(false); expect(check.total_cost).toBe(json.receipt.payload.cost);
    } finally { h.app.request = original; }
  });
  test("a charged correction that returns an error still appears in the receipt and total", async () => {
    replies = ["broken", '{"ok":true}']; const original = h.app.request.bind(h.app);
    h.app.request = (async (input: any, ...args: any[]) => {
      const res = await original(input, ...args);
      if (!(input instanceof Request) || input.method !== "POST") return res;
      const charged: any = await res.json();
      return new Response(JSON.stringify({ error: { type: "attestation_refused" }, receipt: charged.receipt, usage: charged.usage }), { status: 502 });
    }) as typeof h.app.request;
    try {
      const { res, key } = await chat("repair"); const json: any = await res.json(); const check = json.receipt.structured_output;
      expect(json.choices[0].message.content).toBe("broken"); expect(check.valid).toBe(false); expect(check.retry_error.status).toBe(502);
      expect(check.calls.length).toBe(2); for (const call of check.calls) await checkReceipt(call.receipt);
      const rows = await h.ctx.db.select().from(generations).where(eq(generations.keyHash, key.hash));
      expect(rows.length).toBe(2); expect(rows.reduce((v, r) => v + r.cost, 0n)).toBe(usdToPico(check.total_cost));
    } finally { h.app.request = original; }
  });
  test("unsupported schemas and invalid opt-ins refuse before a provider call", async () => {
    const before = received();
    for (const [mode, extra] of [["wrong", {}], ["validate", { response_format: { type: "text" } }], ["validate", { n: 2 }], ["validate", { verify: "dual" }], ["validate", { response_format: { type: "json_schema", json_schema: { schema: { pattern: "x" } } } }]] as [string, any][]) {
      const { res } = await chat(mode, extra); expect(res.status).toBe(400);
    }
    expect(received()).toBe(before);
  });
  test("non-key repair is refused before billing but streams still validate", async () => {
    const res = await h.request("/api/v1/chat/completions", { method: "POST", json: request("repair") });
    expect(res.status).toBe(400); expect((await res.json() as any).error.message).toContain("bearer API key");
  });
  test("without a request opt-in, enabled deployments do not check or retry", async () => {
    replies = ["broken"]; const before = received(); const { res } = await chat();
    expect(res.headers.get("x-anyroute-json-check")).toBeNull(); const json: any = await res.json();
    expect(json.receipt.structured_output).toBeUndefined(); expect(received() - before).toBe(1);
  });
  test("presets carry the option cheaply and explicit request settings win", async () => {
    const doc = presetDocSchema.parse({ models: [model], response_format: { type: "json_object" }, anyroute: { json_check: "repair" } });
    expect(normalizePreset(doc).anyroute).toEqual({ json_check: "repair" });
    const body: any = { messages: [{ role: "user", content: "JSON" }], anyroute: { json_check: "validate" } };
    applyPreset(body, doc); expect(body.anyroute.json_check).toBe("validate");
    const key = await h.fundedKey();
    const saved = await h.request("/api/v1/presets/json-settings", { method: "PUT", headers: key.auth, json: doc });
    expect(saved.ok).toBe(true); replies = ['{"ok":true}'];
    const res = await h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth, json: { model: "@preset/json-settings", messages: body.messages } });
    const json: any = await res.json(); expect(json.receipt.structured_output.mode).toBe("repair"); expect(json.receipt.structured_output.valid).toBe(true);
  });
  test("v1 alias and browser-readable header work", async () => {
    replies = ['{"ok":true}']; const { res } = await chat("validate", {}, "/v1/chat/completions");
    expect(res.headers.get("x-anyroute-json-check")).toBe("valid"); expect(res.headers.get("access-control-expose-headers")).toContain("x-anyroute-json-check");
  });
});

test("flag off is byte-identical even with a repair opt-in and leaves the request untouched", async () => {
  const app = new Hono(); const ctx = { cfg: loadConfig({ ANYROUTE_ENV: "test" }) } as any;
  structuredOutputMiddleware(app, ctx);
  const body = request("repair", { response_format: { type: "text" } }); const before = JSON.stringify(body);
  const bytes = '  {"choices":[],"receipt":{"payload":{"cost":"1"}}}\n';
  app.post("/api/v1/chat/completions", c => { captureStructuredOutput(ctx, c, "chat", body); return new Response(bytes, { headers: { "x-receipt-id": "original", "content-type": "application/json" } }); });
  const res = await app.request("/api/v1/chat/completions", { method: "POST" });
  expect(await res.text()).toBe(bytes); expect(JSON.stringify(body)).toBe(before); expect(res.headers.get("x-anyroute-json-check")).toBeNull(); expect(res.headers.get("x-receipt-id")).toBe("original");
});

test("production-like config loader starts with JSON checking enabled without changing guards", () => {
  const address = "0x" + "1".repeat(40);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/db", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), STRUCTURED_OUTPUT_CHECK_ENABLED: "true" });
  expect(cfg.production).toBe(true); expect(cfg.structuredOutputCheckEnabled).toBe(true);
});

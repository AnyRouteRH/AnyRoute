import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { keys } from "../src/db/schema.ts";
import { decrypt } from "../src/lib/util.ts";
import { parseTraceparent, sealTracing, shouldExportTrace, tracingJson, TracingExporter, type StoredTracing, type TraceRecord } from "../src/services/tracing.ts";

// Customer tracing export. Destinations are real HTTP servers on 127.0.0.1 (a fake OTLP collector and a fake Langfuse);
// the exporter's transport maps the https:// destination the customer saved onto them, after the URL checks ran.

type Hit = { path: string; headers: Record<string, string>; body: any };

function fakeServer(status: () => number = () => 200) {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hits.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers.entries()), body: await req.json() });
      const s = status();
      return new Response(s === 207 ? JSON.stringify({ successes: [], errors: [] }) : "{}", { status: s, headers: { "content-type": "application/json" } });
    },
  });
  return { hits, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Transport for the exporter: https://<name>.example.com/... goes to the matching local server. */
const routeTo = (map: Record<string, string>) => (url: string, init: RequestInit) => {
  const u = new URL(url);
  const base = map[u.host];
  if (!base) throw new Error("unexpected destination " + u.host);
  return fetch(base + u.pathname, init);
};

const SECRET = "test-secret-test-secret-test-secret-1234";
const record = (over: Partial<TraceRecord> = {}): TraceRecord => ({
  generationId: "gen-1",
  startMs: 1_790_000_000_000,
  endMs: 1_790_000_000_450,
  operation: "chat",
  provider: "alpha",
  requestModel: "meta-llama/llama-3.3-70b-instruct",
  responseModel: "meta-llama/llama-3.3-70b-instruct",
  inputTokens: 12,
  outputTokens: 34,
  temperature: 0.2,
  maxTokens: 64,
  finishReasons: ["stop"],
  costUsd: 0.000012,
  timeToFirstTokenMs: 120,
  mode: "prepaid",
  streamed: false,
  attempts: 1,
  input: [{ role: "user", content: "secret prompt" }],
  output: "secret answer",
  ...over,
});
const attrs = (span: any) => Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue ?? a.value.arrayValue?.values.map((v: any) => v.stringValue)]));

describe("settings", () => {
  test("destinations must be public https URLs without a query, and reserved headers are refused", () => {
    const bad = [
      { type: "otlp", endpoint: "http://collector.example.com" },
      { type: "otlp", endpoint: "https://localhost:4318" },
      { type: "otlp", endpoint: "https://10.0.0.5" },
      { type: "otlp", endpoint: "https://collector.internal" },
      { type: "otlp", endpoint: "https://collector.example.com/v1/traces?token=x" },
      { type: "otlp", endpoint: "https://collector.example.com", headers: { host: "evil" } },
      { type: "otlp" },
      { type: "langfuse", public_key: "pk-lf-1" },
      { type: "helicone" },
    ] as const;
    for (const b of bad) expect(() => sealTracing(SECRET, b as any, null)).toThrow();
  });

  test("credentials are sealed with APP_SECRET, the view shows none of them, and a left-out secret is kept", () => {
    const t = sealTracing(SECRET, { type: "otlp", endpoint: "https://api.honeycomb.io/", headers: { "x-honeycomb-team": "hc-secret-123" } }, null);
    expect(JSON.stringify(t)).not.toContain("hc-secret-123");
    expect(JSON.parse(decrypt(SECRET, t.sealed))).toMatchObject({ url: "https://api.honeycomb.io/v1/traces", headers: { "x-honeycomb-team": "hc-secret-123" } });
    const view = tracingJson(t)!;
    expect(view).toMatchObject({ type: "otlp", target: "https://api.honeycomb.io/…", header_names: ["x-honeycomb-team"], include_content: false, secrets_set: true });
    expect(JSON.stringify(view)).not.toContain("hc-secret");
    const flipped = sealTracing(SECRET, { type: "otlp", include_content: true }, t);
    expect(flipped.include_content).toBe(true);
    expect(JSON.parse(decrypt(SECRET, flipped.sealed)).headers).toEqual({ "x-honeycomb-team": "hc-secret-123" });
    // A new type does not inherit the old one's secrets.
    expect(() => sealTracing(SECRET, { type: "langfuse" }, t)).toThrow();
    const lf = sealTracing(SECRET, { type: "langfuse", public_key: "pk-lf-1234567890", secret_key: "sk-lf-abcdef" }, null);
    expect(JSON.parse(decrypt(SECRET, lf.sealed)).url).toBe("https://cloud.langfuse.com/api/public/ingestion");
    expect(JSON.stringify(tracingJson(lf))).not.toContain("sk-lf-abcdef");
    expect(tracingJson(lf)).toMatchObject({ public_key_hint: "pk-lf-…7890" });
  });

  test("the privacy gate passes only the public lane", () => {
    expect(shouldExportTrace({ lane: "public", privateLaneRequest: false, privateRoute: false })).toBe(true);
    expect(shouldExportTrace({ lane: "attested", privateLaneRequest: true, privateRoute: false })).toBe(false);
    expect(shouldExportTrace({ lane: "unlinkable", privateLaneRequest: true, privateRoute: false })).toBe(false);
    expect(shouldExportTrace({ lane: "public", privateLaneRequest: true, privateRoute: false })).toBe(false);
    expect(shouldExportTrace({ lane: "public", privateLaneRequest: false, privateRoute: true })).toBe(false);
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toEqual({ traceId: "0af7651916cd43dd8448eb211c80319c", parentSpanId: "b7ad6b7169203331" });
    expect(parseTraceparent("garbage")).toEqual({});
  });
});

describe("exporter", () => {
  const otlp = (over: Partial<Parameters<typeof sealTracing>[1]> = {}) => sealTracing(SECRET, { type: "otlp", endpoint: "https://collector.example.com", headers: { authorization: "Bearer c0llect0r" }, ...over } as any, null);

  test("OTLP/HTTP JSON spans carry the GenAI attributes and no content unless include_content", async () => {
    const col = fakeServer();
    const ex = new TracingExporter(SECRET, { flushMs: 0, send: routeTo({ "collector.example.com": col.url }) });
    expect(ex.enqueue("k1", otlp(), record())).toBe(true);
    expect(ex.enqueue("k2", otlp({ include_content: true }), record({ generationId: "gen-2", traceId: "0af7651916cd43dd8448eb211c80319c", parentSpanId: "b7ad6b7169203331" }))).toBe(true);
    await ex.drain();
    expect(col.hits.map((h) => h.path)).toEqual(["/v1/traces", "/v1/traces"]);
    expect(col.hits[0].headers.authorization).toBe("Bearer c0llect0r");
    const [plain, rich] = col.hits.map((h) => h.body.resourceSpans[0].scopeSpans[0].spans[0]);
    expect(plain.name).toBe("chat meta-llama/llama-3.3-70b-instruct");
    expect(plain.kind).toBe(3);
    expect(attrs(plain)).toMatchObject({
      "gen_ai.system": "alpha",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "meta-llama/llama-3.3-70b-instruct",
      "gen_ai.response.model": "meta-llama/llama-3.3-70b-instruct",
      "gen_ai.usage.input_tokens": "12",
      "gen_ai.usage.output_tokens": "34",
      "gen_ai.request.temperature": 0.2,
      "gen_ai.request.max_tokens": "64",
      "gen_ai.response.finish_reasons": ["stop"],
      "anyroute.cost_usd": 0.000012,
      "anyroute.receipt_id": "gen-1",
      "anyroute.lane": "public",
      "anyroute.provider": "alpha",
      "anyroute.server_latency_ms": "450",
    });
    expect(JSON.stringify(col.hits[0].body)).not.toContain("secret prompt");
    expect(JSON.stringify(col.hits[0].body)).not.toContain("secret answer");
    expect(rich.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(rich.parentSpanId).toBe("b7ad6b7169203331");
    expect(attrs(rich)["gen_ai.input.messages"]).toContain("secret prompt");
    expect(attrs(rich)["gen_ai.output.messages"]).toContain("secret answer");
    expect(ex.stats("k1")).toMatchObject({ exported: 1, dropped: 0, failed: 0, circuit: "closed" });
    col.stop();
  });

  test("Langfuse gets a trace and a generation per call through the public ingestion API", async () => {
    const lf = fakeServer(() => 207);
    const ex = new TracingExporter(SECRET, { flushMs: 0, send: routeTo({ "langfuse.example.com": lf.url }) });
    const dest = sealTracing(SECRET, { type: "langfuse", host: "https://langfuse.example.com", public_key: "pk-lf-1234567890", secret_key: "sk-lf-abcdef" }, null);
    ex.enqueue("k", dest, record());
    await ex.drain();
    expect(lf.hits[0].path).toBe("/api/public/ingestion");
    expect(lf.hits[0].headers.authorization).toBe("Basic " + Buffer.from("pk-lf-1234567890:sk-lf-abcdef").toString("base64"));
    const batch = lf.hits[0].body.batch;
    expect(batch.map((e: any) => e.type)).toEqual(["trace-create", "generation-create"]);
    expect(batch[1].body).toMatchObject({ id: "gen-1", traceId: "gen-1", model: "meta-llama/llama-3.3-70b-instruct", usageDetails: { input: 12, output: 34, total: 46 }, costDetails: { total: 0.000012 }, modelParameters: { temperature: 0.2, max_tokens: 64 } });
    expect(batch[1].body.input).toBeUndefined();
    expect(JSON.stringify(batch)).not.toContain("secret prompt");
    expect(ex.stats("k")!.exported).toBe(1);
    lf.stop();
  });

  test("a full queue drops and counts; enqueue never waits on the network", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const col = fakeServer();
    const ex = new TracingExporter(SECRET, { flushMs: 0, queueMax: 3, batchMax: 1, send: async (url, init) => (await gate, routeTo({ "collector.example.com": col.url })(url, init)) });
    const dest = otlp();
    const t0 = performance.now();
    const queued = Array.from({ length: 8 }, (_, i) => ex.enqueue("k", dest, record({ generationId: "g" + i })));
    expect(performance.now() - t0).toBeLessThan(50);
    // batchMax 1 starts the first send at once (it leaves the queue), so four fit before the bound of three is hit.
    expect(queued.filter(Boolean).length).toBe(4);
    expect(ex.stats("k")!.dropped).toBe(4);
    expect(ex.totals.dropped).toBe(4);
    release();
    await ex.drain();
    expect(ex.stats("k")!.exported).toBe(4);
    col.stop();
  });

  test("5xx is retried with backoff; 4xx is not", async () => {
    let n = 0;
    const flaky = fakeServer(() => (++n <= 2 ? 503 : 200));
    const ex = new TracingExporter(SECRET, { flushMs: 0, retries: 3, backoffMs: 5, send: routeTo({ "collector.example.com": flaky.url }) });
    ex.enqueue("k", otlp(), record());
    await ex.drain();
    expect(flaky.hits.length).toBe(3);
    expect(ex.stats("k")).toMatchObject({ exported: 1, retries: 2, failed: 0 });
    flaky.stop();

    const denied = fakeServer(() => 401);
    const ex2 = new TracingExporter(SECRET, { flushMs: 0, retries: 3, backoffMs: 5, send: routeTo({ "collector.example.com": denied.url }) });
    ex2.enqueue("k", otlp(), record());
    await ex2.drain();
    expect(denied.hits.length).toBe(1);
    expect(ex2.stats("k")).toMatchObject({ exported: 0, failed: 1, retries: 0, last_error: "http_401" });
    denied.stop();
  });

  test("a destination that keeps failing is switched off, its spans dropped, and it recovers after the cooldown", async () => {
    let up = false;
    const col = fakeServer(() => (up ? 200 : 500));
    const clock = { t: 1_000 };
    const ex = new TracingExporter(SECRET, { flushMs: 0, retries: 1, backoffMs: 1, breakerThreshold: 2, breakerCooldownMs: 60_000, now: () => clock.t, send: routeTo({ "collector.example.com": col.url }) });
    const dest = otlp();
    for (let i = 0; i < 2; i++) {
      ex.enqueue("k", dest, record());
      await ex.drain();
    }
    expect(ex.stats("k")).toMatchObject({ failed: 2, circuit: "open", last_error: "http_500" });
    const sent = col.hits.length;
    expect(ex.enqueue("k", dest, record())).toBe(false); // open: dropped at once, nothing sent
    await ex.drain();
    expect(col.hits.length).toBe(sent);
    expect(ex.stats("k")!.dropped).toBe(1);
    clock.t += 60_001;
    expect(ex.stats("k")!.circuit).toBe("half_open");
    up = true;
    expect(ex.enqueue("k", dest, record())).toBe(true);
    await ex.drain();
    expect(ex.stats("k")).toMatchObject({ exported: 1, circuit: "closed" });
    col.stop();
  });

  test("a destination that resolves to a private address is never contacted", async () => {
    const ex = new TracingExporter(SECRET, { flushMs: 0, retries: 0, resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    ex.enqueue("k", otlp(), record());
    await ex.drain();
    expect(ex.stats("k")).toMatchObject({ exported: 0, failed: 1, last_error: "destination_blocked" });
  });
});

describe("over HTTP", () => {
  let h: Harness;
  let key: Awaited<ReturnType<Harness["fundedKey"]>>;
  const col = fakeServer();
  const lf = fakeServer(() => 207);
  const admin = { "x-admin-token": ADMIN };
  const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };
  const chat = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, ...headers }, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "tell me the secret plan" }], temperature: 0.3, max_tokens: 40, ...body } });
  const patch = (tracing: unknown) => h.request(`/api/v1/keys/${key.hash}`, { method: "PATCH", headers: key.auth, json: { tracing } });
  const spans = () => col.hits.flatMap((x) => x.body.resourceSpans[0].scopeSpans[0].spans);

  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.qwen] },
        { id: "enclave", name: "Enclave", models: [MODELS.llamaPricey], tee: "dev" },
      ],
    });
    h.ctx.tracing.configure({ flushMs: 0, backoffMs: 1, send: routeTo({ "collector.example.com": col.url, "langfuse.example.com": lf.url }) });
    key = await h.fundedKey(20n);
    expect((await h.request("/api/v1/disclosure/enclave", { method: "PUT", headers: admin, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } })).status).toBe(200);
    await runAttestor(h.ctx);
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => {
    await h.close();
    col.stop();
    lf.stop();
  });

  test("PATCH stores the destination encrypted; GET never returns the endpoint path or a header value", async () => {
    const r = await patch({ type: "otlp", endpoint: "https://collector.example.com/otlp", headers: { "X-Api-Key": "tempo-token-xyz" } });
    expect(r.status).toBe(200);
    const view = (await r.json()).data.tracing;
    expect(view).toMatchObject({ type: "otlp", enabled: true, include_content: false, target: "https://collector.example.com/…", header_names: ["x-api-key"], secrets_set: true });
    const got = await (await h.request(`/api/v1/keys/${key.hash}`, { headers: key.auth })).text();
    const list = await (await h.request(`/api/v1/keys`, { headers: key.auth })).text();
    const me = await (await h.request(`/api/v1/key`, { headers: key.auth })).text();
    for (const body of [got, list, me]) {
      expect(body).toContain('"tracing"');
      expect(body).not.toContain("tempo-token-xyz");
      expect(body).not.toContain("/otlp");
    }
    const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
    expect(JSON.stringify(row.tracing)).not.toContain("tempo-token-xyz");
    expect(JSON.parse(decrypt(h.ctx.cfg.appSecret, (row.tracing as StoredTracing).sealed)).headers).toEqual({ "x-api-key": "tempo-token-xyz" });
    expect((await patch({ type: "otlp", endpoint: "https://169.254.169.254/latest" })).status).toBe(400);
  });

  test("a public-lane call exports one GenAI span, without content by default", async () => {
    col.hits.length = 0;
    const r = await chat({}, { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });
    expect(r.status).toBe(200);
    const id = (await r.json()).id;
    await h.ctx.tracing.drain();
    expect(col.hits.length).toBe(1);
    expect(col.hits[0].path).toBe("/otlp/v1/traces");
    expect(col.hits[0].headers["x-api-key"]).toBe("tempo-token-xyz");
    const [span] = spans();
    expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span.parentSpanId).toBe("00f067aa0ba902b7");
    const a = attrs(span);
    expect(a).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.request.model": MODELS.llama.slug, "gen_ai.request.temperature": 0.3, "gen_ai.request.max_tokens": "40", "anyroute.receipt_id": id, "anyroute.lane": "public" });
    // On the public lane the router may pick any of the model's providers (attested ones carry a weight bonus).
    expect(["alpha", "enclave"]).toContain(a["anyroute.provider"]);
    expect(Number(a["gen_ai.usage.input_tokens"])).toBeGreaterThan(0);
    expect(Number(a["gen_ai.usage.output_tokens"])).toBeGreaterThan(0);
    expect(a["anyroute.cost_usd"]).toBeGreaterThan(0);
    expect(a["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(JSON.stringify(col.hits[0].body)).not.toContain("secret plan");
    const status = (await (await h.request(`/api/v1/keys/${key.hash}`, { headers: key.auth })).json()).data.tracing.status;
    expect(status).toMatchObject({ exported: 1, dropped: 0, circuit: "closed" });
  });

  test("include_content: true (secrets kept from before) adds the prompt and the completion", async () => {
    col.hits.length = 0;
    expect((await patch({ type: "otlp", include_content: true })).status).toBe(200);
    expect((await chat()).status).toBe(200);
    await h.ctx.tracing.drain();
    expect(col.hits[0].headers["x-api-key"]).toBe("tempo-token-xyz");
    const a = attrs(spans()[0]);
    expect(a["gen_ai.input.messages"]).toContain("tell me the secret plan");
    expect(typeof a["gen_ai.output.messages"]).toBe("string");
  });

  test("attested and unlinkable lane calls export nothing, even with content on", async () => {
    col.hits.length = 0;
    const attested = await chat({ provider: { lane: "attested" } });
    expect(attested.status).toBe(200);
    expect(attested.headers.get("x-anyroute-lane")).toBe("attested");
    const viaHeader = await chat({}, { "x-anyroute-lane": "attested" });
    expect(viaHeader.status).toBe(200);
    const suffix = await chat({ model: MODELS.llama.slug + ":private" });
    expect(suffix.status).toBe(200);
    await chat({ provider: { lane: "unlinkable" } }); // refused or served, it is never exported
    await h.ctx.tracing.drain();
    expect(col.hits.length).toBe(0);
    // The same key on the public lane still exports: the silence above is the lane, not a broken destination.
    expect((await chat()).status).toBe(200);
    await h.ctx.tracing.drain();
    expect(col.hits.length).toBe(1);
  });

  test("Langfuse destination over HTTP, and tracing: null removes it", async () => {
    expect((await patch({ type: "langfuse", host: "https://langfuse.example.com", public_key: "pk-lf-1234567890", secret_key: "sk-lf-very-secret" })).status).toBe(200);
    expect(await (await h.request(`/api/v1/keys/${key.hash}`, { headers: key.auth })).text()).not.toContain("sk-lf-very-secret");
    expect((await chat()).status).toBe(200);
    await h.ctx.tracing.drain();
    expect(lf.hits.length).toBe(1);
    expect(lf.hits[0].body.batch[1]).toMatchObject({ type: "generation-create", body: { model: MODELS.llama.slug } });
    expect(lf.hits[0].body.batch[1].body.input).toBeUndefined(); // include_content does not carry across types
    const off = await patch(null);
    expect((await off.json()).data.tracing).toBeNull();
    col.hits.length = 0;
    lf.hits.length = 0;
    expect((await chat()).status).toBe(200);
    await h.ctx.tracing.drain();
    expect(col.hits.length + lf.hits.length).toBe(0);
  });

  test("a destination that is down never slows or fails the call", async () => {
    // The collector never answers; only the exporter's own timeout ends the attempt.
    const hang = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    h.ctx.tracing.configure({ send: hang, timeoutMs: 300, retries: 0 });
    expect((await patch({ type: "otlp", endpoint: "https://collector.example.com", headers: { "x-api-key": "t" } })).status).toBe(200);
    const t0 = performance.now();
    expect((await chat()).status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(250);
    await h.ctx.tracing.drain();
    expect((await (await h.request(`/api/v1/keys/${key.hash}`, { headers: key.auth })).json()).data.tracing.status).toMatchObject({ failed: 1, last_error: "timeout" });
    h.ctx.tracing.configure({ send: routeTo({ "collector.example.com": col.url }), timeoutMs: 5_000, retries: 3 });
  });
});

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { buyTokens, tokenNullifier } from "../src/blind/client.ts";
import { blindNullifiers, generations } from "../src/db/schema.ts";
import { presentBlindToken, claimToken, unclaimToken } from "../src/blind/redeem.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { ONION_HEADER } from "../src/lib/onion.ts";
import { toChatRequest } from "../src/anthropic/convert.ts";
import { estimatePromptTokens } from "../src/router/pricing.ts";
import { startProxy } from "../packages/private/src/proxy.ts";
import { countMessageTokens, messageBudget } from "../packages/private/src/messages.ts";
import { TokenStore, type StoredToken } from "../packages/private/src/store.ts";
import { selectTokens } from "../packages/private/src/selection.ts";
import { torFetch } from "../packages/private/src/tor.ts";
import { tempDir, startTor } from "./private-fixtures.ts";

setDefaultTimeout(60_000);
const ADDRESS = "a2w2k7bgvjopikpj6lakthr6jjbnv3gul7cmsvoxye4zvnbcplunvlyd.onion";
const SECRET = "onion-messages-fixture-secret-0123456789abcdef";
const env = { ANYROUTE_FEATURE_BLIND: "true", BLIND_MULTI_TOKEN_ENABLED: "true", UNLINKABLE_VIA_ONION: "true", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET, BLIND_PURCHASE_RPM: "1000" };
const chat = { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 20 };
const messages = { ...chat, system: "Read this code.", tools: [{ name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } } } }] };
const auth = (tokens: string[]) => `PrivateToken ${tokens.map((t) => `token=${t}`).join(", ")}`;
let h: Harness;
let key: Awaited<ReturnType<Harness["fundedKey"]>>;
const shim = (async (input: unknown, init?: RequestInit) => h.app.request(new URL(String(input)).pathname, init)) as typeof fetch;
const buy = async (n: number, denomination = 1000) => buyTokens({ baseUrl: "http://router.test", apiKey: key.secret, count: n, denomination, fetch: shim });
const send = (tokens: string[], body: unknown = chat, path = "/api/v1/chat/completions", extra: Record<string, string> = {}) => h.request(path, { method: "POST", headers: { authorization: auth(tokens), [ONION_HEADER]: SECRET, "x-anyroute-lane": "unlinkable", ...extra }, json: body });
const rows = (tokens: string[]) => h.ctx.db.select().from(blindNullifiers).where(inArray(blindNullifiers.nullifier, tokens.map(tokenNullifier)));

beforeAll(async () => {
  h = await startRouter({ env, providers: [{ id: "enclave", name: "Enclave", models: [MODELS.llama], tee: "dev" }] });
  key = await h.fundedKey(10n);
  const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };
  expect((await h.request("/api/v1/disclosure/enclave", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } })).status).toBe(200);
  await runAttestor(h.ctx);
});
afterAll(async () => { await h.close(); });

test("multi-token defaults off, cap defaults 16, and production config starts with onion and sets enabled", () => {
  expect(loadConfig({}).blind.multiTokenEnabled).toBe(false);
  expect(loadConfig({}).blind.maxTokensPerRequest).toBe(16);
  for (const cap of ["0", "65", "1.5"]) expect(() => loadConfig({ BLIND_MAX_TOKENS_PER_REQUEST: cap })).toThrow();
  const productionEnv = { ...env, NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "worker", WORKER_JOBS: "blind-key-rotation", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: "0x" + "1".repeat(40), CALLPAY_ADDRESS: "0x" + "1".repeat(40), PROVIDER_BOND_ADDRESS: "0x" + "1".repeat(40), RECEIPT_ANCHOR_ADDRESS: "0x" + "1".repeat(40) };
  const production = loadConfig(productionEnv);
  expect(loadConfig({ ...productionEnv, RUNTIME_ROLE: "api", ROUTER_PRIVATE_KEY: "0x" + "2".repeat(64) }).production).toBe(true);
  expect(production.production).toBe(true);
  expect(production.blind.multiTokenEnabled).toBe(true);
  expect(production.unlinkable.viaOnion).toBe(true);
});

test("an invalid member rejects the full set without reserving any valid member", async () => {
  const { tokens } = await buy(2);
  expect((await send([tokens[0], "AAAA"])).status).toBe(401);
  expect(await rows(tokens)).toHaveLength(0);
  expect((await send(tokens)).status).toBe(200);
});

test("duplicate members, malformed sets and cap violations leave the tokens unspent", async () => {
  const { tokens } = await buy(2);
  expect((await send([tokens[0], tokens[0]])).status).toBe(401);
  expect((await send(tokens, chat, undefined, { authorization: auth(tokens) + ", junk" })).status).toBe(401);
  expect((await send(Array(17).fill(tokens[0]))).status).toBe(400);
  expect(await rows(tokens)).toHaveLength(0);
});

test("sets are refused while their feature is off, but a single-token call retains its receipt fields", async () => {
  const { tokens } = await buy(2);
  const old = h.ctx.cfg.blind.multiTokenEnabled;
  h.ctx.cfg.blind.multiTokenEnabled = false;
  try {
    expect((await send(tokens)).status).toBe(501);
    const r = await send([tokens[0]]);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.receipt.payload.nullifier).toBe(tokenNullifier(tokens[0]));
    expect(j.receipt.payload.token_count).toBeUndefined();
    expect(Object.keys(j.blind).sort()).toEqual(["nullifier", "token_key_id", "epoch", "denomination", "token_value_usd", "unspent_value_forfeited_usd"].sort());
  } finally { h.ctx.cfg.blind.multiTokenEnabled = old; }
});

test("concurrent reversed sets allow one winner and no double spend", async () => {
  const { tokens } = await buy(2);
  const results = await Promise.all([send(tokens), send([...tokens].reverse()), send(tokens)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401]);
  const spent = await rows(tokens);
  expect(spent).toHaveLength(2);
  expect(spent.every((r) => r.status === "spent")).toBe(true);
  expect(new Set(spent.map((r) => r.generationId)).size).toBe(1);
});

test("a conflict rolls back every newly inserted reservation, including concurrent overlapping sets", async () => {
  const { tokens } = await buy(3);
  const passes = await Promise.all([[tokens[0], tokens[1]], [tokens[1], tokens[2]]].map((t) => presentBlindToken(h.ctx, auth(t))));
  const outcomes = await Promise.allSettled(passes.map((p) => claimToken(h.ctx, p!)));
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await rows(tokens)).toHaveLength(2);
  await unclaimToken(h.ctx, passes[outcomes.findIndex((r) => r.status === "fulfilled")]!);
  expect(await rows(tokens)).toHaveLength(0);
  await send([tokens[1]]);
  expect((await send([tokens[0], tokens[1]])).status).toBe(401);
  expect(await rows([tokens[0]])).toHaveLength(0);
});

test("combined value covers a hold that exceeds either token; insufficient budget leaves all unspent", async () => {
  const { tokens } = await buy(4);
  const expensive = { ...chat, max_tokens: 9000 };
  expect((await send([tokens[0]], expensive)).status).toBe(402);
  const r = await send(tokens.slice(0, 2), expensive);
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.blind.token_value_usd).toBe(0.004);
  expect(j.blind.unspent_value_forfeited_usd).toBeGreaterThan(0);
  expect(j.receipt.payload.token_count).toBe(2);
  expect(j.receipt.payload.nullifiers).toEqual(tokens.slice(0, 2).map(tokenNullifier));
  expect(j.receipt.payload.payer).toBeNull();
  expect(JSON.stringify(j.receipt)).not.toContain(key.hash);
  expect((await send(tokens.slice(2), { ...chat, messages: [{ role: "user", content: "a".repeat(150_000) }] })).status).toBe(402);
  expect(await rows(tokens.slice(2))).toHaveLength(0);
});

test("Messages accepts tokens only through qualified onion ingress, forwards receipts, streams tools, and refuses identifying credentials", async () => {
  const { tokens } = await buy(5);
  expect((await send([tokens[0]], messages, "/v1/messages", { [ONION_HEADER]: "forged" })).status).toBe(403);
  expect((await send([tokens[0]], messages, "/v1/messages", { "x-api-key": key.secret })).status).toBe(403);
  const r = await send(tokens.slice(0, 2), messages, "/v1/messages");
  expect(r.status).toBe(200);
  expect(r.headers.get("x-anyroute-lane")).toBe("unlinkable");
  const j = await r.json();
  expect(r.headers.get("x-receipt-id")).toBe(j.anyroute.receipt_id);
  expect(j.anyroute.receipt.payload.token_count).toBe(2);
  const stream = await send(tokens.slice(2, 4), { ...messages, stream: true }, "/api/v1/messages");
  expect(stream.status).toBe(200);
  expect(stream.headers.get("x-anyroute-lane")).toBe("unlinkable");
  const text = await stream.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("event: message_stop");
  expect(text).toContain("token_count");
});

test("onion count_tokens needs no credential, ignores even an invalid token, and spends nothing; clearnet still needs a key", async () => {
  const before = await h.ctx.db.select().from(blindNullifiers);
  for (const authorization of [undefined, "PrivateToken token=AAAA"]) {
    const r = await h.request("/v1/messages/count_tokens", { method: "POST", headers: { [ONION_HEADER]: SECRET, ...(authorization ? { authorization } : {}) }, json: messages });
    expect(r.status).toBe(200);
    expect((await r.json()).input_tokens).toBe(countMessageTokens(messages));
  }
  expect(await h.ctx.db.select().from(blindNullifiers)).toEqual(before);
  expect((await h.request("/v1/messages/count_tokens", { method: "POST", json: messages })).status).toBe(401);
});

const stored = (value: string, id: string): StoredToken => ({ token: id.repeat(354), value_usd: value, denomination: 1000, epoch: 1, key_id: "issuer", redeem_until: new Date(Date.now() + 86_400_000).toISOString(), bought_at: new Date().toISOString() });
test("selection minimizes forfeit before token count and respects the cap", () => {
  const tokens = [stored("0.002", "a"), stored("0.002", "b"), stored("0.02", "c")];
  expect(selectTokens(tokens, 3_000_000_000n, 16)?.map((t) => t.value_usd)).toEqual(["0.002", "0.002"]);
  expect(selectTokens(tokens, 3_000_000_000n, 1)?.map((t) => t.value_usd)).toEqual(["0.02"]);
  expect(selectTokens(tokens, 25_000_000_000n, 16)).toBeNull();
  expect(selectTokens([stored("0.004", "d"), ...tokens], 4_000_000_000n, 16)).toHaveLength(1);
});

test("local estimator equals the router for tools, tool results and images", () => {
  const body = { ...messages, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "code.ts" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "contents" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] };
  expect(countMessageTokens(body)).toBe(estimatePromptTokens(toChatRequest(body, { countOnly: true }).body));
  expect(countMessageTokens(body)).toBeGreaterThan(1600);
});

test("Messages budget includes exact request, reasoning and royalty prices and caches through the supplied transport", async () => {
  let calls = 0;
  const budget = messageBudget(async (url) => { calls++; expect(url).toBe(`http://${ADDRESS}/api/v1/models?lane=unlinkable`); return Response.json({ data: [{ id: messages.model, pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000003", request: "0.0001" }, royalty_bps: 1000 }] }); }, ADDRESS);
  const base = BigInt(countMessageTokens(messages)) * 1_000_000n + 20n * 3_000_000n + 100_000_000n;
  expect(await budget(messages, AbortSignal.timeout(1000))).toBe(base + (base + 9n) / 10n);
  await budget(messages, AbortSignal.timeout(1000));
  expect(calls).toBe(1);
});

test("proxy answers count locally and sends streamed Messages with a budget-covering set, stripping metadata and keys", async () => {
  const { tokens, keyId, epoch } = await buy(3);
  const dir = tempDir();
  const store = new TokenStore(dir.dir);
  await store.add(tokens.map((token) => ({ ...stored("0.002", "a"), token, key_id: keyId, epoch })));
  let network = 0;
  let sentBody: Record<string, unknown> | null = null;
  const ingress = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => {
    const headers = new Headers(req.headers);
    if (req.method === "POST") {
      sentBody = await req.clone().json();
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("x-forwarded-for")).toBeNull();
    }
    headers.set(ONION_HEADER, SECRET);
    return h.app.request(new URL(req.url).pathname + new URL(req.url).search, { method: req.method, headers, body: req.method === "POST" ? await req.arrayBuffer() : undefined });
  } });
  const tor = await startTor({ [ADDRESS]: ingress.port! });
  const transport = torFetch({ host: "127.0.0.1", port: tor.port, label: "fixture" });
  const proxy = await startProxy({ port: 0, onion: ADDRESS, store, fetch: async (url, init) => {
    network++;
    return transport(url, init);
  } });
  try {
    const url = `http://127.0.0.1:${proxy.port}`;
    const counted = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", body: JSON.stringify(messages) });
    expect(counted.status).toBe(200);
    expect((await counted.json()).input_tokens).toBe(countMessageTokens(messages));
    expect(network).toBe(0);
    expect((await store.summary()).usable).toBe(3);
    const r = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "x-api-key": key.secret, "x-forwarded-for": "198.51.100.1" }, body: JSON.stringify({ ...messages, max_tokens: 9000, stream: true, metadata: { user_id: "identity" }, user: "identity" }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-lane")).toBe("unlinkable");
    expect(await r.text()).toContain("event: message_stop");
    expect(network).toBe(2);
    expect(tor.asked.every((a) => a.host === ADDRESS && a.atyp === 3)).toBe(true);
    expect(new Set(tor.asked.map((a) => a.username)).size).toBe(2);
    expect(sentBody!.tools).toEqual(messages.tools);
    expect(sentBody!.metadata).toBeUndefined();
    expect(sentBody!.user).toBeUndefined();
    expect((await store.summary()).usable).toBe(1);
    expect((await store.summary()).unconfirmed).toBe(0);
    const generation = (await h.ctx.db.select().from(generations)).at(-1)!;
    expect(generation.keyHash).toBeNull();
  } finally { await proxy.close(); await tor.close(); ingress.stop(true); dir.remove(); }
});

test("concurrent budget leases never reuse members and settlement returns the full set atomically", async () => {
  const dir = tempDir();
  const store = new TokenStore(dir.dir);
  try {
    await store.add([stored("0.002", "a"), stored("0.002", "b"), stored("0.002", "c")]);
    const leases = await Promise.all([store.leaseBudget(3_000_000_000n), store.leaseBudget(3_000_000_000n)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    expect((await store.summary()).unconfirmed).toBe(2);
    await store.settleMany(leases.find(Boolean)!, "returned");
    expect((await store.summary()).usable).toBe(3);
    expect((await store.summary()).unconfirmed).toBe(0);
  } finally { dir.remove(); }
});

test("proxy preserves a refused set and quarantines every member after an uncertain send", async () => {
  for (const outcome of ["refused", "lost"] as const) {
    const dir = tempDir();
    const store = new TokenStore(dir.dir);
    await store.add([stored("0.002", "a"), stored("0.002", "b")]);
    let calls = 0;
    const proxy = await startProxy({ port: 0, onion: ADDRESS, store, fetch: async (_url, init) => {
      calls++;
      if (init?.method !== "POST") return Response.json({ data: [{ id: messages.model, pricing: { prompt: "0", completion: "0.00000032", request: "0" } }] });
      init.onSent?.();
      if (outcome === "lost") throw new Error("fixture connection lost after send");
      return Response.json({ type: "error", error: { type: "permission_error", message: "No attested endpoint" }, anyroute: { type: "no_attested_endpoint" } }, { status: 503, headers: { "x-should-retry": "false", "request-id": "fixture-request" } });
    } });
    try {
      const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", body: JSON.stringify({ ...messages, max_tokens: 9000 }) });
      expect(r.status).toBe(outcome === "refused" ? 503 : 502);
      expect(calls).toBe(2); // one directory read and one inference; no retry on an uncertain send
      const summary = await store.summary();
      expect(summary.usable).toBe(outcome === "refused" ? 2 : 0);
      expect(summary.unconfirmed).toBe(outcome === "lost" ? 2 : 0);
      if (outcome === "refused") {
        expect(r.headers.get("x-should-retry")).toBe("false");
        expect(r.headers.get("request-id")).toBe("fixture-request");
      }
    } finally { await proxy.close(); dir.remove(); }
  }
});

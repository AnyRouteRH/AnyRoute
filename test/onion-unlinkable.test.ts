import { fixtureEdgeInit } from "./helpers.ts";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { ADMIN, MODELS, sse, startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { requestHash } from "../src/api/chat.ts";
import { blindNullifiers, generations } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { buyTokens } from "../src/blind/client.ts";
import { authorizationHeader, decodeBase64 } from "../src/blind/privacy-token.ts";
import { ONION_HEADER } from "../src/lib/onion.ts";
import { ADDRESS_HEADERS, onionIngress } from "../src/onion/ingress.ts";
import { unlinkableServed, unlinkableTransports } from "../src/onion/lane.ts";

// Lane "unlinkable" over Tor (UNLINKABLE_VIA_ONION): a request the onion proxy forwarded, paid with a blind token, is
// served on the lane by an attested provider, streamed or not. A clearnet request that copies the onion header is not.

setDefaultTimeout(60_000);

const LLAMA = MODELS.llama.slug;
const EMBED = MODELS.embed.slug;
// A version 3 onion hostname built from a throwaway key, and a proxy secret used only here.
const ADDRESS = "a2w2k7bgvjopikpj6lakthr6jjbnv3gul7cmsvoxye4zvnbcplunvlyd.onion";
const SECRET = "onion-unlinkable-proxy-secret-0123456789abcdef";
const ONION = { [ONION_HEADER]: SECRET };
/** The onion proxy reaches the router over a private network: every onion request comes from its address. */
const PROXY_PEER = { requestIP: () => ({ address: "10.20.30.40" }) };
/** An ordinary client on the public internet. */
const PUBLIC_PEER = { requestIP: () => ({ address: "198.51.100.7" }) };
const OLD = "2025-01-15";
const claim = { source: "https://provider.example/terms", as_of: OLD };
const chat = { model: LLAMA, messages: [{ role: "user", content: "hello" }], max_tokens: 20 };
const ONION_ENV = { ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET };
const LANE_ENV = { ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "1000", ...ONION_ENV, UNLINKABLE_VIA_ONION: "true" };
const PROVIDERS = [
  { id: "vendor", name: "Vendor", models: [MODELS.llama, MODELS.embed] },
  { id: "enclave", name: "Enclave", models: [MODELS.llama, MODELS.embed], tee: "dev" as const },
];
const PRODUCTION = {
  ANYROUTE_ENV: "production",
  RUNTIME_ROLE: "api",
  AUTO_MIGRATE: "false",
  HOST: "0.0.0.0",
  APP_SECRET: "fixture-".repeat(6),
  ADMIN_TOKEN: "fixture-admin-".repeat(3),
  PUBLIC_BASE_URL: "https://router.example",
  DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test",
  REDIS_URL: "redis://:fixture-only-credential@localhost:6379",
  CREDITS_ADDRESS: "0x" + "1".repeat(40),
  CALLPAY_ADDRESS: "0x" + "1".repeat(40),
  PROVIDER_BOND_ADDRESS: "0x" + "1".repeat(40),
  RECEIPT_ANCHOR_ADDRESS: "0x" + "1".repeat(40),
  ROUTER_PRIVATE_KEY: "0x" + "2".repeat(64),
};

const shim = (h: Harness): typeof fetch =>
  (async (input: unknown, init?: RequestInit) => {
    const u = new URL(String(input), "http://router.test");
    return h.app.request(u.pathname + u.search, fixtureEdgeInit(h, init));
  }) as never;

const tokenAuth = (token: string) => ({ authorization: authorizationHeader(decodeBase64(token)!) });

/** A request as the onion proxy hands it to the router (the secret set, from the proxy's address), or from the clearnet. */
function send(h: Harness, via: "onion" | "clearnet", body: unknown, headers: Record<string, string> = {}, path = "/api/v1/chat/completions") {
  const init = { method: "POST", headers: { "content-type": "application/json", ...(via === "onion" ? ONION : {}), ...headers }, body: JSON.stringify(body) };
  return h.app.request(path, fixtureEdgeInit(h, init), via === "onion" ? PROXY_PEER : PUBLIC_PEER);
}

async function attestEnclave(h: Harness) {
  const declare = (id: string, json: unknown) => h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json });
  expect((await declare("enclave", { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } })).status).toBe(200);
  await runAttestor(h.ctx);
}

// ---- configuration ---------------------------------------------------------------------------------------------

describe("configuration", () => {
  test("off by default, and the lane stays unserved", () => {
    const cfg = loadConfig({});
    expect(cfg.unlinkable).toEqual({ viaOnion: false });
    expect(unlinkableServed(cfg)).toBe(false);
    expect(unlinkableTransports(cfg)).toEqual([]);
  });

  test("the flag needs the onion service and blind tokens, and says which is missing", () => {
    expect(() => loadConfig({ UNLINKABLE_VIA_ONION: "true", ANYROUTE_FEATURE_BLIND: "true" })).toThrow(/UNLINKABLE_VIA_ONION requires ONION_ADDRESS and ONION_PROXY_SECRET/);
    // The secret alone recognises onion requests but publishes no address: not enough to serve the lane over Tor.
    expect(() => loadConfig({ UNLINKABLE_VIA_ONION: "true", ANYROUTE_FEATURE_BLIND: "true", ONION_PROXY_SECRET: SECRET })).toThrow(/UNLINKABLE_VIA_ONION requires ONION_ADDRESS/);
    expect(() => loadConfig({ UNLINKABLE_VIA_ONION: "true", ...ONION_ENV })).toThrow(/UNLINKABLE_VIA_ONION requires ANYROUTE_FEATURE_BLIND=true/);
    const cfg = loadConfig(LANE_ENV);
    expect(cfg.unlinkable).toEqual({ viaOnion: true });
    expect(cfg.ohttp.enabled).toBe(false); // an alternative to Oblivious HTTP, not a way of switching it on
    expect(unlinkableServed(cfg)).toBe(true);
    expect(unlinkableTransports(cfg)).toEqual(["onion"]);
    expect(unlinkableTransports(loadConfig({ ...LANE_ENV, OHTTP_ENABLED: "true" }))).toEqual(["ohttp", "onion"]);
    expect(unlinkableTransports(loadConfig({ ANYROUTE_FEATURE_BLIND: "true", OHTTP_ENABLED: "true" }))).toEqual(["ohttp"]);
  });

  test("production starts with the flag on when the onion service and blind tokens are configured, and fails clearly when not", () => {
    const load = (extra: Record<string, string>) => () => loadConfig({ ...PRODUCTION, ...extra });
    const cfg = load(LANE_ENV)();
    expect(cfg.production).toBe(true);
    expect(cfg.unlinkable.viaOnion).toBe(true);
    expect(cfg.ohttp.enabled).toBe(false);
    expect(unlinkableServed(cfg)).toBe(true);
    expect(load({ ...LANE_ENV, ONION_ADDRESS: "" })).toThrow(/UNLINKABLE_VIA_ONION requires ONION_ADDRESS and ONION_PROXY_SECRET/);
    expect(load({ ...LANE_ENV, ANYROUTE_FEATURE_BLIND: "false" })).toThrow(/UNLINKABLE_VIA_ONION requires ANYROUTE_FEATURE_BLIND=true/);
    // The Oblivious HTTP guard is untouched: switching that path on as well still needs relays from two other operators.
    expect(load({ ...LANE_ENV, OHTTP_ENABLED: "true" })).toThrow(/OHTTP_ENABLED in production needs relays from at least 2 operators/);
    // A worker loads the same configuration.
    const { ROUTER_PRIVATE_KEY: _signing, ...worker } = PRODUCTION;
    expect(loadConfig({ ...worker, ...LANE_ENV, RUNTIME_ROLE: "worker", WORKER_JOBS: "health-flush" }).unlinkable.viaOnion).toBe(true);
  });
});

// ---- the ingress middleware --------------------------------------------------------------------------------------

describe("client address headers on onion requests", () => {
  test("are removed before any route runs; other requests keep them", async () => {
    const app = new Hono();
    app.use("*", onionIngress({ onion: { address: ADDRESS, secrets: [SECRET], poolMultiplier: 10 } }));
    app.get("/seen", (c) => c.json(Object.fromEntries(ADDRESS_HEADERS.map((h) => [h, c.req.header(h) ?? null]))));
    const spoof = Object.fromEntries(ADDRESS_HEADERS.map((h, i) => [h, `203.0.113.${i + 1}`]));
    const seen = async (headers: Record<string, string>) => (await app.request("/seen", { headers })).json() as Promise<Record<string, string | null>>;
    expect(Object.values(await seen({ ...spoof, ...ONION })).every((v) => v === null)).toBe(true);
    expect(await seen(spoof)).toEqual(spoof);
    expect(await seen({ ...spoof, [ONION_HEADER]: SECRET.slice(0, -1) })).toEqual(spoof); // a wrong secret is not an onion request
    // With no secret configured nothing is an onion request.
    const bare = new Hono();
    bare.use("*", onionIngress({ onion: { address: null, secrets: [], poolMultiplier: 10 } }));
    bare.get("/xff", (c) => c.text(c.req.header("x-forwarded-for") ?? ""));
    expect(await (await bare.request("/xff", { headers: { ...ONION, "x-forwarded-for": "203.0.113.9" } })).text()).toBe("203.0.113.9");
  });
});

// ---- flag off --------------------------------------------------------------------------------------------------

describe("with UNLINKABLE_VIA_ONION off", () => {
  test("an onion request with a blind token is treated exactly as before: the lane is not served", async () => {
    const h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "1000", ...ONION_ENV }, providers: PROVIDERS });
    try {
      await attestEnclave(h);
      const api = await h.fundedKey(2n);
      const [token] = (await buyTokens({ baseUrl: "http://router.test", apiKey: api.secret, denomination: 10_000, count: 1, fetch: shim(h) })).tokens;
      const calls = h.mocks.enclave.stats.requests + h.mocks.vendor.stats.requests;
      for (const r of [await send(h, "onion", { ...chat, provider: { lane: "unlinkable" } }, tokenAuth(token)), await send(h, "onion", chat, { ...tokenAuth(token), "x-anyroute-lane": "unlinkable" })]) {
        expect(r.status).toBe(501);
        expect((await r.json()).error).toMatchObject({ type: "lane_not_available", metadata: { available_lanes: ["public", "attested"] } });
      }
      expect(h.mocks.enclave.stats.requests + h.mocks.vendor.stats.requests).toBe(calls);
      const status = (await (await h.request("/api/v1/status")).json()).data;
      expect(status.lanes.unlinkable).toMatchObject({ available: false, models: 0, endpoints: 0, via: [] });
      expect((await h.request("/api/v1/models?lane=unlinkable")).status).toBe(501);
      // Without a lane the request is served as it always was, on the public lane.
      const plain = await send(h, "onion", chat, tokenAuth(token));
      expect(plain.status).toBe(200);
      expect(plain.headers.get("x-anyroute-lane")).toBe("public");
    } finally {
      await h.close();
    }
  });

  test("with Oblivious HTTP on and this flag off, an onion request is refused as a direct one, with the same message as before", async () => {
    const h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", OHTTP_ENABLED: "true", BLIND_PURCHASE_RPM: "1000", ...ONION_ENV }, providers: PROVIDERS });
    try {
      const api = await h.fundedKey(2n);
      const [token] = (await buyTokens({ baseUrl: "http://router.test", apiKey: api.secret, denomination: 10_000, count: 1, fetch: shim(h) })).tokens;
      const r = await send(h, "onion", { ...chat, provider: { lane: "unlinkable" } }, tokenAuth(token));
      expect(r.status).toBe(403);
      const e = (await r.json()).error;
      expect(e.type).toBe("unlinkable_requires_relay");
      expect(e.message).toBe(
        'Lane "unlinkable" is only served for requests that arrive through an Oblivious HTTP relay. This request came directly, so the router would see your network address. Pick a relay from GET /api/v1/relays, send the request through it to the gateway, and pay with a blind token (Authorization: PrivateToken).',
      );
      expect(e.metadata).toEqual({ relays_url: "/api/v1/relays", gateway_url: "/api/v1/ohttp/gateway" });
      const keyed = await send(h, "onion", { ...chat, provider: { lane: "unlinkable" } }, api.auth);
      expect((await keyed.json()).error.message).toMatch(/send the request through an Oblivious HTTP relay, or set provider\.lane_downgrade/);
      expect((await (await h.request("/api/v1/status")).json()).data.lanes.unlinkable).toMatchObject({ available: true, via: ["ohttp"] });
    } finally {
      await h.close();
    }
  });
});

// ---- the lane over Tor -------------------------------------------------------------------------------------------

describe("lane unlinkable over Tor", () => {
  let h: Harness;
  let api: { secret: string; auth: Record<string, string> };
  let tokens: string[] = [];
  let next = 0;
  const token = () => tokens[next++];
  const spent = async () => (await h.ctx.db.select().from(blindNullifiers)).length;
  const gens = async () => (await h.ctx.db.select().from(generations)).length;
  const providerCalls = () => h.mocks.enclave.stats.requests + h.mocks.vendor.stats.requests;
  const unlinkable = { ...chat, provider: { lane: "unlinkable" } };

  beforeAll(async () => {
    // TRUST_PROXY as behind a platform edge: X-Forwarded-For would be read for clearnet clients, never for onion ones.
    h = await startRouter({ env: { ...LANE_ENV, TRUST_PROXY: "true" }, providers: PROVIDERS });
    api = await h.fundedKey(10n);
    tokens = (await buyTokens({ baseUrl: "http://router.test", apiKey: api.secret, denomination: 10_000, count: 16, fetch: shim(h) })).tokens;
    expect(tokens).toHaveLength(16);
  });
  afterAll(async () => {
    await h.close();
  });

  test("a clearnet request that sends the onion header without the proxy's secret does not get the lane", async () => {
    const t = token();
    const before = { spent: await spent(), gens: await gens(), calls: providerCalls() };
    const forged = ["1", "true", "onion", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), ` ${SECRET}x `, ""];
    const attempts = [
      await send(h, "clearnet", unlinkable, tokenAuth(t)),
      await send(h, "clearnet", chat, { ...tokenAuth(t), "x-anyroute-lane": "unlinkable" }),
      await send(h, "clearnet", { ...unlinkable, stream: true }, tokenAuth(t)),
      ...(await Promise.all(forged.map((v) => send(h, "clearnet", unlinkable, { ...tokenAuth(t), [ONION_HEADER]: v, "x-forwarded-for": "10.20.30.40", "x-real-ip": "10.20.30.40" })))),
      // The secret in some other header means nothing either.
      await send(h, "clearnet", unlinkable, { ...tokenAuth(t), "x-anyroute-tor": SECRET, "x-onion": SECRET, via: `1.1 ${ADDRESS}`, forwarded: `for=${ADDRESS}` }),
    ];
    for (const r of attempts) {
      expect(r.status).toBe(403);
      const e = (await r.json()).error;
      expect(e.type).toBe("unlinkable_requires_relay");
      expect(e.message).toMatch(/over Tor to this router's onion service/);
      expect(e.message).toContain(`http://${ADDRESS}`);
      expect(e.message).toMatch(/blind token/);
      expect(e.metadata).toEqual({ status_url: "/api/v1/status", onion_url: `http://${ADDRESS}` });
    }
    // Nothing was spent, recorded or sent anywhere.
    expect(await spent()).toBe(before.spent);
    expect(await gens()).toBe(before.gens);
    expect(providerCalls()).toBe(before.calls);
  });

  test("with no attested provider the lane is refused over Tor too (503 no_attested_endpoint), and the token is kept", async () => {
    const before = { spent: await spent(), calls: providerCalls() };
    const r = await send(h, "onion", unlinkable, tokenAuth(tokens[next]));
    expect(r.status).toBe(503);
    const e = (await r.json()).error;
    expect(e.type).toBe("no_attested_endpoint");
    expect(e.message).toMatch(/lane "unlinkable"/);
    expect(await spent()).toBe(before.spent);
    expect(providerCalls()).toBe(before.calls);
    const status = (await (await h.request("/api/v1/status")).json()).data;
    expect(status.lanes.unlinkable).toMatchObject({ available: true, models: 0, endpoints: 0, via: ["onion"] });
  });

  test("a genuine onion request paid with a blind token is served on the lane by the attested provider alone", async () => {
    await attestEnclave(h);
    const t = token();
    const before = { spent: await spent(), vendor: h.mocks.vendor.stats.requests, enclave: h.mocks.enclave.stats.requests };
    const r = await send(h, "onion", unlinkable, tokenAuth(t));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-lane")).toBe("unlinkable");
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    const j = await r.json();
    expect(j.provider).toBe("Enclave");
    expect(r.headers.get("x-receipt-id")).toBe(j.receipt.id);
    expect(j.receipt.payload).toMatchObject({ lane: "unlinkable", disclosure: "attested", payer: null, provider: "enclave" });
    expect(j.receipt.payload.nullifier).toMatch(/^[0-9a-f]{64}$/);
    expect(h.mocks.enclave.stats.requests).toBe(before.enclave + 1);
    expect(h.mocks.vendor.stats.requests).toBe(before.vendor);
    expect(await spent()).toBe(before.spent + 1);
    const ver = await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: j.receipt.payload, sig: j.receipt.sig, key_id: j.receipt.key_id } });
    expect((await ver.json()).data.signature_valid).toBe(true);
    // A token spends once, over Tor as anywhere.
    const again = await send(h, "onion", unlinkable, tokenAuth(t));
    expect(again.status).toBe(401);
    expect((await again.json()).error.type).toBe("token_spent");
  });

  test("streamed over Tor: the lane, the attested provider and the token are the same", async () => {
    const before = { spent: await spent(), vendor: h.mocks.vendor.stats.requests, enclave: h.mocks.enclave.stats.requests };
    const r = await send(h, "onion", { ...unlinkable, stream: true }, tokenAuth(token()));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("x-anyroute-lane")).toBe("unlinkable");
    const s = await sse(r);
    expect(s.done).toBe(true);
    expect(s.events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).not.toBe("");
    expect(h.mocks.enclave.stats.requests).toBe(before.enclave + 1);
    expect(h.mocks.vendor.stats.requests).toBe(before.vendor);
    expect(await spent()).toBe(before.spent + 1);
    // The last event carries the signed receipt, which records the lane.
    const receipt = s.events.find((e) => e.receipt)?.receipt;
    expect(receipt?.payload).toMatchObject({ lane: "unlinkable", disclosure: "attested", payer: null, provider: "enclave" });
  });

  test("the lane by header, and embeddings, work over Tor the same way", async () => {
    const viaHeader = await send(h, "onion", chat, { ...tokenAuth(token()), "x-anyroute-lane": "unlinkable" });
    expect(viaHeader.status).toBe(200);
    expect((await viaHeader.json()).receipt.payload).toMatchObject({ lane: "unlinkable", provider: "enclave" });
    const emb = await send(h, "onion", { model: EMBED, input: "hello", provider: { lane: "unlinkable" } }, tokenAuth(token()), "/api/v1/embeddings");
    expect(emb.status).toBe(200);
    expect(emb.headers.get("x-anyroute-lane")).toBe("unlinkable");
    expect((await emb.json()).receipt.payload).toMatchObject({ lane: "unlinkable", disclosure: "attested", payer: null });
  });

  test("over Tor, an API key, a wallet or a per-call payment is refused exactly as on the lane anywhere else", async () => {
    const before = { spent: await spent(), gens: await gens(), calls: providerCalls() };
    const wallet = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const signed = async (body: Record<string, unknown>) => {
      const ts = Math.floor(Date.now() / 1000);
      return { "x-wallet-auth": `${wallet.address}:${ts}:${await wallet.signMessage({ message: `anyroute:${ts}:${requestHash(body)}` })}` };
    };
    const withKey = await send(h, "onion", unlinkable, api.auth);
    const withWallet = await send(h, "onion", unlinkable, await signed(unlinkable));
    const withPayment = await send(h, "onion", unlinkable, { "x-payment": "0x" + "ab".repeat(32) });
    const keyByHeader = await send(h, "onion", chat, { ...api.auth, "x-anyroute-lane": "unlinkable" });
    for (const r of [withKey, withWallet, withPayment, keyByHeader]) {
      expect(r.status).toBe(403);
      const e = (await r.json()).error;
      expect(e).toMatchObject({ type: "lane_requires_anonymous_auth", metadata: { lane: "unlinkable", downgrade: "attested" } });
      expect(e.message).toMatch(/never with an API key or a wallet, because those name the payer/);
    }
    // The same refusal as from the clearnet: the transport does not change the payment rule.
    const clearnet = await send(h, "clearnet", unlinkable, api.auth);
    expect(clearnet.status).toBe(403);
    expect((await clearnet.json()).error.type).toBe("lane_requires_anonymous_auth");
    expect(await spent()).toBe(before.spent);
    expect(await gens()).toBe(before.gens);
    expect(providerCalls()).toBe(before.calls);
    // An explicit downgrade serves a key holder on lane attested (attested providers only), never unlinkable or public.
    const vendor = h.mocks.vendor.stats.requests;
    const down = await send(h, "onion", { ...chat, provider: { lane: "unlinkable", lane_downgrade: "attested" } }, api.auth);
    expect(down.status).toBe(200);
    expect(down.headers.get("x-anyroute-lane")).toBe("attested");
    expect((await down.json()).receipt.payload).toMatchObject({ lane: "attested", provider: "enclave" });
    expect(h.mocks.vendor.stats.requests).toBe(vendor);
    // No payment at all gets the token challenge.
    const none = await send(h, "onion", unlinkable);
    expect(none.status).toBe(401);
    expect((await none.json()).error.type).toBe("unlinkable_requires_token");
    expect(none.headers.get("www-authenticate")).toMatch(/^PrivateToken challenge="/);
  });

  test("forwarded address headers are ignored and stripped: limits use the shared onion bucket, and nothing stored names an address", async () => {
    const keys: string[] = [];
    const limiter = h.ctx.limiter;
    h.ctx.limiter = { take: (key, amount, limit, windowMs) => (keys.push(key), limiter.take(key, amount, limit, windowMs)), close: () => limiter.close() };
    const marks = ["203.0.113.61", "203.0.113.62", "203.0.113.63", "2001:db8::64", "203.0.113.65"];
    try {
      const r = await send(h, "onion", unlinkable, {
        ...tokenAuth(token()),
        "x-forwarded-for": `${marks[0]}, ${marks[1]}`,
        "x-real-ip": marks[2],
        "cf-connecting-ip": marks[3],
        "true-client-ip": marks[4],
        forwarded: `for=${marks[0]}`,
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("x-anyroute-lane")).toBe("unlinkable");
      // The only per-request limit is the shared onion pool for blind-token calls; no address, and not the proxy's either.
      expect(keys).toContain("blind-ip:onion");
      for (const k of keys) {
        for (const m of [...marks, "10.20.30.40"]) expect(k).not.toContain(m);
      }
    } finally {
      h.ctx.limiter = limiter;
    }
    const dump = JSON.stringify(await h.ctx.db.select().from(generations), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const m of [...marks, "10.20.30.40", SECRET]) expect(dump).not.toContain(m);
  });

  test("a token request over Tor that names no lane stays public, as before: the lane is asked for, never assumed", async () => {
    const r = await send(h, "onion", chat, tokenAuth(token()));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-lane")).toBe("public");
  });

  test("status and the model list say the lane is served, and over which transport", async () => {
    const status = (await (await h.request("/api/v1/status")).json()).data;
    expect(status.lanes.unlinkable.available).toBe(true);
    expect(status.lanes.unlinkable.via).toEqual(["onion"]);
    expect(status.lanes.unlinkable.models).toBeGreaterThan(0);
    expect(status.lanes.unlinkable.endpoints).toBeGreaterThan(0);
    expect(status.onion).toEqual({ address: ADDRESS, url: `http://${ADDRESS}` });
    expect(JSON.stringify(status)).not.toContain(SECRET);
    const listed = await h.request("/api/v1/models?lane=unlinkable");
    expect(listed.status).toBe(200);
    const models = (await listed.json()).data as { id: string; lanes: string[] }[];
    expect(models.map((m) => m.id)).toContain(LLAMA);
    expect(models.every((m) => m.lanes.includes("unlinkable"))).toBe(true);
  });
});

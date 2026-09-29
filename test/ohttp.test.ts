import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { apps, blindNullifiers, generations, ohttpKeys } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { blindTokens, buyTokens, fetchDirectory, finalizeTokens, issuingKey } from "../src/blind/client.ts";
import { authorizationHeader, decodeBase64 } from "../src/blind/privacy-token.ts";
import { encodeRequest, encodeResponse, decodeResponse, type HeaderList } from "../src/ohttp/bhttp.ts";
import { KEM_X25519, MEDIA_KEYS, MEDIA_REQ, MEDIA_RES, parseKeyConfigList, sealRequest, serializeKeyConfigList, type PublicKeyConfig as KeyConfig } from "../src/ohttp/ohttp.ts";
import { OhttpKeys, keyIdOfEpoch, keyLog } from "../src/ohttp/keys.ts";
import { ReplayGuard } from "../src/ohttp/replay.ts";
import { fetchKeyConfig, fetchKeyList, logExtends, sendViaRelay, verifyKeyList, type KeyListDocument } from "../src/ohttp/client.ts";
import { gatewayOrigin, markFromGateway } from "../src/ohttp/origin.ts";
import { loadConfig as loadRelayConfig } from "../relay/src/config.ts";
import { createRelay } from "../relay/src/relay.ts";

// The unlinkable lane end to end: a client, a relay (the real relay package), the gateway in the router, the router's
// own chat / embeddings / blind-purchase routes, a blind token, and an attested mock provider.

setDefaultTimeout(60_000);

const LLAMA = MODELS.llama.slug;
const EMBED = MODELS.embed.slug;
const chat = { model: LLAMA, messages: [{ role: "user", content: "hello" }], max_tokens: 20 };
const OLD = "2025-01-15";
const claim = { source: "https://provider.example/terms", as_of: OLD };
const SEAL_MAX = 1 << 24;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const SECRET_ALPHA = "alpha-relay-secret-value-0001";
const SECRET_SELF = "self-relay-secret-value-0002";
const SECRET_BETA = "beta-relay-secret-value-0003";
const RELAYS = [
  { operator: "Alpha Relay Co", url: "https://relay.alpha.example/relay", key_id: "alpha-1", secret_sha256: sha(SECRET_ALPHA) },
  { operator: "AnyRoute", url: "https://relay.anyroute.example/relay", key_id: "self-1", secret_sha256: sha(SECRET_SELF) },
  { operator: "Beta Relay Org", url: "https://relay.beta.example/relay", key_id: "beta-1", secret_sha256: sha(SECRET_BETA) },
];
const OHTTP_ENV = { ANYROUTE_FEATURE_BLIND: "true", OHTTP_ENABLED: "true", BLIND_PURCHASE_RPM: "1000", RELAY_OPERATORS: JSON.stringify(RELAYS) };

/** The relay package, configured for one of the test relays, forwarding to the router's own app instead of the network. */
function relayFor(h: Harness, keyId: string, secret: string) {
  const cfg = loadRelayConfig({ RELAY_GATEWAYS: JSON.stringify([{ name: "router", url: "https://router.test/api/v1/ohttp/gateway", credential: `${keyId}:${secret}` }]) });
  const seenByGateway: { headers: Record<string, string>; url: string }[] = [];
  const relay = createRelay(cfg, (async (url: string, init?: RequestInit) => {
    seenByGateway.push({ headers: Object.fromEntries(new Headers(init?.headers)), url: String(url) });
    return h.app.request(new URL(String(url)).pathname, init);
  }) as never);
  const handlerFetch = (async (url: string, init?: RequestInit) => relay.handle(new Request(String(url), init))) as never as typeof fetch;
  return { relay, seenByGateway, fetch: handlerFetch, url: "https://relay.test/relay" };
}

async function servedKey(h: Harness): Promise<KeyConfig> {
  const res = await h.request("/api/v1/ohttp/keys");
  expect(res.status).toBe(200);
  return parseKeyConfigList(new Uint8Array(await res.arrayBuffer()))[0];
}

/** A fetch that carries every call to the router through a relay and the gateway, like a client of the unlinkable lane. */
function throughRelay(r: ReturnType<typeof relayFor>, keyConfig: KeyConfig): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const u = new URL(String(input), "https://router.test");
    const res = await sendViaRelay({ relayUrl: r.url, keyConfig, method: init?.method ?? "GET", path: u.pathname + u.search, headers: [...new Headers(init?.headers).entries()], body: init?.body as string | undefined, fetch: r.fetch });
    return new Response(res.body as never, { status: res.status, headers: res.headers });
  }) as never;
}

/** POST to the gateway directly (no relay), returning the raw response and, when it is encapsulated, the inner one. */
async function toGateway(h: Harness, cfg: KeyConfig, req: { method?: string; path: string; headers?: HeaderList; body?: string }, extra: Record<string, string> = {}) {
  const bhttp = encodeRequest({ method: req.method ?? "POST", path: req.path, headers: req.headers ?? [], body: req.body ? new TextEncoder().encode(req.body) : undefined });
  const sent = await sealRequest(cfg, bhttp, SEAL_MAX);
  const res = await h.request("/api/v1/ohttp/gateway", { method: "POST", headers: { "content-type": MEDIA_REQ, ...extra }, body: sent.encapsulated as never });
  const raw = new Uint8Array(await res.clone().arrayBuffer());
  const inner = res.status === 200 && res.headers.get("content-type") === MEDIA_RES ? decodeResponse(await sent.openResponse(raw)) : null;
  return { res, inner, sent, raw };
}
const innerJson = (inner: ReturnType<typeof decodeResponse>) => JSON.parse(new TextDecoder().decode(inner.body));

async function attestEnclave(h: Harness) {
  const declare = (id: string, json: unknown) => h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json });
  expect((await declare("enclave", { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } })).status).toBe(200);
  expect(((await runAttestor(h.ctx)).results.find((r) => (r as { provider?: string }).provider === "enclave") as { ok: boolean } | undefined)?.ok ?? true).toBe(true);
}

const PROVIDERS = [
  { id: "vendor", name: "Vendor", models: [MODELS.llama, MODELS.embed] },
  { id: "enclave", name: "Enclave", models: [MODELS.llama, MODELS.embed], tee: "dev" as const },
];

// ---- off by default --------------------------------------------------------------------------------------------

describe("feature flag", () => {
  test("Oblivious HTTP is off by default: no routes, no keys, no job, and the unlinkable lane keeps answering 501", async () => {
    const h = await startRouter();
    try {
      expect(h.ctx.cfg.ohttp.enabled).toBe(false);
      expect(h.ctx.ohttp).toBeUndefined();
      for (const [method, path] of [["GET", "/api/v1/ohttp/keys"], ["GET", "/.well-known/ohttp-gateway"], ["POST", "/api/v1/ohttp/gateway"], ["GET", "/api/v1/ohttp/key-list"], ["GET", "/api/v1/relays"]] as const)
        expect((await h.request(path, { method })).status).toBe(404);
      expect(h.ctx.jobs.status().map((j) => j.name)).not.toContain("ohttp-key-rotation");
      expect(await h.ctx.db.select().from(ohttpKeys)).toHaveLength(0); // nothing is generated while the feature is off
      for (const [body, headers] of [[{ ...chat, provider: { lane: "unlinkable" } }, {}], [chat, { "x-anyroute-lane": "unlinkable" }]] as const) {
        const r = await h.request("/api/v1/chat/completions", { method: "POST", headers, json: body });
        expect(r.status).toBe(501);
        expect((await r.json()).error.type).toBe("lane_not_available");
      }
      expect((await h.request("/api/v1/models?lane=unlinkable")).status).toBe(501);
    } finally {
      await h.close();
    }
  });

  test("configuration defaults and validation", () => {
    expect(loadConfig({}).ohttp).toMatchObject({ enabled: false, keyEpochSeconds: 86_400, keyGraceSeconds: 86_400, padBytes: 256, relays: [] });
    const on = (extra: Record<string, string> = {}) => () => loadConfig({ ANYROUTE_FEATURE_BLIND: "true", OHTTP_ENABLED: "true", ...extra });
    expect(on()).not.toThrow();
    expect(() => loadConfig({ OHTTP_ENABLED: "true" })).toThrow(/requires ANYROUTE_FEATURE_BLIND/);
    expect(on({ OHTTP_KEY_EPOCH_SECONDS: "10" })).toThrow(/OHTTP_KEY_EPOCH_SECONDS/);
    expect(on({ OHTTP_KEY_EPOCH_SECONDS: "60", OHTTP_KEY_GRACE_SECONDS: "6001" })).toThrow(/OHTTP_KEY_GRACE_SECONDS/);
    expect(on({ OHTTP_MAX_REQUEST_BYTES: "10" })).toThrow(/OHTTP_MAX_REQUEST_BYTES/);
    expect(on({ OHTTP_RELAY_RPM: "0" })).toThrow(/RPM/);
    expect(on({ OHTTP_PAD_BYTES: "-1" })).toThrow(/OHTTP_PAD_BYTES/);
    expect(on({ RELAY_OPERATORS: "nope" })).toThrow(/RELAY_OPERATORS/);
    const one = { operator: "Op", url: "https://relay.example/r", key_id: "op-1", secret_sha256: "a".repeat(64) };
    expect(on({ RELAY_OPERATORS: JSON.stringify([one]) })).not.toThrow();
    expect(on({ RELAY_OPERATORS: JSON.stringify([{ ...one, url: "http://relay.example/r" }]) })).not.toThrow(); // http is only for development
    expect(on({ RELAY_OPERATORS: JSON.stringify([{ ...one, key_id: "bad id" }]) })).toThrow(/key_id/);
    expect(on({ RELAY_OPERATORS: JSON.stringify([{ ...one, secret_sha256: "abc" }]) })).toThrow(/secret_sha256/);
    expect(on({ RELAY_OPERATORS: JSON.stringify([{ ...one, extra: 1 }]) })).toThrow(/RELAY_OPERATORS/);
    expect(on({ RELAY_OPERATORS: JSON.stringify([{ ...one, url: "https://u:p@relay.example/r" }]) })).toThrow(/credentials/);
    expect(on({ RELAY_OPERATORS: JSON.stringify([one, { ...one, operator: "Other", secret_sha256: "b".repeat(64) }]) })).toThrow(/unique/); // same key_id
    expect(on({ RELAY_OPERATORS: JSON.stringify([one, { ...one, operator: "Other", key_id: "op-2" }]) })).toThrow(/own secret/);
    const cfg = on({ RELAY_OPERATORS: JSON.stringify(RELAYS) })();
    expect(cfg.ohttp.relays.map((r) => r.keyId)).toEqual(["alpha-1", "self-1", "beta-1"]);
  });

  test("production needs relays from enough operators other than the gateway's own", () => {
    const production = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: "0x" + "1".repeat(40), CALLPAY_ADDRESS: "0x" + "1".repeat(40), PROVIDER_BOND_ADDRESS: "0x" + "1".repeat(40), RECEIPT_ANCHOR_ADDRESS: "0x" + "1".repeat(40), ROUTER_PRIVATE_KEY: "0x" + "2".repeat(64), ANYROUTE_FEATURE_BLIND: "true", OHTTP_ENABLED: "true" };
    const load = (relays: unknown[], extra: Record<string, string> = {}) => () => loadConfig({ ...production, RELAY_OPERATORS: JSON.stringify(relays), ...extra });
    const [alpha, self, beta] = RELAYS;
    expect(load([])).toThrow(/at least 2 operators/);
    expect(load([alpha])).toThrow(/at least 2 operators/);
    expect(load([alpha, self])).toThrow(/at least 2 operators/); // the gateway operator's own relay does not count
    expect(load([alpha, beta])).not.toThrow();
    expect(load([alpha, { ...beta, operator: "alpha relay co", key_id: "beta-2", secret_sha256: sha("x") }])).toThrow(/at least 2 operators/); // one operator under two names
    expect(load([alpha], { OHTTP_MIN_RELAY_OPERATORS: "1" })).not.toThrow();
    expect(load([alpha, beta], { OHTTP_GATEWAY_OPERATOR: "Beta Relay Org" })).toThrow(/at least 2 operators/); // now Beta is the gateway's own
    expect(load([alpha, beta, self], { OHTTP_GATEWAY_OPERATOR: "Beta Relay Org" })).not.toThrow(); // and AnyRoute is another operator
    expect(load([{ ...alpha, url: "http://relay.alpha.example/relay" }, beta])).toThrow(/https/);
    const { ROUTER_PRIVATE_KEY: _signing, ...workerEnv } = production;
    expect(loadConfig({ ...workerEnv, RELAY_OPERATORS: JSON.stringify([alpha, beta]), RUNTIME_ROLE: "worker", WORKER_JOBS: "ohttp-key-rotation" }).workerJobs).toEqual(["ohttp-key-rotation"]);
  });
});

// ---- keys, key list, relays --------------------------------------------------------------------------------------

describe("gateway keys, the signed key list and the relay list", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: OHTTP_ENV, providers: PROVIDERS });
  });
  afterAll(async () => {
    await h.close();
  });

  test("GET /api/v1/ohttp/keys serves one application/ohttp-keys configuration, also at the well-known path", async () => {
    const res = await h.request("/api/v1/ohttp/keys");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(MEDIA_KEYS);
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const [cfg, ...rest] = parseKeyConfigList(bytes);
    expect(rest).toHaveLength(0);
    expect(cfg.kemId).toBe(KEM_X25519);
    expect(cfg.symmetricAlgorithms).toEqual([{ kdfId: 1, aeadId: 1 }]);
    expect(cfg.publicKey).toHaveLength(32);
    expect(cfg.keyId).toBe(keyIdOfEpoch(h.ctx.ohttp!.epochAt()));
    expect(Buffer.from(serializeKeyConfigList([cfg]))).toEqual(Buffer.from(bytes)); // canonical
    const wk = await h.request("/.well-known/ohttp-gateway");
    expect(wk.headers.get("content-type")).toBe(MEDIA_KEYS);
    expect(Buffer.from(await wk.arrayBuffer())).toEqual(Buffer.from(bytes));
  });

  test("private keys are encrypted at rest; the current and next epoch have keys; nothing secret is published", async () => {
    await servedKey(h);
    const epoch = h.ctx.ohttp!.epochAt();
    const rows = await h.ctx.db.select().from(ohttpKeys);
    expect(rows.map((r) => r.epoch).sort()).toEqual([epoch, epoch + 1]);
    for (const r of rows) {
      expect(r.privateEnc).toMatch(/^v1\./);
      expect(r.privateEnc).not.toContain(r.publicKey);
      expect(r.keyId).toBe(keyIdOfEpoch(r.epoch));
      expect(r.configSha256).toBe(createHash("sha256").update(Buffer.from(r.config, "base64url")).digest("hex"));
    }
    const list = await (await h.request("/api/v1/ohttp/key-list")).text();
    expect(list).not.toMatch(/private_enc|secret_sha256/);
    for (const r of rows) expect(list).not.toContain(r.privateEnc!);
    for (const s of [SECRET_ALPHA, SECRET_SELF, SECRET_BETA, ...RELAYS.map((r) => r.secret_sha256)]) expect(list).not.toContain(s);
    expect(await (await h.request("/api/v1/relays")).text()).not.toMatch(new RegExp(RELAYS.map((r) => r.secret_sha256).join("|")));
  });

  test("the key list is signed with the receipt key, chained, and lists the next key as upcoming before it is served", async () => {
    const doc = (await (await h.request("/api/v1/ohttp/key-list")).json()) as KeyListDocument;
    const jwks = (await (await h.request("/api/v1/receipts/keys")).json()) as { keys: { x: string; kid: string }[] };
    const signer = jwks.keys.find((k) => k.kid === doc.signature.key_id)!;
    const signerHex = Buffer.from(signer.x, "base64url").toString("hex");
    const usable = verifyKeyList(doc, [signerHex]);
    const epoch = h.ctx.ohttp!.epochAt();
    expect(doc.data.keys.map((k) => [k.epoch, k.status])).toEqual([[epoch, "current"], [epoch + 1, "upcoming"]]);
    expect(usable.map((k) => k.epoch)).toEqual([epoch]); // the upcoming key is published but not offered
    expect(doc.data.log).toMatchObject({ algorithm: "sha256-chain", entries: 2, first_prev: "0".repeat(64) });
    expect(doc.data.log.head).toBe(doc.data.keys[1].entry_hash);
    expect(doc.data.relays.map((r) => [r.operator, r.key_id, r.independent])).toEqual([["Alpha Relay Co", "alpha-1", true], ["AnyRoute", "self-1", false], ["Beta Relay Org", "beta-1", true]]);
    expect(doc.data.router).toBe(h.ctx.cfg.publicUrl);
    // Altering anything the signature covers is caught: a substituted key, a dropped entry, a relay swapped in.
    const forged = (edit: (d: KeyListDocument) => void) => {
      const copy = structuredClone(doc);
      edit(copy);
      return () => verifyKeyList(copy, [signerHex]);
    };
    expect(forged((d) => (d.data.keys[0].public_key = d.data.keys[1].public_key))).toThrow(/signature/);
    expect(forged((d) => d.data.keys.pop())).toThrow(/signature/);
    expect(forged((d) => (d.data.relays[0].url = "https://relay.evil.example/relay"))).toThrow(/signature/);
    expect(() => verifyKeyList(doc, ["00".repeat(32)])).toThrow(/signature/);
    // A signer that re-signs a forged chain is still caught by the chain itself.
    const rechained = structuredClone(doc);
    rechained.data.keys[0].config_sha256 = "f".repeat(64);
    expect(() => verifyKeyList(rechained, [])).toThrow(/signature/);
  });

  test("the client helper returns the served configuration only if the signed list contains it", async () => {
    const jwks = (await (await h.request("/api/v1/receipts/keys")).json()) as { keys: { x: string }[] };
    const trusted = jwks.keys.map((k) => Buffer.from(k.x, "base64url").toString("hex"));
    const shim = (async (input: unknown, init?: RequestInit) => h.app.request(new URL(String(input)).pathname, init)) as never as typeof fetch;
    const got = await fetchKeyConfig("https://router.test", { trustedSigners: trusted, fetch: shim });
    expect(got.config).toEqual(await servedKey(h));
    expect(got.epoch).toBe(h.ctx.ohttp!.epochAt());
    // Trust on first use works too, and a wrong pin is refused.
    expect((await fetchKeyConfig("https://router.test", { fetch: shim })).logHead).toBe(got.logHead);
    await expect(fetchKeyConfig("https://router.test", { trustedSigners: ["00".repeat(32)], fetch: shim })).rejects.toThrow(/signature/);
    // A gateway that serves a key the signed list does not contain (a substituted key) is refused.
    const swap: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.pathname !== "/api/v1/ohttp/keys") return shim(input as never, init);
      const cfg = await servedKey(h);
      const other = { ...cfg, publicKey: new Uint8Array(32).fill(7) };
      return new Response(serializeKeyConfigList([other]) as never, { headers: { "content-type": MEDIA_KEYS } });
    }) as never;
    await expect(fetchKeyConfig("https://router.test", { trustedSigners: trusted, fetch: swap })).rejects.toThrow(/not in the signed key list/);
    const doc = await fetchKeyList("https://router.test", shim);
    expect(doc.data.kind).toBe("ohttp-key-list");
  });

  test("GET /api/v1/relays lists the operators with their key ids and flags the gateway operator's own relay", async () => {
    const res = await h.request("/api/v1/relays");
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.lane).toBe("unlinkable");
    expect(d.gateway).toMatchObject({ operator: "AnyRoute", url: `${h.ctx.cfg.publicUrl}/api/v1/ohttp/gateway` });
    expect(d.relays).toEqual([
      { operator: "Alpha Relay Co", url: "https://relay.alpha.example/relay", key_id: "alpha-1", independent: true },
      { operator: "AnyRoute", url: "https://relay.anyroute.example/relay", key_id: "self-1", independent: false },
      { operator: "Beta Relay Org", url: "https://relay.beta.example/relay", key_id: "beta-1", independent: true },
    ]);
    expect(d.independent_operators).toBe(2);
  });

  test("the rotation job runs, is idempotent, and is a worker job", async () => {
    expect(h.ctx.jobs.status().map((j) => j.name)).toContain("ohttp-key-rotation");
    const first = (await h.ctx.jobs.run("ohttp-key-rotation")) as { epoch: number; created: number; destroyed: number };
    expect(first.epoch).toBe(h.ctx.ohttp!.epochAt());
    expect(await h.ctx.jobs.run("ohttp-key-rotation")).toMatchObject({ created: 0, destroyed: 0 });
  });
});

// ---- rotation ---------------------------------------------------------------------------------------------------

describe("key rotation by epoch", () => {
  test("a key opens requests through its epoch and its grace period, is replaced, and is destroyed", async () => {
    const h = await startRouter({ env: { ...OHTTP_ENV, OHTTP_KEY_EPOCH_SECONDS: "3600", OHTTP_KEY_GRACE_SECONDS: "1800" }, providers: PROVIDERS });
    try {
      const keys = h.ctx.ohttp!;
      const HOUR = 3_600_000;
      const start = (Math.floor(Date.now() / HOUR) + 1000) * HOUR; // an epoch boundary far from any other test
      let t = start + 10 * 60_000;
      keys.now = () => t;
      const e0 = keys.epochAt();
      const get = (path: string, ...rest: []) => h.request(path, ...rest);
      const models = (cfg: KeyConfig) => toGateway(h, cfg, { method: "GET", path: "/api/v1/models" });

      const k0 = await servedKey(h);
      expect(k0.keyId).toBe(keyIdOfEpoch(e0));
      expect((await models(k0)).inner!.status).toBe(200);
      const doc0 = (await (await get("/api/v1/ohttp/key-list")).json()) as KeyListDocument;

      // Ten minutes into the next epoch: clients are told to use the new key, and the old key still works (grace).
      t = start + HOUR + 10 * 60_000;
      const k1 = await servedKey(h);
      expect(keys.epochAt()).toBe(e0 + 1);
      expect(k1.keyId).toBe(keyIdOfEpoch(e0 + 1));
      expect(Buffer.from(k1.publicKey)).not.toEqual(Buffer.from(k0.publicKey));
      expect((await models(k1)).inner!.status).toBe(200);
      expect((await models(k0)).inner!.status).toBe(200);
      const doc1 = (await (await get("/api/v1/ohttp/key-list")).json()) as KeyListDocument;
      // The key for the epoch after next was created ahead when the new key was first served; the old key is kept for its grace period.
      expect((await keys.rotate())).toMatchObject({ created: 0, destroyed: 0 });
      expect((await keys.history()).map((k) => k.epoch)).toEqual([e0, e0 + 1, e0 + 2]);

      // Past the grace period (30 minutes into the epoch after the key's own): the private half is destroyed.
      t = start + HOUR + 45 * 60_000;
      const stale = await models(k0);
      expect(stale.res.status).toBe(422); // the key identifier is no longer accepted: refused before unwrapping
      expect(stale.res.headers.get("content-type")).toBe("application/problem+json");
      expect((await stale.res.json()).type).toBe("https://iana.org/assignments/http-problem-types#ohttp-key");
      expect((await keys.rotate())).toMatchObject({ destroyed: 1 });
      const [row0] = await h.ctx.db.select().from(ohttpKeys).where(eq(ohttpKeys.epoch, e0));
      expect(row0.privateEnc).toBeNull();
      // Nor does this process keep the expired key's imported form once a later key has been used.
      expect((await models(k1)).inner!.status).toBe(200);
      expect((keys as unknown as { imported: Map<number, unknown> }).imported.has(e0)).toBe(false);
      expect(row0.config).toBeTruthy(); // the public half and its configuration stay in the history
      expect((await models(k1)).inner!.status).toBe(200);

      // The published history only grows, and each list extends the previous chain.
      const doc = (await (await get("/api/v1/ohttp/key-list")).json()) as KeyListDocument;
      expect(doc.data.keys.map((k) => [k.epoch, k.status, k.private_key_destroyed])).toEqual([[e0, "expired", true], [e0 + 1, "current", false], [e0 + 2, "upcoming", false]]);
      const history = await keys.history();
      const chain = keyLog(history);
      expect(chain.entries.map((e) => e.entry_hash)).toEqual(doc.data.keys.map((k) => k.entry_hash));
      expect(keyLog(history.slice(0, 2)).head).toBe(doc.data.keys[1].entry_hash); // the earlier head is an entry of the later chain
      expect(logExtends(doc0.data.log.head, doc)).toBe(true);
      expect(logExtends(doc1.data.log.head, doc)).toBe(true);
      expect(logExtends("ab".repeat(32), doc)).toBe(false); // a head the list does not continue: something was replaced or removed
      // A client that pinned the earlier configuration finds it in the later list, as an expired key.
      expect(doc.data.keys[0].config).toBe(Buffer.from(serializeKeyConfigList([k0]).subarray(2)).toString("base64url"));
    } finally {
      await h.close();
    }
  });

  test("a revoked key stops opening requests at once and the next key is served", async () => {
    const h = await startRouter({ env: { ...OHTTP_ENV, OHTTP_KEY_EPOCH_SECONDS: "3600" }, providers: PROVIDERS });
    try {
      const keys = h.ctx.ohttp!;
      const k0 = await servedKey(h);
      const models = (cfg: KeyConfig) => toGateway(h, cfg, { method: "GET", path: "/api/v1/models" });
      expect((await models(k0)).inner!.status).toBe(200);
      expect(await keys.revokeEpoch(keys.epochAt())).toBe(1);
      expect((await models(k0)).res.status).toBe(422);
      const k1 = await servedKey(h);
      expect(k1.keyId).toBe(keyIdOfEpoch(keys.epochAt() + 1));
      expect((await models(k1)).inner!.status).toBe(200);
      const doc = (await (await h.request("/api/v1/ohttp/key-list")).json()) as KeyListDocument;
      expect(doc.data.keys[0]).toMatchObject({ status: "revoked", private_key_destroyed: true });
    } finally {
      await h.close();
    }
  });

  test("key identifiers are the epoch modulo 256", () => {
    expect(keyIdOfEpoch(0)).toBe(0);
    expect(keyIdOfEpoch(255)).toBe(255);
    expect(keyIdOfEpoch(256)).toBe(0);
    expect(keyIdOfEpoch(20_000)).toBe(20_000 % 256);
  });
});

// ---- the gateway protocol -----------------------------------------------------------------------------------------

describe("gateway protocol", () => {
  let h: Harness;
  let cfg: KeyConfig;
  beforeAll(async () => {
    h = await startRouter({ env: { ...OHTTP_ENV, OHTTP_DIRECT_RPM: "1000", OHTTP_MAX_REQUEST_BYTES: "4096" }, providers: PROVIDERS });
    cfg = await servedKey(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const post = (body: BodyInit | null, headers: Record<string, string> = { "content-type": MEDIA_REQ }) => h.request("/api/v1/ohttp/gateway", { method: "POST", headers, body: body as never });

  test("errors before unwrapping are plain HTTP errors: media type, size, garbage, unknown key, wrong ciphersuite", async () => {
    expect((await post("x", { "content-type": "application/json" })).status).toBe(415);
    expect((await post("x", {})).status).toBe(415);
    expect((await post(new Uint8Array(4097))).status).toBe(413);
    const junk = await post(new Uint8Array(20));
    expect(junk.status).toBe(400);
    const good = (await sealRequest(cfg, encodeRequest({ method: "GET", path: "/api/v1/models" }), SEAL_MAX)).encapsulated;
    const unknown = Buffer.from(good);
    unknown[0] = (cfg.keyId + 100) % 256;
    const r422 = await post(unknown);
    expect(r422.status).toBe(422);
    expect(r422.headers.get("content-type")).toBe("application/problem+json");
    expect(await r422.json()).toEqual({ type: "https://iana.org/assignments/http-problem-types#ohttp-key", title: "key identifier unknown" });
    const suite = Buffer.from(good);
    suite[4] = 2; // KDF HKDF-SHA384: not offered
    expect((await post(suite)).status).toBe(422);
    const flipped = Buffer.from(good);
    flipped[flipped.length - 1] ^= 1; // a key id we hold, but the request does not decrypt
    const bad = await post(flipped);
    expect(bad.status).toBe(422);
    expect((await bad.json()).title).toMatch(/could not be decrypted/);
    for (const r of [r422, bad]) expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("the well-known location serves the same key configuration and gateway (RFC 9540)", async () => {
    const wk = await h.request("/.well-known/ohttp-gateway");
    expect(wk.headers.get("content-type")).toBe(MEDIA_KEYS);
    const sent = await sealRequest(cfg, encodeRequest({ method: "GET", path: "/api/v1/models" }), SEAL_MAX);
    const res = await h.request("/.well-known/ohttp-gateway", { method: "POST", headers: { "content-type": MEDIA_REQ }, body: sent.encapsulated as never });
    expect(res.status).toBe(200);
    expect(decodeResponse(await sent.openResponse(new Uint8Array(await res.arrayBuffer()))).status).toBe(200);
  });

  test("a wrong relay credential is refused; no credential means the request is treated as direct", async () => {
    const enc = async () => (await sealRequest(cfg, encodeRequest({ method: "GET", path: "/api/v1/models" }), SEAL_MAX)).encapsulated;
    for (const auth of ["Bearer alpha-1:wrong-secret", "Bearer nobody:x", "Bearer alpha-1", "Basic YTpi", `Bearer alpha-1:${SECRET_SELF}`]) {
      const r = await post((await enc()) as never, { "content-type": MEDIA_REQ, authorization: auth });
      expect(r.status).toBe(401);
      expect((await r.json()).error.type).toBe("relay_auth_invalid");
    }
    const ok = await post((await enc()) as never, { "content-type": MEDIA_REQ, authorization: `Bearer alpha-1:${SECRET_ALPHA}` });
    expect(ok.status).toBe(200);
    expect((await post((await enc()) as never)).status).toBe(200);
  });

  test("only an allow-list of the router's own routes is reachable, and only as listed", async () => {
    const cases: [string, string, number][] = [
      ["GET", "/api/v1/models", 200],
      ["GET", "/api/v1/blind/keys", 200],
      ["POST", "/api/v1/models", 404], // wrong method
      ["GET", "/api/v1/keys", 404],
      ["POST", "/api/v1/keys", 404],
      ["GET", "/api/v1/ohttp/keys", 404], // the gateway does not call itself
      ["POST", "/api/v1/ohttp/gateway", 404],
      ["POST", "/trpc/anything", 404],
      ["GET", "/api/v1/chat/completions", 404],
      ["GET", "/api/v1/models/../keys", 404],
      ["GET", "/api/v1/chat/completions/../../keys", 404],
      ["GET", "/api/v1/models%2f..%2fkeys", 404],
      ["GET", "//example.org/api/v1/models", 400],
      ["GET", "/api/v1\\models", 400],
    ];
    for (const [method, path, status] of cases) {
      const { inner, res } = await toGateway(h, cfg, { method, path });
      expect(res.status).toBe(200); // errors after unwrapping are encapsulated
      expect([method, path, inner!.status]).toEqual([method, path, status]);
    }
    const denied = await toGateway(h, cfg, { method: "GET", path: "/api/v1/keys" });
    expect(innerJson(denied.inner!).error.type).toBe("route_not_allowed");
    // A path that normalises onto an allowed route is dispatched as the normalised path.
    expect((await toGateway(h, cfg, { method: "GET", path: "/x/../api/v1/models" })).inner!.status).toBe(200);
  });

  test("a malformed binary HTTP request is answered inside the encapsulation, and Expect: 100-continue is refused", async () => {
    const sent = await sealRequest(cfg, new Uint8Array([0x00, 0x03, 0x47, 0x45]), SEAL_MAX);
    const res = await post(sent.encapsulated as never);
    expect(res.status).toBe(200);
    const inner = decodeResponse(await sent.openResponse(new Uint8Array(await res.arrayBuffer())));
    expect(inner.status).toBe(400);
    expect(innerJson(inner).error.message).toMatch(/Invalid binary HTTP request/);
    const expectCont = await toGateway(h, cfg, { method: "POST", path: "/api/v1/embeddings", headers: [["expect", "100-continue"]], body: "{}" });
    expect(expectCont.inner!.status).toBe(400);
    expect(innerJson(expectCont.inner!).error.message).toMatch(/100-continue/);
  });

  test("a replayed encapsulated request is answered with an encapsulated 409, not run twice", async () => {
    const bhttp = encodeRequest({ method: "GET", path: "/api/v1/models" });
    const sent = await sealRequest(cfg, bhttp, SEAL_MAX);
    const first = await post(sent.encapsulated as never);
    expect(decodeResponse(await sent.openResponse(new Uint8Array(await first.arrayBuffer()))).status).toBe(200);
    const again = await post(sent.encapsulated as never);
    expect(again.status).toBe(200);
    const inner = decodeResponse(await sent.openResponse(new Uint8Array(await again.arrayBuffer())));
    expect(inner.status).toBe(409);
    expect(innerJson(inner).error.type).toBe("replayed_request");
  });

  test("responses are padded to a multiple of OHTTP_PAD_BYTES, so their size says little about their content", async () => {
    for (const path of ["/api/v1/blind/keys", "/api/v1/models", "/api/v1/keys"]) {
      const { raw } = await toGateway(h, cfg, { method: "GET", path });
      const len = raw.byteLength - 16 - 16; // response nonce and AEAD tag
      expect(len % 256).toBe(0);
    }
  });

  test("the gateway drops what a client sends beyond a short allow-list of headers, and records nothing about it", async () => {
    const before = (await h.ctx.db.select().from(apps)).length;
    const { inner } = await toGateway(h, cfg, {
      method: "GET",
      path: "/api/v1/models",
      headers: [["user-agent", "client-ua-mark"], ["cookie", "sid=client-cookie-mark"], ["x-forwarded-for", "203.0.113.5"], ["http-referer", "https://client.example/app"], ["x-title", "client-title-mark"], ["traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"]],
    });
    expect(inner!.status).toBe(200);
    expect((await h.ctx.db.select().from(apps)).length).toBe(before); // http-referer and x-title did not reach the app-attribution code
  });

  test("only the gateway can mark a request as coming from it: the mark is bound to the request object, not to anything a client sends", () => {
    const spoof = { "x-anyroute-relay": "alpha-1", "x-anyroute-ohttp": "1", "x-relay": "alpha-1", "x-forwarded-for": "10.0.0.1", authorization: `Bearer alpha-1:${SECRET_ALPHA}` };
    const req = new Request("https://router.test/api/v1/chat/completions", { method: "POST", headers: spoof, body: "{}" });
    expect(gatewayOrigin(req)).toBeUndefined();
    markFromGateway(req, { relay: null });
    expect(gatewayOrigin(req)).toEqual({ relay: null });
    expect(gatewayOrigin(req.clone())).toBeUndefined(); // a copy is a different request
    expect(gatewayOrigin(new Request(req))).toBeUndefined();
  });

  test("rate limits: relays are limited by identity, everyone else by address, with a Retry-After", async () => {
    // A relay name of its own keeps the counters apart from every other test, even when a shared Redis backs the limiter.
    const uniq = `rl${Math.random().toString(36).slice(2, 10)}`;
    const relays = JSON.stringify([{ operator: "Limit Relay Co", url: "https://relay.limit.example/relay", key_id: uniq, secret_sha256: sha(SECRET_ALPHA) }]);
    const limited = await startRouter({ env: { ...OHTTP_ENV, RELAY_OPERATORS: relays, OHTTP_DIRECT_RPM: "2", OHTTP_RELAY_RPM: "3", TRUST_PROXY: "true" }, providers: PROVIDERS });
    try {
      const c = await servedKey(limited);
      const enc = async () => (await sealRequest(c, encodeRequest({ method: "GET", path: "/api/v1/models" }), SEAL_MAX)).encapsulated as never;
      const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      const direct = async () => limited.request("/api/v1/ohttp/gateway", { method: "POST", headers: { "content-type": MEDIA_REQ, "x-forwarded-for": ip }, body: await enc() });
      expect((await direct()).status).toBe(200);
      expect((await direct()).status).toBe(200);
      const over = await direct();
      expect(over.status).toBe(429);
      expect(over.headers.get("retry-after")).toBeTruthy();
      // A relay is counted apart, whatever its address: three requests, then the fourth is limited.
      const viaRelay = async (ipOfRelay: string) => limited.request("/api/v1/ohttp/gateway", { method: "POST", headers: { "content-type": MEDIA_REQ, authorization: `Bearer ${uniq}:${SECRET_ALPHA}`, "x-forwarded-for": ipOfRelay }, body: await enc() });
      for (const n of [1, 2, 3]) expect((await viaRelay(`10.9.9.${n}`)).status).toBe(200);
      expect((await viaRelay("10.9.9.9")).status).toBe(429);
    } finally {
      await limited.close();
    }
  });

  test("a response larger than OHTTP_MAX_RESPONSE_BYTES is not carried", async () => {
    const small = await startRouter({ env: { ...OHTTP_ENV, OHTTP_MAX_RESPONSE_BYTES: "1024" }, providers: PROVIDERS });
    try {
      const { inner } = await toGateway(small, await servedKey(small), { method: "GET", path: "/api/v1/models" });
      expect(inner!.status).toBe(502);
      expect(innerJson(inner!).error.type).toBe("response_too_large");
    } finally {
      await small.close();
    }
  });

  test("the replay guard forgets after its lifetime and never grows past its capacity", () => {
    let now = 1000;
    const g = new ReplayGuard(3, () => now);
    expect(g.seen("a", 100)).toBe(false);
    expect(g.seen("a", 100)).toBe(true);
    now += 101;
    expect(g.seen("a", 100)).toBe(false); // expired, recorded again
    g.seen("b", 1000);
    g.seen("c", 1000);
    g.seen("d", 1000); // over capacity: the oldest ("a") goes
    expect(g.size).toBe(3);
    expect(g.seen("a", 1000)).toBe(false);
    expect(g.size).toBe(3);
  });
});

// ---- the unlinkable lane ------------------------------------------------------------------------------------------

describe("the unlinkable lane", () => {
  let h: Harness;
  let cfg: KeyConfig;
  let alpha: ReturnType<typeof relayFor>;
  let self: ReturnType<typeof relayFor>;
  let tokens: string[] = [];
  let api: { secret: string; auth: Record<string, string> };
  const spent = async () => (await h.ctx.db.select().from(blindNullifiers)).length;
  const gens = async () => (await h.ctx.db.select().from(generations)).length;
  const use = (i: number, extra: Record<string, unknown> = {}) => ({ ...chat, provider: { lane: "unlinkable" }, ...extra, _token: tokens[i] });

  /** One request through a relay with a token; returns the decoded inner response. */
  async function viaRelay(r: ReturnType<typeof relayFor>, token: string | null, body: unknown, path = "/api/v1/chat/completions", headers: HeaderList = []) {
    const { _token, ...json } = body as Record<string, unknown>;
    void _token;
    return sendViaRelay({
      relayUrl: r.url,
      keyConfig: cfg,
      method: "POST",
      path,
      headers: [["content-type", "application/json"], ...(token ? ([["authorization", authorizationHeader(decodeBase64(token)!)]] as HeaderList) : []), ...headers],
      body: JSON.stringify(json),
      fetch: r.fetch,
    });
  }

  beforeAll(async () => {
    h = await startRouter({ env: { ...OHTTP_ENV, ANYROUTE_FEATURE_COUNCIL: "true" }, providers: PROVIDERS });
    cfg = await servedKey(h);
    alpha = relayFor(h, "alpha-1", SECRET_ALPHA);
    self = relayFor(h, "self-1", SECRET_SELF);
    api = await h.fundedKey(10n);
    // Buying tokens goes through the relay too: the directory, then the purchase, all inside the encapsulation.
    const bought = await buyTokens({ baseUrl: "https://router.test", apiKey: api.secret, denomination: 10_000, count: 14, fetch: throughRelay(alpha, cfg) });
    tokens = bought.tokens;
    expect(tokens).toHaveLength(14);
  });
  afterAll(async () => {
    await h.close();
  });

  test("a direct request for the lane is refused with an explanation, and the token is not spent", async () => {
    const before = { spent: await spent(), gens: await gens() };
    const providerCalls = h.mocks.enclave.stats.requests + h.mocks.vendor.stats.requests;
    const token = tokens[0];
    const direct = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: authorizationHeader(decodeBase64(token)!), ...headers }, json: body });
    // Headers that a client might hope make the router think a relay sent it change nothing.
    const spoof = { "x-anyroute-relay": "alpha-1", "x-anyroute-ohttp": "1", "x-forwarded-for": "10.0.0.1", "x-relay-key-id": "alpha-1", "x-relay-secret": SECRET_ALPHA };
    for (const r of [await direct({ ...chat, provider: { lane: "unlinkable" } }), await direct(chat, { "x-anyroute-lane": "unlinkable" }), await direct({ ...chat, stream: true, provider: { lane: "unlinkable" } }), await direct({ ...chat, provider: { lane: "unlinkable" } }, spoof)]) {
      expect(r.status).toBe(403);
      const e = (await r.json()).error;
      expect(e.type).toBe("unlinkable_requires_relay");
      expect(e.message).toMatch(/Oblivious HTTP relay/);
      expect(e.message).toMatch(/blind token/);
      expect(e.metadata).toMatchObject({ relays_url: "/api/v1/relays" });
    }
    const emb = await h.request("/api/v1/embeddings", { method: "POST", headers: { authorization: authorizationHeader(decodeBase64(token)!) }, json: { model: EMBED, input: "hi", provider: { lane: "unlinkable" } } });
    expect(emb.status).toBe(403);
    expect((await emb.json()).error.type).toBe("unlinkable_requires_relay");
    // A key holder asking directly gets the same answer, and is told nothing about tokens it did not present.
    const keyed = await h.request("/api/v1/chat/completions", { method: "POST", headers: api.auth, json: { ...chat, provider: { lane: "unlinkable" } } });
    expect(keyed.status).toBe(403);
    expect((await keyed.json()).error.type).toBe("unlinkable_requires_relay");
    expect(await spent()).toBe(before.spent);
    expect(await gens()).toBe(before.gens);
    expect(h.mocks.enclave.stats.requests + h.mocks.vendor.stats.requests).toBe(providerCalls); // nothing reached a provider
    // The plain lanes are unaffected by any of this.
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: api.auth, json: { ...chat, provider: { only: ["vendor"] } } })).status).toBe(200);
  });

  test("through the gateway but not through a relay, the lane is refused as well", async () => {
    const before = await spent();
    const { inner } = await toGateway(h, cfg, { path: "/api/v1/chat/completions", headers: [["content-type", "application/json"], ["authorization", authorizationHeader(decodeBase64(tokens[0])!)]], body: JSON.stringify({ ...chat, provider: { lane: "unlinkable" } }) });
    expect(inner!.status).toBe(403);
    expect(innerJson(inner!).error.type).toBe("unlinkable_requires_relay");
    expect(await spent()).toBe(before);
  });

  test("through a relay run by the gateway's own operator, the lane is refused: it would hide nothing", async () => {
    const before = await spent();
    const r = await viaRelay(self, tokens[0], use(0));
    expect(r.status).toBe(403);
    expect(r.json<{ error: { type: string; message: string } }>().error.type).toBe("unlinkable_requires_independent_relay");
    expect(r.json<{ error: { message: string } }>().error.message).toMatch(/AnyRoute/);
    expect(await spent()).toBe(before);
  });

  test("through a relay without a blind token: an API key is refused, and no credential gets the token challenge", async () => {
    const providerCalls = h.mocks.enclave.stats.requests + h.mocks.vendor.stats.requests;
    const withKey = await viaRelay(alpha, null, use(0), "/api/v1/chat/completions", [["authorization", `Bearer ${api.secret}`]]);
    expect(withKey.status).toBe(403);
    expect(withKey.json<{ error: { type: string } }>().error.type).toBe("unlinkable_requires_token");
    const nothing = await viaRelay(alpha, null, use(0));
    expect(nothing.status).toBe(401);
    expect(nothing.json<{ error: { type: string } }>().error.type).toBe("unlinkable_requires_token");
    expect(nothing.headers.get("www-authenticate")).toMatch(/^PrivateToken challenge="/);
    expect(h.mocks.enclave.stats.requests + h.mocks.vendor.stats.requests).toBe(providerCalls);
  });

  test("with no attested provider the lane is refused (409) and the token is kept", async () => {
    const before = { spent: await spent(), gens: await gens() };
    const providerCalls = h.mocks.vendor.stats.requests + h.mocks.enclave.stats.requests;
    const r = await viaRelay(alpha, tokens[0], use(0));
    expect(r.status).toBe(409);
    const e = r.json<{ error: { type: string; message: string } }>().error;
    expect(e.type).toBe("lane_unavailable");
    expect(e.message).toMatch(/lane "unlinkable"/);
    expect(e.message).toMatch(/Nothing was sent to any provider and nothing was charged/);
    expect(await spent()).toBe(before.spent);
    expect(await gens()).toBe(before.gens);
    expect(h.mocks.vendor.stats.requests + h.mocks.enclave.stats.requests).toBe(providerCalls);
  });

  test("once a provider is attested: the whole flow through a relay serves the request from it alone, and the receipt says unlinkable", async () => {
    await attestEnclave(h);
    const before = { spent: await spent(), vendor: h.mocks.vendor.stats.requests, enclave: h.mocks.enclave.stats.requests };
    const r = await viaRelay(alpha, tokens[0], use(0));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-lane")).toBe("unlinkable");
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    const j = r.json<any>();
    expect(j.provider).toBe("Enclave");
    // The receipt headers travel inside the encapsulated response like the rest.
    expect(r.headers.get("x-receipt-id")).toBe(j.receipt.id);
    expect(r.headers.get("inference-id")).toBe(j.receipt.id);
    expect(j.receipt.payload).toMatchObject({ lane: "unlinkable", disclosure: "attested", payer: null, provider: "enclave", attestation_simulated: true });
    expect(j.receipt.payload.nullifier).toMatch(/^[0-9a-f]{64}$/);
    expect(j.receipt.payload.token_key_id).toMatch(/^[0-9a-f]{64}$/);
    expect(h.mocks.enclave.stats.requests).toBe(before.enclave + 1);
    expect(h.mocks.vendor.stats.requests).toBe(before.vendor); // the vendor-forwarded provider was never used
    expect(await spent()).toBe(before.spent + 1);
    // The receipt verifies like any other.
    const ver = await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: j.receipt.payload, sig: j.receipt.sig, key_id: j.receipt.key_id } });
    expect(ver.status).toBe(200);
    expect((await ver.json()).data.signature_valid).toBe(true);
    // The same token cannot be used again.
    const again = await viaRelay(alpha, tokens[0], use(0));
    expect(again.status).toBe(401);
    expect(again.json<{ error: { type: string } }>().error.type).toBe("token_spent");
  });

  test("lane through the header, and embeddings, work the same way", async () => {
    const viaHeader = await viaRelay(alpha, tokens[1], chat, "/api/v1/chat/completions", [["x-anyroute-lane", "unlinkable"]]);
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.json<any>().receipt.payload).toMatchObject({ lane: "unlinkable", provider: "enclave" });
    const emb = await viaRelay(alpha, tokens[2], { model: EMBED, input: "hello", provider: { lane: "unlinkable" } }, "/api/v1/embeddings");
    expect(emb.status).toBe(200);
    expect(emb.json<any>().receipt.payload).toMatchObject({ lane: "unlinkable", disclosure: "attested", payer: null });
    expect(emb.headers.get("x-anyroute-lane")).toBe("unlinkable");
    // The other independent relay carries it just as well.
    const beta = relayFor(h, "beta-1", SECRET_BETA);
    const viaBeta = await viaRelay(beta, tokens[3], use(3));
    expect(viaBeta.status).toBe(200);
  });

  test("a token request through a relay that does not ask for the lane is an ordinary blind request", async () => {
    const r = await viaRelay(alpha, tokens[4], { ...chat });
    expect(r.status).toBe(200);
    expect(r.json<any>().receipt.payload.lane).toBe("public");
  });

  test("streaming, council and dual verification are refused without spending the token", async () => {
    const before = await spent();
    const streamed = await viaRelay(alpha, tokens[5], use(5, { stream: true }));
    expect(streamed.status).toBe(400);
    expect(streamed.json<{ error: { type: string } }>().error.type).toBe("stream_unsupported");
    for (const extra of [{ model: "anyroute/council" }, { verify: "dual" }]) {
      const r = await viaRelay(alpha, tokens[5], use(5, extra));
      expect(r.status).toBe(400);
      expect(r.json<{ error: { type: string } }>().error.type).toBe("blind_unsupported");
    }
    expect(await spent()).toBe(before);
    expect((await viaRelay(alpha, tokens[5], use(5))).status).toBe(200); // and the token still pays
  });

  test("a relay is told nothing but the ciphertext; the gateway is given nothing that names the client", async () => {
    const marks = { ua: "client-ua-mark-51", cookie: "sid=client-cookie-mark-51", ip: "203.0.113.51", ref: "https://client.example/app-51", title: "client-title-mark-51" };
    const before = (await h.ctx.db.select().from(apps)).length;
    const r = await viaRelay(alpha, tokens[6], use(6), "/api/v1/chat/completions", [["user-agent", marks.ua], ["cookie", marks.cookie], ["x-forwarded-for", marks.ip], ["http-referer", marks.ref], ["x-title", marks.title]]);
    expect(r.status).toBe(200);
    // What the relay sent on to the gateway: its own four headers, and the ciphertext.
    const last = alpha.seenByGateway[alpha.seenByGateway.length - 1];
    expect(Object.keys(last.headers).sort()).toEqual(["accept", "authorization", "content-type", "user-agent"]);
    expect(JSON.stringify(last)).not.toMatch(new RegExp(Object.values(marks).map((m) => m.replace(/[.]/g, "\\.")).join("|")));
    // Nothing the router stored carries any of it.
    expect((await h.ctx.db.select().from(apps)).length).toBe(before);
    const dump = JSON.stringify(await h.ctx.db.select().from(generations), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const m of Object.values(marks)) expect(dump).not.toContain(m);
    for (const s of [SECRET_ALPHA, "alpha-1"]) expect(dump).not.toContain(s); // the receipt does not say which relay carried it
    // The prompt and the answer are inside the encapsulation: the relay saw neither.
    expect(JSON.stringify(last)).not.toContain("hello");
  });

  test("a blind purchase through a relay is the same purchase, and replaying its ciphertext does not charge twice", async () => {
    const key = await h.fundedKey(2n);
    const dir = await fetchDirectory("https://router.test", throughRelay(alpha, cfg));
    const k = issuingKey(dir, 1_000);
    const pending = await blindTokens(k, dir.challenge_digest, 1);
    const body = JSON.stringify({ token_key_id: k.token_key_id, blinded_msgs: [Buffer.from(pending[0].blindedMsg).toString("base64url")] });
    const send = () => sendViaRelay({ relayUrl: alpha.url, keyConfig: cfg, method: "POST", path: "/api/v1/blind/purchase", headers: [["content-type", "application/json"], ["authorization", `Bearer ${key.secret}`]], body, fetch: alpha.fetch });
    const first = await send();
    expect(first.status).toBe(200);
    const second = await send(); // a fresh encapsulation of the same purchase: idempotent, not charged again
    expect(second.status).toBe(200);
    expect(second.json<any>().data.replayed).toBe(true);
    expect(second.json<any>().data.signatures).toEqual(first.json<any>().data.signatures);
    const [token] = await finalizeTokens(k, pending, first.json<any>().data.signatures);
    expect(token).toBeTruthy();
  });

  test("the model list can be filtered to the lane", async () => {
    const res = await h.request(`/api/v1/models?lane=unlinkable`);
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.map((m: { id: string }) => m.id);
    expect(ids).toContain(LLAMA);
    expect((await h.request("/api/v1/models?lane=bogus")).status).toBe(400);
  });

  test("over real sockets: client, relay, router", async () => {
    const routerServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, server) => h.app.fetch(req, server as never) });
    const relayCfg = loadRelayConfig({ RELAY_GATEWAYS: JSON.stringify([{ name: "router", url: `http://127.0.0.1:${routerServer.port}/api/v1/ohttp/gateway`, credential: `beta-1:${SECRET_BETA}` }]) });
    const relay = createRelay(relayCfg);
    const relayServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: relay.handle });
    try {
      const relayUrl = `http://127.0.0.1:${relayServer.port}/relay`;
      const keys = await fetchKeyConfig(`http://127.0.0.1:${routerServer.port}`);
      const res = await sendViaRelay({
        relayUrl,
        keyConfig: keys.config,
        method: "POST",
        path: "/api/v1/chat/completions",
        headers: [["content-type", "application/json"], ["authorization", authorizationHeader(decodeBase64(tokens[7])!)]],
        body: JSON.stringify({ ...chat, provider: { lane: "unlinkable" } }),
      });
      expect(res.status).toBe(200);
      expect(res.json<any>().receipt.payload).toMatchObject({ lane: "unlinkable", disclosure: "attested" });
      expect(relay.counters).toMatchObject({ requests: 1, forwarded: 1, gateway: { ok: 1 } });
      // A relay that is not in the router's list is refused by the gateway: the relay reports it, and the client sees a 502.
      const unknown = createRelay(loadRelayConfig({ RELAY_GATEWAYS: JSON.stringify([{ name: "router", url: `http://127.0.0.1:${routerServer.port}/api/v1/ohttp/gateway`, credential: "ghost-1:whatever" }]) }));
      const ghost = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: unknown.handle });
      try {
        await expect(sendViaRelay({ relayUrl: `http://127.0.0.1:${ghost.port}/relay`, keyConfig: keys.config, method: "GET", path: "/api/v1/models" })).rejects.toMatchObject({ status: 502, unencapsulated: true });
        expect(unknown.counters.credentialRejected).toBe(1);
      } finally {
        ghost.stop(true);
      }
    } finally {
      relayServer.stop(true);
      routerServer.stop(true);
    }
  });
});

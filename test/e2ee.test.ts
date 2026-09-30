import { afterAll, beforeAll, beforeEach, expect, test, setDefaultTimeout } from "bun:test";
import { eq } from "drizzle-orm";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { providers, generations, holds } from "../src/db/schema.ts";
import { encrypt, sha256 } from "../src/lib/util.ts";
import { runRegistry } from "../src/services/registry.ts";
import { saveAciGateway, keysetDigest } from "../src/providers/aci.ts";
import { priceUsage } from "../src/router/pricing.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { privacyLabel } from "../src/privacy/label.ts";
import { privacyLabel as clientLabel } from "../packages/client/src/privacy.ts";
import { e2eeChat, e2eeKeyPair, e2eePublicKey, sealE2eeField, openE2eeField, e2eeAad, verifyE2eeReport } from "../packages/client/src/e2ee.ts";
import { validateEnvelope, inputBound } from "../src/e2ee/protocol.ts";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";
import { standInGateway } from "./e2ee-gateway.ts";
import { gatewayReport } from "./aci-fixtures.ts";
import { buyTokens } from "../src/blind/client.ts";
import { authorizationHeader, decodeBase64 } from "../src/blind/privacy-token.ts";
import { ONION_HEADER } from "../src/lib/onion.ts";

setDefaultTimeout(60_000);
const MODEL = "acme/e2ee-chat";
const PROVIDER = "phala-confidential-ai";
const onion = "a2w2k7bgvjopikpj6lakthr6jjbnv3gul7cmsvoxye4zvnbcplunvlyd.onion";
const proxySecret = "e2ee-proxy-fixture-secret-0123456789abcdef";
let h: Harness; let gw: ReturnType<typeof standInGateway>; let auth: Record<string, string>;
const body = (stream = false) => ({ model: MODEL, messages: [{ role: "user" as const, content: "confidential question" }, { role: "system" as const, content: "answer briefly" }], max_tokens: 16, stream });
let seenResponse: Response | undefined;
const shim: typeof fetch = (async (input: any, init?: RequestInit) => {
  const u = new URL(String(input)); const r = await h.app.request(u.pathname + u.search, init);
  if (u.pathname.endsWith("/chat/completions")) { seenResponse = r; if (!r.ok) throw new Error(`Router ${r.status}: ${await r.clone().text()}`); }
  return r;
}) as typeof fetch;
const options = () => ({ baseUrl: "http://router.example", headers: auth, fetch: shim, verifyAttestation: async () => true }); // synthetic quote accepted only by this isolated caller
const collect = async (result: any) => { const events = []; for await (const event of result) events.push(event); return events; };
const lastGeneration = async () => { const id = seenResponse!.headers.get("x-receipt-id")!; return (await h.ctx.db.select().from(generations).where(eq(generations.id, id)))[0]; };

beforeAll(async () => {
  gw = standInGateway();
  h = await startRouter({ env: { E2EE_PASSTHROUGH_ENABLED: "true", ANYROUTE_FEATURE_BLIND: "true", UNLINKABLE_VIA_ONION: "true", ONION_ADDRESS: onion, ONION_PROXY_SECRET: proxySecret } });
  await h.ctx.db.insert(providers).values({ id: PROVIDER, name: "Phala", baseUrl: gw.url, status: "live", teeKind: "tdx", attestationUrl: gw.url + "/aci/attestation", apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "fixture-provider-credential"), attested: true, attestedAt: new Date(), attestationHash: "ab".repeat(32), staticModels: [{ id: MODEL, context_length: 32768, max_output_length: 1024, pricing: { prompt: "0.000001", completion: "0.000002" } }] });
  await runRegistry(h.ctx);
  const claim = { source: "https://gateway.example/retention", as_of: "2026-09-01" };
  const disclosure = await h.request(`/api/v1/disclosure/${PROVIDER}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
  expect(disclosure.status).toBe(200);
  await saveAciGateway(h.ctx.db, PROVIDER, { v: 1, keysetDigest: keysetDigest(gw.ks), workloadId: null, receiptKeys: gw.ks.receipt_signing_keys as any, tlsSpki: [], notAfter: gw.ks.not_after, staleAfter: null, serving: "aggregator", sourceProvenance: null, composeHash: null, osImageHash: null, appId: null, keysetEndorsement: "absent", attestedAt: new Date().toISOString() });
  await h.ctx.catalog.refresh();
  auth = (await h.fundedKey()).auth;
});
beforeEach(() => { gw.state.attack = ""; seenResponse = undefined; });
afterAll(async () => { await h?.close(); gw?.server.stop(true); });

test("independent Node gateway decrypts every field, buffered client opens reply and records exact ciphertext hashes", async () => {
  const result = await e2eeChat(body(), options());
  expect(result.choices[0].message.content).toBe("Encrypted reply");
  expect(gw.state.lastPlaintext).toContain("confidential question");
  expect(gw.state.lastBytes.toString()).not.toContain("confidential question");
  expect(gw.state.lastHeaders.get("authorization")).toBe("Bearer fixture-provider-credential");
  for (const name of ["x-client-pub-key", "x-model-pub-key", "x-e2ee-nonce", "x-e2ee-timestamp", "x-e2ee-version"]) expect(gw.state.lastHeaders.has(name)).toBe(true);
  const row = await lastGeneration(); const receipt = row.receipt as any;
  expect(row.requestSha256).toBe(sha256(gw.state.lastBytes));
  expect(row.responseSha256).toBe(sha256(gw.state.lastResponse));
  expect(receipt).toMatchObject({ end_to_end_encrypted: true, lane: "attested", e2ee: { complete: true, billing_basis: "gateway_reported_usage", gateway_receipt: { request_hash_verified: false, response_hash_verified: true } } });
  expect(JSON.stringify(row, (_k, v) => typeof v === "bigint" ? v.toString() : v)).not.toContain("confidential question");
  const label = privacyLabel(receipt);
  expect(label).toEqual(clientLabel(receipt));
  expect(label.label.prompt_readers.router).toBe(false);
  expect(label.summary[0]).toBe("Read by: the provider's attested gateway enclave only — AnyRoute's router forwarded ciphertext and could not read it");
  const [hold] = await h.ctx.db.select().from(holds).where(eq(holds.id, row.id));
  expect(hold.status).toBe("settled"); expect(row.cost < hold.amount).toBe(true);
  const account = await balanceOf(h.ctx.db, row.accountId!); expect(account.held).toBe(0n);
  const cand = h.ctx.catalog.offers(MODEL).find(c => c.providerId === PROVIDER)!;
  const cost = priceUsage(cand, h.ctx.catalog.models.get(MODEL)!, { prompt: 12, completion: 5, reasoning: 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: false }, "prepaid", { ...h.ctx.cfg.fees, royaltyBps: 0 }, false);
  expect(row.cost).toBe(cost.total);
});
test("stream opens deltas and reasoning while full iteration verifies complete wire receipt", async () => {
  const events = await collect(await e2eeChat(body(true), options()));
  expect(events[0].choices[0].delta.content).toBe("Encrypted reply");
  expect(events[0].choices[0].delta.reasoning).toBe("Reasoned privately");
  expect(events[0].choices[0].delta.reasoning_content).toBe("Reasoning content");
  expect((await lastGeneration()).streamed).toBe(true);
  expect(seenResponse!.headers.get("x-anyroute-lane")).toBe("attested");
});
for (const attack of ["wrong-response-key", "tampered-field", "truncate", "duplicate-chunk", "receipt-tamper"]) test(`client fails closed for ${attack}`, async () => {
  gw.state.attack = attack;
  await expect((async () => { await collect(await e2eeChat(body(true), options())); })()).rejects.toThrow();
});
test("truncation settles reported usage, releases remainder and records incomplete evidence", async () => {
  gw.state.attack = "truncate";
  await expect(collect(await e2eeChat(body(true), options()))).rejects.toThrow();
  const row = await lastGeneration(); const [hold] = await h.ctx.db.select().from(holds).where(eq(holds.id, row.id));
  expect(row.cancelled).toBe(true); expect(row.cost < hold.amount).toBe(true);
  expect(row.receipt).toMatchObject({ e2ee: { complete: false, billing_basis: "gateway_reported_usage" } });
  expect((await balanceOf(h.ctx.db, row.accountId!)).held).toBe(0n);
});
test("missing usage on a truncated stream settles the reservation bound", async () => {
  gw.state.attack = "truncate-no-usage";
  await expect(collect(await e2eeChat(body(true), options()))).rejects.toThrow();
  const row = await lastGeneration(); const [hold] = await h.ctx.db.select().from(holds).where(eq(holds.id, row.id));
  expect(row.cost).toBe(hold.amount); expect(row.receipt).toMatchObject({ e2ee: { billing_basis: "reservation_bound", complete: false } });
});
test("no usage on complete JSON also uses the explicit bound", async () => {
  gw.state.attack = "no-usage"; await e2eeChat(body(), options());
  const row = await lastGeneration(); const [hold] = await h.ctx.db.select().from(holds).where(eq(holds.id, row.id)); expect(row.cost).toBe(hold.amount);
});
test("replayed attestation challenge is rejected before inference", async () => {
  const posts = gw.state.posts; gw.state.attack = "attestation-replay";
  await expect(e2eeChat(body(), options())).rejects.toThrow("mismatch"); expect(gw.state.posts).toBe(posts);
});
test("caller quote appraisal is mandatory and refusal precedes inference", async () => {
  const posts = gw.state.posts;
  await expect(e2eeChat(body(), { ...options(), verifyAttestation: async () => false })).rejects.toThrow("Caller refused");
  await expect(e2eeChat(body(), { ...options(), verifyAttestation: undefined as any })).rejects.toThrow();
  expect(gw.state.posts).toBe(posts);
});
test("gateway rejects wrong recipient key, request AEAD tampering and repeated nonce, releasing unserved holds", async () => {
  await e2eeChat(body(), options());
  const bytes = gw.state.lastBytes; const headers = new Headers(gw.state.lastHeaders);
  headers.set("authorization", auth.authorization);
  let r = await h.request("/api/v1/e2ee/chat/completions", { method: "POST", headers, body: bytes });
  expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ error: { type: "e2ee_replay_detected" } });
  headers.set("x-e2ee-nonce", "45".repeat(32)); headers.set("x-model-pub-key", "67".repeat(32));
  r = await h.request("/api/v1/e2ee/chat/completions", { method: "POST", headers, body: bytes }); expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ error: { type: "e2ee_model_key_mismatch" } });
  headers.set("x-model-pub-key", gw.ks.e2ee_public_keys[0].public_key);
  r = await h.request("/api/v1/e2ee/chat/completions", { method: "POST", headers, body: bytes }); expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ error: { type: "e2ee_decryption_failed" } });
  const held = await h.ctx.db.select().from(holds).where(eq(holds.status, "held")); expect(held).toHaveLength(0);
});
test("strict endpoint refuses tools, files, search and plaintext fields before provider calls", async () => {
  await e2eeChat(body(), options());
  const headers = new Headers(gw.state.lastHeaders); headers.set("authorization", auth.authorization);
  const good = JSON.parse(gw.state.lastBytes.toString()); const posts = gw.state.posts;
  for (const extra of [{ tools: [] }, { files: [] }, { web_search_options: {} }, { metadata: "content" }, { messages: [{ role: "user", content: "plaintext" }] }]) {
    const r = await h.request("/api/v1/e2ee/chat/completions", { method: "POST", headers, json: { ...good, ...extra } }); expect(r.status).toBe(400);
  }
  expect(gw.state.posts).toBe(posts);
});
test("opaque forwarding preserves original whitespace and order", async () => {
  const client = (async (input: any, init?: RequestInit) => {
    if (String(input).endsWith("/chat/completions")) init = { ...init, body: " \n" + JSON.stringify(JSON.parse(String(init!.body)), null, 2) + "\n" };
    return shim(input, init);
  }) as typeof fetch;
  await e2eeChat(body(), { ...options(), fetch: client });
  expect(gw.state.lastBytes.toString().startsWith(" \n{")).toBe(true);
  expect((await lastGeneration()).requestSha256).toBe(sha256(gw.state.lastBytes));
});
test("Tor plus blind token reuses unlinkable admission and pooled billing", async () => {
  const api = await h.fundedKey(2n);
  const [token] = (await buyTokens({ baseUrl: "http://router.example", apiKey: api.secret, denomination: 10_000, count: 1, fetch: shim })).tokens;
  const headers = { authorization: authorizationHeader(decodeBase64(token)!), [ONION_HEADER]: proxySecret, "x-anyroute-lane": "unlinkable" };
  const result = await e2eeChat(body(), { ...options(), headers }); expect(result.choices[0].message.content).toBe("Encrypted reply");
  const row = await lastGeneration(); expect(row.keyHash).toBeNull(); expect(row.receipt).toMatchObject({ mode: "blind", lane: "unlinkable", payer: null });
  expect(privacyLabel(row.receipt, { unlinkableTransports: ["onion"] }).label.network.hidden).toBe(true);
});
test("freshness and expiry checks fail closed", async () => {
  const report = gatewayReport("ab".repeat(32), { keyset: gw.ks });
  const quote = Buffer.from(report.attestation.evidence.quote, "hex"); quote.writeUInt32LE(0x81, 4); report.attestation.evidence.quote = quote.toString("hex");
  await expect(verifyE2eeReport({ ...report, workload_keyset_digest: "sha256:" + "00".repeat(32) }, "ab".repeat(32), async () => true)).rejects.toThrow();
  await expect(verifyE2eeReport(gatewayReport("ab".repeat(32), { keyset: { ...gw.ks, not_after: 1 } }), "ab".repeat(32), async () => true)).rejects.toThrow();
});
test("byte bound includes framing and field overhead without calling it observed usage", () => {
  const envelope = { model: MODEL, messages: [{ role: "user", content: "ab".repeat(64) }], max_tokens: 16, provider: { aci_verified: true, zdr: true } };
  expect(inputBound(envelope as any)).toBe(516);
});
test("AEAD authenticates exact Unicode model, field index, id and nonce", async () => {
  const pair = await e2eeKeyPair(); const ctx = { model: "acme/é", nonce: "ab".repeat(32), ts: 1 };
  const field = await sealE2eeField("hello", await e2eePublicKey(pair), e2eeAad(ctx, "messages.0.content"));
  expect(await openE2eeField(field, pair.privateKey, e2eeAad(ctx, "messages.0.content"))).toBe("hello");
  for (const associated of [e2eeAad({ ...ctx, model: "acme/e\u0301" }, "messages.0.content"), e2eeAad(ctx, "messages.1.content"), e2eeAad(ctx, "messages.0.content", "id"), e2eeAad({ ...ctx, nonce: "cd".repeat(32) }, "messages.0.content")]) await expect(openE2eeField(field, pair.privateKey, associated)).rejects.toThrow();
});
test("off-by-default routes return 404", async () => {
  const off = await startRouter(); try { expect((await off.request("/api/v1/e2ee/chat/completions", { method: "POST", json: {} })).status).toBe(404); expect((await off.request("/api/v1/e2ee/attestation?nonce=" + "ab".repeat(32))).status).toBe(404); expect(off.ctx.cfg.e2ee.enabled).toBe(false); } finally { await off.close(); }
});
test("real production loader starts enabled with configured Phala manifest and refuses missing or wrong provider", () => {
  const address = "0x" + "1".repeat(40);
  const base = { NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/database", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), E2EE_PASSTHROUGH_ENABLED: "true", ALLOW_DEV_ATTESTATION: "false" };
  const dir = mkdtempSync(join(tmpdir(), "anyroute-e2ee-")); const path = join(dir, "providers.json");
  try {
    expect(() => loadConfig({ ...base, PROVIDERS_FILE: "" })).toThrow("PROVIDERS_FILE");
    // Pinned by settings instead of a file: both URLs required, https only.
    expect(loadConfig({ ...base, PROVIDERS_FILE: "", E2EE_GATEWAY_BASE_URL: "https://gateway.example/v1/", E2EE_GATEWAY_ATTESTATION_URL: "https://gateway.example/v1/aci/attestation" }).e2ee.provider).toEqual({ baseUrl: "https://gateway.example/v1", attestationUrl: "https://gateway.example/v1/aci/attestation" });
    expect(() => loadConfig({ ...base, PROVIDERS_FILE: "", E2EE_GATEWAY_BASE_URL: "https://gateway.example/v1" })).toThrow("E2EE_GATEWAY_ATTESTATION_URL");
    expect(() => loadConfig({ ...base, PROVIDERS_FILE: "", E2EE_GATEWAY_BASE_URL: "http://gateway.example/v1", E2EE_GATEWAY_ATTESTATION_URL: "https://gateway.example/a" })).toThrow("https");
    writeFileSync(path, JSON.stringify({ providers: [{ id: PROVIDER, status: "live", base_url: "https://gateway.example/v1", api_key_env: "PHALA_KEY", tee: { kind: "tdx", attestation_url: "https://gateway.example/v1/aci/attestation" } }] }));
    expect(loadConfig({ ...base, PROVIDERS_FILE: path }).e2ee.enabled).toBe(true);
    writeFileSync(path, JSON.stringify({ providers: [{ id: "other" }] })); expect(() => loadConfig({ ...base, PROVIDERS_FILE: path })).toThrow("phala-confidential-ai");
  } finally { rmSync(dir, { recursive: true }); }
});

test("content-addressed session claims are verified by router and client", async () => {
  gw.state.attack = "session-claims";
  const result = await e2eeChat(body(), options());
  expect(result.choices[0].message.content).toBe("Encrypted reply");
  expect((await lastGeneration()).receipt).toMatchObject({ e2ee: { gateway_receipt: { upstream_verified: true } } });
});
test("unencrypted and malformed flags do not change ordinary receipt labels", () => {
  for (const flags of [{}, { end_to_end_encrypted: true }, { end_to_end_encrypted: true, e2ee: { version: 1, gateway_attested: true } }]) {
    expect(privacyLabel({ provider: PROVIDER, ...flags }).label.prompt_readers.router).toBe(true);
  }
});

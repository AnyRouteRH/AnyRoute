import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { startRouter, type Harness, MODELS } from "./helpers.ts";
import { agentPolicies } from "../src/agents/schema.ts";
import { generations, keys, receiptKeys } from "../src/db/schema.ts";
import { appendEvent, pruneAgentPolicyEvents } from "../src/agents/store.ts";
import { checkRecordClaims } from "../src/agents/record-certificate.ts";
import { RECORD_CERTIFICATE_TTL_MS, verifyRecordCertificate, type RecordCertificate } from "../packages/client/src/record-certificate.ts";
import { loadConfig } from "../src/config.ts";
import { noteSigner, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";
import { sha256 } from "../src/lib/util.ts";
let h: Harness;
const witness = noteSigner("record-witness.example/log", SIG_COSIGNATURE_V1, randomBytes(32));
const env = { AGENT_POLICY_ENABLED: "true", TLOG_ENABLED: "true", TLOG_WITNESSES: witness.verifierKey, TLOG_WITNESS_QUORUM: "1" };
const base = { version: 1 as const, models: {}, caps: {}, on_breach: "deny" as const };
const issue = (k: { auth: Record<string, string> }, claims: string[]) => h.request("/api/v1/agents/me/record-certificate", { method: "POST", headers: k.auth, json: { claims } });
const verify = (c: unknown) => h.request("/api/v1/agents/certificates/verify", { method: "POST", json: c });
const keyRow = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0];
const seedGenerations = async (hash: string, dates: Date[], cancelled = false) => {
  for (const ts of dates) await h.ctx.db.insert(generations).values({ id: randomBytes(16).toString("hex"), keyHash: hash, modelId: MODELS.llama.slug, providerId: "alpha", mode: "prepaid", ts, cancelled, finishReason: "stop" });
};
beforeAll(async () => { h = await startRouter({ env }); await h.ctx.tlog!.idle(); });
afterAll(async () => { await h?.close(); });

test("true integer thresholds only, no partial certificate, completed records on distinct UTC dates", async () => {
  const k = await h.fundedKey();
  await seedGenerations(k.hash, [new Date("2025-01-01T01:00:00Z"), new Date("2025-01-01T23:00:00Z"), new Date("2025-01-02T00:00:00Z")]);
  await seedGenerations(k.hash, [new Date("2025-01-03T00:00:00Z")], true);
  const certificate = (await (await issue(k, ["requests_at_least:3", "active_days_at_least:2"])).json()).data;
  expect(certificate.payload.claims).toEqual(["requests_at_least:3", "active_days_at_least:2"]);
  expect(Date.parse(certificate.payload.expires_at) - Date.parse(certificate.payload.issued_at)).toBe(RECORD_CERTIFICATE_TTL_MS);
  for (const claims of [["requests_at_least:4"], ["active_days_at_least:3"], ["requests_at_least:1", "active_days_at_least:3"]]) {
    const r = await issue(k, claims); expect(r.status).toBe(422); expect((await r.json()).error.type).toBe("record_claim_unproven");
  }
  const other = await h.fundedKey(); expect((await issue(other, ["requests_at_least:1"])).status).toBe(422);
});
test("strict bounded claims; autonomy is absent so rung claims are unsupported", async () => {
  const k = await h.fundedKey();
  for (const claims of [[], ["requests_at_least:1.1"], ["no_denials_days:91"], ["rung_at_least:1"], ["requests_at_least:1", "requests_at_least:1"]]) expect((await issue(k, claims)).status).toBe(400);
});
test("new policies and unknown history never become absence claims; denials and kills refuse", async () => {
  const k = await h.fundedKey(); const key = await keyRow(k.hash);
  const now = new Date(); const old = new Date(now.getTime() - 3 * 86_400_000);
  await h.ctx.db.update(keys).set({ createdAt: old }).where(eq(keys.keyHash, k.hash));
  await expect(checkRecordClaims(h.ctx.db, { ...key, createdAt: old }, ["no_denials_days:1"], now)).rejects.toThrow("retained");
  await h.ctx.db.insert(agentPolicies).values({ keyHash: k.hash, spec: base, version: 1, sha256: "a".repeat(64), updatedBy: k.hash });
  await expect(checkRecordClaims(h.ctx.db, { ...key, createdAt: old }, ["no_kills_days:1"], now)).rejects.toThrow("retained");
  await h.ctx.db.update(agentPolicies).set({ updatedAt: old }).where(eq(agentPolicies.keyHash, k.hash));
  const good = await issue(k, ["no_denials_days:1", "no_kills_days:1"]); expect(good.status).toBe(200);
  await appendEvent(h.ctx.db, { keyHash: k.hash, kind: "decision", decision: "deny", policySha256: "a".repeat(64) }, new Date(now.getTime() - 1000));
  expect((await issue(k, ["no_denials_days:1"])).status).toBe(422);
  await appendEvent(h.ctx.db, { keyHash: k.hash, kind: "killed", policySha256: "a".repeat(64) }, new Date(now.getTime() - 1000));
  expect((await issue(k, ["no_kills_days:1"])).status).toBe(422);
  await appendEvent(h.ctx.db, { keyHash: k.hash, kind: "killed", policySha256: "a".repeat(64) }, new Date(now.getTime() - 100 * 86_400_000));
  expect(await pruneAgentPolicyEvents(h.ctx.db, now)).toBeGreaterThan(0);
  // The retention horizon rejects a request for history that has already aged out.
  expect((await issue(k, ["no_denials_days:100"])).status).toBe(400);
});
test("absence claim includes parent restrictions, session cannot borrow its parent's generation record", async () => {
  const parent = await h.fundedKey();
  await seedGenerations(parent.hash, [new Date(Date.now() - 1000)]);
  const response = await h.request("/api/v1/sessions", { method: "POST", headers: parent.auth, json: { budget_usd: 1 } });
  const session = (await response.json()).data;
  const child = { auth: { authorization: `Bearer ${session.key}` } };
  expect((await issue(child, ["requests_at_least:1"])).status).toBe(422);
  const old = new Date(Date.now() - 3 * 86_400_000);
  await h.ctx.db.update(keys).set({ createdAt: old }).where(eq(keys.keyHash, session.key_hash));
  await h.ctx.db.insert(agentPolicies).values({ keyHash: parent.hash, spec: base, version: 1, sha256: "b".repeat(64), updatedBy: parent.hash, updatedAt: old });
  expect((await issue(child, ["no_denials_days:1"])).status).toBe(200);
  await appendEvent(h.ctx.db, { keyHash: parent.hash, kind: "decision", decision: "deny", policySha256: "b".repeat(64) });
  expect((await issue(child, ["no_denials_days:1"])).status).toBe(422);
});
test("fresh pseudonyms expose no agent key, account, event, receipt or policy identifier", async () => {
  const k = await h.fundedKey(); await seedGenerations(k.hash, [new Date(Date.now() - 1000)]);
  const a = (await (await issue(k, ["requests_at_least:1"])).json()).data as RecordCertificate;
  const b = (await (await issue(k, ["requests_at_least:1"])).json()).data as RecordCertificate;
  expect(a.payload.pseudonym).not.toBe(b.payload.pseudonym);
  expect(a.payload.pseudonym).toHaveLength(64);
  for (const c of [a, b]) {
    expect(JSON.stringify(c)).not.toContain(k.hash); expect(JSON.stringify(c)).not.toContain((await keyRow(k.hash)).accountId);
    expect(Object.keys(c.payload).sort()).toEqual(["claims", "expires_at", "issued_at", "notice", "pseudonym", "type", "version"]);
    expect((await (await verify(c)).json()).data.valid).toBe(true);
  }
  const get = await h.request("/api/v1/agents/certificates/verify?certificate=" + encodeURIComponent(JSON.stringify(a)));
  expect((await get.json()).data.valid).toBe(true);
});
test("offline verification checks expiry boundary, future issuance, every signed field and unknown keys", async () => {
  const k = await h.fundedKey(); await seedGenerations(k.hash, [new Date(Date.now() - 1000)]);
  const c = (await (await issue(k, ["requests_at_least:1"])).json()).data as RecordCertificate;
  const options = { keys: await h.ctx.signer.jwks() };
  expect(await verifyRecordCertificate(c, options)).toBe(true);
  expect(await verifyRecordCertificate(c, { ...options, nowMs: Date.parse(c.payload.expires_at) })).toBe(false);
  expect(await verifyRecordCertificate(c, { ...options, nowMs: Date.parse(c.payload.expires_at) - 1 })).toBe(true);
  expect(await verifyRecordCertificate(c, { ...options, nowMs: Date.parse(c.payload.issued_at) - 1 })).toBe(false);
  for (const changes of [{ claims: ["requests_at_least:2"] }, { pseudonym: "a".repeat(64) }, { expires_at: new Date(Date.parse(c.payload.expires_at) + 1000).toISOString() }, { notice: "changed" }]) {
    expect(await verifyRecordCertificate({ ...c, payload: { ...c.payload, ...changes } }, options)).toBe(false);
  }
  const bad = { ...c, signature: (c.signature[0] === "A" ? "B" : "A") + c.signature.slice(1) };
  expect((await (await verify(bad)).json()).data.valid).toBe(false);
  expect(await verifyRecordCertificate({ ...c, key_id: "0".repeat(16) }, options)).toBe(false);
  expect(await verifyRecordCertificate(c, { keys: { keys: [] } })).toBe(false);
  expect((await verify({ ...c, payload: { ...c.payload, key_hash: k.hash } })).status).toBe(400);
});
test("rotation logs the new receipt key and preserves verification of earlier certificates", async () => {
  const k = await h.fundedKey(); await seedGenerations(k.hash, [new Date(Date.now() - 1000)]);
  const a = (await (await issue(k, ["requests_at_least:1"])).json()).data as RecordCertificate;
  await h.ctx.signer.rotateIfDue(true);
  const b = (await (await issue(k, ["requests_at_least:1"])).json()).data as RecordCertificate;
  expect(a.key_id).not.toBe(b.key_id);
  for (const c of [a, b]) {
    expect((await (await verify(c)).json()).data.valid).toBe(true);
    const [row] = await h.ctx.db.select().from(receiptKeys).where(eq(receiptKeys.id, c.key_id));
    expect(await h.ctx.tlog!.lookup("receipt_key", sha256(Buffer.from(row.publicKey, "hex")))).not.toBeNull();
  }
});
test("issuance authenticates and rate-limits per account, verification is public; feature off is 404", async () => {
  expect((await h.request("/api/v1/agents/me/record-certificate", { method: "POST", json: { claims: ["requests_at_least:1"] } })).status).toBe(401);
  const k = await h.fundedKey(); await seedGenerations(k.hash, [new Date(Date.now() - 1000)]);
  const sibling = await h.request("/api/v1/keys", { method: "POST", headers: k.auth, json: { name: "sibling" } });
  expect(sibling.status).toBe(201);
  const second = await sibling.json();
  for (let i = 0; i < 5; i++) expect((await issue(k, ["requests_at_least:1"])).status).toBe(200);
  const limited = await issue({ auth: { authorization: `Bearer ${second.key}` } }, ["requests_at_least:1"]);
  expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, k.hash));
  expect((await issue(k, ["requests_at_least:1"])).status).toBe(401);
  const off = await startRouter();
  try {
    for (const [path, method] of [["/me/record-certificate", "POST"], ["/certificates/verify", "POST"], ["/certificates/verify", "GET"]]) expect((await off.request("/api/v1/agents" + path, { method, json: method === "POST" ? {} : undefined })).status).toBe(404);
  } finally { await off.close(); }
});
test("issuance refuses when the signing key log is unavailable", async () => {
  const original = h.ctx.tlog; h.ctx.tlog = undefined;
  try { const k = await h.fundedKey(); expect((await issue(k, ["requests_at_least:1"])).status).toBe(503); }
  finally { h.ctx.tlog = original; }
});
test("real production config loader accepts certificate prerequisites without weakening guards", () => {
  const address = "0x" + "1".repeat(40);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), ...env, TLOG_SIGNING_KEY: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") });
  expect(cfg.agentPolicyEnabled).toBe(true); expect(cfg.tlog.enabled).toBe(true);
});

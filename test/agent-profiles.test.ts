import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { startRouter, type Harness, MODELS } from "./helpers.ts";
import { agentProfiles } from "../src/agents/profile-schema.ts";
import { newProfileSlug, profileCard } from "../src/agents/profiles.ts";
import { generations, keys } from "../src/db/schema.ts";
import { noteSigner, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";
import { loadConfig } from "../src/config.ts";

let h: Harness;
const witness = noteSigner("profile-witness.example/log", SIG_COSIGNATURE_V1, randomBytes(32));
const env = { AGENT_PROFILES_ENABLED: "true", AGENT_POLICY_ENABLED: "true", TLOG_ENABLED: "true", TLOG_WITNESSES: witness.verifierKey, TLOG_WITNESS_QUORUM: "1" };
const body = { name: "Public agent", description: "Searches documents", capabilities: ["search"], show: [] };
type Owner = Awaited<ReturnType<Harness["fundedKey"]>>;
const publish = (k: Owner, json: unknown = body) => h.request(`/api/v1/agents/${k.hash}/profile`, { method: "PUT", headers: k.auth, json });
const card = (id: string) => h.request(`/api/v1/agents/profiles/${id}`);
const rpc = (method: string, params?: unknown) => h.request("/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method, params } });
beforeAll(async () => { h = await startRouter({ env }); await h.ctx.tlog!.idle(); });
afterAll(async () => { await h?.close(); });

test("publication is opt-in, keeps stable random slug on updates, deletes and changes slug on republish", async () => {
  const k = await h.fundedKey();
  expect((await (await h.request(`/api/v1/agents/${k.hash}/profile`, { headers: k.auth })).json()).data).toBeNull();
  const first = (await (await publish(k)).json()).data.id;
  expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/); expect(first).not.toBe(k.hash); expect(k.hash).not.toContain(first);
  const c = await (await card(first)).json(); expect(c.name).toBe(body.name); expect(JSON.stringify(c)).not.toContain(k.hash);
  expect((await (await publish(k, { ...body, name: "Updated", homepage: "https://agent.example/" })).json()).data.id).toBe(first);
  expect((await (await card(first)).json()).homepage).toBe("https://agent.example/");
  expect((await h.request(`/api/v1/agents/${k.hash}/profile`, { method: "DELETE", headers: k.auth })).status).toBe(200);
  expect((await card(first)).status).toBe(404);
  expect((await (await publish(k)).json()).data.id).not.toBe(first);
  const slugs = new Set(Array.from({ length: 1000 }, newProfileSlug)); expect(slugs.size).toBe(1000);
});
test("public projection includes only selected categories, never private policy amounts or identifiers", async () => {
  const k = await h.fundedKey();
  const policy = { version: 1, models: { allow: ["private-model"] }, caps: { per_request_usd: 123.456 }, approval: { above_usd: 78.9 }, on_breach: "deny" };
  expect((await h.request(`/api/v1/agents/${k.hash}/policy`, { method: "PUT", headers: k.auth, json: policy })).status).toBe(200);
  const id = (await (await publish(k)).json()).data.id;
  expect((await (await card(id)).json()).anyroute.rulebook_summary).toEqual({});
  await publish(k, { ...body, show: ["spending_caps", "ask_first", "kill_switch"] });
  const publicCard = await (await card(id)).json();
  expect(publicCard.anyroute.rulebook_summary).toEqual({ has_spending_caps: true, asks_before_spending: true, kill_switch_armed: true, killed: false });
  expect(publicCard.anyroute.status).toEqual({ sealed: "unavailable", attested: "unavailable" });
  await h.request(`/api/v1/agents/${k.hash}/kill`, { method: "POST", headers: k.auth, json: { reason: "private-reason" } });
  expect((await (await card(id)).json()).anyroute.rulebook_summary.killed).toBe(true);
  for (const value of [k.hash, "123.456", "78.9", "private-model", "private-reason", "policy_sha256", "account_id", "key_hash"]) expect(JSON.stringify(await (await card(id)).json())).not.toContain(value);
  await publish(k, { ...body, show: ["spending_caps"] });
  expect((await (await card(id)).json()).anyroute.rulebook_summary).toEqual({ has_spending_caps: true });
});
test("owner authorization, session refusal, strict fields and safe homepage schemes", async () => {
  const k = await h.fundedKey(), other = await h.fundedKey();
  expect((await h.request(`/api/v1/agents/${k.hash}/profile`, { method: "PUT", json: body })).status).toBe(401);
  for (const method of ["GET", "PUT", "DELETE"]) expect((await h.request(`/api/v1/agents/${k.hash}/profile`, { method, headers: other.auth, ...(method === "PUT" ? { json: body } : {}) })).status).toBe(404);
  const session = (await (await h.request('/api/v1/sessions', { method: "POST", headers: k.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await h.request(`/api/v1/agents/${k.hash}/profile`, { method: "PUT", headers: { authorization: `Bearer ${session.key}` }, json: body })).status).toBe(403);
  for (const extra of [{ key_hash: k.hash }, { certificates: [] }, { exact_caps: true }, { status: { attested: true } }, { homepage: "javascript:alert(1)" }, { homepage: "https://user:password@agent.example" }, { capabilities: Array(17).fill("tag") }, { show: ["caps"] }, { description: "x".repeat(281) }]) expect((await publish(k, { ...body, ...extra })).status).toBe(400);
});
test("directory is paginated opt-in only and searches exact tags; disabled keys are hidden", async () => {
  const tag = "tag-" + randomBytes(5).toString("hex");
  const owners = await Promise.all([h.fundedKey(), h.fundedKey(), h.fundedKey()]);
  const ids: string[] = [];
  for (const k of owners) ids.push((await (await publish(k, { ...body, capabilities: [tag] })).json()).data.id);
  const unlisted = await h.fundedKey();
  const page = await (await h.request(`/api/v1/agents/profiles?tag=${tag}&limit=2`)).json();
  expect(page.data).toHaveLength(2); expect(page.next_cursor).toBe(page.data[1].anyroute.id);
  const next = await (await h.request(`/api/v1/agents/profiles?tag=${tag}&limit=2&cursor=${page.next_cursor}`)).json();
  expect(next.data).toHaveLength(1); expect(next.next_cursor).toBeNull();
  expect([...page.data, ...next.data].map(c => c.anyroute.id).sort()).toEqual(ids.sort());
  expect(JSON.stringify(page)).not.toContain(unlisted.hash);
  expect((await (await h.request(`/api/v1/agents/profiles?tag=${tag.slice(0, -1)}`)).json()).data).toEqual([]);
  const row = (await h.ctx.db.select().from(agentProfiles).where(eq(agentProfiles.keyHash, owners[0].hash)))[0];
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owners[0].hash)); expect((await card(row.slug)).status).toBe(404);
  await h.ctx.db.update(keys).set({ disabled: false, expiresAt: sql`now() - interval '1 millisecond'` }).where(eq(keys.keyHash, owners[0].hash)); expect((await card(row.slug)).status).toBe(404);
  for (const query of ['limit=0', 'limit=51', 'cursor=bad', 'tag=']) expect((await h.request('/api/v1/agents/profiles?' + query)).status).toBe(400);
});
test("profile certificates belong to selected key, verify expiry at reads and clear on opt-out", async () => {
  const k = await h.fundedKey();
  expect((await publish(k, { ...body, certificate_claims: ["requests_at_least:1"] })).status).toBe(422);
  await h.ctx.db.insert(generations).values({ id: randomBytes(16).toString("hex"), keyHash: k.hash, modelId: MODELS.llama.slug, providerId: "alpha", mode: "prepaid", ts: new Date(Date.now() - 1000), finishReason: "stop" });
  const id = (await (await publish(k, { ...body, certificate_claims: ["requests_at_least:1"] })).json()).data.id;
  const publicCard = await (await card(id)).json();
  expect(publicCard.anyroute.certificates).toHaveLength(1); expect(publicCard.anyroute.certificates[0].valid).toBe(true);
  const row = (await h.ctx.db.select().from(agentProfiles).where(eq(agentProfiles.slug, id)))[0];
  expect((await profileCard(h.ctx, row, Date.parse(row.certificates[0].payload.expires_at))).anyroute.certificates).toEqual([]);
  const c = row.certificates[0];
  await h.ctx.db.update(agentProfiles).set({ certificates: [{ ...c, signature: (c.signature[0] === "A" ? "B" : "A") + c.signature.slice(1) }] }).where(eq(agentProfiles.slug, id));
  expect((await (await card(id)).json()).anyroute.certificates).toEqual([]);
  await publish(k, body); expect((await (await card(id)).json()).anyroute.certificates).toEqual([]);
});
test("MCP tool lists when enabled and reuses public directory without authentication", async () => {
  const tools = (await (await rpc("tools/list")).json()).result.tools; expect(tools.some(t => t.name === "anyroute_agent_directory")).toBe(true);
  const response = await (await rpc("tools/call", { name: "anyroute_agent_directory", arguments: { tag: "absent-tag", limit: 1 } })).json();
  expect(response.result.structuredContent).toEqual({ data: [], next_cursor: null });
});
test("flag off returns 404 on every profile API, tool hidden; profile flag works independently", async () => {
  const off = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } });
  try {
    for (const [path, method] of [["/profiles", "GET"], ["/profiles/" + newProfileSlug(), "GET"], ["/abc/profile", "GET"], ["/abc/profile", "PUT"], ["/abc/profile", "DELETE"]]) expect((await off.request('/api/v1/agents' + path, { method, ...(method === "PUT" ? { json: body } : {}) })).status).toBe(404);
    const listed = await (await off.request('/mcp', { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json(); expect(listed.result.tools.some(t => t.name === "anyroute_agent_directory")).toBe(false);
  } finally { await off.close(); }
  const alone = await startRouter({ env: { AGENT_PROFILES_ENABLED: "true" } });
  try { const k = await alone.fundedKey(); expect((await alone.request(`/api/v1/agents/${k.hash}/profile`, { method: "PUT", headers: k.auth, json: body })).status).toBe(200); expect((await alone.request('/api/v1/agents/profiles')).status).toBe(200); }
  finally { await alone.close(); }
});
test("production config loader accepts profiles on and defaults off without weakening guards", () => {
  expect(loadConfig({}).agentProfilesEnabled).toBe(false);
  const address = "0x" + "1".repeat(40);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), ...env, TLOG_SIGNING_KEY: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") });
  expect(cfg.production).toBe(true); expect(cfg.agentProfilesEnabled).toBe(true);
});

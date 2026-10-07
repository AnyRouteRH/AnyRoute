import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readAgentSpend, spendDates, summarizeSpend } from "../src/agents/spend-glance.ts";
import { generations, keys, ledger, models, teamMembers } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { startRouter, type Harness } from "./helpers.ts";

const USD = 1_000_000_000_000n;
const path = "/api/v1/agents/spend?days=7";
let h: Harness, off: Harness, sequence = 0;
beforeAll(async () => {
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } });
  off = await startRouter();
});
afterAll(async () => { await h?.close(); await off?.close(); });
const row = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0];
async function charge(key: typeof keys.$inferSelect, amount: bigint, at: Date, kind = "usage", generationId?: string) {
  const id = `spend-glance-${++sequence}`;
  await h.ctx.db.insert(ledger).values({ id, ref: id, accountId: key.accountId, keyHash: key.keyHash, amount, kind, generationId, createdAt: at });
}
async function generation(key: typeof keys.$inferSelect, modelId: string, ts: Date) {
  const id = `spend-glance-generation-${++sequence}`;
  await h.ctx.db.insert(generations).values({ id, accountId: key.accountId, keyHash: key.keyHash, modelId, providerId: "alpha", mode: "prepaid", ts });
  return id;
}
async function child(owner: { auth: Record<string, string> }) {
  const result = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: {} })).json();
  return { hash: result.data.hash, auth: { authorization: "Bearer " + result.key } };
}

test("seven calendar dates use UTC across timezone offsets, year boundaries and leap days", () => {
  expect(spendDates(new Date("2026-01-01T23:30:00-05:00"))).toEqual(["2025-12-27", "2025-12-28", "2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]);
  expect(spendDates(new Date("2024-03-01T01:00:00+02:00")).at(-1)).toBe("2024-02-29");
});
test("zeros remain, pico sums and model winners are exact, ties are stable", () => {
  const dates = spendDates(new Date("2026-10-07T12:00:00Z"));
  const empty = summarizeSpend(dates, [], null);
  expect(empty.daily).toHaveLength(7); expect(empty.daily.every(d => d.charged_usd === 0)).toBe(true);
  expect(empty).toMatchObject({ total_usd: 0, top_model: null, last_request_at: null });
  const result = summarizeSpend(dates, [
    { day: dates[0], amount: "1", modelId: "b", modelName: "Model B" },
    { day: dates[0], amount: "1", modelId: "a", modelName: null },
    { day: dates[6], amount: "2", modelId: null, modelName: null },
    { day: "2026-09-30", amount: "999", modelId: "old", modelName: "Old" },
  ], new Date("2026-10-07T11:00:00Z"));
  expect(result.total_usd).toBe(4e-12); expect(result.daily[0].charged_usd).toBe(2e-12);
  expect(result.top_model).toEqual({ id: "a", name: "a", charged_usd: 1e-12 });
  expect(result.last_request_at).toBe("2026-10-07T11:00:00.000Z");
});
test("UTC settlement buckets include the start and now, exclude older/future rows and non-charge kinds", async () => {
  const owner = await h.newKey(), key = await row(owner.hash);
  const now = new Date("2026-10-07T12:00:00Z");
  const start = new Date("2026-10-01T00:00:00Z");
  await h.ctx.db.insert(models).values({ id: "spend/model-a", author: "spend", name: "Model A", createdUnix: 0 });
  const a = await generation(key, "spend/model-a", start);
  const b = await generation(key, "spend/model-b", new Date("2026-10-07T11:00:00Z"));
  await charge(key, -USD, start, "usage", a);
  await charge(key, -2n * USD, new Date("2026-10-01T23:59:59.999Z"), "usage", a);
  await charge(key, -USD, new Date("2026-10-02T00:00:00Z"), "tool_call");
  await charge(key, -USD, now, "data_tool", b);
  await charge(key, -10n * USD, new Date(start.getTime() - 1));
  await charge(key, -10n * USD, new Date(now.getTime() + 1));
  for (const [kind, amount] of [["refund", USD], ["deposit", USD], ["usage", USD], ["withdrawal", -USD], ["usage", 0n]] as const) await charge(key, amount, now, kind);
  const result = await readAgentSpend(h.ctx, key, now);
  expect(result).toMatchObject({ days: 7, from: start.toISOString(), as_of: now.toISOString() });
  expect(result.data).toHaveLength(1);
  expect(result.data[0]).toMatchObject({ key_hash: owner.hash, total_usd: 5, top_model: { id: "spend/model-a", name: "Model A", charged_usd: 3 }, last_request_at: now.toISOString() });
  expect(result.data[0].daily.map(d => d.charged_usd)).toEqual([3, 1, 0, 0, 0, 0, 1]);
});
test("generation links cannot attribute another key/account, and free recorded calls update last-call time", async () => {
  const owner = await h.newKey(), other = await h.newKey(), key = await row(owner.hash), foreign = await row(other.hash);
  const sibling = await child(owner), siblingRow = await row(sibling.hash);
  const now = new Date("2026-10-07T12:00:00Z");
  const foreignGen = await generation(foreign, "foreign/model", now);
  const siblingGen = await generation(siblingRow, "sibling/model", now);
  await charge(key, -USD, new Date("2026-10-07T09:00:00Z"), "usage", foreignGen);
  await charge(key, -USD, new Date("2026-10-07T10:00:00Z"), "usage", siblingGen);
  await generation(key, "free/model", now);
  const result = await readAgentSpend(h.ctx, key, now);
  expect(result.data.find(d => d.key_hash === key.keyHash)).toMatchObject({ total_usd: 2, top_model: null, last_request_at: now.toISOString() });
  expect(result.data.find(d => d.key_hash === sibling.hash)?.total_usd).toBe(0);
  expect(result.data.some(d => d.key_hash === foreign.keyHash)).toBe(false);
});
test("last request can precede the week and management reads do not change agents responses or ledger", async () => {
  const owner = await h.newKey(), key = await row(owner.hash), now = new Date("2026-10-07T12:00:00Z");
  const old = new Date("2026-09-20T12:00:00Z");
  await charge(key, -USD, old, "tool_call");
  const result = await readAgentSpend(h.ctx, key, now);
  expect(result.data[0]).toMatchObject({ total_usd: 0, last_request_at: old.toISOString(), top_model: null });
  const list = await (await h.request("/api/v1/agents", { headers: owner.auth })).text();
  const entries = await h.ctx.db.select().from(ledger).where(eq(ledger.accountId, key.accountId));
  const response = await h.request(path, { headers: owner.auth });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await (await h.request("/api/v1/agents", { headers: owner.auth })).text()).toBe(list);
  expect(await h.ctx.db.select().from(ledger).where(eq(ledger.accountId, key.accountId))).toEqual(entries);
});
test("auth matches agents list: sessions, ordinary children, inference, disabled and expired keys are refused", async () => {
  for (const headers of [{}, { authorization: "Bearer invalid" }]) expect((await h.request(path, { headers })).status).toBe(401);
  const owner = await h.newKey(), ordinary = await child(owner);
  expect((await h.request(path, { headers: ordinary.auth })).status).toBe(403);
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await h.request(path, { headers: { authorization: "Bearer " + session.key } })).status).toBe(403);
  await h.ctx.db.update(keys).set({ scope: "inference" }).where(eq(keys.keyHash, ordinary.hash));
  expect((await h.request(path, { headers: ordinary.auth })).status).toBe(403);
  const disabled = await h.newKey(); await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, disabled.hash));
  expect((await h.request(path, { headers: disabled.auth })).status).toBe(401);
  const expired = await h.newKey(); await h.ctx.db.update(keys).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(keys.keyHash, expired.hash));
  expect((await h.request(path, { headers: expired.auth })).status).toBe(401);
});
test("team owners/admins see exactly the agents-list keys, without other team/account spending", async () => {
  const owner = await h.newKey(), foreign = await h.newKey();
  const admin = await child(owner), peer = await child(owner), hidden = await child(owner);
  await h.ctx.db.update(keys).set({ teamId: "spend-team-a" }).where(eq(keys.keyHash, admin.hash));
  await h.ctx.db.update(keys).set({ teamId: "spend-team-a" }).where(eq(keys.keyHash, peer.hash));
  await h.ctx.db.update(keys).set({ teamId: "spend-team-b" }).where(eq(keys.keyHash, hidden.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "spend-team-a", keyHash: admin.hash, role: "admin" });
  const at = new Date(Date.now() - 1000);
  for (const hash of [owner.hash, admin.hash, peer.hash, hidden.hash, foreign.hash]) await charge(await row(hash), -USD, at);
  for (const role of ["admin", "owner"]) {
    await h.ctx.db.update(teamMembers).set({ role }).where(eq(teamMembers.keyHash, admin.hash));
    const response = await h.request(path, { headers: admin.auth }); expect(response.status).toBe(200);
    const spend = (await response.json()).data;
    const list = (await (await h.request("/api/v1/agents", { headers: admin.auth })).json()).data;
    expect(spend.map((d: any) => d.key_hash).sort()).toEqual(list.map((d: any) => d.key_hash).sort());
    expect(spend.map((d: any) => d.key_hash).sort()).toEqual([admin.hash, peer.hash].sort());
    expect(spend.every((d: any) => d.total_usd === 1)).toBe(true);
  }
  const management = (await (await h.request(path, { headers: owner.auth })).json()).data;
  expect(management.map((d: any) => d.key_hash).sort()).toEqual([owner.hash, admin.hash, peer.hash, hidden.hash].sort());
  await h.ctx.db.update(teamMembers).set({ role: "viewer" }).where(eq(teamMembers.keyHash, admin.hash));
  expect((await h.request(path, { headers: admin.auth })).status).toBe(403);
});
test("existing flag defaults off, no new flag; only seven-day requests are accepted", async () => {
  expect(loadConfig({ ANYROUTE_ENV: "test" }).agentPolicyEnabled).toBe(false);
  const owner = await off.newKey();
  expect((await off.request(path, { headers: owner.auth })).status).toBe(404);
  expect((await off.request(path)).status).toBe(404);
  const onOwner = await h.newKey();
  const response = await h.request("/api/v1/agents/spend", { headers: onOwner.auth });
  expect(response.status).toBe(200); expect((await response.json()).data[0].daily).toHaveLength(7);
  for (const value of ["0", "8", "7.0", "bad", ""]) expect((await h.request("/api/v1/agents/spend?days=" + value, { headers: onOwner.auth })).status).toBe(400);
});

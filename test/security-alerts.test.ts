import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { startRouter, type Harness } from "./helpers.ts";
import { keys, kv, teams } from "../src/db/schema.ts";
import { appendAudit } from "../src/teams/audit.ts";
import { consumeCode, removeLink } from "../src/telegram/linking.ts";
import { securityContext, recordSecurity } from "../src/security-alerts/records.ts";
import { registerSecurityAlertsJob, runSecurityAlerts, securityInbox } from "../src/security-alerts/worker.ts";
import { loadConfig } from "../src/config.ts";
let h: Harness;
const path = "/api/v1/account/security-alerts";
type Key = { hash: string; auth: Record<string, string> };
beforeAll(async () => { h = await startRouter({ env: { SECURITY_ALERTS_ENABLED: "true", AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456789:AAFixtureTokenFixtureToken0123456789" } }); });
afterAll(async () => { await h?.close(); });
async function row(key: Key) { return (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)))[0]; }
async function child(owner: Key, data = {}) {
  const response = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "agent", ...data } });
  expect(response.status).toBe(201);
  const result = await response.json(); return { hash: result.data.hash, auth: { authorization: "Bearer " + result.key } };
}
async function notices(owner: Key) {
  const response = await h.request("/api/v1/inbox", { headers: owner.auth }); expect(response.status).toBe(200);
  return (await response.json()).data.filter((item: any) => item.kind === "security");
}
async function patch(owner: Key, target: Key, data: unknown) {
  const response = await h.request(`/api/v1/keys/${target.hash}`, { method: "PATCH", headers: owner.auth, json: data }); expect(response.status).toBe(200);
}
const policy = { version: 1, models: {}, caps: { per_day_usd: 2 }, on_breach: "deny" };

test("default off records nothing, exposes no routes or inbox changes, and registers no job", async () => {
  expect(loadConfig({ NODE_ENV: "test" }).securityAlertsEnabled).toBe(false);
  const off = await startRouter();
  try {
    const key = await off.newKey();
    expect((await off.request(path, { headers: key.auth })).status).toBe(404);
    expect((await off.request(path, { method: "PATCH", headers: key.auth, json: { enabled: true } })).status).toBe(404);
    await recordSecurity(off.ctx, off.ctx.db, "off-account", null, "Off change");
    expect(await runSecurityAlerts(off.ctx)).toEqual({ skipped: true, created: 0 });
    expect(await off.ctx.db.select().from(kv).where(like(kv.key, "security-alerts:%"))).toEqual([]);
    const registrations: unknown[] = []; registerSecurityAlertsJob({ ...off.ctx, jobs: { register: (...args: unknown[]) => registrations.push(args) } } as any); expect(registrations).toEqual([]);
  } finally { await off.close(); }
});

test("settings require management authority, default on, validate strictly, and stay account scoped", async () => {
  const owner = await h.newKey(), other = await h.newKey(), ordinary = await child(owner);
  expect((await h.request(path)).status).toBe(401);
  expect((await h.request(path, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
  for (const method of ["GET", "PATCH"]) expect((await h.request(path, { method, headers: ordinary.auth, ...(method === "PATCH" ? { json: { enabled: false } } : {}) })).status).toBe(403);
  const result = await h.request(path, { headers: owner.auth }); expect(result.headers.get("cache-control")).toBe("no-store"); expect(await result.json()).toEqual({ data: { enabled: true } });
  for (const json of [{ enabled: "false" }, { enabled: true, extra: "no" }, {}]) expect((await h.request(path, { method: "PATCH", headers: owner.auth, json })).status).toBe(400);
  expect((await h.request(path, { method: "PATCH", headers: owner.auth, json: { enabled: false } })).status).toBe(200);
  await child(owner, { name: "muted" }); await runSecurityAlerts(h.ctx);
  expect(await notices(owner)).toEqual([]); expect((await (await h.request(path, { headers: other.auth })).json()).data.enabled).toBe(true);
  await h.request(path, { method: "PATCH", headers: owner.auth, json: { enabled: true } }); await child(owner, { name: "after mute" }); await runSecurityAlerts(h.ctx);
  expect((await notices(owner)).map((i: any) => i.title)).toEqual(["API key 'after mute' created by key 'test'"]);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owner.hash)); expect((await h.request(path, { headers: owner.auth })).status).toBe(401);
});

test("key creation, management status, expiry, budget and disable name the actor without secrets", async () => {
  const owner = await h.newKey(), agent = await child(owner, { name: "worker" });
  await child(owner, { name: "laptop", management: true });
  await patch(owner, agent, { expires_at: new Date(Date.now() + 86400000).toISOString(), limit: 3 });
  await patch(owner, agent, { limit: 3 }); // Identical save produces no notice.
  const disabled = await h.request(`/api/v1/keys/${agent.hash}`, { method: "DELETE", headers: owner.auth }); expect(disabled.status).toBe(200);
  await runSecurityAlerts(h.ctx);
  const titles = (await notices(owner)).map((i: any) => i.title);
  expect(titles).toContain("API key 'worker' created by key 'test'"); expect(titles).toContain("Management API key 'laptop' created by key 'test'");
  expect(titles).toContain("Key 'worker': expiry changed, spending limit changed by key 'test'"); expect(titles).toContain("Key 'worker': switched off by key 'test'"); expect(titles.length).toBe(5);
  expect(JSON.stringify(titles)).not.toContain("sk-ar-v1-"); expect(JSON.stringify(titles)).not.toContain(agent.hash);
});

test("rulebook, spending limit saves, Stop and Resume capture the acting key at event time", async () => {
  const owner = await h.newKey(), agent = await child(owner);
  for (const caps of [{ per_day_usd: 2 }, { per_day_usd: 4 }]) expect((await h.request(`/api/v1/agents/${agent.hash}/policy`, { method: "PUT", headers: owner.auth, json: { ...policy, caps } })).status).toBe(200);
  for (const action of ["kill", "resume"]) expect((await h.request(`/api/v1/agents/${agent.hash}/${action}`, { method: "POST", headers: owner.auth, json: action === "kill" ? { reason: "private reason sentinel" } : {} })).status).toBe(200);
  await patch(owner, owner, { name: "renamed actor" });
  await runSecurityAlerts(h.ctx);
  const titles = (await notices(owner)).map((i: any) => i.title);
  expect(titles.filter((t: string) => t.startsWith("Rulebook and spending limits saved"))).toHaveLength(2);
  expect(titles).toContain("Stop saved for key 'agent' by key 'test'"); expect(titles).toContain("Resume saved for key 'agent' by key 'test'"); expect(JSON.stringify(titles)).not.toContain("private reason sentinel");
});

test("wallet sign-in reports only the account's shortened address", async () => {
  const wallet = privateKeyToAccount("0x" + "12".repeat(32) as `0x${string}`);
  const challenge = await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: wallet.address } })).json();
  const response = await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: wallet.address, nonce: challenge.data.nonce, signature: await wallet.signMessage({ message: challenge.data.message }), name: "wallet access" } });
  expect(response.status).toBe(201); const login = await response.json(); const owner = { hash: login.data.hash, auth: { authorization: "Bearer " + login.key } };
  await runSecurityAlerts(h.ctx); const items = await notices(owner);
  expect(items).toHaveLength(1); expect(items[0].title).toContain(`New sign-in with wallet ${wallet.address.toLowerCase().slice(0, 6)}…${wallet.address.toLowerCase().slice(-4)}`); expect(JSON.stringify(items)).not.toContain(wallet.address.toLowerCase()); expect(JSON.stringify(items)).not.toContain(login.key);
});

test("team member additions and role changes respect team, account and session boundaries", async () => {
  const owner = await h.newKey(), account = (await row(owner)).accountId, other = await h.newKey();
  await h.ctx.db.insert(teams).values([{ id: "security-team-a", name: "Team A", ownerAccount: account }, { id: "security-team-b", name: "Team B", ownerAccount: account }]);
  const admin = await child(owner, { team: "security-team-a", role: "admin" }), peer = await child(owner, { team: "security-team-b", role: "admin" });
  const actor = "key:" + owner.hash.slice(0, 16);
  await securityContext.run(h.ctx, () => appendAudit(h.ctx.db, "security-team-a", actor, "member.join", "member-neutral", { role: "member" }));
  await securityContext.run(h.ctx, () => appendAudit(h.ctx.db, "security-team-a", actor, "member.role", "member-neutral", { role: "viewer", previous: "member" }));
  await securityContext.run({ ...h.ctx, securityActorHash: owner.hash }, () => appendAudit(h.ctx.db, "security-team-a", "wallet:0x" + "34".repeat(20), "member.role", "wallet-member-neutral", { role: "viewer", previous: "member" }));
  await runSecurityAlerts(h.ctx);
  expect((await notices(owner)).some((i: any) => i.title === "Team member role changed in 'Team A' (viewer) by a wallet member")).toBe(true);
  const titles = (await notices(admin)).map((i: any) => i.title); expect(titles).toContain("Team member added in 'Team A' (member) by key 'test'"); expect(titles).toContain("Team member role changed in 'Team A' (viewer) by key 'test'");
  expect((await notices(peer)).some((i: any) => i.title.includes("Team A"))).toBe(false); expect((await notices(other)).some((i: any) => i.title.includes("Team A"))).toBe(false);
  expect((await h.request(path, { headers: admin.auth })).status).toBe(403);
  const sessionRes = await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } }); expect(sessionRes.status).toBe(201);
  const session = (await sessionRes.json()).data; expect((await h.request(path, { headers: { authorization: "Bearer " + session.key } })).status).toBe(403);
  expect(await securityInbox(h.ctx, await row(admin), false)).toEqual([]);
});

test("Telegram link and unlink alert eligible linked principals once, with no post-unlink sends", async () => {
  const owner = await h.newKey(), adminKey = await child(owner, { management: true, name: "laptop" });
  async function link(key: Key, uid: number) { const result = await (await h.request("/api/v1/telegram/link", { method: "POST", headers: key.auth })).json(); await consumeCode(h.ctx, uid, result.data.code); }
  await link(owner, 13801); await link(adminKey, 13802);
  const calls: any[] = []; const fetchImpl = (async (_url: unknown, init: any) => { calls.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof fetch;
  await runSecurityAlerts(h.ctx, fetchImpl);
  expect((await notices(owner)).filter((i: any) => i.title.startsWith("Telegram linked"))).toHaveLength(2);
  const count = calls.length; await runSecurityAlerts(h.ctx, fetchImpl); expect(calls).toHaveLength(count);
  await h.request("/api/v1/telegram/link", { method: "DELETE", headers: owner.auth });
  await runSecurityAlerts(h.ctx, fetchImpl);
  expect(calls.slice(count)).toHaveLength(1); expect(calls.at(-1).chat_id).toBe(13802); expect(calls.at(-1).text).toBe("Telegram unlinked by key 'test'");
  await removeLink(h.ctx, 13802); await runSecurityAlerts(h.ctx, fetchImpl); expect(calls).toHaveLength(count + 1);
  expect((await notices(owner)).some((i: any) => i.title === "Telegram unlinked by its Telegram member")).toBe(true);
});

test("durable cursor serializes concurrent runs and handles same-time and late events", async () => {
  const owner = await h.newKey(), account = (await row(owner)).accountId;
  await runSecurityAlerts(h.ctx); const before = (await notices(owner)).length;
  for (const id of ["cursor-a", "cursor-b"]) await recordSecurity(h.ctx, h.ctx.db, account, null, id, id);
  await Promise.all([runSecurityAlerts(h.ctx), runSecurityAlerts(h.ctx)]);
  await recordSecurity(h.ctx, h.ctx.db, account, null, "late change", "cursor-late");
  await h.ctx.db.update(kv).set({ updatedAt: new Date(0) }).where(eq(kv.key, "security-alerts:event:cursor-late"));
  await runSecurityAlerts(h.ctx); await runSecurityAlerts(h.ctx);
  expect((await notices(owner)).length).toBe(before + 3);
  await recordSecurity(h.ctx, h.ctx.db, account, null, "duplicate source", "cursor-a"); await runSecurityAlerts(h.ctx); expect((await notices(owner)).length).toBe(before + 3);
  const items = await notices(owner); expect(new Set(items.map((i: any) => i.id)).size).toBe(items.length);
  const since = new Date(Date.now() + 1000).toISOString(); expect(await securityInbox(h.ctx, await row(owner), true, since)).toEqual([]);
});

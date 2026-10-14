// H172: bulk controls use the existing API and Telegram bot with isolated fixture accounts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, like, sql } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { eventJson, verifyEventChain } from "../src/agents/store.ts";
import { changeAllStops } from "../src/agents/stop-all.ts";
import { keys, kv, teamMembers } from "../src/db/schema.ts";
import { TelegramApi, TelegramBot, type TgUpdate } from "../src/services/telegram.ts";
import { handleAgentStopAll } from "../src/telegram/agent-stop-all.ts";
import { LINK_FIRST } from "../src/telegram/balance-spend.ts";
import { loadConfig } from "../src/config.ts";
const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
const policy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
type Key = { hash: string; auth: Record<string, string> };
let h: Harness, off: Harness, seq = 0, identity = 17200;
beforeAll(async () => {
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN, SECURITY_ALERTS_ENABLED: "true", READ_ONLY_KEYS_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true", AGENT_TEAM_APPROVERS_ENABLED: "true" } });
  off = await startRouter();
});
afterAll(async () => { await h?.close(); await off?.close(); });
const bulk = (owner: Key, action = "stop-all", body = {}, router = h) => router.request(`/api/v1/agents/${action}`, { method: "POST", headers: owner.auth, ...(action === "stop-all" ? { json: body } : {}) });
const row = async (hash: string) => (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, hash)))[0]!;
const keyRow = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0]!;
const events = async (hash: string) => (await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, hash)).orderBy(asc(agentPolicyEvents.id))).map(eventJson);
async function agent(owner: Key, name = "Service agent") {
  const result = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name } })).json();
  const key = { hash: result.data.hash as string, auth: { authorization: `Bearer ${result.key}` } };
  expect((await h.request(`/api/v1/agents/${key.hash}/policy`, { method: "PUT", headers: owner.auth, json: policy })).status).toBe(200);
  return key;
}
const message = (uid: number, text: string): TgUpdate => ({ update_id: ++seq, message: { message_id: seq, from: { id: uid }, chat: { id: uid, type: "private" }, text } });
function telegram(router = h) {
  const calls: { method: string; params: any }[] = [];
  const fetchImpl = (async (url: unknown, init: any) => { const method = String(url).split("/").at(-1)!; calls.push({ method, params: JSON.parse(init.body) }); return Response.json({ ok: true, result: method === "getUpdates" ? [] : { message_id: seq } }); }) as typeof fetch;
  return { bot: new TelegramBot(router.ctx, { token: TOKEN, fetch: fetchImpl, pollTimeoutS: 0 }), api: new TelegramApi(TOKEN, fetchImpl), calls, replies: () => calls.filter(c => c.method === "sendMessage").map(c => c.params.text as string) };
}
async function link(tg: ReturnType<typeof telegram>, owner: Key) {
  const r = await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth }); expect(r.status).toBe(200);
  const uid = ++identity; await tg.bot.handleUpdate(message(uid, `/link ${(await r.json()).data.code}`)); return uid;
}

test("management stops and resumes all own rulebooks once, with counts, deadlines, events and security records per agent", async () => {
  const owner = await h.newKey(), a = await agent(owner), b = await agent(owner), foreign = await agent(await h.newKey());
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const before = await events(a.hash);
  const result = await bulk(owner, "stop-all", { until, reason: "Maintenance" }); expect(result.status).toBe(200);
  expect((await result.json()).data).toEqual({ count: 2, message: "Stopped 2 agents" });
  for (const key of [a, b]) {
    const stopped = await row(key.hash); expect(stopped.killed).toBe(true); expect(stopped.killUntil?.toISOString()).toBe(until); expect(stopped.killedReason).toBe("Maintenance"); expect(stopped.updatedBy).toBe(owner.hash);
    const chain = await events(key.hash); expect(chain.at(-1)?.kind).toBe("killed"); expect(verifyEventChain(chain)).toBe(true);
    const security = (await h.ctx.db.select().from(kv).where(eq(kv.key, `security-alerts:event:policy:${chain.at(-1)!.id}`)))[0]!.value as { title: string }; expect(security.title).toContain("Stop saved");
    const listed = (await (await h.request("/api/v1/agents", { headers: owner.auth })).json()).data.find((r: any) => r.key_hash === key.hash); expect(listed.stopped_until).toBe(until);
  }
  expect((await row(foreign.hash)).killed).toBe(false);
  expect((await (await bulk(owner)).json()).data.count).toBe(0); expect((await events(a.hash)).length).toBe(before.length + 1); expect((await row(a.hash)).killUntil?.toISOString()).toBe(until);
  expect((await (await bulk(owner, "resume-all")).json()).data).toEqual({ count: 2, message: "Resumed 2 agents" });
  for (const key of [a, b]) { expect((await row(key.hash)).killUntil).toBeNull(); const chain = await events(key.hash); expect(chain.at(-1)?.kind).toBe("resumed"); expect(verifyEventChain(chain)).toBe(true); }
  expect((await (await bulk(owner, "resume-all")).json()).data.count).toBe(0);
});

test("team owners/admins affect only their own team; management reaches all teams; members refused", async () => {
  for (const role of ["owner", "admin"] as const) {
    const owner = await h.newKey(), admin = await agent(owner), teammate = await agent(owner), hidden = await agent(owner), team = `bulk-${role}-${++seq}`;
    for (const key of [admin, teammate]) await h.ctx.db.update(keys).set({ teamId: team }).where(eq(keys.keyHash, key.hash));
    await h.ctx.db.insert(teamMembers).values({ teamId: team, keyHash: admin.hash, role });
    expect((await (await bulk(admin)).json()).data.count).toBe(2); expect((await row(hidden.hash)).killed).toBe(false);
    expect((await (await bulk(admin, "resume-all")).json()).data.count).toBe(2);
    await h.ctx.db.update(teamMembers).set({ role: "member" }).where(eq(teamMembers.keyHash, admin.hash)); expect((await bulk(admin)).status).toBe(403);
    expect((await (await bulk(owner)).json()).data.count).toBe(3); expect((await (await bulk(owner, "resume-all")).json()).data.count).toBe(3);
  }
});

test("Resume all includes individually stopped agents; expired stops can be stopped again; keys without rulebooks skipped", async () => {
  const owner = await h.newKey(), a = await agent(owner);
  expect((await h.request(`/api/v1/agents/${a.hash}/kill`, { method: "POST", headers: owner.auth, json: {} })).status).toBe(200);
  expect((await (await bulk(owner, "resume-all")).json()).data.count).toBe(1);
  await h.ctx.db.update(agentPolicies).set({ killed: true, killUntil: new Date(0) }).where(eq(agentPolicies.keyHash, a.hash));
  expect((await (await bulk(owner)).json()).data.count).toBe(1); expect((await row(a.hash)).killUntil).toBeNull();
  const empty = await h.newKey(); expect((await (await bulk(empty)).json()).data).toEqual({ count: 0, message: "Stopped 0 agents" });
});

test("missing auth, read/inference scope, session authority, default-off and invalid durations refused", async () => {
  const owner = await h.newKey(), a = await agent(owner);
  for (const action of ["stop-all", "resume-all"]) expect((await h.request(`/api/v1/agents/${action}`, { method: "POST", json: {} })).status).toBe(401);
  for (const scope of ["read", "inference"]) {
    await h.ctx.db.update(keys).set({ scope, management: false }).where(eq(keys.keyHash, owner.hash));
    for (const action of ["stop-all", "resume-all"]) expect((await bulk(owner, action)).status).toBe(403);
  }
  await h.ctx.db.update(keys).set({ scope: null, management: true }).where(eq(keys.keyHash, owner.hash));
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  for (const action of ["stop-all", "resume-all"]) expect((await bulk({ hash: session.key_hash, auth: { authorization: `Bearer ${session.key}` } }, action)).status).toBe(403);
  const disabled = await off.newKey();
  for (const action of ["stop-all", "resume-all"]) expect((await bulk(disabled, action, {}, off)).status).toBe(404);
  for (const body of [{ until: new Date(0).toISOString() }, { until: new Date(Date.now() + 31 * 86_400_000).toISOString() }, { reason: "x".repeat(161) }, { unexpected: true }]) expect((await bulk(owner, "stop-all", body)).status).toBe(400);
  expect((await row(a.hash)).killed).toBe(false);
});

test("a later write failure rolls back every Stop, event and security record", async () => {
  const owner = await h.newKey(), a = await agent(owner), b = await agent(owner), beforeA = await events(a.hash), beforeB = await events(b.hash);
  const last = [a.hash, b.hash].sort().at(-1)!;
  // Trigger fails on the second policy write, after the first changeKill and its records.
  await h.ctx.db.execute(sql`create function h172_refuse_stop() returns trigger language plpgsql as $$ begin if NEW.key_hash = '${sql.raw(last)}' and NEW.killed then raise exception 'H172 write failure'; end if; return NEW; end $$`);
  await h.ctx.db.execute(sql`create trigger h172_stop_failure before update on agent_policies for each row execute function h172_refuse_stop()`);
  try { expect((await bulk(owner)).status).toBe(500); }
  finally { await h.ctx.db.execute(sql`drop trigger h172_stop_failure on agent_policies`); await h.ctx.db.execute(sql`drop function h172_refuse_stop()`); }
  expect((await row(a.hash)).killed).toBe(false); expect((await row(b.hash)).killed).toBe(false);
  expect(await events(a.hash)).toEqual(beforeA); expect(await events(b.hash)).toEqual(beforeB);
});

test("bulk operation rechecks changed role inside its transaction and serializes concurrent retries", async () => {
  const owner = await h.newKey(), a = await agent(owner), saved = await keyRow(owner.hash);
  await h.ctx.db.update(keys).set({ management: false }).where(eq(keys.keyHash, owner.hash));
  await expect(h.ctx.db.transaction(tx => changeAllStops(h.ctx, tx, saved, true))).rejects.toThrow(); expect((await row(a.hash)).killed).toBe(false);
  await h.ctx.db.update(keys).set({ management: true }).where(eq(keys.keyHash, owner.hash));
  const responses = await Promise.all([bulk(owner), bulk(owner)]); expect(await Promise.all(responses.map(async r => (await r.json()).data.count))).toEqual(expect.arrayContaining([0, 1]));
  expect((await events(a.hash)).filter(e => e.kind === "killed")).toHaveLength(1);
});

test("Telegram bulk presets, counts, idempotency, individually stopped Resume, help/menu and reply failure", async () => {
  const owner = await h.newKey(), a = await agent(owner), b = await agent(owner), tg = telegram(), uid = await link(tg, owner);
  await tg.bot.handleUpdate(message(uid, "/stopall@AnyrouteBot 1h")); expect(tg.replies().at(-1)).toBe("Stopped 2 agents for 1 hour."); expect((await row(a.hash)).killUntil!.getTime() - Date.now()).toBeGreaterThan(3_500_000);
  await tg.bot.handleUpdate(message(uid, "/stopall 1h")); expect(tg.replies().at(-1)).toBe("Stopped 0 agents for 1 hour.");
  await tg.bot.handleUpdate(message(uid, "/startall")); expect(tg.replies().at(-1)).toContain("Resumed 2 agents");
  await tg.bot.handleUpdate(message(uid, "/stopall tomorrow")); expect(tg.replies().at(-1)).toBe("Stopped 2 agents until 09:00 tomorrow UTC."); expect((await row(b.hash)).killUntil!.getUTCHours()).toBe(9);
  await tg.bot.handleUpdate(message(uid, "/startall")); await tg.bot.handleUpdate(message(uid, "/stopall resume-only")); expect((await row(a.hash)).killUntil).toBeNull();
  await tg.bot.handleUpdate(message(uid, "/startall")); await tg.bot.handleUpdate(message(uid, "/stopall 2h")); expect(tg.replies().at(-1)).toContain("Choose 1h"); expect((await row(a.hash)).killed).toBe(false);
  await tg.bot.handleUpdate(message(uid, "/startall unexpected")); expect(tg.replies().at(-1)).toContain("Send /startall");
  await tg.bot.handleUpdate(message(uid, "/stopall")); expect(tg.replies().at(-1)).toBe("Stopped 2 agents until you resume.");
  await tg.bot.handleUpdate(message(uid, "/help")); expect(tg.replies().at(-1)).toContain("/stopall");
  await tg.bot.poll(); expect(tg.calls.find(c => c.method === "setMyCommands")!.params.commands.map((c: any) => c.command)).toEqual(expect.arrayContaining(["stopall", "startall"]));
  const failing = new TelegramApi(TOKEN, (async () => { throw Error("transport unavailable"); }) as typeof fetch);
  expect(await handleAgentStopAll(h.ctx, failing, message(uid, "/startall"))).toBe(true); expect((await row(a.hash)).killed).toBe(false);
});

test("Telegram scope, team, revoked authority, unlinked chats, private identity and default-off guards", async () => {
  const owner = await h.newKey(), admin = await agent(owner), hidden = await agent(owner), tg = telegram(), uid = await link(tg, owner);
  await tg.bot.handleUpdate(message(++identity, "/stopall")); expect(tg.replies().at(-1)).toBe(LINK_FIRST);
  const count = tg.calls.length;
  for (const patch of [{ chat: { id: uid, type: "group" } }, { chat: { id: uid + 1, type: "private" } }, { from: { id: uid, is_bot: true } }]) { const u = message(uid, "/stopall"); u.message = { ...u.message!, ...patch }; await tg.bot.handleUpdate(u); }
  expect(tg.calls).toHaveLength(count);
  for (const patch of [{ scope: "read", management: false }, { scope: "inference", management: false }, { disabled: true }, { expiresAt: new Date(0) }]) {
    await h.ctx.db.update(keys).set(patch).where(eq(keys.keyHash, owner.hash));
    for (const command of ["/stopall", "/startall"]) { await tg.bot.handleUpdate(message(uid, command)); expect(tg.replies().at(-1)).toContain("unavailable"); }
    expect((await row(admin.hash)).killed).toBe(false);
    await h.ctx.db.update(keys).set({ scope: null, management: true, disabled: false, expiresAt: null }).where(eq(keys.keyHash, owner.hash));
  }
  const team = `bulk-tg-${++seq}`;
  for (const key of [owner, admin]) await h.ctx.db.update(keys).set({ teamId: team, management: false }).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: team, keyHash: owner.hash, role: "admin" });
  await tg.bot.handleUpdate(message(uid, "/stopall")); expect(tg.replies().at(-1)).toBe("Stopped 1 agent until you resume."); expect((await row(hidden.hash)).killed).toBe(false);
  await tg.bot.handleUpdate(message(uid, "/startall")); expect((await row(admin.hash)).killed).toBe(false);
  await tg.bot.handleUpdate(message(uid, "/unlink")); await tg.bot.handleUpdate(message(uid, "/stopall")); expect(tg.replies().at(-1)).toBe(LINK_FIRST);
  expect(loadConfig({ ANYROUTE_ENV: "test" }).agentPolicyEnabled).toBe(false);
  expect(await handleAgentStopAll(off.ctx, tg.api, message(uid, "/stopall"))).toBe(false);
  expect(await handleAgentStopAll({ ...h.ctx, cfg: { ...h.ctx.cfg, agentPolicyEnabled: false } }, tg.api, message(uid, "/startall"))).toBe(false);
});

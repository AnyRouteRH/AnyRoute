// K195: real Stop events, scoped routes and existing notification channels in both database modes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, like, sql } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { accounts, keys, kv } from "../src/db/schema.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { eventJson, verifyEventChain } from "../src/agents/store.ts";
import { loadConfig } from "../src/config.ts";
import { pauseKey, readPause, registerLowBalancePauseJob, runLowBalancePause, RESUME_ALL_HREF } from "../src/account/low-balance-pause.ts";
import { readPreferences, savePreferences } from "../src/notifications/prefs.ts";
import { flushQuietNotifications } from "../src/notifications/telegram.ts";
import { noticeFeatureEnabled } from "../src/notifications/config.ts";
const PATH = "/api/v1/account/low-balance-pause", USD = 1_000_000_000_000n;
type Owner = Awaited<ReturnType<Harness["newKey"]>>;
let h: Harness, off: Harness, identity = 195000;
beforeAll(async () => {
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", LOW_BALANCE_PAUSE_ENABLED: "true", LOW_BALANCE_ALERTS_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456789:AAFixtureTokenFixtureToken0123456789", NOTIFICATION_QUIET_HOURS_ENABLED: "true", SECURITY_ALERTS_ENABLED: "true", READ_ONLY_KEYS_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true" } });
  off = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } });
});
afterAll(async () => { await h?.close(); await off?.close(); });
const caller = async (owner: Owner) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash)))[0]!;
const balance = async (owner: Owner, dollars: bigint) => h.ctx.db.update(accounts).set({ balance: dollars * USD }).where(eq(accounts.id, (await caller(owner)).accountId));
const setting = (owner: Owner, amount: unknown, router = h) => router.request(PATH, { method: "PATCH", headers: owner.auth, json: { low_balance_usd: amount } });
const row = async (hash: string) => (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, hash)))[0]!;
const events = async (hash: string) => (await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, hash)).orderBy(asc(agentPolicyEvents.id))).map(eventJson);
async function agent(owner: Owner) {
  const result = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Service agent" } })).json();
  expect((await h.request(`/api/v1/agents/${result.data.hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: {}, on_breach: "deny" } })).status).toBe(200);
  return { hash: result.data.hash as string, auth: { authorization: `Bearer ${result.key}` } };
}
async function notices(owner: { auth: Record<string, string> }, suffix = "") {
  const response = await h.request("/api/v1/inbox" + suffix, { headers: owner.auth }); expect(response.status).toBe(200);
  return (await response.json()).data.filter((item: any) => item.kind === "low_balance_pause");
}
async function fixture() { const owner = await h.newKey(), a = await agent(owner); await balance(owner, 10n); return { owner, a, account: (await caller(owner)).accountId }; }
async function link(owner: Owner) {
  const uid = ++identity, account = (await caller(owner)).accountId;
  await h.ctx.db.insert(kv).values({ key: `telegram-link:${uid}`, value: { account, key_hash: owner.hash, uid, generation: `generation-${uid}`, linked_at: new Date().toISOString() } });
  return uid;
}
function telegram(fail = false) {
  const calls: any[] = [];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); if (fail) throw Error("delivery unavailable"); return Response.json({ ok: true, result: { message_id: calls.length } }); }) as typeof fetch;
  return { calls, fetchImpl };
}

test("flag and account opt-in default off; disabled worker does not read storage or register", async () => {
  expect(loadConfig({ ANYROUTE_ENV: "test" }).lowBalancePauseEnabled).toBe(false);
  const owner = await off.newKey();
  expect(await (await off.request(PATH, { headers: owner.auth })).json()).toEqual({ low_balance_usd: null, enabled: false });
  expect((await setting(owner, 5, off)).status).toBe(403);
  expect(await runLowBalancePause({ ...off.ctx, db: null as any })).toEqual({ skipped: true });
  const disabledPolicy = { ...h.ctx, cfg: { ...h.ctx.cfg, agentPolicyEnabled: false } };
  expect(await runLowBalancePause({ ...disabledPolicy, db: null as any })).toEqual({ skipped: true });
  expect(noticeFeatureEnabled(off.ctx, "low_balance_pause")).toBe(false);
  registerLowBalancePauseJob(off.ctx); registerLowBalancePauseJob(disabledPolicy); registerLowBalancePauseJob(h.ctx);
  expect(off.ctx.jobs.status().some(job => job.name === "low-balance-pause")).toBe(false);
  expect(h.ctx.jobs.status().find(job => job.name === "low-balance-pause")?.every_ms).toBe(60_000);
  const f = await fixture(); await balance(f.owner, 0n); await runLowBalancePause(h.ctx);
  expect((await row(f.a.hash)).killed).toBe(false); expect(await notices(f.owner)).toEqual([]);
});

test("routes require account management authority, reject missing/read/inference/team/session keys, and validate strict amounts", async () => {
  const { owner, a } = await fixture();
  for (const method of ["GET", "PATCH"]) {
    expect((await h.request(PATH, { method, json: method === "PATCH" ? { low_balance_usd: 5 } : undefined })).status).toBe(401);
    expect((await h.request(PATH, { method, headers: a.auth, json: method === "PATCH" ? { low_balance_usd: 5 } : undefined })).status).toBe(403);
  }
  for (const scope of ["read", "inference"]) {
    await h.ctx.db.update(keys).set({ scope, management: false }).where(eq(keys.keyHash, owner.hash));
    for (const method of ["GET", "PATCH"]) expect((await h.request(PATH, { method, headers: owner.auth, json: { low_balance_usd: 5 } })).status).toBe(403);
  }
  await h.ctx.db.update(keys).set({ scope: null, management: true }).where(eq(keys.keyHash, owner.hash));
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  for (const method of ["GET", "PATCH"]) expect((await h.request(PATH, { method, headers: { authorization: `Bearer ${session.key}` }, json: { low_balance_usd: 5 } })).status).toBe(403);
  for (const amount of [-1, 1_000_001, "5", {}, true]) expect((await setting(owner, amount)).status).toBe(400);
  expect((await h.request(PATH, { method: "PATCH", headers: owner.auth, json: { low_balance_usd: 5, extra: true } })).status).toBe(400);
  expect((await setting(owner, 5)).status).toBe(200);
  const response = await h.request(PATH, { headers: owner.auth }); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ low_balance_usd: 5, enabled: true });
  expect(await (await h.request(PATH, { headers: (await h.newKey()).auth })).json()).toEqual({ low_balance_usd: null, enabled: true });
  expect((await setting(owner, 0)).status).toBe(200); expect((await setting(owner, 1_000_000)).status).toBe(200); expect((await setting(owner, null)).status).toBe(200);
});

test("crossing uses Stop all events, until-resumed reasons, author and account isolation, and one notice across concurrent ticks", async () => {
  const { owner, a, account } = await fixture(), b = await agent(owner), foreign = await agent(await h.newKey());
  await setting(owner, 5); await runLowBalancePause(h.ctx); expect((await row(a.hash)).killed).toBe(false);
  await balance(owner, 4n); await Promise.all([runLowBalancePause(h.ctx), runLowBalancePause(h.ctx)]);
  for (const key of [a, b]) {
    expect(await row(key.hash)).toMatchObject({ killed: true, killUntil: null, killedReason: "Paused: balance below $5", updatedBy: owner.hash });
    const chain = await events(key.hash); expect(chain.filter(event => event.kind === "killed")).toHaveLength(1); expect(verifyEventChain(chain)).toBe(true);
    expect((await h.ctx.db.select().from(kv).where(eq(kv.key, `security-alerts:event:policy:${chain.at(-1)!.id}`)))[0]).toBeDefined();
  }
  expect((await row(foreign.hash)).killed).toBe(false);
  expect(await notices(owner)).toHaveLength(1); expect((await notices(owner))[0]).toMatchObject({ href: RESUME_ALL_HREF, amount: "4", title: "Paused: balance below $5. Resume all" });
  expect(await notices(a)).toEqual([]); expect(await notices(await h.newKey())).toEqual([]);
  expect(await notices(owner, "?kinds=agents")).toHaveLength(1); expect(await notices(owner, "?kinds=money")).toHaveLength(0);
  const page = await (await h.request("/api/v1/inbox", { headers: owner.auth })).json();
  expect(await notices(owner, "?since=" + encodeURIComponent(page.as_of))).toEqual([]);
  expect((await readPause(h.ctx.db, account)).notices[0]).toMatchObject({ actor: owner.hash, count: 2, threshold: (5n * USD).toString() });
});

test("same threshold and staying below never repeat, manual Resume stays resumed, equality does not re-arm, top-up above does", async () => {
  const { owner, a, account } = await fixture(); await setting(owner, 5); await balance(owner, 4n); await runLowBalancePause(h.ctx);
  await h.request("/api/v1/agents/resume-all", { method: "POST", headers: owner.auth });
  await setting(owner, 5); await runLowBalancePause(h.ctx); expect((await row(a.hash)).killed).toBe(false); expect(await notices(owner)).toHaveLength(1);
  await balance(owner, 5n); await runLowBalancePause(h.ctx); expect((await readPause(h.ctx.db, account)).alerted).toBe(true);
  await balance(owner, 4n); await runLowBalancePause(h.ctx); expect((await row(a.hash)).killed).toBe(false);
  await balance(owner, 6n); await runLowBalancePause(h.ctx); expect((await readPause(h.ctx.db, account)).alerted).toBe(false); expect((await row(a.hash)).killed).toBe(false);
  await balance(owner, 5n); await runLowBalancePause(h.ctx); expect((await row(a.hash)).killed).toBe(false);
  await balance(owner, 4n); await runLowBalancePause(h.ctx); expect((await row(a.hash)).killed).toBe(true); expect(await notices(owner)).toHaveLength(2);
  await setting(owner, null); await balance(owner, 10n); await runLowBalancePause(h.ctx); expect((await row(a.hash)).killed).toBe(true); expect(await notices(owner)).toHaveLength(2);
});

test("first check below pauses; timed Stops become indefinite through existing events and indefinite Stops retain original attribution", async () => {
  const { owner, a } = await fixture(), b = await agent(owner);
  await h.request(`/api/v1/agents/${a.hash}/kill`, { method: "POST", headers: owner.auth, json: { reason: "Scheduled break", until: new Date(Date.now() + 3_600_000).toISOString() } });
  await h.request(`/api/v1/agents/${b.hash}/kill`, { method: "POST", headers: owner.auth, json: { reason: "Manual Stop" } });
  await balance(owner, 4n); await setting(owner, 5); await runLowBalancePause(h.ctx);
  expect(await row(a.hash)).toMatchObject({ killed: true, killUntil: null, killedReason: "Paused: balance below $5", updatedBy: owner.hash });
  expect((await events(a.hash)).filter(event => event.kind === "killed")).toHaveLength(2); expect(verifyEventChain(await events(a.hash))).toBe(true);
  expect((await row(b.hash)).killedReason).toBe("Manual Stop"); expect((await events(b.hash)).filter(event => event.kind === "killed")).toHaveLength(1);
  expect(await notices(owner)).toHaveLength(1);
});

test("changing threshold starts another check, and empty accounts claim without notices", async () => {
  const owner = await h.newKey(), account = (await caller(owner)).accountId; await setting(owner, 5); await runLowBalancePause(h.ctx);
  expect((await readPause(h.ctx.db, account)).alerted).toBe(true); expect(await notices(owner)).toEqual([]);
  const a = await agent(owner); await runLowBalancePause(h.ctx); expect((await row(a.hash)).killed).toBe(false);
  await setting(owner, 6); await runLowBalancePause(h.ctx); expect((await row(a.hash)).killed).toBe(true); expect(await notices(owner)).toHaveLength(1);
});

test("worker revalidates disabled, expired and demoted setting authority", async () => {
  for (const patch of [{ disabled: true }, { expiresAt: new Date(0) }, { management: false }, { scope: "read", management: false }, { scope: "inference", management: false }]) {
    const { owner, a, account } = await fixture(); await setting(owner, 5); await balance(owner, 4n);
    await h.ctx.db.update(keys).set(patch).where(eq(keys.keyHash, owner.hash)); await runLowBalancePause(h.ctx);
    expect((await row(a.hash)).killed).toBe(false); expect((await readPause(h.ctx.db, account)).alerted).toBe(false);
    await h.ctx.db.update(keys).set({ disabled: false, expiresAt: null, management: true, scope: null }).where(eq(keys.keyHash, owner.hash));
    await setting(owner, null);
  }
});

test("Stop failure atomically rolls back all agents, events, crossing and notice", async () => {
  const { owner, a, account } = await fixture(), b = await agent(owner); await setting(owner, 5); await balance(owner, 4n);
  const last = [a.hash, b.hash].sort().at(-1)!;
  await h.ctx.db.execute(sql`create function k195_refuse_stop() returns trigger language plpgsql as $$ begin if NEW.key_hash = '${sql.raw(last)}' and NEW.killed then raise exception 'K195 write failure'; end if; return NEW; end $$`);
  await h.ctx.db.execute(sql`create trigger k195_stop_failure before update on agent_policies for each row execute function k195_refuse_stop()`);
  try { await expect(runLowBalancePause(h.ctx)).rejects.toThrow(); }
  finally { await h.ctx.db.execute(sql`drop trigger k195_stop_failure on agent_policies`); await h.ctx.db.execute(sql`drop function k195_refuse_stop()`); }
  for (const key of [a, b]) { expect((await row(key.hash)).killed).toBe(false); expect((await events(key.hash)).some(event => event.kind === "killed")).toBe(false); }
  expect((await readPause(h.ctx.db, account)).alerted).toBe(false); expect(await notices(owner)).toEqual([]);
  await setting(owner, null);
});

test("one Telegram notice uses only current linked management authority; no repeat after failed send or unlink", async () => {
  const { owner, account } = await fixture(), tg = telegram(); await link(owner); await setting(owner, 5); await balance(owner, 4n);
  await runLowBalancePause(h.ctx, tg.fetchImpl); expect(tg.calls).toHaveLength(1); expect(tg.calls[0].text).toContain("Paused: balance below $5"); expect(tg.calls[0].text).toContain(RESUME_ALL_HREF);
  await runLowBalancePause(h.ctx, tg.fetchImpl); expect(tg.calls).toHaveLength(1);
  await h.request("/api/v1/agents/resume-all", { method: "POST", headers: owner.auth }); await setting(owner, 6);
  const failing = telegram(true); await runLowBalancePause(h.ctx, failing.fetchImpl); expect(failing.calls).toHaveLength(1);
  await runLowBalancePause(h.ctx, tg.fetchImpl); expect(tg.calls).toHaveLength(1); expect((await readPause(h.ctx.db, account)).notices).toHaveLength(2);
  await setting(owner, null);
  const unlinked = await fixture(), never = telegram(); await setting(unlinked.owner, 5); await balance(unlinked.owner, 4n);
  await runLowBalancePause(h.ctx, never.fetchImpl); expect(never.calls).toEqual([]);
  const scoped = await fixture(), uid = await link(scoped.owner), child = await agent(scoped.owner);
  await h.ctx.db.update(kv).set({ value: { account: scoped.account, key_hash: child.hash, uid, generation: "scoped-generation", linked_at: new Date().toISOString() } }).where(eq(kv.key, `telegram-link:${uid}`));
  await setting(scoped.owner, 5); await balance(scoped.owner, 4n); await runLowBalancePause(h.ctx, never.fetchImpl); expect(never.calls).toEqual([]);
});

test("notice switches mute channels without blocking Stops; quiet hours queue and feature flag pauses delayed delivery", async () => {
  const { owner, a, account } = await fixture(), tg = telegram(); await link(owner);
  const prefs = await readPreferences(h.ctx.db, account); prefs.channels.low_balance_pause = { inbox: false, telegram: false }; await savePreferences(h.ctx.db, account, prefs);
  await setting(owner, 5); await balance(owner, 4n); await runLowBalancePause(h.ctx, tg.fetchImpl);
  expect((await row(a.hash)).killed).toBe(true); expect(await notices(owner)).toEqual([]); expect(tg.calls).toEqual([]);
  await h.request("/api/v1/agents/resume-all", { method: "POST", headers: owner.auth });
  const clock = (date: Date) => date.toISOString().slice(11, 16), now = new Date();
  prefs.channels.low_balance_pause = { inbox: true, telegram: true }; prefs.quiet_hours = { from_utc: clock(new Date(now.getTime() - 60_000)), to_utc: clock(new Date(now.getTime() + 3_600_000)) }; await savePreferences(h.ctx.db, account, prefs);
  await setting(owner, 6); await runLowBalancePause(h.ctx, tg.fetchImpl); expect(tg.calls).toEqual([]); expect(await notices(owner)).toHaveLength(2);
  const queued = await h.ctx.db.select().from(kv).where(like(kv.key, "notification-quiet:%")); expect(queued.some(item => (item.value as any).type === "low_balance_pause")).toBe(true);
  prefs.quiet_hours = null; await savePreferences(h.ctx.db, account, prefs);
  const flagOff = { ...h.ctx, cfg: { ...h.ctx.cfg, lowBalancePauseEnabled: false } };
  await flushQuietNotifications(flagOff, tg.fetchImpl, new Date(now.getTime() + 7_200_000)); expect(tg.calls).toEqual([]);
  await flushQuietNotifications(h.ctx, tg.fetchImpl, new Date(now.getTime() + 7_200_000)); expect(tg.calls).toHaveLength(1); expect(tg.calls[0].text).toContain("Paused: balance below $6");
  expect((await h.ctx.db.select().from(kv).where(eq(kv.key, pauseKey(account))))[0]).toBeDefined();
});

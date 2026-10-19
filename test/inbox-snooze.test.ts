// K187: runs with PGlite and with dedicated Postgres/Redis services.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { keys, kv, ledger } from "../src/db/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { inboxScope } from "../src/inbox/read.ts";
import { projectSnoozes, snoozeKey, snoozeReadSince, type Snooze } from "../src/inbox/snooze.ts";
import { registerInboxSnooze, runInboxSnooze } from "../src/inbox/snooze-worker.ts";
import { linkKey, type Link } from "../src/telegram/linking.ts";
import { readPreferences, savePreferences } from "../src/notifications/prefs.ts";
let h: Harness, sequence = 0;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456789:AAFixtureTokenFixtureToken0123456789" } }); });
afterAll(async () => { await h?.close(); });
const path = (id: string) => "/api/v1/inbox/" + encodeURIComponent(id) + "/snooze";
async function fixture(approval = false) {
  const owner = await h.newKey(), [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  const id = `k187-${++sequence}`, at = new Date(Date.now() - 60_000), expiry = new Date(Date.now() + 600_000);
  if (approval) await h.ctx.db.insert(agentApprovals).values({ id, keyHash: key!.keyHash, requestedAt: at, expiresAt: expiry, intent: {}, intentHash: "intent", maxCostPico: 0n });
  else await h.ctx.db.insert(ledger).values({ id, accountId: key!.accountId, keyHash: key!.keyHash, kind: "deposit", amount: 1n, ref: id, createdAt: at });
  const page = await read(owner), item = page.data.find((row: any) => row.id.includes(id));
  expect(item).toBeDefined();
  const scope = await inboxScope(h.ctx, key!);
  return { ...owner, key: key!, item, expiry, storage: snoozeKey(key!.accountId, scope.seenScope, item.id) };
}
async function read(owner: { auth: Record<string, string> }, query = "") { const r = await h.request("/api/v1/inbox" + query, { headers: owner.auth }); expect(r.status).toBe(200); return r.json(); }
async function snooze(owner: Awaited<ReturnType<typeof fixture>>, until = new Date(Date.now() + 300_000).toISOString()) { return h.request(path(owner.item.id), { method: "POST", headers: owner.auth, json: { until } }); }
async function due(owner: Awaited<ReturnType<typeof fixture>>) { const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, owner.storage)); await h.ctx.db.update(kv).set({ value: { ...row!.value as Snooze, until: new Date(Date.now() - 1000).toISOString() } }).where(eq(kv.key, owner.storage)); }
async function linked(owner: Awaited<ReturnType<typeof fixture>>) {
  const link: Link = { uid: 187000 + ++sequence, account: owner.key.accountId, key_hash: owner.hash, generation: "generation", linked_at: new Date().toISOString() };
  await h.ctx.db.insert(kv).values({ key: linkKey(link.uid), value: link }); return link;
}
const enabled = () => ({ ...h.ctx, cfg: { ...h.ctx.cfg, inboxSnoozeRemindersEnabled: true } });
function telegram() { const calls: any[] = []; return { calls, fetch: (async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return Response.json({ ok: true, result: { message_id: calls.length } }); }) as typeof fetch }; }
test("snooze hides in normal/bell reads, combines with kind filters, and unsnooze returns unread after seen time", async () => {
  const owner = await fixture(), since = new Date(Date.now() - 10_000).toISOString();
  const response = await snooze(owner); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await read(owner)).data).toEqual([]);
  const sleeping = await read(owner, "?snoozed=true&kinds=money&since=" + encodeURIComponent(since));
  expect(sleeping.data).toHaveLength(1); expect(sleeping.data[0].snoozed_until).toBeDefined(); expect(sleeping.count).toBe(0); expect(sleeping.kind_counts.money).toBe(1);
  expect((await read(owner, "?snoozed=true&kinds=approvals")).data).toEqual([]);
  expect((await h.request(path(owner.item.id), { method: "DELETE", headers: owner.auth })).status).toBe(200);
  const awake = await read(owner, "?since=" + encodeURIComponent(since)); expect(awake.data[0]).toMatchObject({ id: owner.item.id, unread: true }); expect(awake.data[0].reminder_at).toBeDefined();
  expect((await read(owner, "?since=" + encodeURIComponent(awake.as_of))).data).toEqual([]);
  expect((await read(owner, "?snoozed=true")).data).toEqual([]);
});
test("a due notice reappears with a stable unread clock, with the worker off", async () => {
  const owner = await fixture(); await snooze(owner); await due(owner);
  const since = new Date(Date.now() - 10_000).toISOString(), first = await read(owner, "?since=" + encodeURIComponent(since));
  expect(first.data[0]).toMatchObject({ id: owner.item.id, unread: true }); expect(first.count).toBe(1);
  expect((await read(owner, "?since=" + encodeURIComponent(since))).data[0].at).toBe(first.data[0].at);
  expect(h.ctx.cfg.inboxSnoozeRemindersEnabled).toBe(false); registerInboxSnooze(h.ctx);
  expect(h.ctx.jobs.status().some(job => job.name === "inbox-snooze")).toBe(false);
  expect(await runInboxSnooze(h.ctx)).toEqual({ attempted: 0, skipped: "disabled" });
});
test("approvals cap at expiry, explain the cap, and decided requests are never restored", async () => {
  const owner = await fixture(true), r = await snooze(owner, new Date(Date.now() + 3_600_000).toISOString());
  expect(await r.json()).toMatchObject({ until: owner.expiry.toISOString(), capped: true, message: expect.stringContaining("expiry") });
  await due(owner); const since = new Date(Date.now() - 10_000).toISOString();
  expect((await read(owner, "?since=" + encodeURIComponent(since))).data[0]).toMatchObject({ kind: "approval", unread: true, can_decide: true });
  await h.ctx.db.update(agentApprovals).set({ status: "denied" }).where(eq(agentApprovals.id, owner.item.approval_id));
  expect((await read(owner)).data).toEqual([]);
});
test("auth, ordinary-key scopes, read-only guard, malformed times and missing ids", async () => {
  const owner = await fixture(), other = await h.newKey(); await snooze(owner);
  for (const method of ["POST", "DELETE"]) expect((await h.request(path(owner.item.id), { method, json: { until: new Date(Date.now() + 10000).toISOString() } })).status).toBe(401);
  expect((await snooze({ ...owner, auth: other.auth })).status).toBe(404);
  await h.request(path(owner.item.id), { method: "DELETE", headers: other.auth }); expect((await read(owner)).data).toEqual([]);
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Notice reader" } })).json();
  const childAuth = { authorization: "Bearer " + child.key };
  expect((await h.request(path(owner.item.id), { method: "POST", headers: childAuth, json: { until: new Date(Date.now() + 10000).toISOString() } })).status).toBe(404);
  await h.ctx.db.update(keys).set({ scope: "read" }).where(eq(keys.keyHash, child.data.hash));
  for (const method of ["POST", "DELETE"]) expect((await h.request(path(owner.item.id), { method, headers: childAuth, json: { until: new Date(Date.now() + 10000).toISOString() } })).status).toBe(403);
  // Existing read-only principals deliberately inherit their owner’s read visibility.
  expect((await read({ auth: childAuth }, "?snoozed=true")).data[0].id).toBe(owner.item.id);
  for (const until of ["bad", new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 31 * 86400000).toISOString()]) expect((await snooze(owner, until)).status).toBe(400);
  expect((await h.request(path("absent"), { method: "POST", headers: owner.auth, json: { until: new Date(Date.now() + 10000).toISOString() } })).status).toBe(404);
  expect((await h.request("/api/v1/inbox?snoozed=wrong", { headers: owner.auth })).status).toBe(400);
});
test("Telegram sends one short reminder only to a current authorized link and claims across ticks", async () => {
  const owner = await fixture(true), link = await linked(owner), tg = telegram(); await snooze(owner); await due(owner);
  const results = await Promise.all([runInboxSnooze(enabled(), tg.fetch), runInboxSnooze(enabled(), tg.fetch)]);
  expect(results.reduce((sum, row) => sum + row.attempted, 0)).toBe(1);
  expect(tg.calls).toHaveLength(1); expect(tg.calls[0]).toMatchObject({ chat_id: link.uid, text: "Reminder: Approve an agent request" });
  await runInboxSnooze(enabled(), tg.fetch); expect(tg.calls).toHaveLength(1);
});
test("ordinary-key snoozes can remind an authorized linked owner without widening the key's inbox", async () => {
  const owner = await fixture(true); await linked(owner);
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Notice agent" } })).json();
  const id = "k187-child-" + ++sequence;
  await h.ctx.db.insert(agentApprovals).values({ id, keyHash: child.data.hash, requestedAt: new Date(), expiresAt: new Date(Date.now() + 600_000), intent: {}, intentHash: "intent", maxCostPico: 0n });
  const auth = { authorization: "Bearer " + child.key }, page = await read({ auth }); expect(page.data.map((item: any) => item.id)).toEqual(["approval:" + id]);
  expect((await h.request(path("approval:" + id), { method: "POST", headers: auth, json: { until: new Date(Date.now() + 10_000).toISOString() } })).status).toBe(200);
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, child.data.hash));
  const storage = snoozeKey(owner.key.accountId, (await inboxScope(h.ctx, key!)).seenScope, "approval:" + id);
  await due({ ...owner, storage }); const tg = telegram(); await runInboxSnooze(enabled(), tg.fetch);
  expect(tg.calls).toHaveLength(1); expect(tg.calls[0].text).toBe("Reminder: Approve an agent request");
});
test("Telegram respects original/new switches, no link, revoked principal, and manual unsnooze", async () => {
  for (const mode of ["source", "reminder", "unlinked", "revoked", "unsnooze"]) {
    const owner = await fixture(true), tg = telegram(); if (mode !== "unlinked") await linked(owner);
    await snooze(owner); await due(owner);
    const prefs = await readPreferences(h.ctx.db, owner.key.accountId);
    if (mode === "source") prefs.channels.approvals.telegram = false;
    if (mode === "reminder") prefs.channels.inbox_snooze.telegram = false;
    await savePreferences(h.ctx.db, owner.key.accountId, prefs);
    if (mode === "revoked") await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owner.hash));
    if (mode === "unsnooze") await h.request(path(owner.item.id), { method: "DELETE", headers: owner.auth });
    await runInboxSnooze(enabled(), tg.fetch); expect(tg.calls).toHaveLength(0);
  }
});
test("approval reminders wait through quiet hours, then recheck switches; API workers stay off", async () => {
  const owner = await fixture(true), tg = telegram(); await linked(owner); await snooze(owner); await due(owner);
  const prefs = await readPreferences(h.ctx.db, owner.key.accountId), now = new Date();
  const clock = (hour: number) => String((hour + 24) % 24).padStart(2, "0") + ":00";
  prefs.quiet_hours = { from_utc: clock(now.getUTCHours()), to_utc: clock(now.getUTCHours() + 2) }; await savePreferences(h.ctx.db, owner.key.accountId, prefs);
  await runInboxSnooze(enabled(), tg.fetch); expect(tg.calls).toHaveLength(0);
  const [saved] = await h.ctx.db.select().from(kv).where(eq(kv.key, owner.storage)); expect((saved!.value as Snooze).claimed).toBe(false);
  prefs.quiet_hours = null; await savePreferences(h.ctx.db, owner.key.accountId, prefs);
  await runInboxSnooze(enabled(), tg.fetch); expect(tg.calls).toHaveLength(1);
  expect(await runInboxSnooze({ ...enabled(), cfg: { ...enabled().cfg, runtimeRole: "api" } }, tg.fetch)).toEqual({ attempted: 0, skipped: "disabled" });
});
test("projection preserves unrelated seen filtering and wake opt-out", () => {
  const record: Snooze = { account: "account", scope: "scope", principal: "principal", id: "notice", at: "2026-10-01T10:00:00.000Z", until: "2026-10-01T12:00:00.000Z", created: "2026-10-01T10:00:00.000Z", claimed: false };
  expect(snoozeReadSince("2026-10-01T11:00:00.000Z", [record])).toBe("2026-10-01T09:59:59.999Z");
  const data = [{ id: "notice", kind: "deposit", at: record.at, unread: true }, { id: "other", kind: "deposit", at: record.at, unread: true }];
  projectSnoozes(data, [record], "2026-10-01T11:00:00.000Z", "2026-10-01T13:00:00.000Z", false); expect(data).toHaveLength(1); expect(data[0]!.at).toBe(record.until);
  const muted = [{ id: "notice", kind: "deposit", at: record.at, unread: true }]; projectSnoozes(muted, [record], "2026-10-01T11:00:00.000Z", "2026-10-01T13:00:00.000Z", false, false); expect(muted).toEqual([]);
  const precise = [{ id: "other", kind: "deposit", at: "2026-10-01T11:00:00.000123Z", unread: true }]; projectSnoozes(precise, [record], "2026-10-01T11:00:00.000Z", "2026-10-01T13:00:00.000Z", false); expect(precise).toHaveLength(1);
});

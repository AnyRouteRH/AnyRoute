// G164: runs against both real services and single-connection in-process PostgreSQL.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { keys, kv } from "../src/db/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { nudgeDue, nudgeWindow, nudgeTitle, nudgeKey, registerApprovalNudges, runApprovalNudges } from "../src/agents/approval-nudges.ts";
import { consumeCode, removeLink } from "../src/telegram/linking.ts";
import { deliverTelegramApprovals, handleLinkedUpdate } from "../src/telegram/delivery.ts";
import { TelegramApi, type TgUpdate } from "../src/services/telegram.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import type { Preferences } from "../src/notifications/prefs.ts";
let h: Harness, uid = 164000;
const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
const env = { AGENT_POLICY_ENABLED: "true", APPROVAL_NUDGES_ENABLED: "true", AGENT_TEAM_APPROVERS_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN, NOTIFICATION_QUIET_HOURS_ENABLED: "true" };
type Key = { hash: string; auth: Record<string, string> };
beforeAll(async () => { h = await startRouter({ env }); });
afterAll(async () => { await h?.close(); });
afterEach(async () => { if (h) { await h.ctx.db.delete(agentApprovals); await h.ctx.db.delete(kv).where(like(kv.key, "approval-nudged:%")); } });
function telegram(fail = false) {
  const calls: { method: string; body: any }[] = [];
  const fetch = (async (url: unknown, init: RequestInit) => { calls.push({ method: String(url).split("/").at(-1)!, body: JSON.parse(init.body as string) }); return Response.json(fail ? { ok: false, error_code: 429 } : { ok: true, result: { message_id: calls.length } }); }) as typeof globalThis.fetch;
  return { calls, fetch, sends: () => calls.filter(c => c.method === "sendMessage") };
}
async function fixture() {
  const owner = await h.fundedKey();
  const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Approval team" } })).json()).data.id;
  const create = async (role: string): Promise<Key> => {
    const response = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { team, role, name: `Review ${role}` } });
    expect(response.status).toBe(201); const { data, key } = await response.json(); return { hash: data.hash, auth: { authorization: `Bearer ${key}` } };
  };
  return { owner, agent: await create("agent"), admin: await create("admin"), member: await create("member"), create };
}
async function linked(key: Key) {
  const response = await h.request("/api/v1/telegram/link", { method: "POST", headers: key.auth }); expect(response.status).toBe(200);
  return consumeCode(h.ctx, ++uid, (await response.json()).data.code);
}
async function pending(key: Key, remaining = 9 * 60_000, lifetime = 60 * 60_000, status: "pending" | "denied" = "pending", decided = false) {
  const now = Date.now(), id = randomBytes(18).toString("base64url");
  await h.ctx.db.insert(agentApprovals).values({ id, keyHash: key.hash, intent: { kind: "inference", model: MODELS.llama.slug, lane: "public", tools: [], est_cost_pico: "1000" }, intentHash: id, maxCostPico: 1000n, requestedAt: new Date(now + remaining - lifetime), expiresAt: new Date(now + remaining), status, decidedAt: decided ? new Date(now) : null });
  return id;
}
async function inbox(key: Key) { const response = await h.request("/api/v1/inbox", { headers: key.auth }); expect(response.status).toBe(200); return (await response.json()).data; }
async function prefs(key: Key): Promise<Preferences> { return (await (await h.request("/api/v1/account/notifications", { headers: key.auth })).json()).data; }
async function save(key: Key, value: Preferences) { expect((await h.request("/api/v1/account/notifications", { method: "PUT", headers: key.auth, json: { channels: value.channels, quiet_hours: value.quiet_hours } })).status).toBe(200); }
async function marker(id: string) { return (await h.ctx.db.select().from(kv).where(eq(kv.key, nudgeKey(id))))[0]; }
async function configure(f: Awaited<ReturnType<typeof fixture>>, mode: string, ids: string[] = []) { expect((await h.request(`/api/v1/agents/${f.agent.hash}/approvers`, { method: "PUT", headers: f.owner.auth, json: { mode, member_ids: ids } })).status).toBe(200); }

test("timing uses shorter of ten minutes and one fifth, minimum two, pending undecided only", () => {
  expect(nudgeWindow(3600_000)).toBe(600_000); expect(nudgeWindow(900_000)).toBe(180_000); expect(nudgeWindow(300_000)).toBe(120_000);
  const now = new Date("2026-10-12T12:00Z");
  const row = { status: "pending", decidedAt: null, requestedAt: new Date(now.getTime() - 720_000), expiresAt: new Date(now.getTime() + 180_000) };
  expect(nudgeDue(row, now)).toBe(true); expect(nudgeDue(row, new Date(now.getTime() - 1))).toBe(false);
  expect(nudgeDue({ ...row, expiresAt: now }, now)).toBe(false);
  expect(nudgeDue({ ...row, status: "approved" }, now)).toBe(false); expect(nudgeDue({ ...row, decidedAt: now }, now)).toBe(false);
  expect(nudgeTitle(new Date(now.getTime() + 540_000), now)).toBe("Expires in 9 minutes"); expect(nudgeTitle(new Date(now.getTime() + 1), now)).toBe("Expires in 1 minute");
});
test("off/default and API-only workers are absent and never access the database", async () => {
  expect(loadConfig({}).approvalNudgesEnabled).toBe(false);
  expect(() => loadConfig({ APPROVAL_NUDGES_ENABLED: "true" })).toThrow(/requires AGENT_POLICY_ENABLED/);
  expect(loadConfig({ ...env, RUNTIME_ROLE: "worker", WORKER_JOBS: "approval-nudges" }).workerJobs).toEqual(["approval-nudges"]);
  for (const cfg of [{ ...h.ctx.cfg, approvalNudgesEnabled: false }, { ...h.ctx.cfg, agentPolicyEnabled: false }, { ...h.ctx.cfg, runtimeRole: "api" as const }]) {
    const ctx = { ...h.ctx, cfg, db: null as any }, names: string[] = [];
    expect(await runApprovalNudges(ctx)).toEqual({ nudged: 0, sent: 0, skipped: "disabled" });
    registerApprovalNudges({ ...ctx, jobs: { register: (name: string) => names.push(name) } } as any); expect(names).toEqual([]);
  }
  const names: string[] = []; registerApprovalNudges({ ...h.ctx, jobs: { register: (name: string) => names.push(name) } } as any); expect(names).toEqual(["approval-nudges"]);
});
test("concurrent ticks claim once, send once, highlight one existing row and preserve single-use buttons", async () => {
  const f = await fixture(), link = await linked(f.owner), tg = telegram(), id = await pending(f.agent);
  await deliverTelegramApprovals(h.ctx, new TelegramApi(TOKEN, tg.fetch)); expect(tg.sends()).toHaveLength(1);
  const original = tg.sends()[0].body;
  const results = await Promise.all([runApprovalNudges(h.ctx, tg.fetch), runApprovalNudges(h.ctx, tg.fetch), runApprovalNudges(h.ctx, tg.fetch)]);
  expect(results.reduce((sum, r) => sum + r.nudged, 0)).toBe(1); expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(1); expect(tg.sends()).toHaveLength(2);
  const reminder = tg.sends()[1].body; expect(reminder.text).toStartWith("Expires in 9 minutes\n"); expect(reminder.reply_markup).toEqual(original.reply_markup); expect(reminder.text).not.toContain('{"');
  expect(await marker(id)).toBeDefined(); expect(await runApprovalNudges(h.ctx, tg.fetch)).toEqual({ nudged: 0, sent: 0 });
  const items = (await inbox(f.owner)).filter((r: any) => r.approval_id === id); expect(items).toHaveLength(1); expect(items[0].title).toBe("Expires in 9 minutes");
  expect((await inbox(f.agent)).find((r: any) => r.approval_id === id)?.title).toBe("Approve an agent request");
  const callback = (message: number, action: number): TgUpdate => ({ update_id: action, callback_query: { id: String(action), from: { id: link.uid }, data: reminder.reply_markup.inline_keyboard[0][0].callback_data, message: { message_id: message, chat: { id: link.uid, type: "private" } } } } as TgUpdate);
  await handleLinkedUpdate(h.ctx, new TelegramApi(TOKEN, tg.fetch), callback(2, 1));
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0].status).toBe("approved");
  await handleLinkedUpdate(h.ctx, new TelegramApi(TOKEN, tg.fetch), callback(1, 2)); expect(tg.calls.at(-1)!.body.text).toBe("Approval is no longer pending.");
  expect((await inbox(f.owner)).some((r: any) => r.approval_id === id)).toBe(false);
});
test("decided, expired and early approvals are skipped; expiry cleans claims", async () => {
  const f = await fixture();
  for (const id of [await pending(f.agent, 11 * 60_000), await pending(f.agent, -1), await pending(f.agent, 60_000, 900_000, "denied", true), await pending(f.agent, 60_000, 900_000, "pending", true)]) {
    await runApprovalNudges(h.ctx, telegram().fetch); expect(await marker(id)).toBeUndefined();
  }
  const id = await pending(f.agent); await runApprovalNudges(h.ctx, telegram().fetch); expect(await marker(id)).toBeDefined();
  await runApprovalNudges(h.ctx, telegram().fetch, new Date(Date.now() + 3600_000)); expect(await marker(id)).toBeUndefined();
});
test("channel preferences default on, mute independently and quiet hours never defer reminders", async () => {
  const f = await fixture(), tg = telegram(); await linked(f.owner); const value = await prefs(f.owner);
  expect(value.channels.approval_reminders).toEqual({ inbox: true, telegram: true });
  value.channels.approval_reminders = { inbox: false, telegram: false }; value.quiet_hours = { from_utc: "00:00", to_utc: "23:59" }; await save(f.owner, value);
  const muted = await pending(f.agent); await runApprovalNudges(h.ctx, tg.fetch); expect(tg.sends()).toHaveLength(0); expect((await inbox(f.owner)).find((r: any) => r.approval_id === muted).title).toBe("Approve an agent request");
  value.channels.approval_reminders = { inbox: true, telegram: false }; await save(f.owner, value); expect((await inbox(f.owner)).find((r: any) => r.approval_id === muted).title).toBe("Expires in 9 minutes");
  value.channels.approval_reminders = { inbox: false, telegram: true }; await save(f.owner, value);
  await pending(f.agent); await runApprovalNudges(h.ctx, tg.fetch); expect(tg.sends()).toHaveLength(1);
  expect(await h.ctx.db.select().from(kv).where(like(kv.key, "notification-quiet:%"))).toHaveLength(0);
});
test("only current delegated decision makers receive a reminder or inbox highlight", async () => {
  const f = await fixture(), tg = telegram(); const ownerLink = await linked(f.owner); await configure(f, "owners_and_admins"); const adminLink = await linked(f.admin);
  await configure(f, "specific_members", [f.member.hash]); const memberLink = await linked(f.member), id = await pending(f.agent);
  await runApprovalNudges(h.ctx, tg.fetch); expect(tg.sends().map(c => c.body.chat_id).sort()).toEqual([memberLink.uid, ownerLink.uid].sort());
  expect((await inbox(f.member)).find((r: any) => r.approval_id === id).title).toBe("Expires in 9 minutes");
  expect((await inbox(f.admin)).find((r: any) => r.approval_id === id).title).toBe("Approve an agent request");
  await configure(f, "owners"); expect((await inbox(f.member)).some((r: any) => r.approval_id === id)).toBe(false);
  const stranger = await h.fundedKey(); expect((await inbox(stranger)).some((r: any) => r.approval_id === id)).toBe(false);
});
test("team delegation off keeps owner/admin guards; revoked links and read keys cannot decide", async () => {
  const f = await fixture(), tg = telegram(); await linked(f.owner); const admin = await linked(f.admin);
  const id = await pending(f.agent); await runApprovalNudges({ ...h.ctx, cfg: { ...h.ctx.cfg, agentTeamApproversEnabled: false } }, tg.fetch); expect(tg.sends()).toHaveLength(2);
  await removeLink(h.ctx, admin.uid); await pending(f.agent); await runApprovalNudges(h.ctx, tg.fetch); expect(tg.sends()).toHaveLength(3);
  const response = await h.request("/api/v1/keys", { method: "POST", headers: f.owner.auth, json: { name: "Read account", scope: "read" } }); expect(response.status).toBe(201);
  const auth = { authorization: `Bearer ${(await response.json()).key}` };
  expect((await h.request(`/api/v1/agents/approvals/${id}/approve`, { method: "POST", headers: auth })).status).toBe(403);
  const readInbox = await h.request("/api/v1/inbox", { headers: auth }); expect(readInbox.status).toBe(200); expect((await readInbox.json()).data.every((row: any) => !row.title.startsWith("Expires in"))).toBe(true);
});
test("failed sends are attempted once and flags off preserve inbox titles", async () => {
  const f = await fixture(), tg = telegram(true); await linked(f.owner); const id = await pending(f.agent);
  await runApprovalNudges(h.ctx, tg.fetch); const count = tg.sends().length; expect(count).toBe(1); await runApprovalNudges(h.ctx, tg.fetch); expect(tg.sends()).toHaveLength(count);
  const enabled = h.ctx.cfg.approvalNudgesEnabled; h.ctx.cfg.approvalNudgesEnabled = false;
  try { expect((await inbox(f.owner)).find((r: any) => r.approval_id === id).title).toBe("Approve an agent request"); } finally { h.ctx.cfg.approvalNudgesEnabled = enabled; }
  expect((await h.request("/api/v1/inbox")).status).toBe(401); expect((await h.request("/api/v1/account/notifications", { method: "PUT", json: {} })).status).toBe(401);
});

// K186: run unchanged with real services or plain bun test's single-connection database.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { decisionNote } from "../src/agents/decision-notes.ts";
import { eventJson, verifyEventChain } from "../src/agents/store.ts";
import { keys, kv } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { consumeCode, readLink } from "../src/telegram/linking.ts";
import { deliverTelegramApprovals, notificationKey } from "../src/telegram/delivery.ts";
import { NOTE_PROMPT } from "../src/telegram/approval-notes.ts";
import { TelegramApi, TelegramBot, type TgUpdate } from "../src/services/telegram.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
let h: Harness;
const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
type Key = { hash: string; auth: Record<string, string> };
const policy = { version: 1, models: {}, caps: {}, approval: { above_usd: 0.000000001 }, on_breach: "deny" };
const inference = { model: MODELS.llama.slug, messages: [{ role: "user", content: "request-content-sentinel" }], max_tokens: 32, provider: { only: ["alpha"] } };
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_TEAM_APPROVERS_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_APPROVAL_NOTES_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN, SECURITY_ALERTS_ENABLED: "true" } }); }, 60_000);
afterAll(async () => { await h?.close(); });
async function child(owner: Key, options = {}) {
  const response = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Review agent", ...options } });
  expect(response.status).toBe(201); const body = await response.json();
  return { hash: body.data.hash, auth: { authorization: `Bearer ${body.key}` } };
}
async function waiting(owner: Key, agent: Key) {
  expect((await h.request(`/api/v1/agents/${agent.hash}/policy`, { method: "PUT", headers: owner.auth, json: policy })).status).toBe(200);
  const response = await call(agent); expect(response.status).toBe(403);
  return (await response.json()).error.metadata.approval_id as string;
}
const call = (agent: Key, id?: string) => h.request("/api/v1/chat/completions", { method: "POST", headers: { ...agent.auth, ...(id ? { "x-agent-approval": id } : {}) }, json: inference });
const poll = async (agent: Key, id: string) => (await (await h.request(`/api/v1/agents/approvals/${id}`, { headers: agent.auth })).json()).data;
const row = async (id: string) => (await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0];
const decide = (who: Key | undefined, id: string, action: string, note?: unknown) => h.request(`/api/v1/agents/approvals/${id}/${action}`, { method: "POST", headers: who?.auth, ...(note === undefined ? {} : { json: { decision_note: note } }) });

test("note validation handles empty text, Unicode length, plain text and invalid values", () => {
  for (const value of [undefined, null, "", " \n "]) expect(decisionNote(value)).toBeNull();
  expect(decisionNote("  <b>Check this</b>\nThen stop.  ")).toBe("<b>Check this</b>\nThen stop.");
  expect(decisionNote("😀".repeat(280))).toBe("😀".repeat(280));
  for (const value of [false, 42, {}, [], "a".repeat(281), "😀".repeat(281), "hidden\u0000text"]) expect(() => decisionNote(value)).toThrow("plain text up to 280");
});
for (const surface of ["agents", "inbox"]) for (const action of ["approve", "deny"]) for (const withNote of [false, true]) {
  test(`${surface}: ${action} ${withNote ? "with" : "without"} a note reaches the agent and attributed history`, async () => {
    const owner = await h.fundedKey(), agent = await child(owner), id = await waiting(owner, agent);
    const note = withNote ? "Check the recipient before trying again. <plain text>" : undefined;
    if (surface === "inbox") {
      const inbox = await (await h.request("/api/v1/inbox", { headers: owner.auth })).json();
      expect(inbox.data.find((item: any) => item.approval_id === id)).toMatchObject({ can_decide: true });
    }
    const result = await decide(owner, id, action, note); expect(result.status).toBe(200);
    const data = (await result.json()).data;
    expect(data.decided_by).toBe(owner.hash); expect(data.status).toBe(action === "deny" ? "denied" : "approved");
    const status = await poll(agent, id);
    expect(status.decision_note).toBe(note);
    expect(data.decision_note).toBe(note);
    const listed = await (await h.request(`/api/v1/agents/approvals?status=${data.status}`, { headers: owner.auth })).json();
    expect(listed.data.find((item: any) => item.id === id)?.decision_note).toBe(note);
    const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, agent.hash)).orderBy(asc(agentPolicyEvents.id));
    const event = events.find(event => event.kind === `approval_${data.status}`)!;
    expect(event.reasons).toEqual(note ? [{ code: "decision_note", message: note }] : []);
    expect(verifyEventChain(events.map(eventJson))).toBe(true);
    if (action === "deny") {
      const refused = await call(agent, id); expect(refused.status).toBe(403);
      const error = (await refused.json()).error;
      expect(error.metadata?.decision_note).toBe(note);
      if (note) { expect(error.message).toBe(`Denied by your owner: ${note}`); expect(status.message).toBe(error.message); }
      else expect(status).not.toHaveProperty("decision_note");
    } else expect((await call(agent, id)).status).toBe(200);
    expect((await decide(owner, id, "deny", "replacement")).status).toBe(409);
    if (note) {
      const activity = await (await h.request("/api/v1/activity?kind=approval", { headers: owner.auth })).json();
      expect(activity.data.find((item: any) => item.id === `approval:${id}`).title).toContain(note);
      const history = await h.request(`/api/v1/agents/${agent.hash}/events`, { headers: owner.auth });
      expect(history.status).toBe(200); expect(JSON.stringify(await history.json())).toContain(note);
    }
  });
}
test("decision auth, read-only and length guards apply before saving a note", async () => {
  const owner = await h.fundedKey(), agent = await child(owner), stranger = await h.fundedKey(), id = await waiting(owner, agent);
  for (const action of ["approve", "deny"]) {
    expect((await decide(undefined, id, action, "note")).status).toBe(401);
    expect((await decide(agent, id, action, "note")).status).toBe(403);
    expect((await decide(stranger, id, action, "note")).status).toBe(404);
    for (const note of ["a".repeat(281), "😀".repeat(281), { reason: "wrong type" }]) expect((await decide(owner, id, action, note)).status).toBe(400);
  }
  expect((await row(id)).status).toBe("pending"); expect((await row(id)).decisionNote).toBeNull();
  const read = await child(owner, { scope: "read" });
  expect((await decide(read, id, "deny", "not permitted")).status).toBe(403);
  expect((await h.request(`/api/v1/agents/approvals/${id}`, { headers: stranger.auth })).status).toBe(404);
  expect((await decide(owner, id, "approve", "😀".repeat(280))).status).toBe(200);
});
test("approve and allow next time keeps its confirmation and includes the same optional note", async () => {
  const owner = await h.fundedKey(), agent = await child(owner), id = await waiting(owner, agent), path = `/api/v1/agents/approvals/${id}/approve-and-allow`;
  const preview = await h.request(path, { headers: owner.auth }); expect(preview.status).toBe(200);
  const change = (await preview.json()).data;
  expect((await h.request(path, { method: "POST", headers: owner.auth, json: { policy_sha256: change.policy_sha256, decision_note: "a".repeat(281) } })).status).toBe(400);
  expect((await row(id)).status).toBe("pending");
  const result = await h.request(path, { method: "POST", headers: owner.auth, json: { policy_sha256: change.policy_sha256, decision_note: "This amount is fine." } });
  expect(result.status).toBe(200); expect((await result.json()).data.approval.decision_note).toBe("This amount is fine.");
  expect((await poll(agent, id)).decision_note).toBe("This amount is fine.");
});
let sequence = 91_000;
function telegram() {
  const calls: { method: string; params: any; id: number }[] = [];
  const fetch = (async (input: any, init: any) => {
    const method = String(input).split("/").at(-1)!, params = JSON.parse(init.body), id = ++sequence;
    calls.push({ method, params, id });
    return Response.json({ ok: true, result: { message_id: id } });
  }) as typeof globalThis.fetch;
  const api = new TelegramApi(TOKEN, fetch), bot = new TelegramBot(h.ctx, { token: TOKEN, fetch, router: (p, i) => h.app.request(p, i) });
  return { calls, api, bot };
}
async function linked(owner: Key) {
  const response = await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth }); expect(response.status).toBe(200);
  const uid = ++sequence; await consumeCode(h.ctx, uid, (await response.json()).data.code); return uid;
}
async function click(tg: ReturnType<typeof telegram>, uid: number, id: string, action: string) {
  const link = (await readLink(h.ctx.db, uid))!, [marker] = await h.ctx.db.select().from(kv).where(eq(kv.key, notificationKey(id, link)));
  await tg.bot.handleUpdate({ update_id: ++sequence, callback_query: { id: String(sequence), from: { id: uid }, data: `tg:${action === "deny" ? "d" : "a"}:${id}:${link.generation}`, message: { message_id: (marker.value as any).message_id, chat: { id: uid, type: "private" } } } });
}
function reply(uid: number, text: string, prompt?: { id: number }, otherId?: number): TgUpdate {
  return { update_id: ++sequence, message: { message_id: sequence, from: { id: uid }, chat: { id: uid, type: "private" }, text, ...(prompt ? { reply_to_message: { message_id: otherId ?? prompt.id, text: NOTE_PROMPT } } : {}) } } as TgUpdate;
}
for (const action of ["approve", "deny"]) for (const withNote of [false, true]) test(`Telegram ${action} ${withNote ? "with a reason" : "and skip"} saves once, before any model call`, async () => {
  const owner = await h.fundedKey(), agent = await child(owner), uid = await linked(owner), tg = telegram(), id = await waiting(owner, agent);
  await deliverTelegramApprovals(h.ctx, tg.api); await click(tg, uid, id, action);
  expect((await poll(agent, id)).status).toBe(action === "deny" ? "denied" : "approved");
  const prompt = tg.calls.find(call => call.params.chat_id === uid && call.params.text === NOTE_PROMPT)!; expect(prompt).toBeDefined();
  expect(prompt.params.reply_markup.force_reply).toBe(true);
  const before = h.mocks.alpha.stats.requests;
  const note = withNote ? "Review the recipient first." : undefined;
  await tg.bot.handleUpdate(reply(uid, note ?? "/skip", prompt));
  expect(h.mocks.alpha.stats.requests).toBe(before);
  expect((await poll(agent, id)).decision_note).toBe(note);
  await tg.bot.handleUpdate(reply(uid, "cannot overwrite", prompt));
  expect((await poll(agent, id)).decision_note).toBe(note);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, agent.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(events.filter(e => e.kind === "approval_note_added")).toHaveLength(withNote ? 1 : 0);
  expect(verifyEventChain(events.map(eventJson))).toBe(true);
});
test("Telegram rejects long, forged, expired, revoked and unlinked replies without sending text to a model", async () => {
  const owner = await h.fundedKey(), agent = await child(owner), uid = await linked(owner), tg = telegram(), id = await waiting(owner, agent);
  await deliverTelegramApprovals(h.ctx, tg.api); await click(tg, uid, id, "deny");
  const prompt = tg.calls.find(call => call.params.chat_id === uid && call.params.text === NOTE_PROMPT)!;
  const before = h.mocks.alpha.stats.requests;
  await tg.bot.handleUpdate(reply(uid, "x".repeat(281), prompt));
  expect((await row(id)).decisionNote).toBeNull(); expect(tg.calls.at(-1)!.params.text).toContain("280");
  await tg.bot.handleUpdate(reply(uid, "forged", prompt, -10)); expect((await row(id)).decisionNote).toBeNull();
  await tg.bot.handleUpdate(reply(uid + 1000, "wrong identity", prompt)); expect((await row(id)).decisionNote).toBeNull();
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owner.hash));
  await tg.bot.handleUpdate(reply(uid, "revoked", prompt)); expect((await row(id)).decisionNote).toBeNull();
  await h.ctx.db.update(keys).set({ disabled: false }).where(eq(keys.keyHash, owner.hash));
  const link = (await readLink(h.ctx.db, uid))!, markerKey = notificationKey(id, link), [marker] = await h.ctx.db.select().from(kv).where(eq(kv.key, markerKey));
  await h.ctx.db.update(kv).set({ value: { ...(marker.value as object), note_until: 0 } }).where(eq(kv.key, markerKey));
  await tg.bot.handleUpdate(reply(uid, "expired", prompt)); expect((await row(id)).decisionNote).toBeNull();
  expect((await h.request("/api/v1/telegram/link", { method: "DELETE", headers: owner.auth })).status).toBe(200);
  await tg.bot.handleUpdate(reply(uid, "unlinked", prompt)); expect((await row(id)).decisionNote).toBeNull();
  expect(h.mocks.alpha.stats.requests).toBe(before);
});
test("Telegram note prompting defaults off, honors approval preferences and validates prerequisites", async () => {
  expect(loadConfig({}).telegramApprovalNotesEnabled).toBe(false);
  expect(() => loadConfig({ TELEGRAM_APPROVAL_NOTES_ENABLED: "true" })).toThrow("requires");
  const owner = await h.fundedKey(), agent = await child(owner), uid = await linked(owner), tg = telegram(), id = await waiting(owner, agent);
  await deliverTelegramApprovals(h.ctx, tg.api);
  h.ctx.cfg.telegramApprovalNotesEnabled = false;
  try { await click(tg, uid, id, "deny"); } finally { h.ctx.cfg.telegramApprovalNotesEnabled = true; }
  expect((await row(id)).status).toBe("denied"); expect(tg.calls.some(call => call.params.chat_id === uid && call.params.text === NOTE_PROMPT)).toBe(false);
  const second = await waiting(owner, agent); await deliverTelegramApprovals(h.ctx, tg.api);
  const prefs = await h.request("/api/v1/account/notifications", { headers: owner.auth });
  expect(prefs.status).toBe(200); const settings = (await prefs.json()).data;
  settings.channels.approvals.telegram = false;
  expect((await h.request("/api/v1/account/notifications", { method: "PUT", headers: owner.auth, json: { channels: settings.channels, quiet_hours: settings.quiet_hours } })).status).toBe(200);
  await click(tg, uid, second, "approve");
  expect((await row(second)).status).toBe("approved"); expect(tg.calls.some(call => call.params.chat_id === uid && call.params.text === NOTE_PROMPT)).toBe(false);
});
test("agent policy off refuses decision note endpoints", async () => {
  const off = await startRouter();
  try {
    const owner = await off.fundedKey();
    for (const action of ["approve", "deny"]) expect((await off.request(`/api/v1/agents/approvals/${randomBytes(18).toString("base64url")}/${action}`, { method: "POST", headers: owner.auth, json: { decision_note: "note" } })).status).toBe(404);
  } finally { await off.close(); }
});

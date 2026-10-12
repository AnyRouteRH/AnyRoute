// G163: exercise commands through the existing bot, without Telegram network calls.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, like } from "drizzle-orm";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { eventJson, verifyEventChain } from "../src/agents/store.ts";
import { keys, kv, teamMembers } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { TelegramApi, TelegramBot, type TgUpdate } from "../src/services/telegram.ts";
import { agentStopCallback, handleAgentStop, telegramStopUntil } from "../src/telegram/agent-stop.ts";
import { LINK_FIRST } from "../src/telegram/balance-spend.ts";
import { linkKey } from "../src/telegram/linking.ts";
import { startRouter, type Harness } from "./helpers.ts";

const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
const policy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
let h: Harness, off: Harness, seq = 0, identity = 16300;
type Key = { hash: string; auth: Record<string, string> };
beforeAll(async () => {
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN,
    SECURITY_ALERTS_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true", AGENT_TEAM_APPROVERS_ENABLED: "true", READ_ONLY_KEYS_ENABLED: "true" } });
  off = await startRouter();
});
afterAll(async () => { await h?.close(); await off?.close(); });
const message = (uid: number, text: string): TgUpdate => ({ update_id: ++seq, message: { message_id: seq, from: { id: uid }, chat: { id: uid, type: "private" }, text } });
const callback = (uid: number, data: string): TgUpdate => ({ update_id: ++seq, callback_query: { id: String(seq), from: { id: uid }, data, message: message(uid, "").message } });
function telegram(router = h) {
  const calls: { method: string; params: any }[] = [];
  const fetchImpl = (async (url: unknown, init: any) => {
    const method = String(url).split("/").at(-1)!;
    calls.push({ method, params: JSON.parse(init.body) });
    return Response.json({ ok: true, result: method === "getUpdates" ? [] : { message_id: seq } });
  }) as typeof fetch;
  let routerCalls = 0;
  const bot = new TelegramBot(router.ctx, { token: TOKEN, fetch: fetchImpl, pollTimeoutS: 0,
    router: (path, init) => { routerCalls++; return router.app.request(path, init); } });
  return { bot, api: new TelegramApi(TOKEN, fetchImpl), calls, routerCalls: () => routerCalls,
    replies: () => calls.filter(c => c.method === "sendMessage" || c.method === "answerCallbackQuery").map(c => c.params.text as string) };
}
const read = async (hash: string) => (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, hash)))[0]!;
const events = async (hash: string) => (await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, hash)).orderBy(asc(agentPolicyEvents.id))).map(eventJson);
const keyRow = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0]!;
const path = (key: Key, action: string) => `/api/v1/agents/${key.hash}/${action}`;
async function agent(owner: Key, name: string) {
  const result = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name } })).json();
  const key = { hash: result.data.hash as string, auth: { authorization: `Bearer ${result.key}` } };
  expect((await h.request(path(key, "policy"), { method: "PUT", headers: owner.auth, json: policy })).status).toBe(200);
  return key;
}
async function link(tg: ReturnType<typeof telegram>, owner: Key) {
  const response = await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth });
  expect(response.status).toBe(200);
  const uid = ++identity;
  await tg.bot.handleUpdate(message(uid, `/link ${(await response.json()).data.code}`));
  expect(tg.replies().at(-1)).toContain("Telegram linked");
  return uid;
}
const linkRow = async (uid: number) => (await h.ctx.db.select().from(kv).where(eq(kv.key, linkKey(uid))))[0]!.value as { generation: string };

test("presets use UTC across year boundaries, validate durations, and full-digest buttons fit 64 bytes", () => {
  const now = new Date("2026-12-31T23:30:00-05:00");
  expect(telegramStopUntil("1h", now)?.toISOString()).toBe("2027-01-01T05:30:00.000Z");
  expect(telegramStopUntil("tomorrow", now)?.toISOString()).toBe("2027-01-02T09:00:00.000Z");
  expect(telegramStopUntil("resume-only", now)).toBeNull();
  expect(() => telegramStopUntil("2h", now)).toThrow();
  expect(Buffer.byteLength(agentStopCallback("h", "ab".repeat(32), "abcdefghijkl"))).toBe(62);
});

test("unlinked or Chat-only identities cannot control agents; groups, bots and mismatched chats are ignored", async () => {
  const tg = telegram(), uid = ++identity, owner = await h.newKey();
  await tg.bot.handleUpdate(message(uid, `/key ${owner.secret}`));
  for (const command of ["/agents", "/stop Shop bot 1h", "/start Shop bot"]) {
    await tg.bot.handleUpdate(message(uid, command)); expect(tg.replies().at(-1)).toBe(LINK_FIRST);
  }
  const count = tg.calls.length;
  for (const patch of [{ chat: { id: uid, type: "group" } }, { chat: { id: uid + 1, type: "private" } }, { from: { id: uid, is_bot: true } }]) {
    const update = message(uid, "/agents"); update.message = { ...update.message!, ...patch };
    await tg.bot.handleUpdate(update);
  }
  expect(tg.calls).toHaveLength(count); expect(tg.routerCalls()).toBe(1);
});

test("list has readable names, inherited/current Stop status and buttons; expired Stop reads do not write", async () => {
  const tg = telegram(), owner = await h.newKey(), shop = await agent(owner, "Shop bot"), other = await h.newKey();
  await agent(other, "Hidden foreign bot");
  const uid = await link(tg, owner);
  await tg.bot.handleUpdate(message(uid, "/stop Shop bot tomorrow"));
  expect(tg.replies().at(-1)).toBe("Stopped Shop bot until 09:00 tomorrow UTC.");
  const before = await events(shop.hash);
  await tg.bot.handleUpdate(message(uid, "/agents@AnyrouteBot"));
  const listed = tg.calls.filter(c => c.method === "sendMessage" && c.params.text.includes("Shop bot · Stopped"));
  expect(listed).toHaveLength(1); expect(listed[0]!.params.text).toContain("UTC");
  const buttons = listed[0]!.params.reply_markup.inline_keyboard.flat();
  expect(buttons.map((button: any) => button.text)).toEqual(["Stop 1 hour", "Stop until tomorrow", "Stop until resumed", "Resume"]);
  expect(tg.replies().join("\n")).not.toContain("Hidden foreign bot");
  await h.ctx.db.update(keys).set({ management: true }).where(eq(keys.keyHash, shop.hash));
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: shop.auth, json: { budget_usd: 1 } })).json()).data;
  expect(session.key_hash).toBeDefined();
  await tg.bot.handleUpdate(message(uid, "/agents"));
  expect(tg.calls.some(c => c.method === "sendMessage" && c.params.text.includes("Stopped") && c.params.text.includes("Set a rulebook"))).toBe(true);
  await h.ctx.db.update(agentPolicies).set({ killUntil: new Date(0) }).where(eq(agentPolicies.keyHash, shop.hash));
  await tg.bot.handleUpdate(message(uid, "/agents"));
  expect(tg.calls.filter(c => c.method === "sendMessage" && c.params.text.includes("Shop bot ·")).at(-1)!.params.text).toContain("Running");
  expect(await events(shop.hash)).toEqual(before); expect((await read(shop.hash)).killed).toBe(true);
});

test("timed/indefinite Stop and Resume have the web action's stored effect, event and security trail", async () => {
  const tg = telegram(), owner = await h.newKey(), shop = await agent(owner, "Shop bot"), uid = await link(tg, owner);
  const until = telegramStopUntil("tomorrow")!.toISOString();
  expect((await h.request(path(shop, "kill"), { method: "POST", headers: owner.auth, json: { until } })).status).toBe(200);
  const web = await read(shop.hash), webEvent = (await events(shop.hash)).at(-1)!;
  await tg.bot.handleUpdate(message(uid, "/stop Shop bot tomorrow"));
  const stopped = await read(shop.hash), tgEvent = (await events(shop.hash)).at(-1)!;
  for (const field of ["killed", "killUntil", "killedReason", "updatedBy", "sha256", "spec"] as const) expect(stopped[field]).toEqual(web[field]);
  for (const field of ["kind", "reasons", "intent", "policy_sha256", "decision"] as const) expect(tgEvent[field]).toEqual(webEvent[field]);
  const security = await h.ctx.db.select().from(kv).where(like(kv.key, "security-alerts:event:policy:%"));
  const securityFor = (id: number) => security.find(row => row.key === `security-alerts:event:policy:${id}`)!.value as { title: string };
  expect(securityFor(tgEvent.id).title).toEqual(securityFor(webEvent.id).title);
  await tg.bot.handleUpdate(message(uid, "/start Shop bot"));
  expect(tg.replies().at(-1)).toContain("Resumed Shop bot"); expect((await read(shop.hash)).killed).toBe(false); expect((await read(shop.hash)).killUntil).toBeNull();
  expect((await events(shop.hash)).at(-1)!.kind).toBe("resumed");
  await tg.bot.handleUpdate(message(uid, "/stop Shop bot 1h"));
  expect((await read(shop.hash)).killUntil!.getTime() - Date.now()).toBeGreaterThan(3_590_000);
  for (const command of ["/stop Shop bot resume-only", "/stop Shop bot"]) {
    await tg.bot.handleUpdate(message(uid, command)); expect((await read(shop.hash)).killUntil).toBeNull(); expect((await read(shop.hash)).killed).toBe(true);
  }
  expect(verifyEventChain(await events(shop.hash))).toBe(true); expect(tg.routerCalls()).toBe(0);
});

test("ambiguous names ask for a choice, then preserve the selected duration and exact target", async () => {
  const tg = telegram(), owner = await h.newKey(), first = await agent(owner, "Shop bot"), second = await agent(owner, "Shop bot"), uid = await link(tg, owner);
  const before = [await events(first.hash), await events(second.hash)];
  await tg.bot.handleUpdate(message(uid, "/stop Shop bot 1h"));
  const choice = tg.calls.at(-1)!; expect(choice.params.text).toContain("More than one");
  const options = choice.params.reply_markup.inline_keyboard.flat(); expect(options).toHaveLength(2); expect(options[0].text).not.toBe(options[1].text);
  expect([await events(first.hash), await events(second.hash)]).toEqual(before);
  const token = options.find((option: any) => option.callback_data === agentStopCallback("h", second.hash, (option.callback_data as string).split(":").at(-1)!)).callback_data;
  await tg.bot.handleUpdate(callback(uid, token)); expect((await read(first.hash)).killed).toBe(false); expect((await read(second.hash)).killed).toBe(true);
  expect((await read(second.hash)).killUntil!.getTime() - Date.now()).toBeGreaterThan(3_590_000);
  await tg.bot.handleUpdate(message(uid, "/start Shop bot"));
  const resume = tg.calls.at(-1)!.params.reply_markup.inline_keyboard.flat().find((option: any) => option.callback_data === agentStopCallback("r", second.hash, (option.callback_data as string).split(":").at(-1)!));
  await tg.bot.handleUpdate(callback(uid, resume.callback_data)); expect((await read(second.hash)).killed).toBe(false);
});

test("permission matrix matches web Stop/Resume, with team visibility and approval-only refusal", async () => {
  const tg = telegram(), owner = await h.newKey(), admin = await agent(owner, "Team manager"), peer = await agent(owner, "Visible agent"), hidden = await agent(owner, "Hidden agent");
  for (const key of [admin, peer]) await h.ctx.db.update(keys).set({ teamId: "stop-team-a" }).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.update(keys).set({ teamId: "stop-team-b" }).where(eq(keys.keyHash, hidden.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "stop-team-a", keyHash: admin.hash, role: "admin" });
  const uid = await link(tg, admin), generation = (await linkRow(uid)).generation;
  for (const role of ["owner", "admin", "dev", "member", "viewer", "agent"]) {
    await h.ctx.db.update(teamMembers).set({ role }).where(eq(teamMembers.keyHash, admin.hash));
    const allowed = role === "owner" || role === "admin";
    const web = await h.request(path(peer, "kill"), { method: "POST", headers: admin.auth, json: {} }); expect(web.status).toBe(allowed ? 200 : 403);
    const before = await events(peer.hash);
    await tg.bot.handleUpdate(message(uid, "/stop Visible agent"));
    expect(tg.replies().at(-1)).toContain(allowed ? "Stopped Visible agent" : "unavailable");
    expect((await events(peer.hash)).length).toBe(before.length + (allowed ? 1 : 0));
    await tg.bot.handleUpdate(callback(uid, agentStopCallback("r", peer.hash, generation)));
    expect(tg.replies().at(-1)).toContain(allowed ? "Resumed Visible agent" : "unavailable");
    if (allowed) {
      const count = tg.calls.length; await tg.bot.handleUpdate(message(uid, "/agents"));
      expect(tg.calls.slice(count).map(call => call.params.text).join("\n")).not.toContain("Hidden agent");
      await tg.bot.handleUpdate(message(uid, "/stop Hidden agent")); expect(tg.replies().at(-1)).toContain("No matching agent");
      await tg.bot.handleUpdate(callback(uid, agentStopCallback("s", hidden.hash, generation))); expect((await read(hidden.hash)).killed).toBe(false);
      expect((await h.request(path(hidden, "kill"), { method: "POST", headers: admin.auth, json: {} })).status).toBe(403);
    }
  }
});

test("disabled, expired, read-only and inference-only links cannot list or mutate; session authority is refused", async () => {
  const tg = telegram(), owner = await h.newKey(), shop = await agent(owner, "Shop bot"), uid = await link(tg, owner), saved = await keyRow(owner.hash);
  const generation = (await linkRow(uid)).generation;
  for (const patch of [{ disabled: true }, { expiresAt: new Date(0) }, { scope: "read", management: false }, { scope: "inference", management: false }]) {
    await h.ctx.db.update(keys).set(patch).where(eq(keys.keyHash, owner.hash));
    const before = await events(shop.hash);
    for (const command of ["/agents", "/stop Shop bot", "/start Shop bot"]) {
      await tg.bot.handleUpdate(message(uid, command)); expect(tg.replies().at(-1)).toContain("unavailable");
    }
    await tg.bot.handleUpdate(callback(uid, agentStopCallback("s", shop.hash, generation))); expect(tg.replies().at(-1)).toContain("unavailable");
    expect(await events(shop.hash)).toEqual(before); expect((await read(shop.hash)).killed).toBe(false);
    expect((await h.request(path(shop, "kill"), { method: "POST", headers: owner.auth, json: {} })).status).not.toBe(200);
    await h.ctx.db.update(keys).set({ disabled: saved.disabled, expiresAt: saved.expiresAt, scope: saved.scope, management: saved.management }).where(eq(keys.keyHash, owner.hash));
  }
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  const stored = (await h.ctx.db.select().from(kv).where(eq(kv.key, linkKey(uid))))[0]!;
  await h.ctx.db.update(kv).set({ value: { ...(stored.value as object), key_hash: session.key_hash } }).where(eq(kv.key, linkKey(uid)));
  await tg.bot.handleUpdate(message(uid, "/stop Shop bot")); expect(tg.replies().at(-1)).toContain("unavailable"); expect((await read(shop.hash)).killed).toBe(false);
});

test("buttons recheck role, team, unlink/relink generation, foreign identity and malformed data", async () => {
  const tg = telegram(), owner = await h.newKey(), shop = await agent(owner, "Shop bot"), uid = await link(tg, owner), generation = (await linkRow(uid)).generation;
  const data = agentStopCallback("s", shop.hash, generation);
  await tg.bot.handleUpdate(callback(uid + 1, data)); expect((await read(shop.hash)).killed).toBe(false);
  await tg.bot.handleUpdate(callback(uid, "tgs:invalid")); expect((await read(shop.hash)).killed).toBe(false);
  await tg.bot.handleUpdate(message(uid, "/unlink")); await tg.bot.handleUpdate(callback(uid, data)); expect((await read(shop.hash)).killed).toBe(false);
  const code = (await (await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth })).json()).data.code;
  await tg.bot.handleUpdate(message(uid, `/link ${code}`)); await tg.bot.handleUpdate(callback(uid, data)); expect((await read(shop.hash)).killed).toBe(false);
  await h.ctx.db.update(keys).set({ management: false, teamId: "new-stop-team" }).where(eq(keys.keyHash, owner.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "new-stop-team", keyHash: owner.hash, role: "admin" });
  const fresh = (await linkRow(uid)).generation;
  await tg.bot.handleUpdate(callback(uid, agentStopCallback("s", shop.hash, fresh))); expect((await read(shop.hash)).killed).toBe(false);
});

test("missing names and rulebooks fail plainly without an event; list buttons stop and resume", async () => {
  const tg = telegram(), owner = await h.newKey(), shop = await agent(owner, "Shop bot"), uid = await link(tg, owner);
  await tg.bot.handleUpdate(message(uid, "/stop")); expect(tg.replies().at(-1)).toContain("followed by an agent name");
  await tg.bot.handleUpdate(message(uid, "/stop Missing agent 1h")); expect(tg.replies().at(-1)).toContain("No matching agent");
  await tg.bot.handleUpdate(message(uid, "/stop Shop bot 2h")); expect(tg.replies().at(-1)).toContain("No matching agent"); expect((await read(shop.hash)).killed).toBe(false);
  await tg.bot.handleUpdate(message(uid, "/agents"));
  const buttons = tg.calls.filter(c => c.method === "sendMessage" && c.params.text.includes("Shop bot ·")).at(-1)!.params.reply_markup.inline_keyboard.flat();
  for (const index of [0, 1, 2]) { await tg.bot.handleUpdate(callback(uid, buttons[index].callback_data)); expect((await read(shop.hash)).killed).toBe(true); }
  await tg.bot.handleUpdate(callback(uid, buttons[3].callback_data)); expect((await read(shop.hash)).killed).toBe(false);
  await h.ctx.db.delete(agentPolicies).where(eq(agentPolicies.keyHash, shop.hash)); const before = await events(shop.hash);
  await tg.bot.handleUpdate(message(uid, "/stop Shop bot")); expect(tg.replies().at(-1)).toContain("Set a rulebook"); expect(await events(shop.hash)).toEqual(before);
});

test("help/menu expose commands when enabled; default-off handling and existing /start are preserved", async () => {
  const tg = telegram(), disabled = telegram(off), uid = ++identity;
  expect(loadConfig({ ANYROUTE_ENV: "test" }).telegram.linkingEnabled).toBe(false);
  for (const context of [off.ctx, { ...h.ctx, cfg: { ...h.ctx.cfg, agentPolicyEnabled: false } }]) {
    expect(await handleAgentStop(context, disabled.api, message(uid, "/agents"))).toBe(false);
    expect(await handleAgentStop(context, disabled.api, callback(uid, "tgs:invalid"))).toBe(false);
  }
  expect(disabled.calls).toHaveLength(0);
  await tg.bot.handleUpdate(message(uid, "/help")); expect(tg.replies().at(-1)).toContain("/stop <agent>"); expect(tg.replies().at(-1)).toContain("/start <agent>");
  await disabled.bot.handleUpdate(message(uid, "/help")); expect(disabled.replies().at(-1)).not.toContain("/stop <agent>");
  await tg.bot.handleUpdate(message(uid, "/start")); expect(tg.replies().at(-1)).toContain("Connect:");
  await disabled.bot.handleUpdate(message(uid, "/stop Shop bot")); expect(disabled.replies().at(-1)).toContain("don't know that command");
  await tg.bot.poll(); await disabled.bot.poll();
  const commands = tg.calls.find(call => call.method === "setMyCommands")!.params.commands;
  expect(commands.map((command: any) => command.command)).toEqual(expect.arrayContaining(["agents", "stop", "start", "balance", "spend", "link"]));
  expect(new Set(commands.map((command: any) => command.command)).size).toBe(commands.length);
  expect(disabled.calls.find(call => call.method === "setMyCommands")!.params.commands.map((command: any) => command.command)).not.toContain("agents");
});

test("Telegram reply failures do not roll back a committed Stop or its event", async () => {
  const tg = telegram(), owner = await h.newKey(), shop = await agent(owner, "Shop bot"), uid = await link(tg, owner);
  const before = await events(shop.hash);
  const failing = new TelegramApi(TOKEN, (async () => { throw new Error("transport unavailable"); }) as typeof fetch);
  expect(await handleAgentStop(h.ctx, failing, message(uid, "/stop Shop bot"))).toBe(true);
  expect((await read(shop.hash)).killed).toBe(true);
  expect((await events(shop.hash)).length).toBe(before.length + 1);
});

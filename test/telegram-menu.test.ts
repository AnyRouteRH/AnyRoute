// J179: command equivalence and current link authority through the existing bot.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { keys, kv, ledger, teamMembers } from "../src/db/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { TelegramApi, TelegramBot, type TgUpdate } from "../src/services/telegram.ts";
import { handleTelegramMenu, menuButtons, menuCallback } from "../src/telegram/menu.ts";
import { LINK_FIRST } from "../src/telegram/balance-spend.ts";
import { bindMenuCommand, menuLinkMatches, STALE_MENU } from "../src/telegram/menu-command.ts";
import { consumeCode, readLink, type Link } from "../src/telegram/linking.ts";
import { deliverTelegramApprovals, linkHowTo, notificationKey } from "../src/telegram/delivery.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";

const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
const env = { AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN,
  AGENT_TEAM_APPROVERS_ENABLED: "true", NOTIFICATION_QUIET_HOURS_ENABLED: "true", READ_ONLY_KEYS_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true" };
type Key = { hash: string; auth: Record<string, string> };
let h: Harness, off: Harness, sequence = 0, identity = 17900;
beforeAll(async () => { h = await startRouter({ env }); off = await startRouter(); });
afterAll(async () => { await h?.close(); await off?.close(); });
const message = (uid: number, text: string): TgUpdate => ({ update_id: ++sequence, message: { message_id: sequence, from: { id: uid }, chat: { id: uid, type: "private" }, text } });
const callback = (uid: number, data: string, messageId = 0): TgUpdate => ({ update_id: ++sequence, callback_query: {
  id: `menu-${sequence}`, from: { id: uid }, data, message: { message_id: messageId, chat: { id: uid, type: "private" } },
} });
function telegram(router = h, fail = false) {
  const calls: { method: string; params: any; id: number }[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit) => {
    const method = String(url).split("/").at(-1)!, id = ++sequence;
    calls.push({ method, params: JSON.parse(init.body as string), id });
    return Response.json(fail ? { ok: false, error_code: 500 } : { ok: true, result: method === "getUpdates" ? [] : { message_id: id } });
  }) as typeof fetch;
  let routerCalls = 0;
  const bot = new TelegramBot(router.ctx, { token: TOKEN, fetch: fetchImpl, pollTimeoutS: 0,
    router: (path, init) => { routerCalls++; return router.app.request(path, init); } });
  return { calls, bot, api: new TelegramApi(TOKEN, fetchImpl), routerCalls: () => routerCalls,
    sends: () => calls.filter(c => c.method === "sendMessage"), texts: () => calls.filter(c => c.method === "sendMessage").map(c => c.params.text as string) };
}
async function link(key: Key, uid = ++identity) {
  const response = await h.request("/api/v1/telegram/link", { method: "POST", headers: key.auth });
  expect(response.status).toBe(200);
  return consumeCode(h.ctx, uid, (await response.json()).data.code);
}
async function child(owner: Key, name = "Menu agent", team?: string, role = "agent"): Promise<Key> {
  const response = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name, ...(team ? { team, role } : {}) } });
  expect(response.status).toBe(201);
  const result = await response.json();
  return { hash: result.data.hash, auth: { authorization: `Bearer ${result.key}` } };
}
async function policy(owner: Key, key: Key) {
  expect((await h.request(`/api/v1/agents/${key.hash}/policy`, { method: "PUT", headers: owner.auth,
    json: { version: 1, models: {}, caps: {}, on_breach: "deny" } })).status).toBe(200);
}
const stopped = async (hash: string) => (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, hash)))[0]!.killed;
async function pending(key: Key, status: "pending" | "used" | "denied" = "pending", remaining = 900_000) {
  const id = randomBytes(18).toString("base64url");
  await h.ctx.db.insert(agentApprovals).values({ id, keyHash: key.hash, intent: { kind: "inference", model: MODELS.llama.slug, lane: "public", tools: [], est_cost_pico: "1000" },
    intentHash: id, maxCostPico: 1000n, status, expiresAt: new Date(Date.now() + remaining) });
  return id;
}
const approval = async (id: string) => (await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0]!;
const click = (tg: ReturnType<typeof telegram>, link: Link, action: Parameters<typeof menuCallback>[0]) => tg.bot.handleUpdate(callback(link.uid, menuCallback(action, link.generation)));
const approvalSends = (tg: ReturnType<typeof telegram>) => tg.sends().filter(c => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.text === "Approve");

async function teamFixture() {
  const owner = await h.newKey();
  const response = await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Menu team" } });
  expect(response.status).toBe(201);
  const team = (await response.json()).data.id;
  const agent = await child(owner, "Team agent", team), member = await child(owner, "Approval teammate", team, "member"), admin = await child(owner, "Team admin", team, "admin");
  await policy(owner, agent);
  return { owner, team, agent, member, admin };
}
async function configure(owner: Key, agent: Key, mode: string, ids: string[] = []) {
  expect((await h.request(`/api/v1/agents/${agent.hash}/approvers`, { method: "PUT", headers: owner.auth, json: { mode, member_ids: ids } })).status).toBe(200);
}

test("menu buttons have bounded generation callbacks and existing credential-free site links", () => {
  const buttons = menuButtons("https://anyroute.tech", "Abcdef123_-x").flat();
  expect(buttons.map(button => button.text)).toEqual(["Balance", "Spend", "Agents", "Stop all", "Waiting approvals", "Inbox", "Settings"]);
  for (const button of buttons) if ("callback_data" in button) {
    expect(button.callback_data).toEndWith(":Abcdef123_-x"); expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  }
  expect(buttons.at(-2)).toEqual({ text: "Inbox", url: "https://anyroute.tech/dashboard/#inbox" });
  expect(buttons.at(-1)).toEqual({ text: "Settings", url: "https://anyroute.tech/dashboard/#notifications" });
  const update = message(1, "/balance"), link = { generation: "old-generation" } as Link;
  expect(menuLinkMatches(update, undefined)).toBe(true);
  bindMenuCommand(update, link.generation);
  expect(menuLinkMatches(update, link)).toBe(true); expect(menuLinkMatches(update, undefined)).toBe(false);
  expect(menuLinkMatches(update, { ...link, generation: "new-generation" })).toBe(false);
});

test("welcome, help and setMyCommands expose menu only with existing feature guards", async () => {
  const tg = telegram(), disabled = telegram(off), uid = ++identity;
  for (const text of ["/start", "/help"]) {
    await tg.bot.handleUpdate(message(uid, text)); expect(tg.texts().at(-1)).toContain("/menu");
    await disabled.bot.handleUpdate(message(uid, text)); expect(disabled.texts().at(-1)).not.toContain("/menu");
  }
  for (const ctx of [off.ctx, { ...h.ctx, cfg: { ...h.ctx.cfg, agentPolicyEnabled: false } }]) {
    expect(await handleTelegramMenu(ctx, disabled.api, message(uid, "/menu"))).toBe(false);
    expect(await handleTelegramMenu(ctx, disabled.api, callback(uid, "tgm:invalid"))).toBe(false);
  }
  await tg.bot.poll(); await disabled.bot.poll();
  const commands = tg.calls.find(c => c.method === "setMyCommands")!.params.commands.map((c: any) => c.command);
  expect(commands.filter((command: string) => command === "menu")).toHaveLength(1);
  expect(disabled.calls.find(c => c.method === "setMyCommands")!.params.commands.map((c: any) => c.command)).not.toContain("menu");
});

test("unlinked chat receives the existing link instructions; groups, mismatched identities and bots stay silent", async () => {
  const tg = telegram(), uid = ++identity;
  // A separate Chat credential does not establish account authority.
  await tg.bot.handleUpdate(message(uid, `/key ${(await h.newKey()).secret}`));
  await tg.bot.handleUpdate(message(uid, "/menu@TryAnyrouteBot")); expect(tg.texts().at(-1)).toBe(linkHowTo(h.ctx));
  const before = tg.calls.length;
  const group = message(uid, "/menu"); group.message!.chat.type = "group";
  const mismatch = message(uid, "/menu"); mismatch.message!.chat.id++;
  const bot = message(uid, "/menu"); bot.message!.from!.is_bot = true;
  const groupCallback = callback(uid, menuCallback("stopall", "Abcdef123_-x")); groupCallback.callback_query!.message!.chat.type = "group";
  for (const update of [group, mismatch, bot, groupCallback]) await tg.bot.handleUpdate(update);
  expect(tg.calls.length).toBe(before); expect(tg.routerCalls()).toBe(1);
});

test("Balance and Spend buttons equal their commands and do not create stored menu or billing records", async () => {
  const tg = telegram(), owner = await h.newKey(), agent = await child(owner), linked = await link(owner);
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  await h.ctx.db.insert(ledger).values([{ id: `menu-deposit-${++sequence}`, ref: `menu-deposit-${sequence}`, accountId: key!.accountId, keyHash: owner.hash, kind: "deposit", amount: 5_000_000_000_000n },
    { id: `menu-charge-${++sequence}`, ref: `menu-charge-${sequence}`, accountId: key!.accountId, keyHash: agent.hash, kind: "usage", amount: -500_000_000_000n }]);
  const before = await h.ctx.db.select().from(kv), billing = await h.ctx.db.select().from(ledger);
  await tg.bot.handleUpdate(message(linked.uid, "/menu")); expect(tg.sends().at(-1)!.params.reply_markup.inline_keyboard).toEqual(menuButtons(h.ctx.cfg.siteUrl, linked.generation));
  for (const command of ["balance", "spend"] as const) {
    await tg.bot.handleUpdate(message(linked.uid, `/${command}`)); const direct = tg.texts().at(-1);
    await click(tg, linked, command); expect(tg.texts().at(-1)).toBe(direct);
  }
  expect(await h.ctx.db.select().from(kv)).toEqual(before); expect(await h.ctx.db.select().from(ledger)).toEqual(billing); expect(tg.routerCalls()).toBe(0);
});

test("Agents uses the existing list and Stop buttons; Stop all matches the command, events and account visibility", async () => {
  const tg = telegram(), owner = await h.newKey(), agent = await child(owner), foreign = await h.newKey(), linked = await link(owner);
  await policy(owner, agent); await policy(foreign, foreign);
  let offset = tg.sends().length;
  await tg.bot.handleUpdate(message(linked.uid, "/agents")); const direct = tg.sends().slice(offset).map(c => c.params);
  offset = tg.sends().length; await click(tg, linked, "agents"); expect(tg.sends().slice(offset).map(c => c.params)).toEqual(direct);
  await tg.bot.handleUpdate(message(linked.uid, "/stopall")); const text = tg.texts().at(-1); expect(await stopped(agent.hash)).toBe(true);
  await tg.bot.handleUpdate(message(linked.uid, "/startall")); expect(await stopped(agent.hash)).toBe(false);
  const before = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, agent.hash));
  await click(tg, linked, "stopall"); expect(tg.texts().at(-1)).toBe(text); expect(await stopped(agent.hash)).toBe(true); expect(await stopped(foreign.hash)).toBe(false);
  const after = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, agent.hash));
  expect(after.length).toBe(before.length + 1); expect(after.at(-1)!.kind).toBe("killed");
  expect((await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, agent.hash)))[0]!.updatedBy).toBe(owner.hash);
});

test("all old action buttons are refused after unlink and relink; copying them to another identity grants nothing", async () => {
  const tg = telegram(), owner = await h.newKey(), agent = await child(owner), linked = await link(owner);
  await policy(owner, agent); await pending(agent);
  await tg.bot.handleUpdate(message(linked.uid, "/unlink"));
  for (const action of ["balance", "spend", "agents", "stopall", "approvals"] as const) {
    const offset = tg.sends().length; await click(tg, linked, action);
    expect(tg.sends().slice(offset).every(c => c.params.text === STALE_MENU)).toBe(true);
  }
  const fresh = await link(owner, linked.uid); expect(fresh.generation).not.toBe(linked.generation);
  for (const action of ["balance", "spend", "agents", "stopall", "approvals"] as const) await click(tg, linked, action);
  expect(await stopped(agent.hash)).toBe(false); expect(approvalSends(tg)).toHaveLength(0);
  const offset = tg.sends().length;
  await tg.bot.handleUpdate(callback(++identity, menuCallback("balance", fresh.generation)));
  await tg.bot.handleUpdate(callback(fresh.uid, "tgm:stopall:malformed"));
  expect(tg.sends().slice(offset).every(c => c.params.text === STALE_MENU)).toBe(true);
});

test("current disabled, expired, read-only and inference scopes retain the commands' permissions", async () => {
  for (const patch of [{ disabled: true }, { expiresAt: new Date(Date.now() - 1000) }, { scope: "read", management: false, teamId: null }, { scope: "inference", management: false }]) {
    const tg = telegram(), owner = await h.newKey(), agent = await child(owner), linked = await link(owner); await policy(owner, agent);
    await h.ctx.db.update(keys).set(patch).where(eq(keys.keyHash, owner.hash));
    for (const action of ["balance", "spend", "agents", "stopall"] as const) {
      await tg.bot.handleUpdate(message(linked.uid, `/${action}`)); const direct = tg.texts().at(-1);
      await click(tg, linked, action); expect(tg.texts().at(-1)).toBe(direct);
    }
    expect(await stopped(agent.hash)).toBe(false);
    await h.ctx.db.update(keys).set({ disabled: false, expiresAt: null, scope: null }).where(eq(keys.keyHash, owner.hash));
  }
});

test("team admins see and stop only their own team; loss of role is checked on press", async () => {
  const f = await teamFixture(), tg = telegram(), linked = await link(f.admin), hidden = await child(f.owner, "Other team agent"); await policy(f.owner, hidden);
  await click(tg, linked, "agents"); expect(tg.texts().join("\n")).toContain("Team agent"); expect(tg.texts().join("\n")).not.toContain("Other team agent");
  await click(tg, linked, "stopall"); expect(await stopped(f.agent.hash)).toBe(true); expect(await stopped(hidden.hash)).toBe(false);
  await tg.bot.handleUpdate(message(linked.uid, "/startall"));
  await h.ctx.db.update(teamMembers).set({ role: "member" }).where(eq(teamMembers.keyHash, f.admin.hash));
  await click(tg, linked, "stopall"); expect(await stopped(f.agent.hash)).toBe(false); expect(tg.texts().at(-1)).toContain("unavailable");
});

test("Waiting approvals refreshes previously delivered requests with existing message binding and single-use decisions", async () => {
  const tg = telegram(), owner = await h.newKey(), agent = await child(owner), linked = await link(owner); await policy(owner, agent);
  const id = await pending(agent), denied = await pending(agent, "denied"), expired = await pending(agent, "pending", -1), used = await pending(agent, "used");
  await deliverTelegramApprovals(h.ctx, tg.api); const original = approvalSends(tg).find(c => c.params.text.includes(id))!;
  const offset = approvalSends(tg).length; await click(tg, linked, "approvals"); const listing = approvalSends(tg).slice(offset);
  expect(listing).toHaveLength(1); const current = listing[0]!;
  expect(current.params.text).toContain(id); expect(current.params.text).not.toContain('"kind"');
  for (const missing of [denied, expired, used]) expect(current.params.text).not.toContain(missing);
  expect(current.params.reply_markup).toEqual(original.params.reply_markup);
  const buttons = current.params.reply_markup.inline_keyboard[0];
  await tg.bot.handleUpdate(callback(linked.uid, buttons[0].callback_data, original.id)); expect((await approval(id)).status).toBe("pending");
  await tg.bot.handleUpdate(callback(linked.uid, buttons[0].callback_data, current.id + 1)); expect((await approval(id)).status).toBe("pending");
  await tg.bot.handleUpdate(callback(linked.uid, buttons[0].callback_data, current.id)); expect((await approval(id)).status).toBe("approved");
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, agent.hash));
  await tg.bot.handleUpdate(callback(linked.uid, buttons[1].callback_data, current.id)); expect((await approval(id)).status).toBe("approved");
  expect((await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, agent.hash))).length).toBe(events.length);
  const next = await pending(agent); await click(tg, linked, "approvals"); const deny = approvalSends(tg).at(-1)!;
  await tg.bot.handleUpdate(callback(linked.uid, deny.params.reply_markup.inline_keyboard[0][1].callback_data, deny.id)); expect((await approval(next)).status).toBe("denied");
});

test("approval-only teammates list only delegated requests; revoked permission blocks old approval buttons", async () => {
  const f = await teamFixture(), tg = telegram(); await configure(f.owner, f.agent, "specific_members", [f.member.hash]);
  const hidden = await child(f.owner, "Private team agent", f.team); await policy(f.owner, hidden);
  const visible = await pending(f.agent), missing = await pending(hidden), linked = await link(f.member);
  await tg.bot.handleUpdate(message(linked.uid, "/menu")); expect(tg.sends().at(-1)!.params.reply_markup).toBeDefined();
  for (const action of ["balance", "spend", "agents", "stopall"] as const) { await click(tg, linked, action); expect(tg.texts().at(-1)).toContain("unavailable"); }
  await click(tg, linked, "approvals"); const sent = approvalSends(tg).at(-1)!; expect(sent.params.text).toContain(visible); expect(sent.params.text).not.toContain(missing);
  await configure(f.owner, f.agent, "owners");
  await tg.bot.handleUpdate(callback(linked.uid, sent.params.reply_markup.inline_keyboard[0][0].callback_data, sent.id)); expect((await approval(visible)).status).toBe("pending");
  expect(await stopped(f.agent.hash)).toBe(false);
});

test("approval notification switch is respected and existing quiet-hour exception remains", async () => {
  const tg = telegram(), owner = await h.newKey(), agent = await child(owner), linked = await link(owner); await pending(agent);
  const prefs = (await (await h.request("/api/v1/account/notifications", { headers: owner.auth })).json()).data;
  prefs.channels.approvals.telegram = false;
  const save = async () => expect((await h.request("/api/v1/account/notifications", { method: "PUT", headers: owner.auth,
    json: { channels: prefs.channels, quiet_hours: prefs.quiet_hours } })).status).toBe(200);
  await save(); await click(tg, linked, "approvals"); expect(approvalSends(tg)).toHaveLength(0);
  prefs.channels.approvals.telegram = true;
  const clock = (date: Date) => date.toISOString().slice(11, 16);
  prefs.quiet_hours = { from_utc: clock(new Date(Date.now() - 60_000)), to_utc: clock(new Date(Date.now() + 60_000)) };
  await save(); await click(tg, linked, "approvals"); expect(approvalSends(tg)).toHaveLength(1);
});

test("failed requested approval refresh preserves the original marker and working buttons", async () => {
  const tg = telegram(), owner = await h.newKey(), agent = await child(owner), linked = await link(owner), id = await pending(agent);
  await deliverTelegramApprovals(h.ctx, tg.api);
  const marker = async () => (await h.ctx.db.select().from(kv).where(eq(kv.key, notificationKey(id, linked))))[0]!.value;
  const before = await marker(); expect(await deliverTelegramApprovals(h.ctx, telegram(h, true).api, linked)).toBe(0); expect(await marker()).toEqual(before);
});

test("unlink between callback delegation and the handler lock prevents reads and Stop all", async () => {
  for (const action of ["balance", "spend", "agents", "stopall", "approvals"] as const) {
    const owner = await h.newKey(), agent = await child(owner), linked = await link(owner); await policy(owner, agent); await pending(agent);
    const db = new Proxy(h.ctx.db, { get(target, property) {
      if (property === "transaction") return async (...args: Parameters<typeof target.transaction>) => {
        await target.delete(kv).where(eq(kv.key, `telegram-link:${linked.uid}`));
        return target.transaction(...args);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const tg = telegram({ ...h, ctx: { ...h.ctx, db } });
    await click(tg, linked, action);
    expect(await stopped(agent.hash)).toBe(false); expect(approvalSends(tg)).toHaveLength(0);
    expect(tg.texts().every(text => text === STALE_MENU || text === LINK_FIRST)).toBe(true);
  }
});

test("session authority cannot use a saved menu, and approval buttons stay invalid after relinking", async () => {
  const tg = telegram(), owner = await h.newKey(), agent = await child(owner), linked = await link(owner); await policy(owner, agent);
  const sessionResponse = await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } });
  expect(sessionResponse.status).toBe(201); const session = (await sessionResponse.json()).data;
  await h.ctx.db.update(kv).set({ value: { ...linked, key_hash: session.key_hash } }).where(eq(kv.key, `telegram-link:${linked.uid}`));
  for (const action of ["balance", "spend", "agents", "stopall", "approvals"] as const) await click(tg, linked, action);
  expect(await stopped(agent.hash)).toBe(false); expect(approvalSends(tg)).toHaveLength(0);
  await h.ctx.db.update(kv).set({ value: linked }).where(eq(kv.key, `telegram-link:${linked.uid}`));
  const id = await pending(agent); await click(tg, linked, "approvals"); const sent = approvalSends(tg).at(-1)!;
  await tg.bot.handleUpdate(message(linked.uid, "/unlink")); await link(owner, linked.uid);
  await tg.bot.handleUpdate(callback(linked.uid, sent.params.reply_markup.inline_keyboard[0][0].callback_data, sent.id));
  expect((await approval(id)).status).toBe("pending");
});

test("menu balance presses use the existing twenty-action limiter", async () => {
  const tg = telegram(), owner = await h.newKey(), linked = await link(owner);
  for (let index = 0; index < 20; index++) await click(tg, linked, "balance");
  expect(tg.sends()).toHaveLength(20);
  await click(tg, linked, "balance"); expect(tg.sends()).toHaveLength(20);
  expect(tg.calls.at(-1)!.params.text).toContain("Menu unavailable");
});

test("waiting list is bounded to the ten oldest eligible requests", async () => {
  const tg = telegram(), owner = await h.newKey(), agent = await child(owner), linked = await link(owner), ids: string[] = [];
  for (let index = 0; index < 11; index++) {
    const id = await pending(agent); ids.push(id);
    await h.ctx.db.update(agentApprovals).set({ requestedAt: new Date(Date.now() - 60_000 + index * 1000) }).where(eq(agentApprovals.id, id));
  }
  await click(tg, linked, "approvals"); const listed = approvalSends(tg);
  expect(listed).toHaveLength(10); expect(listed.every((sent, index) => sent.params.text.includes(ids[index]))).toBe(true);
  expect(listed.some(sent => sent.params.text.includes(ids[10]))).toBe(false);
});

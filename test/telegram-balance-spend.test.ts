import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { keys, kv, ledger, teamMembers } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { TelegramApi, TelegramBot, type TgUpdate } from "../src/services/telegram.ts";
import { balanceText, handleBalanceSpend, LINK_FIRST, readTelegramSpend, spendText, utcWeekDays } from "../src/telegram/balance-spend.ts";
import { linkKey } from "../src/telegram/linking.ts";
import { startRouter, type Harness } from "./helpers.ts";

const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
const USD = 1_000_000_000_000n;
let h: Harness, off: Harness, sequence = 0, identity = 15200;
beforeAll(async () => {
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN } });
  off = await startRouter();
});
afterAll(async () => { await h?.close(); await off?.close(); });
function message(uid: number, text: string, chat = uid, type = "private"): TgUpdate {
  return { update_id: ++sequence, message: { message_id: sequence, from: { id: uid }, chat: { id: chat, type }, text } };
}
function telegram(router = h) {
  const calls: { method: string; params: any }[] = [];
  const fetchImpl = (async (url: unknown, init: any) => {
    const method = String(url).split("/").at(-1)!;
    calls.push({ method, params: JSON.parse(init.body) });
    return Response.json({ ok: true, result: method === "getUpdates" ? [] : { message_id: sequence } });
  }) as typeof fetch;
  let routerCalls = 0;
  const bot = new TelegramBot(router.ctx, { token: TOKEN, fetch: fetchImpl, pollTimeoutS: 0,
    router: (path, init) => { routerCalls++; return router.app.request(path, init); } });
  return { bot, api: new TelegramApi(TOKEN, fetchImpl), calls, routerCalls: () => routerCalls,
    texts: () => calls.filter(c => c.method === "sendMessage").map(c => c.params.text as string) };
}
const row = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0]!;
async function entry(hash: string, amount: bigint, at: Date, kind = "usage") {
  const key = await row(hash), id = `telegram-spend-${++sequence}`;
  await h.ctx.db.insert(ledger).values({ id, ref: id, accountId: key.accountId, keyHash: hash, amount, kind, createdAt: at });
}
async function child(owner: { auth: Record<string, string> }, name: string) {
  const result = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name } })).json();
  return { hash: result.data.hash as string, auth: { authorization: "Bearer " + result.key } };
}
async function link(tg: ReturnType<typeof telegram>, key: { auth: Record<string, string> }) {
  const uid = ++identity;
  const response = await h.request("/api/v1/telegram/link", { method: "POST", headers: key.auth });
  expect(response.status).toBe(200);
  const code = (await response.json()).data.code;
  await tg.bot.handleUpdate(message(uid, `/link ${code}`));
  expect(tg.texts().at(-1)).toContain("Telegram linked");
  return uid;
}

test("UTC week begins Monday across offsets and year boundaries; text covers empty and short runway", () => {
  expect(utcWeekDays(new Date("2026-10-12T00:00:00Z"))).toBe(1);
  expect(utcWeekDays(new Date("2026-10-12T00:30:00+02:00"))).toBe(7);
  expect(utcWeekDays(new Date("2026-01-01T01:00:00Z"))).toBe(4);
  expect(balanceText({ balance_usd: 4.21, days_left: 12, spend_7d_usd: 2.4, per_day_usd: 2.4 / 7 }))
    .toBe("Balance: $4.21 · lasts about 12 days at your 7-day pace");
  expect(balanceText({ balance_usd: 1, days_left: 1, spend_7d_usd: 7, per_day_usd: 1 })).toContain("about 1 day at");
  expect(balanceText({ balance_usd: 0, days_left: 0, spend_7d_usd: 7, per_day_usd: 1 })).toContain("less than a day");
  expect(balanceText({ balance_usd: 0, days_left: null, spend_7d_usd: 0, per_day_usd: 0 })).toContain("no charged spend");
  expect(spendText({ today: .12, week: 1.4, top: [{ name: "shop-agent", amount: .8 }, { name: "notes-agent", amount: .4 }] }))
    .toBe("Today $0.12 · this week $1.40 · top agents: shop-agent $0.80, notes-agent $0.40");
});

test("unlinked chats, including connected Chat keys, are asked to link; non-private identities are ignored", async () => {
  const tg = telegram(), uid = ++identity;
  const key = await h.newKey();
  await tg.bot.handleUpdate(message(uid, `/key ${key.secret}`));
  for (const command of ["/balance", "/spend@AnyrouteBot"]) {
    await tg.bot.handleUpdate(message(uid, command)); expect(tg.texts().at(-1)).toBe(LINK_FIRST);
  }
  const count = tg.texts().length;
  for (const update of [message(uid, "/balance", uid, "group"), message(uid, "/spend", uid + 1),
    { ...message(uid, "/balance"), message: { ...message(uid, "/balance").message!, from: { id: uid, is_bot: true } } }]) {
    await tg.bot.handleUpdate(update);
  }
  expect(tg.texts()).toHaveLength(count);
  expect(tg.routerCalls()).toBe(1); // Only /key validation; account commands never call a model.
});

test("linked commands match runway and charged-spend APIs for the same account without storing data", async () => {
  const tg = telegram(), owner = await h.newKey(), uid = await link(tg, owner);
  const shop = await child(owner, "shop-agent"), notes = await child(owner, "notes-agent"), other = await h.newKey();
  const at = new Date(Date.now() - 1000);
  await entry(owner.hash, 5_610_000_000_000n, at, "deposit");
  await entry(shop.hash, -800_000_000_000n, at);
  await entry(notes.hash, -400_000_000_000n, at, "tool_call");
  await entry(owner.hash, -200_000_000_000n, at, "data_tool");
  await entry(other.hash, -100n * USD, at);
  const before = await h.ctx.db.select().from(kv);
  const billing = await h.ctx.db.select().from(ledger);
  const runwayResponse = await h.request("/api/v1/account/runway", { headers: owner.auth });
  expect(runwayResponse.status).toBe(200);
  const runway = await runwayResponse.json();
  await tg.bot.handleUpdate(message(uid, "/balance"));
  expect(tg.texts().at(-1)).toBe(balanceText(runway));
  expect(tg.texts().at(-1)).toContain("Balance: $4.21");
  const response = await h.request("/api/v1/agents/spend?days=7", { headers: owner.auth });
  expect(response.status).toBe(200);
  const api = await response.json();
  const monday = api.as_of.slice(0, 10);
  const start = new Date(monday + "T00:00:00Z"); start.setUTCDate(start.getUTCDate() - utcWeekDays(start) + 1);
  const today = api.data.reduce((sum: number, agent: any) => sum + agent.daily.at(-1).charged_usd, 0);
  const week = api.data.reduce((sum: number, agent: any) => sum + agent.daily.filter((day: any) => day.date >= start.toISOString().slice(0, 10)).reduce((n: number, day: any) => n + day.charged_usd, 0), 0);
  const summary = await readTelegramSpend(h.ctx, await row(owner.hash));
  expect(summary.today).toBe(today); expect(summary.week).toBe(week);
  expect(summary.top.slice(0, 2)).toEqual([{ name: "shop-agent", amount: .8 }, { name: "notes-agent", amount: .4 }]);
  await tg.bot.handleUpdate(message(uid, "/spend"));
  expect(tg.texts().at(-1)).toBe(spendText(summary));
  expect(tg.routerCalls()).toBe(0);
  expect(await h.ctx.db.select().from(kv)).toEqual(before);
  expect(await h.ctx.db.select().from(ledger)).toEqual(billing);
});

test("UTC settlement boundaries, charged kinds, top three and names use the existing spend reader", async () => {
  const owner = await h.newKey(), now = new Date("2026-10-11T12:00:00Z");
  const agents = await Promise.all(["shop-agent", "notes-agent", "third-agent", "fourth-agent"].map(name => child(owner, name)));
  const monday = new Date("2026-10-05T00:00:00Z");
  for (const [index, agent] of agents.entries()) await entry(agent.hash, -BigInt(4 - index) * USD, monday);
  await entry(agents[0]!.hash, -USD, new Date("2026-10-11T00:00:00Z"), "tool_call");
  await entry(agents[0]!.hash, -USD, now, "data_tool");
  await entry(agents[0]!.hash, -100n * USD, new Date(monday.getTime() - 1));
  await entry(agents[0]!.hash, -100n * USD, new Date(now.getTime() + 1));
  for (const [kind, amount] of [["refund", USD], ["deposit", USD], ["usage", USD], ["withdrawal", -USD], ["usage", 0n]] as const) await entry(agents[0]!.hash, amount, now, kind);
  expect(await readTelegramSpend(h.ctx, await row(owner.hash), now)).toEqual({ today: 2, week: 12,
    top: [{ name: "shop-agent", amount: 6 }, { name: "notes-agent", amount: 3 }, { name: "third-agent", amount: 2 }] });
  expect((await readTelegramSpend(h.ctx, await row(owner.hash), monday)).today).toBe(10);
  const empty = await h.newKey();
  expect(spendText(await readTelegramSpend(h.ctx, await row(empty.hash), now))).toBe("Today $0.00 · this week $0.00 · top agents: none yet");
});

test("team admin and owner spend matches visible dashboard agents; balance matches account runway", async () => {
  const tg = telegram(), owner = await h.newKey(), foreign = await h.newKey();
  const admin = await child(owner, "team-admin"), peer = await child(owner, "team-agent"), hidden = await child(owner, "hidden-agent");
  for (const key of [admin, peer]) await h.ctx.db.update(keys).set({ teamId: "telegram-team-a" }).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.update(keys).set({ teamId: "telegram-team-b" }).where(eq(keys.keyHash, hidden.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "telegram-team-a", keyHash: admin.hash, role: "admin" });
  const at = new Date(Date.now() - 1000);
  for (const key of [owner, foreign, admin, peer, hidden]) await entry(key.hash, -USD, at);
  const uid = await link(tg, admin);
  for (const role of ["admin", "owner"]) {
    await h.ctx.db.update(teamMembers).set({ role }).where(eq(teamMembers.keyHash, admin.hash));
    const api = await (await h.request("/api/v1/agents/spend?days=7", { headers: admin.auth })).json();
    expect(api.data.map((agent: any) => agent.key_hash).sort()).toEqual([admin.hash, peer.hash].sort());
    const spend = await readTelegramSpend(h.ctx, await row(admin.hash));
    expect(spend.today).toBe(api.data.reduce((sum: number, agent: any) => sum + agent.daily.at(-1).charged_usd, 0));
    expect(spend.week).toBe(2); expect(spend.top.map(agent => agent.name).sort()).toEqual(["team-admin", "team-agent"]);
    await tg.bot.handleUpdate(message(uid, "/spend")); expect(tg.texts().at(-1)).toBe(spendText(spend));
    const runway = await (await h.request("/api/v1/account/runway", { headers: admin.auth })).json();
    await tg.bot.handleUpdate(message(uid, "/balance")); expect(tg.texts().at(-1)).toBe(balanceText(runway));
  }
  await h.ctx.db.update(teamMembers).set({ role: "viewer" }).where(eq(teamMembers.keyHash, admin.hash));
  for (const command of ["/balance", "/spend"]) {
    await tg.bot.handleUpdate(message(uid, command)); expect(tg.texts().at(-1)).toContain("unavailable");
  }
});

test("disabled, expired, inference-only and session authority cannot read; unlink stops commands", async () => {
  const tg = telegram(), owner = await h.newKey(), uid = await link(tg, owner);
  await entry(owner.hash, 4n * USD, new Date(), "deposit");
  await h.ctx.db.update(keys).set({ teamId: "telegram-auth-team" }).where(eq(keys.keyHash, owner.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "telegram-auth-team", keyHash: owner.hash, role: "owner" });
  for (const patch of [{ disabled: true }, { expiresAt: new Date(Date.now() - 1) }, { scope: "inference", management: false }]) {
    await h.ctx.db.update(keys).set(patch).where(eq(keys.keyHash, owner.hash));
    for (const command of ["/balance", "/spend"]) {
      await tg.bot.handleUpdate(message(uid, command)); expect(tg.texts().at(-1)).toContain("unavailable");
      expect(tg.texts().at(-1)).not.toContain("$4.00");
    }
    await h.ctx.db.update(keys).set({ disabled: false, expiresAt: null, scope: null, management: true }).where(eq(keys.keyHash, owner.hash));
  }
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  const saved = (await h.ctx.db.select().from(kv).where(eq(kv.key, linkKey(uid))))[0]!;
  await h.ctx.db.update(kv).set({ value: { ...(saved.value as object), key_hash: session.key_hash } }).where(eq(kv.key, linkKey(uid)));
  for (const command of ["/balance", "/spend"]) {
    await tg.bot.handleUpdate(message(uid, command)); expect(tg.texts().at(-1)).toContain("unavailable");
  }
  await tg.bot.handleUpdate(message(uid, "/unlink"));
  await tg.bot.handleUpdate(message(uid, "/balance")); expect(tg.texts().at(-1)).toBe(LINK_FIRST);
});

test("help and Telegram command menu include both commands only when linking is enabled", async () => {
  const tg = telegram(), disabled = telegram(off), uid = ++identity;
  expect(loadConfig({ ANYROUTE_ENV: "test" }).telegram.linkingEnabled).toBe(false);
  expect(await handleBalanceSpend(off.ctx, disabled.api, message(uid, "/balance"))).toBe(false);
  expect(disabled.calls).toHaveLength(0);
  await tg.bot.handleUpdate(message(uid, "/help"));
  expect(tg.texts().at(-1)).toContain("/balance"); expect(tg.texts().at(-1)).toContain("/spend");
  await disabled.bot.handleUpdate(message(uid, "/help"));
  expect(disabled.texts().at(-1)).not.toContain("/balance"); expect(disabled.texts().at(-1)).not.toContain("/spend");
  await tg.bot.poll(); await disabled.bot.poll();
  const commands = tg.calls.find(call => call.method === "setMyCommands")!.params.commands.map((command: any) => command.command);
  expect(commands).toContain("balance"); expect(commands).toContain("spend");
  const offCommands = disabled.calls.find(call => call.method === "setMyCommands")!.params.commands.map((command: any) => command.command);
  expect(offCommands).not.toContain("balance"); expect(offCommands).not.toContain("spend");
  await disabled.bot.handleUpdate(message(uid, "/spend")); expect(disabled.texts().at(-1)).toContain("don't know that command");
});

test("unlink or team change between reading and sending cannot disclose the earlier summary", async () => {
  for (const change of ["unlink", "team"] as const) {
    const tg = telegram(), owner = await h.newKey(), uid = await link(tg, owner);
    await entry(owner.hash, 9n * USD, new Date(), "deposit");
    const db = new Proxy(h.ctx.db, { get(target, property) {
      if (property === "transaction") return async (...args: Parameters<typeof target.transaction>) => {
        if (change === "unlink") await target.delete(kv).where(eq(kv.key, linkKey(uid)));
        else await target.update(keys).set({ teamId: "changed-team" }).where(eq(keys.keyHash, owner.hash));
        return target.transaction(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await handleBalanceSpend({ ...h.ctx, db }, tg.api, message(uid, "/balance"));
    expect(tg.texts().at(-1)).toBe(change === "unlink" ? LINK_FIRST : "Account spending is unavailable. Check your account link from /agents and try again.");
    expect(tg.texts().at(-1)).not.toContain("$9.00");
  }
});

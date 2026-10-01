import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { runAgentAlerts } from "../src/agents/alert-delivery.ts";
import { eventJson, verifyEventChain } from "../src/agents/store.ts";
import { kv, keys, teamMembers } from "../src/db/schema.ts";
import { codeKey, readLink, consumeCode } from "../src/telegram/linking.ts";
import { deliverTelegramApprovals, notificationKey, linkedAlertTargets } from "../src/telegram/delivery.ts";
import { TelegramApi, TelegramBot, type TgUpdate } from "../src/services/telegram.ts";
const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
let h: Harness;
let uid = 18000, messageId = 1;
beforeAll(async () => { h = await startRouter({ env: { TELEGRAM_LINKING_ENABLED: "true", AGENT_POLICY_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN } }); });
afterAll(async () => { await h?.close(); });
type Key = { hash: string; auth: Record<string, string> };
function telegram() {
  const calls: { method: string; params: any }[] = [];
  const fetch = (async (input: any, init: any) => {
    const method = String(input).split('/').at(-1)!;
    calls.push({ method, params: JSON.parse(init.body) });
    return Response.json({ ok: true, result: method === 'getUpdates' ? [] : { message_id: ++messageId } });
  }) as typeof globalThis.fetch;
  const bot = new TelegramBot(h.ctx, { token: TOKEN, fetch, router: (p, i) => h.app.request(p, i), pollTimeoutS: 0 });
  const api = new TelegramApi(TOKEN, fetch);
  return { calls, fetch, bot, api };
}
const msg = (id: number, text: string): TgUpdate => ({ update_id: ++messageId, message: { message_id: messageId, from: { id }, chat: { type: 'private', id }, text } });
async function issue(key: Key) {
  const res = await h.request('/api/v1/telegram/link', { method: 'POST', headers: key.auth });
  expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
  return (await res.json()).data;
}
async function linked(key: Key, tg: ReturnType<typeof telegram>) {
  const user = ++uid, { code } = await issue(key);
  await tg.bot.handleUpdate(msg(user, `/link ${code}`));
  expect(await readLink(h.ctx.db, user)).toBeDefined();
  return user;
}
const policy = { version: 1, models: {}, caps: {}, approval: { above_usd: 0.000000001 }, on_breach: 'deny', alerts: {} };
const body = { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'Telegram prompt sentinel' }], max_tokens: 32, provider: { only: ['alpha'] } };
async function waiting(key: Key) {
  expect((await h.request(`/api/v1/agents/${key.hash}/policy`, { method: 'PUT', headers: key.auth, json: policy })).status).toBe(200);
  const response = await h.request('/api/v1/chat/completions', { method: 'POST', headers: key.auth, json: body });
  expect(response.status).toBe(403);
  return (await response.json()).error.metadata.approval_id as string;
}
function callback(user: number, tg: ReturnType<typeof telegram>, action = 0, patch: any = {}) {
  const sent = tg.calls.filter(c => c.method === 'sendMessage' && c.params.chat_id === user && c.params.reply_markup).at(-1)!;
  const data = sent.params.reply_markup.inline_keyboard[0][action].callback_data;
  return { update: { update_id: ++messageId, callback_query: { id: 'callback-fixture', from: { id: user }, data, message: { message_id: 0, chat: { type: 'private', id: user } }, ...patch } } as TgUpdate };
}
async function click(user: number, id: string, tg: ReturnType<typeof telegram>, action = 0, patch: any = {}) {
  const link = (await readLink(h.ctx.db, user))!;
  const [saved] = await h.ctx.db.select().from(kv).where(eq(kv.key, notificationKey(id, link)));
  const update = callback(user, tg, action, patch).update;
  update.callback_query!.message!.message_id = (saved.value as any).message_id;
  await tg.bot.handleUpdate(update);
}
async function row(id: string) { return (await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0]; }

test('issue, private consume, hash-only storage, status, code replay and replacement', async () => {
  const key = await h.fundedKey(), tg = telegram();
  const first = await issue(key), second = await issue(key);
  const principal = (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)))[0];
  const [saved] = await h.ctx.db.select().from(kv).where(eq(kv.key, codeKey(principal.accountId)));
  expect(JSON.stringify(saved.value)).not.toContain(second.code);
  expect(Date.parse(second.expires_at) - Date.now()).toBeGreaterThan(290000);
  await expect(consumeCode(h.ctx, ++uid, first.code)).rejects.toThrow(/unavailable/);
  const user = ++uid;
  await tg.bot.handleUpdate(msg(user, `/link ${second.code}`));
  expect(await readLink(h.ctx.db, user)).toMatchObject({ account: principal.accountId, key_hash: key.hash });
  expect(JSON.stringify(await readLink(h.ctx.db, user))).not.toContain(key.secret);
  await expect(consumeCode(h.ctx, ++uid, second.code)).rejects.toThrow(/unavailable/);
  expect((await (await h.request('/api/v1/telegram/link', { headers: key.auth })).json()).data.linked).toBe(true);
  expect(tg.calls.some(c => c.method === 'deleteMessage')).toBe(true);
  expect((await (await h.request('/api/v1/telegram/link', { headers: (await h.fundedKey()).auth })).json()).data.linked).toBe(false);
});
test('expired codes, concurrent single-use and account/identity replacement require unlink', async () => {
  const key = await h.fundedKey(), principal = (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)))[0];
  const expired = await issue(key);
  await h.ctx.db.update(kv).set({ value: { hash: 'unused', account: principal.accountId, key_hash: key.hash, expires: 0 } }).where(eq(kv.key, codeKey(principal.accountId)));
  // Preserve hash so the expiry check, rather than lookup, refuses it.
  const { sha256 } = await import('../src/lib/util.ts');
  await h.ctx.db.update(kv).set({ value: { hash: sha256(expired.code), account: principal.accountId, key_hash: key.hash, expires: Date.now() - 1 } }).where(eq(kv.key, codeKey(principal.accountId)));
  await expect(consumeCode(h.ctx, ++uid, expired.code)).rejects.toThrow(/unavailable/);
  const current = await issue(key);
  const users = [++uid, ++uid];
  const results = await Promise.allSettled(users.map(user => consumeCode(h.ctx, user, current.code)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const other = await issue(key);
  await expect(consumeCode(h.ctx, ++uid, other.code)).rejects.toThrow(/already/);
  const winner = users[results.findIndex(r => r.status === 'fulfilled')];
  const foreign = await issue(await h.fundedKey());
  await expect(consumeCode(h.ctx, winner, foreign.code)).rejects.toThrow(/Unlink/);
});
test('issuance and consumption are rate limited', async () => {
  const key = await h.fundedKey();
  for (let i = 0; i < 5; i++) await issue(key);
  expect((await h.request('/api/v1/telegram/link', { method: 'POST', headers: key.auth })).status).toBe(429);
  const user = ++uid;
  for (let i = 0; i < 10; i++) await expect(consumeCode(h.ctx, user, 'invalid')).rejects.toThrow(/unavailable/);
  await expect(consumeCode(h.ctx, user, 'invalid')).rejects.toThrow(/Too many/);
});
test('member, viewer and session keys cannot link; role and disabled/expired keys are rechecked', async () => {
  const owner = await h.fundedKey();
  const team = (await (await h.request('/api/v1/teams', { method: 'POST', headers: owner.auth, json: { name: 'Telegram permissions' } })).json()).data;
  for (const role of ['member', 'viewer', 'admin']) {
    const child = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { team: team.id, role } })).json();
    const key = { hash: child.data.hash, auth: { authorization: `Bearer ${child.key}` } };
    const res = await h.request('/api/v1/telegram/link', { method: 'POST', headers: key.auth });
    expect(res.status).toBe(role === 'admin' ? 200 : 403);
    if (role === 'admin') {
      const code = (await res.json()).data.code;
      await h.ctx.db.update(teamMembers).set({ role: 'viewer' }).where(eq(teamMembers.keyHash, key.hash));
      await expect(consumeCode(h.ctx, ++uid, code)).rejects.toThrow(/owner\/admin/);
    }
  }
  const session = (await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await h.request('/api/v1/telegram/link', { method: 'POST', headers: { authorization: `Bearer ${session.key}` } })).status).toBe(403);
  for (const change of [{ disabled: true }, { expiresAt: new Date(Date.now() - 1) }]) {
    const key = await h.fundedKey(), code = await issue(key);
    await h.ctx.db.update(keys).set(change).where(eq(keys.keyHash, key.hash));
    await expect(consumeCode(h.ctx, ++uid, code.code)).rejects.toThrow(/unavailable/);
  }
});
test('approve callback follows dashboard events, intent binding and one inference use; polling includes callbacks', async () => {
  const key = await h.fundedKey(), tg = telegram(), user = await linked(key, tg), id = await waiting(key);
  await tg.bot.poll();
  expect(tg.calls.find(c => c.method === 'getUpdates')!.params.allowed_updates).toEqual(['message', 'callback_query']);
  const sent = tg.calls.filter(c => c.method === 'sendMessage' && c.params.reply_markup);
  expect(sent.some(c => c.params.chat_id === user)).toBe(true);
  expect(JSON.stringify(sent)).not.toContain('Telegram prompt sentinel');
  await deliverTelegramApprovals(h.ctx, tg.api);
  expect(tg.calls.filter(c => c.method === 'sendMessage' && c.params.reply_markup && c.params.chat_id === user)).toHaveLength(1);
  await click(user, id, tg);
  expect((await row(id)).status).toBe('approved'); expect((await row(id)).decidedBy).toBe(key.hash);
  expect(tg.calls.some(c => c.method === 'editMessageText' && c.params.text.includes('Status: approved') && c.params.reply_markup.inline_keyboard.length === 0)).toBe(true);
  await click(user, id, tg, 1); expect((await row(id)).status).toBe('approved');
  const headers = { ...key.auth, 'x-agent-approval': id };
  expect((await h.request('/api/v1/chat/completions', { method: 'POST', headers, json: { ...body, max_tokens: 64 } })).status).toBe(403);
  expect((await h.request('/api/v1/chat/completions', { method: 'POST', headers, json: body })).status).toBe(200);
  expect((await h.request('/api/v1/chat/completions', { method: 'POST', headers, json: body })).status).toBe(403);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, key.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(events.filter(e => e.kind === 'approval_approved')).toHaveLength(1);
  expect(events.filter(e => e.kind === 'approval_used')).toHaveLength(1);
  expect(verifyEventChain(events.map(eventJson))).toBe(true);
});
test('deny callback, dashboard outcome sync, expiry and forged messages are refused', async () => {
  for (const action of ['deny', 'dashboard', 'expired', 'forged']) {
    const key = await h.fundedKey(), tg = telegram(), user = await linked(key, tg), id = await waiting(key);
    await deliverTelegramApprovals(h.ctx, tg.api);
    if (action === 'dashboard') {
      expect((await h.request(`/api/v1/agents/approvals/${id}/deny`, { method: 'POST', headers: key.auth })).status).toBe(200);
      await deliverTelegramApprovals(h.ctx, tg.api);
      expect(tg.calls.some(c => c.method === 'editMessageText' && c.params.chat_id === user && c.params.text.includes('Status: denied'))).toBe(true);
    } else if (action === 'forged') {
      const update = callback(user, tg).update; update.callback_query!.message!.message_id = -100;
      await tg.bot.handleUpdate(update); expect((await row(id)).status).toBe('pending');
    } else {
      if (action === 'expired') await h.ctx.db.update(agentApprovals).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(agentApprovals.id, id));
      await click(user, id, tg, 1);
      expect((await row(id)).status).toBe(action === 'deny' ? 'denied' : 'pending');
      if (action === 'expired') expect(tg.calls.at(-1)!.params.text).toContain('no longer pending');
    }
  }
});
test('both unlink paths stop alerts and approvals; old generation buttons and revoked keys fail', async () => {
  for (const via of ['bot', 'api', 'disabled']) {
    const key = await h.fundedKey(), tg = telegram(), user = await linked(key, tg), id = await waiting(key);
    await deliverTelegramApprovals(h.ctx, tg.api);
    const update = callback(user, tg).update;
    const link = (await readLink(h.ctx.db, user))!;
    const [notice] = await h.ctx.db.select().from(kv).where(eq(kv.key, notificationKey(id, link)));
    update.callback_query!.message!.message_id = (notice.value as any).message_id;
    const account = link.account;
    const targets = await linkedAlertTargets(h.ctx, account, key.hash, 'Agent alert metadata', tg.fetch);
    expect(targets).toHaveLength(1); expect(await targets[0].send()).toBe(true);
    if (via === 'bot') await tg.bot.handleUpdate(msg(user, '/unlink'));
    if (via === 'api') expect((await h.request('/api/v1/telegram/link', { method: 'DELETE', headers: key.auth })).status).toBe(200);
    if (via === 'disabled') await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, key.hash));
    expect(await targets[0].send()).toBe(false);
    expect(await linkedAlertTargets(h.ctx, account, key.hash, 'Agent alert metadata', tg.fetch)).toHaveLength(0);
    const before = tg.calls.filter(c => c.method === 'sendMessage' && c.params.reply_markup && c.params.chat_id === user).length;
    await deliverTelegramApprovals(h.ctx, tg.api);
    expect(tg.calls.filter(c => c.method === 'sendMessage' && c.params.reply_markup && c.params.chat_id === user)).toHaveLength(before);
    if (via !== 'disabled') { const code = await issue(key); await tg.bot.handleUpdate(msg(user, `/link ${code.code}`)); }
    await tg.bot.handleUpdate(update); expect((await row(id)).status).toBe('pending');
  }
});
test('flag off hides linking endpoints and leaves legacy bot commands/poll behavior unchanged', async () => {
  const off = await startRouter();
  try {
    const key = await off.fundedKey();
    for (const method of ['GET', 'POST', 'DELETE']) expect((await off.request('/api/v1/telegram/link', { method, headers: key.auth })).status).toBe(404);
    const tg = telegram(), bot = new TelegramBot(off.ctx, { token: TOKEN, fetch: tg.fetch, router: (p, i) => off.app.request(p, i), pollTimeoutS: 0 });
    await bot.handleUpdate(msg(++uid, '/link anything'));
    expect(tg.calls.at(-1)!.params.text).toContain("don't know that command");
    await bot.poll(); expect(tg.calls.find(c => c.method === 'getUpdates')!.params.allowed_updates).toEqual(['message']);
  } finally { await off.close(); }
});

test('existing alert worker delivers through account links without a chat key and stops after unlink', async () => {
  const key = await h.fundedKey(), tg = telegram(), user = await linked(key, tg);
  await waiting(key);
  await runAgentAlerts(h.ctx, { telegramFetch: tg.fetch });
  expect(tg.calls.some(c => c.method === 'sendMessage' && c.params.chat_id === user && c.params.text.includes('AnyRoute agent alert: approval'))).toBe(true);
  await tg.bot.handleUpdate(msg(user, '/unlink'));
  const before = tg.calls.filter(c => c.method === 'sendMessage' && c.params.chat_id === user).length;
  await runAgentAlerts(h.ctx, { telegramFetch: tg.fetch });
  expect(tg.calls.filter(c => c.method === 'sendMessage' && c.params.chat_id === user)).toHaveLength(before);
});
test('team admin link sees only its team and callback role/scope is rechecked', async () => {
  const owner = await h.fundedKey(), tg = telegram();
  const team = (await (await h.request('/api/v1/teams', { method: 'POST', headers: owner.auth, json: { name: 'Telegram scope' } })).json()).data;
  const create = async (options: any) => {
    const child = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: options })).json();
    return { hash: child.data.hash, auth: { authorization: `Bearer ${child.key}` } };
  };
  const admin = await create({ team: team.id, role: 'admin' }), agent = await create({ team: team.id });
  const user = await linked(admin, tg), outside = await waiting(owner);
  expect((await h.request(`/api/v1/agents/${agent.hash}/policy`, { method: 'PUT', headers: owner.auth, json: policy })).status).toBe(200);
  const response = await h.request('/api/v1/chat/completions', { method: 'POST', headers: agent.auth, json: body });
  const id = (await response.json()).error.metadata.approval_id;
  await deliverTelegramApprovals(h.ctx, tg.api);
  const notices = tg.calls.filter(c => c.method === 'sendMessage' && c.params.chat_id === user && c.params.reply_markup);
  expect(notices).toHaveLength(1); expect(notices[0].params.text).toContain(id); expect(notices[0].params.text).not.toContain(outside);
  expect(await linkedAlertTargets(h.ctx, (await readLink(h.ctx.db, user))!.account, owner.hash, 'Scope alert', tg.fetch)).toHaveLength(0);
  const forged = callback(user, tg).update;
  const link = (await readLink(h.ctx.db, user))!;
  const [notice] = await h.ctx.db.select().from(kv).where(eq(kv.key, notificationKey(id, link)));
  forged.callback_query!.message!.message_id = (notice.value as any).message_id;
  forged.callback_query!.data = `tg:a:${outside}:${link.generation}`;
  await tg.bot.handleUpdate(forged); expect((await row(outside)).status).toBe('pending');
  await h.ctx.db.update(teamMembers).set({ role: 'viewer' }).where(eq(teamMembers.keyHash, admin.hash));
  await click(user, id, tg); expect((await row(id)).status).toBe('pending');
});

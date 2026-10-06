import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { agentApprovals } from '../src/agents/approval-schema.ts';
import { consumeCode } from '../src/telegram/linking.ts';
import { approvalText, deliverTelegramApprovals } from '../src/telegram/delivery.ts';
import { TelegramApi } from '../src/services/telegram.ts';
import { startRouter } from './helpers.ts';

const TOKEN = '123456789:AAFixtureTokenFixtureToken0123456789';
const policy = { version: 1, models: {}, caps: { per_request_usd: 0.005 }, approval: { above_usd: 0.001 }, actions: { allow: ['payment.send'], per_action_usd: 20, approval_above_usd: 5 }, on_breach: 'deny' };
test('plain Telegram wording defaults off, and policy routes remain off by default', async () => {
  expect(loadConfig({}).agentRulebookWordsEnabled).toBe(false);
  const h = await startRouter();
  try {
    const key = await h.fundedKey();
    expect((await h.request('/api/v1/agents', { headers: key.auth })).status).toBe(404);
    expect((await h.request('/api/v1/agents/approvals', { headers: key.auth })).status).toBe(404);
  } finally { await h.close(); }
});
for (const enabled of [false, true]) test(`Telegram delivery and authenticated policy access, words enabled=${enabled}`, async () => {
  const h = await startRouter({ env: { AGENT_POLICY_ENABLED: 'true', TELEGRAM_LINKING_ENABLED: 'true', TELEGRAM_BOT_TOKEN: TOKEN, AGENT_RULEBOOK_WORDS_ENABLED: String(enabled), AGENT_GUARD_ENABLED: 'true' } });
  try {
    const owner = await h.fundedKey(); const foreign = await h.fundedKey();
    expect((await h.request(`/api/v1/agents/${owner.hash}/policy`, { method: 'PUT', headers: owner.auth, json: policy })).status).toBe(200);
    expect((await h.request('/api/v1/agents')).status).toBe(401);
    expect((await h.request('/api/v1/agents/approvals')).status).toBe(401);
    expect((await h.request(`/api/v1/agents/${owner.hash}/policy`, { headers: foreign.auth })).status).toBe(404);
    const list = await (await h.request('/api/v1/agents', { headers: foreign.auth })).json();
    expect(list.data.some((row: any) => row.key_hash === owner.hash)).toBe(false);
    const ownedAgents = await (await h.request('/api/v1/agents', { headers: owner.auth })).json();
    const own = await (await h.request(`/api/v1/agents/${owner.hash}/policy`, { headers: owner.auth })).json();
    expect(own.data.policy).toEqual(policy); // No field or API response changes.
    const link = await (await h.request('/api/v1/telegram/link', { method: 'POST', headers: owner.auth })).json();
    await consumeCode(h.ctx, enabled ? 22402 : 22401, link.data.code);
    const [row] = await h.ctx.db.insert(agentApprovals).values({ id: randomBytes(18).toString('base64url'), keyHash: owner.hash, intent: { kind: 'action', action: 'payment.send', amount_pico: '6000000000000' }, intentHash: 'sha256:' + 'ab'.repeat(32), maxCostPico: 6000000000000n, expiresAt: new Date(Date.now() + 900000) }).returning();
    const sent: any[] = [];
    const api = new TelegramApi(TOKEN, (async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: 124 } }); }) as typeof fetch);
    await deliverTelegramApprovals(h.ctx, api);
    expect(sent).toHaveLength(1);
    if (enabled) {
      expect(sent[0].text).toContain('Rulebook: up to $20 a payment; asks above $5');
      expect(sent[0].text).toContain('amount: $6');
      expect(sent[0].text).not.toContain('{');
      expect(sent[0].reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Approve', 'Deny']);
    } else expect(sent[0].text).toBe(approvalText(row, ownedAgents.data.find((a: any) => a.key_hash === owner.hash).name ?? undefined, own.data.sha256, true));
    expect((await h.request(`/api/v1/agents/approvals/${row.id}/approve`, { method: 'POST', headers: foreign.auth })).status).toBe(404);
  } finally { await h.close(); }
});

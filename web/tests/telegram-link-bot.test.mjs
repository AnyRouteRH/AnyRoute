import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { botUsername, issueTelegramLink } from '../lib/telegram-linking.js';

const code = 'AbCdEfGhIjKlMnOp';
const expires_at = new Date(Date.now() + 300000).toISOString();
const issued = data => issueTelegramLink(async () => ({ data: { code, expires_at, ...data } }));

test('the bot username and start link pass through only in the exact form the router sends', async () => {
  assert.equal(botUsername('SampleLinkBot'), 'SampleLinkBot');
  for (const bad of ['@SampleLinkBot', 'a b', 'x', null, 7]) assert.equal(botUsername(bad), null);
  const link_url = `https://t.me/SampleLinkBot?start=link-${code}`;
  assert.deepEqual(await issued({ bot_username: 'SampleLinkBot', link_url }), { code, expires_at, bot_username: 'SampleLinkBot', link_url });
  assert.equal((await issued({ bot_username: 'SampleLinkBot', link_url: 'https://example.com/elsewhere' })).link_url, null);
  assert.deepEqual(await issued({}), { code, expires_at });
});

test('the link panel names the bot, opens it in one tap and keeps the copyable /link fallback', () => {
  const panel = readFileSync(new URL('../app/agents/TelegramLink.jsx', import.meta.url), 'utf8');
  assert.match(panel, /Open @\{code\.bot_username\} in Telegram/);
  assert.match(panel, /Copy \/link code/);
  assert.match(panel, /rel="noopener noreferrer"/);
  const docs = readFileSync(new URL('../components/AgentApprovalDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /@TryAnyrouteBot/);
});

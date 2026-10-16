// J179
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TASKS } from '../lib/site-map.js';

test('Telegram menu is discoverable with existing account destinations and honest permission limits', () => {
  assert.equal(TASKS.find(task => task.id === 'telegram-menu').href, '/docs/#telegram-menu');
  const docs = readFileSync(new URL('../components/TelegramMenuDocs.jsx', import.meta.url), 'utf8');
  for (const wording of ['id="telegram-menu"', '@TryAnyrouteBot', 'Waiting approvals', '/stopall', '/startall', 'single-use', 'Approval-only', 'No new HTTP endpoint', 'Telegram can read']) assert.ok(docs.includes(wording), wording);
  assert.match(readFileSync(new URL('../app/docs/page.jsx', import.meta.url), 'utf8'), /<TelegramMenuDocs \/>/);
  assert.match(readFileSync(new URL('../components/DocsFeatureIndex.jsx', import.meta.url), 'utf8'), /\["telegram-menu", "One Telegram menu"\]/);
});

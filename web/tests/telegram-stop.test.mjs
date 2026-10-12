// G163
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TASKS } from '../lib/site-map.js';

test('Telegram Stop is discoverable and documents UTC, authority and execution limits', () => {
  assert.equal(TASKS.find(task => task.id === 'telegram-stop').href, '/docs/#telegram-stop');
  const docs = readFileSync(new URL('../components/TelegramStopDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /id="telegram-stop"/);
  for (const wording of ['09:00 tomorrow UTC', 'read-only', 'inference-only', 'session keys', 'Approval-only', 'already running', 'outside Anyroute', 'notification settings', 'retention policies']) assert.ok(docs.includes(wording), wording);
  const page = readFileSync(new URL('../app/docs/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /<TelegramStopDocs \/>/);
  const index = readFileSync(new URL('../components/DocsFeatureIndex.jsx', import.meta.url), 'utf8');
  assert.match(index, /\["telegram-stop", "Stop an agent from Telegram"\]/);
});

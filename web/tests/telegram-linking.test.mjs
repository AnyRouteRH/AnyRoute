import test from 'node:test';
import assert from 'node:assert/strict';
import { readTelegramLink, issueTelegramLink, unlinkTelegram } from '../lib/telegram-linking.js';
test('link UI reads status, issues a code, and unlinks on the authenticated endpoint', async () => {
  const calls = [], code = 'abcdefghijklmnop', expires_at = '2026-10-01T12:05:00Z';
  const request = async (path, options) => {
    calls.push([path, options]);
    return { data: options?.method === 'POST' ? { code, expires_at } : { linked: options?.method !== 'DELETE' } };
  };
  assert.equal((await readTelegramLink(request)).linked, true);
  assert.deepEqual(await issueTelegramLink(request), { code, expires_at });
  assert.equal((await unlinkTelegram(request)).data.linked, false);
  assert.deepEqual(calls, [['/api/v1/telegram/link', {}], ['/api/v1/telegram/link', { method: 'POST' }], ['/api/v1/telegram/link', { method: 'DELETE' }]]);
});
test('invalid status and link codes do not render credentials or an incorrect linked status', async () => {
  await assert.rejects(readTelegramLink(async () => ({ data: {} })), /status could not be read/);
  for (const data of [{ code: 'bad', expires_at: '2026-10-01' }, { code: 'abcdefghijklmnop', expires_at: 'invalid' }, {}]) await assert.rejects(issueTelegramLink(async () => ({ data })), /code could not be read/);
});
test('disabled and forbidden responses propagate so the UI hides an off feature and reports role errors', async () => {
  for (const status of [404, 403]) {
    const error = Object.assign(new Error('Unavailable'), { status });
    await assert.rejects(readTelegramLink(async () => { throw error; }), actual => actual === error);
  }
});

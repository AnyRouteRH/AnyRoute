import test from 'node:test';
import assert from 'node:assert/strict';
import { readWeeklySummaryPreference, setWeeklySummaryPreference } from '../lib/weekly-summary.js';
test('weekly summary reads and saves only the authenticated opt-in preference', async () => {
  const calls = [], signal = new AbortController().signal;
  const request = async (path, options) => {
    calls.push([path, options]);
    return { data: { opted_in: options.body?.opted_in ?? false, last_sent_week: null } };
  };
  assert.equal((await readWeeklySummaryPreference(request, { signal })).opted_in, false);
  assert.equal((await setWeeklySummaryPreference(request, true, { signal })).opted_in, true);
  assert.equal((await setWeeklySummaryPreference(request, false)).opted_in, false);
  assert.deepEqual(calls, [['/api/v1/telegram/weekly-summary', { signal }], ['/api/v1/telegram/weekly-summary', { signal, method: 'PUT', body: { opted_in: true } }], ['/api/v1/telegram/weekly-summary', { method: 'PUT', body: { opted_in: false } }]]);
});
test('invalid preferences fail visibly; off and forbidden responses preserve status', async () => {
  for (const data of [{}, { opted_in: 'yes', last_sent_week: null }, { opted_in: true, last_sent_week: 'invalid' }]) await assert.rejects(readWeeklySummaryPreference(async () => ({ data })), /setting could not be read/);
  for (const status of [404, 403, 409]) {
    const error = Object.assign(new Error('Unavailable'), { status });
    await assert.rejects(readWeeklySummaryPreference(async () => { throw error; }), e => e === error);
  }
});

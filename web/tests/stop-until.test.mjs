// B117: local presets, legacy request bytes, and the shared keyboard-accessible control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STOP_PRESETS, stopUntil, stoppedLabel } from '../lib/stop-until.js';
import { confirmKill, decisionText } from '../lib/agents.js';
import { alertLabel } from '../lib/agent-alerts.js';
import { runAgentCommand } from '../lib/site-actions.js';

test('presets use local calendar tomorrow at 9 across the DST boundary', () => {
  const previous = process.env.TZ; process.env.TZ = 'America/Toronto';
  try {
    const now = new Date('2026-10-31T23:30:00-04:00');
    assert.equal(stopUntil('hour', now), '2026-11-01T04:30:00.000Z');
    assert.equal(stopUntil('tomorrow', now), '2026-11-01T14:00:00.000Z');
    assert.equal(stopUntil('manual', now), undefined);
    assert.equal(new Date(stopUntil('tomorrow', now)).getHours(), 9);
    assert.equal(stoppedLabel('2026-11-01T19:05:00Z', new Date('2026-11-01T08:00:00-05:00')), 'Stopped until 14:05');
    assert.equal(stoppedLabel('2026-11-01T14:00:00Z', now), 'Stopped until tomorrow 09:00');
    assert.equal(stoppedLabel(null), 'Stopped until you resume');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('timed confirmation sends ISO until; cancellation sends nothing and legacy stop is unchanged', async () => {
  const calls = [], agent = { name: 'Research', key_hash: 'a'.repeat(64) }, until = '2026-11-01T14:00:00.000Z';
  const request = async (...args) => calls.push(args);
  assert.equal(await confirmKill(agent, '', () => false, request, until), false); assert.equal(calls.length, 0);
  assert.equal(await confirmKill(agent, ' review ', message => { assert.match(message, /until/); return true; }, request, until), true);
  assert.deepEqual(calls[0][1], { method: 'POST', body: { reason: 'review', until } });
  await confirmKill(agent, '', () => true, request); assert.deepEqual(calls[1][1].body, {});
  await runAgentCommand('stop', agent, request, { confirmed: true, signedIn: true, until }); assert.deepEqual(calls[2][1].body, { until });
  assert.equal(decisionText('resume'), 'Resumed');
  assert.match(alertLabel({ kind: 'killed', stopped_until: until }), /until/);
});
test('Stop menu reuses UI components and offers all presets with Escape and focus return', () => {
  assert.deepEqual(STOP_PRESETS.map(p => p[1]), ['Stop for 1 hour', 'Stop until tomorrow 9:00', 'Stop until I resume']);
  const source = readFileSync(new URL('../components/limits/StopMenu.jsx', import.meta.url), 'utf8');
  assert.match(source, /aria-expanded/); assert.match(source, /type="button"/); assert.match(source, /Escape/); assert.match(source, /\.focus\(\)/); assert.match(source, /stopUntil\(preset\)/);
  const css = readFileSync(new URL('../components/limits/StopMenu.module.css', import.meta.url), 'utf8'); assert.match(css, /width: 100%/); assert.match(css, /min-height: 44px/); assert.match(css, /focus-visible/);
});

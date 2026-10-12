import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultWorkHours, applyWorkHours } from '../lib/work-hours.js';
import { limitsFromRulebook, rulebookFromLimits } from '../lib/spending-limits.js';
import { rulebookWords } from '../lib/rulebook-words.js';
import { TASKS } from '../lib/site-map.js';
const base = { version: 1, models: {}, caps: {}, on_breach: 'deny' };
test('work hours survive spending edits and can be disabled; absent hours stay absent', () => {
  const p = { ...base, work_hours: defaultWorkHours() }, form = limitsFromRulebook(p);
  assert.deepEqual(rulebookFromLimits(form), { policy: p, errors: [] });
  form.caps.per_day_usd = '2'; assert.deepEqual(rulebookFromLimits(form).policy.work_hours, p.work_hours);
  form.workHours = undefined; assert.ok(!Object.hasOwn(rulebookFromLimits(form).policy, 'work_hours'));
  assert.deepEqual(rulebookFromLimits(limitsFromRulebook(base)).policy, base);
});
test('work hour validation agrees with strict days, clocks, zone and mode constraints', () => {
  for (const patch of [{ days: [] }, { days: [1,1] }, { days: [7] }, { start: '9:00' }, { end: '09:00' }, { time_zone: 'Mars/Nowhere' }, { outside: 'allow' }]) {
    const errors = []; applyWorkHours({}, { ...defaultWorkHours(), ...patch }, errors); assert.ok(errors.length);
  }
});
test('sentences cover zone and overnight hours, and docs/search expose the existing editor', () => {
  const p = { ...base, work_hours: { ...defaultWorkHours(), start: '22:00', end: '06:00', outside: 'ask_first' } };
  assert.ok(rulebookWords(p).includes('Works Monday to Friday, 22:00 to 6:00 New York time (ends the following day); asks first outside those hours'));
  assert.ok(TASKS.some(t => t.id === 'work-hours' && t.href === '/docs/#work-hours'));
  const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  assert.match(read('app/agents/Agents.jsx'), /<WorkHours value=\{form.workHours\}/);
  assert.match(read('app/agents/WorkHours.jsx'), /<LimitGroup title="Work hours" disabled=\{disabled\}/);
  assert.match(read('app/agents/WorkHours.jsx'), /aria-label="Work days"/);
  assert.match(read('app/docs/page.jsx'), /<WorkHoursDocs \/>/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scheduleDraft, failureWords, approvedScheduleRequests } from '../lib/schedules.js';
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS, TASKS } from '../lib/site-map.js';
import { sectionFromHash } from '../components/account/account-state.js';
test('Schedules is an account tab and searchable destination with a stable deep link', () => {
  assert.deepEqual(ACCOUNT_GROUPS.find(group => group.id === 'schedules').ids, ['schedules']);
  assert.equal(ACCOUNT_SECTIONS.find(section => section.taskId === 'schedules').href, '/dashboard/#schedules');
  assert.equal(sectionFromHash('#schedules'), 'Schedules');
  assert(TASKS.some(task => task.id === 'schedules'));
});
test('editing sends only accepted fields and retains the exact cost ceiling', () => {
  const row = { id: 'saved', name: 'Morning', prompt: 'Write a note', model: 'text/model', key_hash: 'paying-key', cadence: 'hourly', time_utc: null, max_cost_usd: '0.05', paused: false, next_at: 'future', consecutive_failures: 2 };
  const draft = scheduleDraft(row);
  assert.equal(draft.max_cost_usd, '0.05'); assert.equal(draft.time_utc, null);
  assert.equal(draft.prompt, row.prompt); assert(!('id' in draft)); assert(!('consecutive_failures' in draft));
});
test('failure copy is plain and approvals are scoped to the paying key and their expiry', () => {
  assert.match(failureWords('schedule_max_cost'), /maximum cost/);
  assert.match(failureWords('agent_approval_required'), /Inbox/);
  assert(!failureWords('provider_error').includes('provider_error'));
  const future = new Date(Date.now() + 600000).toISOString();
  const approvals = [{ id: 'yes', key_hash: 'paying-key', status: 'approved', expires_at: future }, { id: 'other', key_hash: 'other-key', status: 'approved', expires_at: future }, { id: 'expired', key_hash: 'paying-key', status: 'approved', expires_at: '2020-01-01T00:00:00Z' }, { id: 'pending', key_hash: 'paying-key', status: 'pending', expires_at: future }];
  assert.deepEqual(approvedScheduleRequests(approvals, { key_hash: 'paying-key' }).map(item => item.id), ['yes']);
});
test('form labels, mobile layout, privacy disclosure and OpenAPI match the schedule contract', () => {
  const source = readFileSync(new URL('../components/account/AccountSchedules.jsx', import.meta.url), 'utf8');
  for (const id of ['name', 'prompt', 'model', 'key', 'cadence', 'time', 'cost']) { assert(source.includes(`htmlFor="schedule-${id}"`)); assert(source.includes(`id="schedule-${id}"`)); }
  assert.match(source, /max_cost_usd: '0.05'/); assert.match(source, /last ten replies encrypted at rest/); assert.match(source, /not switched on yet/);
  assert.match(source, /role="alert"/); assert(!source.includes('localStorage'));
  const css = readFileSync(new URL('../components/account/Schedules.module.css', import.meta.url), 'utf8');
  assert.match(css, /max-width: 600px/); assert.match(css, /focus-visible/); assert.match(css, /var\(--ink\)/);
  const api = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  for (const [path, methods] of Object.entries({ '/api/v1/schedules': ['get', 'post'], '/api/v1/schedules/{id}': ['get', 'patch', 'delete'], '/api/v1/schedules/{id}/run-now': ['post'], '/api/v1/schedules/{id}/runs': ['get'] })) for (const method of methods) assert.deepEqual(api.paths[path][method].security, [{ BearerAuth: [] }]);
  assert(api.components.schemas.ScheduledPromptInput.required.includes('max_cost_usd'));
});

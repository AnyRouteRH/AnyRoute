import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WHY_TYPES, whyExplanation, whyQuery } from '../lib/why-refused.js';
import WhyView from '../components/WhyView.js';
import { TASKS } from '../lib/site-map.js';
const render = props => renderToStaticMarkup(createElement(WhyView, props));
for (const [type, explanation] of Object.entries(WHY_TYPES)) test(`${type} renders a plain explanation and an existing settings link signed out`, () => {
  const html = render({ explanation });
  assert.ok(html.includes(explanation.title.replaceAll('’', '’')));
  assert.ok(html.includes('href="' + explanation.href + '"'));
  assert.match(html, /Connect your account management key/);
  assert.doesNotMatch(html, /Your recorded request/);
});
test('owner details render as words and links; signed-out render drops all supplied details', () => {
  const details = { recorded_at: '2026-10-19T12:00:00Z', reasons: [{ text: 'A saved rule refused this request.', href: '/agents/?agent=sample-agent#agent-status-hours', action: 'Change work hours' }], facts: ['Estimated request cost: $2'], rules: ['Up to $1 a request'], note: 'Rules may have changed.' };
  const props = { explanation: whyExplanation('agent_policy_denied'), details };
  const owner = render({ ...props, signedIn: true });
  for (const text of ['Your recorded request', 'Estimated request cost: $2', 'Up to $1 a request', 'Change work hours']) assert.ok(owner.includes(text));
  const publicHtml = render(props);
  for (const text of ['sample-agent', '$2', '$1', 'saved rule refused', 'Rules may have changed']) assert.ok(!publicHtml.includes(text));
});
test('query parsing never reflects arbitrary input and unknown types use a generic explanation', () => {
  assert.deepEqual(whyQuery('?type=read_only_key&id=123'), { type: 'read_only_key', id: '123' });
  for (const type of ['<script>bad</script>', '__proto__', 'constructor', 'account-private-value']) {
    assert.equal(whyQuery('?type=' + encodeURIComponent(type)).type, '');
    assert.equal(whyExplanation(type).title, 'Why a request was refused');
  }
  assert.equal(whyQuery('?type=read_only_key&id=' + encodeURIComponent('https://other.invalid')).id, '');
});
test('page uses account identity guards, aborts stale reads, and registers docs, search and API', () => {
  const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
  const page = read('../app/why/Why.jsx');
  assert.match(page, /AccountShell publicContent/); assert.match(page, /useAccountKey/);
  assert.match(page, /state\?\.key === key/); assert.match(page, /state\?\.id === query.id/); assert.match(page, /state\?\.type === query.type/); assert.match(page, /controller.abort\(\)/);
  assert.match(read('../components/WhyRefusedDocs.jsx'), /id="why-refused"/);
  assert.ok(TASKS.some(task => task.id === 'why-refused'));
  const spec = JSON.parse(read('../public/openapi.json'));
  assert.equal(spec.paths['/api/v1/refusals/{id}'].get.operationId, 'refusalDetails');
  assert.equal(spec.components.schemas.ApiError.properties.error.properties.help_url.type, 'string');
});

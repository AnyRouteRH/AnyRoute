import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
test('agent agreements tab calls party APIs and renders evidence, per-model verdicts and receipt links', () => {
  const tab=read('app/agents/AgentWorkspace.jsx'),view=read('app/agents/Agreements.jsx');
  assert.match(tab,/aria-selected=\{tab === 'agreements'\}/);
  for(const value of ['/api/v1/agreements','/evidence','Router-run jury','statement.votes','receipt_id','/verify/?id=','No automatic']) {
    if(value==='No automatic') assert.ok(view.includes('no automatic ruling')); else assert.ok(view.includes(value),value);
  }
  assert.match(view,/AbortController/); assert.match(view,/JSON\.parse\(content\)/);
  assert.ok(view.includes('Both parties and the router can read uploaded evidence'));
  assert.ok(view.includes('contracts') || view.includes('Contracts'));
});
test('agreements docs and OpenAPI describe disabled flags, jury trust, retention and parties', () => {
  const docs=read('components/AgreementsDocs.jsx');
  for(const value of ['id="agreements"','AGENT_AGREEMENTS_ENABLED defaults to false','AGENT_AGREEMENTS_RULINGS_ENABLED defaults to false','router reads evidence','panel','AGREEMENT_RETENTION_DAYS','deployed on Robinhood Chain','Automatic jury rulings are switched on','AGREEMENT_JURY_SIGNER_KEYS']) assert.ok(docs.includes(value),value);
  assert.match(read('app/docs/page.jsx'),/<AgreementsDocs \/>/);
  const spec=JSON.parse(read('public/openapi.json'));
  for(const path of ['/api/v1/agreements','/api/v1/agreements/prepare','/api/v1/agreements/{id}','/api/v1/agreements/{id}/evidence']) assert.ok(spec.paths[path]);
  for(const word of ['demo','mock','simulated','placeholder','local-build']) assert.equal(docs.toLowerCase().includes(word),false);
});

import { policyForm, buildPolicy } from '../lib/agents.js';
test('editing other rulebook fields preserves agreement limits including an empty allowlist', () => {
  const agreements = { max_escrow_usd: 5, counterparties_allow: [] };
  const form = policyForm({ version:1, models:{}, caps:{}, on_breach:'deny', agreements });
  const result = buildPolicy(form);
  assert.deepEqual(result.errors, []); assert.deepEqual(result.policy.agreements, agreements);
  assert.notEqual(result.policy.agreements, agreements);
});

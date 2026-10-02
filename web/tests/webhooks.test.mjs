import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventLabel, signingLabel } from '../lib/webhooks.js';
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS, TASKS } from '../lib/site-map.js';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';
const source = readFileSync(new URL('../components/WebhookDocs.jsx', import.meta.url), 'utf8');
test('standard library verification example checks exact bytes, time and signed id', () => {
  const code = source.split('export const typescriptVerification = `')[1].split('`;')[0].replaceAll('\\\\','\\');
  const javascript = code.replace(': string', '').replaceAll(': string','').replace(': Buffer','').replace(/import[^;]+;/, '');
  const sandbox = { createHmac, Buffer };
  // The signature verifier's TypeScript parameters are the only type annotations.
  return import('node:crypto').then(({timingSafeEqual}) => {
    sandbox.timingSafeEqual = timingSafeEqual;
    vm.createContext(sandbox); vm.runInContext(javascript,sandbox);
    const body = Buffer.from('{"event_id":"event_1"}'), t = 1700000000;
    const signature = 't='+t+',v1='+createHmac('sha256','fixture-secret').update(t+'.').update(body).digest('hex');
    assert.equal(sandbox.verify('fixture-secret',body,signature,'event_1',t),true);
    assert.equal(sandbox.verify('fixture-secret',body,signature,'tampered',t),false);
    assert.equal(sandbox.verify('fixture-secret',body,signature,'event_1',t+301),false);
    assert.equal(sandbox.verify('fixture-secret',Buffer.concat([body,Buffer.from(' ')]),signature,'event_1',t),false);
  });
});
test('webhook page uses the shared Account group and search-only task', () => {
  assert.ok(ACCOUNT_GROUPS.find(g => g.title === 'Account').ids.includes('webhooks'));
  assert.equal(TASKS.find(t => t.id === 'webhooks').menu,false);
  assert.equal(ACCOUNT_SECTIONS.find(t => t.taskId === 'webhooks').href,'/dashboard/webhooks/');
  assert.equal(eventLabel('approval.decided'),'Approval decided');
  assert.match(signingLabel('unsigned'),/Unsigned/);
});
test('secret UI avoids browser persistence and docs describe bounded delivery', () => {
  const client = readFileSync(new URL('../components/account/Webhooks.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(client,/localStorage|sessionStorage|console\./);
  assert.match(client,/Manager key=\{key\}/);
  assert.match(source,/five minutes/); assert.match(source,/atomically/); assert.match(source,/same transaction/); assert.match(source,/switched on at anyroute\.tech/);
  assert.match(source,/hmac.compare_digest/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TASKS, menuTasks } from '../lib/site-map.js';
const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
const docs = readFileSync(new URL('../components/IdempotencyDocs.jsx', import.meta.url), 'utf8');
test('D145 documents all six opt-in inference endpoints and replay headers', () => {
  for (const path of ['chat/completions', 'completions', 'messages', 'responses', 'embeddings', 'rerank']) {
    const op = spec.paths[`/api/v1/${path}`].post;
    const header = op.parameters.find(p => p.name === 'Idempotency-Key');
    assert.equal(header.required, false);
    assert.equal(header.schema.maxLength, 128);
    assert.equal(header.schema.pattern, '^[!-~]{1,128}$');
    assert.ok(op.responses['422']);
    assert.ok(op.responses['409']);
    assert.ok(op.responses['200'].headers['Idempotent-Replay']);
    assert.ok(docs.includes(`/api/v1/${path}`));
  }
});
test('D145 explains content retention, streaming, expiry and memory limits in plain text', () => {
  for (const text of ['id="idempotency"', '24 hours', 'router reads ordinary requests and replies', 'idempotency_in_progress', 'idempotency_key_reused', 'idempotency_result_not_kept', 'ends at restart', 'blind tokens cannot opt in']) assert.ok(docs.includes(text), text);
  const task = TASKS.find(t => t.id === 'idempotency');
  assert.equal(task.href, '/docs/#idempotency');
  assert.ok(!menuTasks('build').includes(task));
});

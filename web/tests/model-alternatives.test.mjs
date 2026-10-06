import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { api, streamChat } from '../lib/api.js';
import { alternativeRetry, suggestedModels } from '../lib/model-alternatives.js';
const choice = { id: 'acme/available', name: 'Available', prompt_price: '0.000001', completion_price: '0.000002', why: 'Same abilities: reads images, uses tools' };
const envelope = { error: { code: 502, type: 'providers_unavailable', message: 'All providers failed.' }, suggested_models: [choice] };
async function withFetch(response, task) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  try { await task(); } finally { globalThis.fetch = original; }
}

test('HTTP and streamed availability errors preserve suggestions and the original error', async () => {
  for (const streaming of [false, true]) {
    const response = streaming
      ? new Response(`data: ${JSON.stringify(envelope)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : Response.json(envelope, { status: 502 });
    await withFetch(response, async () => {
      await assert.rejects(() => streaming ? streamChat({ key: 'sample-key', body: { model: 'acme/source', messages: [] } }) : api('/api/v1/chat/completions'), error => {
        assert.equal(error.status, 502);
        assert.equal(error.message, envelope.error.message);
        assert.equal(error.type, 'providers_unavailable');
        assert.deepEqual(suggestedModels(error.suggested_models), [choice]);
        return true;
      });
    });
  }
});

test('bounded choices reject malformed entries and duplicates; ordinary errors offer nothing', () => {
  assert.deepEqual(suggestedModels(undefined), []);
  assert.deepEqual(suggestedModels([null, {}, choice, choice, ...Array.from({ length: 5 }, (_, i) => ({ ...choice, id: `acme/${i}` }))]).map(m => m.id), ['acme/available', 'acme/0', 'acme/1']);
});

test('a chosen alternative keeps the same conversation, image attachments and tool results', () => {
  const history = [
    { id: 'u1', role: 'user', text: 'Read this image', attachments: [{ kind: 'image', url: 'data:image/jpeg;base64,aGVsbG8=' }] },
    { id: 'a1', role: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: 'read' }] },
    { id: 't1', role: 'tool', text: 'The result', name: 'read' },
  ];
  const lane = { modelId: 'acme/source', messages: [...history, { role: 'assistant', status: 'error', suggestedModels: [choice], imageMode: { aspect: 'square' } }] };
  const snapshot = structuredClone(lane);
  const retry = alternativeRetry(lane, choice.id);
  assert.equal(retry.modelId, choice.id);
  assert.deepEqual(retry.history, history);
  assert.deepEqual(retry.imageMode, { aspect: 'square' });
  assert.deepEqual(lane, snapshot);
  assert.equal(alternativeRetry(lane, 'acme/unlisted'), null);
  assert.equal(alternativeRetry({ ...lane, modelId: choice.id }, choice.id), null);
  assert.equal(alternativeRetry({ ...lane, messages: [...history, { role: 'assistant', status: 'done' }] }, choice.id), null);
});

test('Chat renders accessible choices and retries only the clicked model', () => {
  const code = `
    import assert from 'node:assert/strict';
    import ModelAlternatives from './components/harness/ModelAlternatives.jsx';
    const choices = ${JSON.stringify([choice, { ...choice, id: 'acme/second', name: 'Second' }])};
    const calls = [];
    const view = ModelAlternatives({model:'Source',suggestions:choices,onRetry:id=>calls.push(id),disabled:false});
    assert.equal(view.props.role, 'status');
    assert.equal(view.props.children.length, 2);
    assert.deepEqual(calls, []);
    const button = view.props.children[1].props.children[2];
    assert.equal(button.type, 'button');
    assert.equal(button.props.type, 'button');
    assert.equal(button.props.disabled, false);
    assert.deepEqual(button.props.children, ['Try ', 'Second']);
    button.props.onClick();
    assert.deepEqual(calls, ['acme/second']);
    const blocked = ModelAlternatives({model:'Source',suggestions:choices,onRetry:id=>calls.push(id),disabled:true});
    assert.equal(blocked.props.children[0].props.children[2].props.disabled, true);
    assert.equal(ModelAlternatives({suggestions:[]}), null);
  `;
  const result = spawnSync('bun', ['-e', code], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('OpenAPI documents bounded optional suggestions without altering required fields', () => {
  const doc = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  const schema = doc.components.schemas.ApiError;
  assert.deepEqual(schema.required, ['error']);
  assert.equal(schema.properties.suggested_models.maxItems, 3);
  assert.deepEqual(schema.properties.suggested_models.items.required, ['id', 'name', 'prompt_price', 'completion_price', 'why']);
});

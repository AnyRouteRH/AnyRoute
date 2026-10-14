import { expect, test } from 'bun:test';
import { applyChunk, blankReply, buildRequest, normalizeModel } from '../web/lib/harness.js';
import { continuationJob, joinContinuation, canContinue } from '../web/lib/harness-continue.js';
import { chatCost } from '../web/lib/chat-cost.js';

test('H166: continuation wire and joined costs work without database or Redis configuration', () => {
  const model = normalizeModel({ id: 'sample/model', supported_parameters: [] });
  const reply = { id: 'answer', role: 'assistant', model: model.id, status: 'done', text: 'First ', finish: 'length', usage: { cost: 0.01 } };
  const lane = { id: 'lane', modelId: model.id, messages: [{ id: 'user', role: 'user', text: 'Question' }, reply] };
  const job = continuationJob(lane, reply.id);
  expect(buildRequest({ model, messages: job.history }).body.messages.at(-2)).toEqual({ role: 'assistant', content: 'First ' });
  const next = applyChunk(blankReply(), { choices: [{ delta: { content: 'second.' }, finish_reason: 'stop' }], usage: { cost: 0.02 } });
  const joined = { ...reply, ...joinContinuation(reply, { ...next, status: 'done' }) };
  expect(joined.id).toBe(reply.id);
  expect(joined.text).toBe('First second.');
  expect(chatCost([{ ...lane, messages: [lane.messages[0], joined] }])).toEqual({ microUsd: '30000', replies: 1 });
  expect(canContinue(joined)).toBe(false);
});

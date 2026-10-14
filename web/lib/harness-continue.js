// H166: continuation uses the selected reply and the existing streaming/cap path.
import { replyFacts } from './harness.js';
import { CONTEXT_FULL, contextMeter } from './context-meter.js';
import { capRequest } from './chat-cap.js';
import { imageSendError } from './harness-images.js';
import { modelUnavailable } from './model-availability.js';

export const CONTINUE_PROMPT = 'Continue exactly where your previous answer stopped. Do not repeat any text already given. Return only the continuation.';
export const canContinue = message => !!message?.text && message.finish === 'length' && ['done', 'stopped'].includes(message.status) && !message.toolCalls?.length;

export function continuationJob(lane, messageId, callId) {
  const index = lane?.messages.findIndex(message => message.id === messageId) ?? -1;
  const reply = lane?.messages[index];
  if (index !== lane?.messages.length - 1 || !canContinue(reply)) return null;
  return { reply, modelId: reply.servedModel || reply.model, history: [...lane.messages.slice(0, index + 1), { role: 'user', text: CONTINUE_PROMPT, continuationOf: messageId, continuationCallId: callId }] };
}

export function continueAnswer({ lane, messageId, busy, find, system, settings, needKey, cap, setLanes, runLane, onError, onStart, resume }) {
  if (busy) return false;
  const job = continuationJob(lane, messageId, globalThis.crypto.randomUUID());
  if (!job) return false;
  const model = find(job.modelId);
  if (!model || modelUnavailable(model)) { onError('The model that answered is unavailable. Try again when it is available.'); return false; }
  if (contextMeter({ model, messages: job.history, system }).blocked) { onError(CONTEXT_FULL); return false; }
  const request = capRequest(model, job.history, system, settings, job.reply.imageMode ?? null);
  const error = imageSendError(model, job.history) || request.error;
  if (error) { onError(error); return false; }
  if (needKey('send') || !cap.check([request], resume)) return false;
  onStart();
  setLanes(lanes => lanes.map(row => row.id === lane.id ? { ...row, messages: row.messages.map(message => message.id === messageId ? { ...message, status: 'waiting', error: '', errorKind: '' } : message) } : row));
  runLane(lane.id, job.modelId, job.history, messageId, job.reply.imageMode ?? null);
  return true;
}

export function callRecord(reply) {
  const facts = replyFacts(reply);
  return {
    ...(facts.receiptId ? { receiptId: facts.receiptId } : {}),
    ...(reply.provider ? { provider: reply.provider } : {}),
    ...(reply.finish ? { finish: reply.finish } : {}),
    ...Object.fromEntries([['prompt_tokens', facts.tokensIn], ['completion_tokens', facts.tokensOut], ['cost', facts.cost]].filter(([, value]) => Number.isFinite(value) && value >= 0)),
  };
}

export function joinContinuation(base, patch, callId) {
  if (!Object.hasOwn(patch, 'text')) return patch;
  const previous = base.continuationCalls || [callRecord(base)];
  const current = { ...callRecord(patch), ...(callId ? { callId } : {}) };
  const calls = [...previous, current];
  const usage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'cost']) {
    const values = calls.map(call => call[key]).filter(Number.isFinite);
    if (values.length) usage[key] = values.reduce((total, value) => total + value, 0);
  }
  const failed = ['error', 'stopped'].includes(patch.status);
  return { ...patch, text: base.text + patch.text, reasoning: (base.reasoning || '') + (patch.reasoning || ''), usage,
    receipt: patch.receipt || base.receipt, provider: patch.provider || base.provider, servedModel: patch.servedModel || base.servedModel,
    images: [...(base.images || []), ...(patch.images || [])],
    continuationCalls: calls, finish: failed && !patch.text ? base.finish : patch.finish,
    // Keep paid text and its cost after a failed follow-up. No charge is invented for missing usage.
    status: patch.status === 'error' ? 'stopped' : patch.status,
  };
}

export function continuationPatcher(patchMessage, lane, history, messageId) {
  const base = history.at(-1)?.continuationOf === messageId && lane?.messages.find(message => message.id === messageId);
  return (laneId, id, patch) => patchMessage(laneId, id, base ? joinContinuation(base, patch, history.at(-1).continuationCallId) : patch);
}

// Aggregate input usage belongs on the footer, not in the cumulative context count.
export function continuationContextFacts(message) {
  const calls = message.continuationCalls;
  if (!calls?.length) return {};
  const last = calls.at(-1);
  const earlierOutput = calls.slice(0, -1).reduce((total, call) => total + (call.completion_tokens || 0), 0);
  const knownOutput = calls.reduce((total, call) => total + (call.completion_tokens || 0), 0);
  const output = calls.every(call => Number.isFinite(call.completion_tokens)) ? knownOutput : Math.max(knownOutput, Math.ceil((message.text || '').length / 4));
  return { tokensIn: Number.isFinite(last.prompt_tokens) ? Math.max(0, last.prompt_tokens - earlierOutput) : null, tokensOut: output };
}

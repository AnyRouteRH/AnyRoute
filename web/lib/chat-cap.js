// G162: an optional browser guard, using the existing cost total and estimator.
import { chatCost } from './chat-cost.js';
import { DEFAULT_COST_STATE, modelCost } from './cost-estimator.js';
import { estimateTokens } from './arena.js';
import { buildRequest } from './harness.js';
import { summaryRequest } from './context-meter.js';
import { imageSettings } from './harness-images.js';

export const CHAT_CAP_PREFS = 'anyroute-harness-prefs';
export const CHAT_CAP_PRESETS = ['0.50', '1', '2', '5'];
export const validCap = value => typeof value === 'string' && /^(0|[1-9]\d{0,14})$/.test(value) && BigInt(value) > 0n;
export function parseCap(value) {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(String(value).trim());
  if (!match) throw new Error('Enter a positive dollar amount with up to six decimal places.');
  const units = String(BigInt(match[1]) * 1_000_000n + BigInt((match[2] || '').padEnd(6, '0')));
  if (!validCap(units)) throw new Error('Enter an amount greater than $0.');
  return units;
}
export function capDollars(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,39})$/.test(value)) return '';
  const units = BigInt(value), fraction = String(units % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return `${units / 1_000_000n}${fraction ? '.' + fraction : ''}`;
}
export function capFields(chat) {
  if (chat?.spendingCap == null) return {};
  if (!validCap(chat.spendingCap)) throw new Error('Choose a history export with a valid chat cap.');
  return { spendingCap: chat.spendingCap };
}
export const restoreChatCap = (chat, lanes) => lanes.map(lane => ({ ...lane, spendingCap: capFields(chat).spendingCap ?? null }));
export function readDefaultCap(storage) {
  try { const value = JSON.parse(storage.getItem(CHAT_CAP_PREFS))?.defaultChatCap; return validCap(value) ? value : null; } catch { return null; }
}
export function writeDefaultCap(storage, value) {
  try {
    let prefs;
    try { prefs = JSON.parse(storage.getItem(CHAT_CAP_PREFS)); } catch { prefs = {}; }
    storage.setItem(CHAT_CAP_PREFS, JSON.stringify({ ...(prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {}), defaultChatCap: value }));
    return true;
  } catch { return false; }
}
export function capRequest(model, messages, system, settings, imageMode = null) {
  return { model, ...buildRequest({ model, messages, system, settings: imageSettings(model, settings, imageMode) }) };
}
export function capSendRequests(lanes, find, system, settings, text, attachments, truncate) {
  return lanes.map(lane => {
    let messages = lane.messages;
    if (truncate !== null) {
      let seen = -1;
      const cut = messages.findIndex(message => message.role === 'user' && ++seen === truncate);
      if (cut >= 0) messages = messages.slice(0, cut);
    }
    return capRequest(find(lane.modelId), [...messages, { role: 'user', text, attachments }], system, settings);
  });
}
export function estimateCapRequests(requests) {
  let total = 0n;
  for (const { model, body, error } of requests) {
    if (!model || !body || error) return null;
    const text = body.messages.map(message => [
      typeof message.content === 'string' ? message.content : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n'),
      ...(message.tool_calls || []).map(call => call.function?.arguments || ''),
    ].join('\n')).join('\n');
    const output = body.max_completion_tokens ?? body.max_tokens ?? DEFAULT_COST_STATE.output;
    const cost = modelCost({ pricing: { prompt: model.inPrice / 1e6, completion: model.outPrice / 1e6, request: model.requestPrice ?? 0 } }, estimateTokens(text), output, 1);
    if (cost.total === null) return null;
    total += cost.total;
  }
  // Round upward only once, to the running total's micro-dollar precision.
  return (total + 999_999_999_999n) / 1_000_000_000_000n;
}
export function capDecision(lanes, cap, requests) {
  if (!validCap(cap)) return { held: false };
  const spent = BigInt(chatCost(lanes).microUsd), estimate = estimateCapRequests(requests);
  return { held: estimate === null || spent + estimate > BigInt(cap), cap, spent, estimate, projected: estimate === null ? null : spent + estimate };
}
// A bypass lives only for this synchronous action and is always cleared, even on an error.
export function createCapGuard() {
  let bypass = false;
  return {
    check(lanes, cap, requests, resume, hold) {
      if (bypass || !validCap(cap)) return true;
      const decision = capDecision(lanes, cap, requests);
      if (!decision.held) return true;
      hold({ ...decision, resume });
      return false;
    },
    sendAnyway(resume) { bypass = true; try { return resume(); } finally { bypass = false; } },
  };
}

export function capSummaryRequests(model, messages, system) {
  try { return [{ model, ...summaryRequest(model, messages, system) }]; } catch { return []; }
}

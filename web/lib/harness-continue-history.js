// H166: optional fields in the existing encrypted history; no new browser store.
const invalid = () => { throw new Error('Choose a history export with valid answer continuation details.'); };
export function continuationFields(message) {
  const out = {};
  if (message?.finish != null) {
    if (typeof message.finish !== 'string' || message.finish.length > 100) invalid();
    out.finish = message.finish;
  }
  if (message?.servedModel != null) {
    if (typeof message.servedModel !== 'string' || message.servedModel.length > 300) invalid();
    out.servedModel = message.servedModel;
  }
  if (message?.continuationCalls !== undefined) {
    if (!Array.isArray(message.continuationCalls) || message.continuationCalls.length < 2 || message.continuationCalls.length > 10000) invalid();
    out.continuationCalls = message.continuationCalls.map(call => {
      if (!call || typeof call !== 'object' || Array.isArray(call)) invalid();
      const kept = {};
      for (const key of ['callId', 'receiptId', 'provider', 'finish']) if (call[key] !== undefined) {
        if (typeof call[key] !== 'string' || call[key].length > 300) invalid();
        kept[key] = call[key];
      }
      for (const key of ['prompt_tokens', 'completion_tokens', 'cost']) if (call[key] !== undefined) {
        if (!Number.isFinite(call[key]) || call[key] < 0) invalid();
        kept[key] = call[key];
      }
      return kept;
    });
  }
  return out;
}

// B121: accept bounded router suggestions; never choose or retry without a click.
export function suggestedModels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(item => {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name || typeof item.why !== 'string' || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, 3);
}
export function alternativeRetry(lane, modelId) {
  const last = lane.messages.findLast(message => message.role === 'assistant');
  if (!last || last.status !== 'error' || !suggestedModels(last.suggestedModels).some(item => item.id === modelId) || modelId === lane.modelId) return null;
  const cut = Math.max(lane.messages.map(m => m.role).lastIndexOf('user'), lane.messages.map(m => m.role).lastIndexOf('tool')) + 1;
  return { modelId, history: lane.messages.slice(0, cut), imageMode: last.imageMode ?? null };
}

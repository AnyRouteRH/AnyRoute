// H171
export const duplicateName = name => `${(name || 'Unnamed agent').slice(0, 95)} copy`;
export async function duplicateAgent(request, hash, name) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) throw new Error('Choose a name between 1 and 100 characters.');
  return request('/api/v1/agents/' + encodeURIComponent(hash) + '/duplicate', { method: 'POST', body: { name: trimmed } });
}

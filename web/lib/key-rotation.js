// G158
export const rotationChoices = [['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days']];
export function canRotateKey(key, caller, rotation, now = Date.now()) {
  return !!key && !!caller && !['read', 'inference'].includes(caller.scope) && (caller.management || caller.hash === key.hash && caller.team) && !key.disabled && (!key.expires_at || Date.parse(key.expires_at) > now) && !rotation?.to;
}
export function rotationLines(rotation, keys = [], links = {}) {
  if (!rotation) return [];
  const label = hash => keys.find(key => key.hash === hash)?.label || hash.slice(0, 12) + '…';
  const date = new Date(rotation.at).toLocaleString();
  const lines = [];
  if (rotation.from) lines.push(`Rotated from ${label(rotation.from)} · ${new Date(links[rotation.from]?.at || rotation.at).toLocaleString()}`);
  if (rotation.to) lines.push(`Rotated to ${label(rotation.to)} · ${date}. Stops ${new Date(rotation.grace_ends_at).toLocaleString()}.`);
  return lines;
}
export async function rotateAccountKey(request, hash, grace) {
  if (!rotationChoices.some(([value]) => value === grace)) throw new Error('Choose a grace period.');
  return request('/api/v1/keys/' + encodeURIComponent(hash) + '/rotate', { method: 'POST', body: { grace } });
}

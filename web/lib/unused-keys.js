// B125: use only the rows visible through the existing key list. Nothing is stored.
const DAY = 86_400_000;
const timestamp = value => value ? Date.parse(value) : NaN;
export const keyName = key => key.name || key.label || 'Unnamed key';

export function lastUsedText(value, now = Date.now()) {
  if (value == null) return 'Never';
  const at = timestamp(value);
  if (!Number.isFinite(at)) return 'Unknown';
  const days = Math.floor(Math.max(0, now - at) / DAY);
  return days === 0 ? 'Today' : days === 1 ? '1 day ago' : `${days} days ago`;
}

export function unusedKeys(keys, currentHash, now = Date.now()) {
  if (!currentHash) return []; // Fail closed until the signed-in key is known.
  return (keys || []).filter(key => {
    if (!key.hash || key.hash === currentHash || key.disabled) return false;
    const at = timestamp(key.last_used == null ? key.created_at : key.last_used);
    return Number.isFinite(at) && now - at >= 30 * DAY;
  });
}

export const unusedKeysNotice = count => `${count} ${count === 1 ? "key hasn't" : "keys haven't"} made a call in 30 days.`;

// One confirmation covers the selection. Recheck current/disabled/recently used rows before writing.
// The existing DELETE disables a key and keeps its usual team audit entry; it does not remove the row.
export async function switchOffUnusedKeys(request, { keys, currentHash, selected, confirmed }, onDisabled = () => {}) {
  if (!confirmed) throw new Error('Confirm before switching off selected keys.');
  const wanted = new Set(selected);
  const targets = unusedKeys(keys, currentHash).filter(key => wanted.has(key.hash));
  const disabled = [], failed = [];
  for (const key of targets) {
    try {
      await request('/api/v1/keys/' + encodeURIComponent(key.hash), { method: 'DELETE' });
      disabled.push(key.hash);
      onDisabled(key.hash);
    } catch (error) {
      failed.push({ hash: key.hash, name: keyName(key), message: error.message || 'Could not switch off this key.' });
    }
  }
  return { disabled, failed };
}

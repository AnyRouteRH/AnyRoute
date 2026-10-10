// E147: reuse key management for revocation; no parallel credential or session store.
export async function listBrowsers(request, options = {}) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const result = await request(`/api/v1/account/browser-sessions?offset=${offset}&limit=100`, options);
    rows.push(...result.data);
    if (!result.has_more) return rows;
    if (!result.data.length) throw new Error('Could not read the remaining browsers.');
  }
}
export async function signOutBrowsers(request, { hash, allOthers = false, confirmed = false }, onDisabled = () => {}) {
  if (!confirmed) throw new Error('Confirm sign-out first.');
  if (!allOthers && !hash) throw new Error('Choose a browser to sign out.');
  // Refresh at confirmation so newly signed-in browsers are included in all others.
  const rows = await listBrowsers(request);
  const targets = rows.filter(row => allOthers ? !row.current : row.hash === hash);
  const disabled = [], failed = [];
  for (const row of targets) {
    try {
      await request(`/api/v1/keys/${encodeURIComponent(row.hash)}`, row.current
        ? { method: 'PATCH', body: { disabled: true } } : { method: 'DELETE' });
    } catch {
      failed.push({ hash: row.hash, label: row.browser_label });
      continue;
    }
    disabled.push(row.hash);
    onDisabled(row);
  }
  return { disabled, failed };
}
export function browserTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown';
}

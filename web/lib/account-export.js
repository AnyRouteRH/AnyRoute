import { statementPath } from './statements.js';
export const EXPORT_PARTS = ['account', 'keys', 'rulebooks', 'policy_events', 'sessions', 'approvals', 'activity', 'statements', 'agreements', 'agent_profiles'];
export const EXPORT_EXCLUSIONS = [
  { name: 'Key secrets and credentials', reason: 'Never included. Metadata uses existing read endpoints; no key is created.' },
  { name: 'Chat history', reason: 'Lives in your browser. Export it from Chat.' },
  { name: 'Private files and saved content', reason: 'Files, characters, saved routes, presets, batches and other content are outside this account-record export.' },
  { name: 'Deleted or expired records', reason: 'Existing retention applies. This export cannot recover data the read APIs no longer return.' },
  { name: 'Other accounts and restricted records', reason: 'Every request uses this connected key and keeps each endpoint’s existing access rules.' },
  { name: 'Underlying statement ledger', reason: 'Statements contain reconciled aggregates; this bundle does not contain a complete raw ledger.' },
];
// Defence in depth: GET endpoints never issue secrets. Strip credential-shaped properties if an endpoint evolves.
export function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !/^(key|secret|api_key|authorization|password|private_key|key_secret|access_token|refresh_token)$/i.test(name)).map(([name,v]) => [name, withoutSecrets(v)]));
}
const unavailable = new Set([403,404,501,503]);
export async function exportAccount(request, { signal, onProgress = () => {}, now = new Date() } = {}) {
  const bundle = { format: 'anyroute.account-export.v1', started_at: now.toISOString(), data: {}, manifest: {
    scope: 'Only records readable by the connected key; endpoint scopes can differ.', inventory_url: '/keep/',
    router_keeps: 'The router stores the records described in What we keep. This bundle contains only the account records listed below, not everything in storage. Ordinary chat requests are read in router memory; encrypted chat through the attested gateway forwards ciphertext.',
    consistency: 'Requests run in sequence, not as a single database snapshot. Activity is bounded before the export start; other records can change during export.', included: [], excluded: EXPORT_EXCLUSIONS, parts: {} } };
  let completed = 0;
  const abort = () => { signal?.throwIfAborted(); };
  const get = async path => { abort(); const r = await request(path, { signal }); abort(); return r; };
  const page = async (path, param = 'cursor', nextField = 'next_cursor') => {
    let cursor = '', rows = [], scope; const seen = new Set();
    do {
      const r = await get(path + (cursor ? `${path.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(cursor)}` : ''));
      if (!Array.isArray(r.data)) throw new Error('An export page could not be read.');
      rows.push(...r.data); scope ??= r.scope; cursor = r[nextField] || '';
      if (cursor && seen.has(cursor)) throw new Error('An export cursor did not advance.');
      seen.add(cursor); onProgress({ completed, total: EXPORT_PARTS.length, part: 'Reading pages', records: rows.length });
    } while (cursor);
    return { data: rows, ...(scope ? { scope } : {}) };
  };
  const part = async (name, read, limit = '') => {
    abort(); onProgress({ completed, total: EXPORT_PARTS.length, part: name });
    try { bundle.data[name] = withoutSecrets(await read()); bundle.manifest.included.push(name); bundle.manifest.parts[name] = { status: 'included', ...(limit ? { limit } : {}) }; }
    catch (e) {
      if (signal?.aborted || e.name === 'AbortError' || !unavailable.has(e.status)) throw e;
      bundle.manifest.parts[name] = { status: 'unavailable', http_status: e.status, reason: e.status === 403 ? 'This key cannot read this endpoint.' : 'This endpoint or record is unavailable on this router.' };
    }
    completed++; onProgress({ completed, total: EXPORT_PARTS.length, part: name });
  };
  await part('account', async () => ({ current_key: (await get('/api/v1/key')).data, credits: (await get('/api/v1/credits')).data }), 'Account metadata exposed by current-key and credits APIs; no separate full account record API.');
  const hash = bundle.data.account?.current_key?.hash;
  await part('keys', () => get('/api/v1/keys'));
  await part('rulebooks', async () => {
    try { return await get('/api/v1/agents'); } catch (e) { if (e.status !== 403) throw e; return get('/api/v1/agents/me'); }
  });
  const agents = Array.isArray(bundle.data.rulebooks?.data) ? bundle.data.rulebooks.data : hash ? [{ key_hash: hash }] : [];
  await part('policy_events', async () => {
    const data = [], access = [];
    for (const agent of agents) {
      try { data.push({ key_hash: agent.key_hash, ...(await page(`/api/v1/agents/${encodeURIComponent(agent.key_hash)}/events`)) }); }
      catch (e) { if (!unavailable.has(e.status)) throw e; access.push({ key_hash: agent.key_hash, http_status: e.status }); }
    }
    return { data, unavailable: access };
  }, 'Events are paged for each visible agent. Per-agent access failures are listed in the data.');
  await part('sessions', async () => {
    try { return await page('/api/v1/sessions?limit=200', 'before', 'next'); }
    catch (e) { if (e.status !== 403) throw e; return get('/api/v1/sessions/current'); }
  });
  await part('approvals', async () => {
    const data = [];
    for (const status of ['pending','approved','denied','expired','used']) data.push({ status, ...(await get('/api/v1/agents/approvals?status=' + status)) });
    return { data };
  }, 'The existing API returns at most 100 approvals per stored status and offers no cursor; older approvals may be absent. Activity includes readable approval events.');
  await part('activity', () => page('/api/v1/activity?limit=100&to=' + encodeURIComponent(now.toISOString())), 'All pages before export start, subject to source retention and the endpoint’s key or account scope.');
  await part('statements', async () => {
    const first = await get(statementPath(now.toISOString().slice(0,7)));
    const created = new Date(first.data?.payload?.account_created_at);
    if (!Number.isFinite(created.getTime()) || created > now) throw new Error('The statement account creation date could not be read.');
    const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), oldest = created.toISOString().slice(0,7), data = [first.data];
    current.setUTCMonth(current.getUTCMonth() - 1);
    while (current.toISOString().slice(0,7) >= oldest) { data.push((await get(statementPath(current.toISOString().slice(0,7)))).data); current.setUTCMonth(current.getUTCMonth() - 1); onProgress({ completed, total: EXPORT_PARTS.length, part: 'statements', records: data.length }); }
    return { data };
  }, 'Each month from account creation through the current month, when statements are switched on. Each statement has its own read time and signature.');
  await part('agreements', () => page('/api/v1/agreements'), 'Wallet-party agreement records from the existing endpoint; evidence bodies, deliveries and dispute details are outside this bundle.');
  await part('agent_profiles', async () => {
    const data = [], access = [];
    for (const agent of agents) {
      try { data.push({ key_hash: agent.key_hash, ...(await get(`/api/v1/agents/${encodeURIComponent(agent.key_hash)}/profile`)) }); }
      catch (e) { if (!unavailable.has(e.status)) throw e; access.push({ key_hash: agent.key_hash, http_status: e.status }); }
    }
    return { data, unavailable: access };
  }, 'Owned profile settings for visible agents, including unpublished profiles. Per-agent access failures are listed.');
  abort(); bundle.completed_at = new Date().toISOString(); return bundle;
}

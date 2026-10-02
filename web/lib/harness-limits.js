// The browser maps controls to existing router APIs; it never estimates or authorises spending.
export const CHAT_LIMITS_STORE = 'anyroute-harness-limits-v1';
const path = value => encodeURIComponent(value);
const abortError = () => new DOMException('Stopped.', 'AbortError');
const failure = message => Object.assign(new Error(message), { type: 'chat_limits' });

export function chatLimitSpec(form) {
  const amount = (value, label, max = 1_000_000) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw failure(`${label} must be greater than $0 and at most $${max}.`);
    return n;
  };
  const budget = amount(form.session, 'Session cap', 1000);
  const minutes = Number(form.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw failure('Expiry must be between 1 and 1440 minutes.');
  return {
    session: { name: 'Chat in this browser', budget_usd: budget, ttl_minutes: minutes },
    policy: { version: 1, models: {}, caps: form.day ? { per_day_usd: amount(form.day, '24-hour cap') } : {},
      ...(form.approval ? { approval: { above_usd: amount(form.approval, 'Ask-first amount') } } : {}), on_breach: 'deny' },
  };
}

// Terminal decisions never return to pending. Only a server-approved, unexpired decision can resume.
export function approvalPhase(current, row, now = Date.now()) {
  if (current !== 'pending') return current;
  if (!row || !Number.isFinite(Date.parse(row.expires_at))) throw failure('The approval could not be read.');
  if (Date.parse(row.expires_at) <= now) return 'expired';
  if (!['pending', 'approved', 'denied', 'expired', 'used'].includes(row.status)) throw failure('Unknown approval status.');
  return row.status;
}

export function createHarnessLimits({ request, stream, storage, pollMs = 5000 }) {
  let parent = '', parentHash = '', running = 0;
  let state = { session: null, busy: false, error: '', approvals: [] };
  const listeners = new Set(), waits = new Map();
  const emit = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const owner = (url, opts = {}) => request(url, { ...opts, key: parent });
  const persist = session => {
    try {
      if (session) storage.setItem(CHAT_LIMITS_STORE, JSON.stringify(session));
      else storage.removeItem(CHAT_LIMITS_STORE);
    } catch { emit({ error: 'Tab storage is unavailable. Keep this tab open to manage or revoke its chat key.' }); }
    emit({ session });
  };
  const revoke = session => owner(`/api/v1/sessions/${path(session.id)}`, { method: 'DELETE' });
  const mutate = async fn => {
    if (state.busy) throw failure('Wait for the current limits change.');
    emit({ busy: true, error: '' });
    try { return await fn(); }
    catch (e) { emit({ error: e.message }); throw e; }
    finally { emit({ busy: false }); }
  };
  async function connect(key, hash) {
    if (parent === key) return;
    return mutate(async () => {
      if (state.session && parent) { await revoke(state.session); persist(null); }
      parent = key; parentHash = hash;
      const raw = storage.getItem(CHAT_LIMITS_STORE);
      if (!raw) return;
      let saved;
      try {
        saved = JSON.parse(raw);
        if (!saved.id || !saved.key || !saved.key_hash || saved.parentHash !== hash) throw failure('Reconnect the account that created these chat limits to remove them.');
      } catch (e) {
        // Retain the record and block chat rather than silently returning to the account key.
        emit({ session: { blocked: true }, error: e.message });
        throw e;
      }
      emit({ session: saved });
    });
  }
  async function enable(form) {
    if (!parent) throw failure('Sign in with a management or owner/admin key first.');
    if (running || state.session) throw failure('Stop replies and remove the existing limits first.');
    const spec = chatLimitSpec(form);
    return mutate(async () => {
      // Check that rulebooks are switched on before creating a child key.
      await owner('/api/v1/agents');
      const { data } = await owner('/api/v1/sessions', { method: 'POST', body: spec.session });
      const session = { ...data, parentHash, policy: spec.policy, ready: false };
      persist(session);
      try {
        await owner(`/api/v1/agents/${path(data.key_hash)}/policy`, { method: 'PUT', body: spec.policy });
        persist({ ...session, ready: true });
      } catch (e) {
        try { await revoke(session); persist(null); }
        catch { throw failure('The rulebook could not be saved or the chat key revoked. Chat is blocked. Use Remove limits to retry, or stop this session in /agents.'); }
        throw e;
      }
    });
  }
  async function remove() {
    return mutate(async () => {
      if (state.session) {
        if (!state.session.id) throw failure('Reconnect the account that created these limits, then reload this tab.');
        await revoke(state.session);
      }
      persist(null);
    });
  }
  async function stop() {
    if (!state.session?.ready) return;
    return mutate(async () => {
      await owner(`/api/v1/agents/${path(state.session.key_hash)}/kill`, { method: 'POST', body: { reason: 'Stopped from chat in this browser' } });
      persist({ ...state.session, stopped: true });
    });
  }
  async function resume() {
    return mutate(async () => {
      await owner(`/api/v1/agents/${path(state.session.key_hash)}/resume`, { method: 'POST' });
      persist({ ...state.session, stopped: false });
    });
  }
  function waitForApproval(error, options, session) {
    const id = error.metadata?.approval_id, expires_at = error.metadata?.expires_at;
    if (!id || !Number.isFinite(Date.parse(expires_at))) throw error;
    return new Promise((resolve, reject) => {
      let phase = 'pending', timer;
      const entry = { id, expires_at, messageId: options.messageId, model: options.body.model, status: phase };
      const finish = (err, value) => {
        clearTimeout(timer); waits.delete(options.messageId);
        options.signal?.removeEventListener('abort', abort);
        emit({ approvals: state.approvals.filter(a => a.messageId !== options.messageId) });
        err ? reject(err) : resolve(value);
      };
      const accept = row => {
        phase = approvalPhase(phase, row);
        if (phase === 'approved') finish(null, id);
        else if (phase !== 'pending') finish(failure(`Reply approval ${phase}. Send again to request a new approval.`));
      };
      const abort = () => finish(abortError());
      const poll = async () => {
        try {
          if (Date.parse(expires_at) <= Date.now()) return accept({ status: 'expired', expires_at });
          const { data } = await request(`/api/v1/agents/approvals/${path(id)}`, { key: session.key, signal: options.signal });
          if (!waits.has(options.messageId)) return;
          accept(data);
          if (phase === 'pending') timer = setTimeout(poll, pollMs);
        } catch (e) {
          if (options.signal?.aborted) return abort();
          // Read failures do not grant approval. Keep controls visible and allow another poll.
          emit({ error: e.message });
          if (waits.has(options.messageId)) timer = setTimeout(poll, pollMs);
        }
      };
      waits.set(options.messageId, { accept, id });
      emit({ approvals: [...state.approvals, entry] });
      owner('/api/v1/agents/approvals').then(({ data }) => {
        const row = Array.isArray(data) && data.find(a => a.id === id);
        if (row && waits.has(options.messageId)) emit({ approvals: state.approvals.map(a => a.messageId === options.messageId ? { ...a, max_cost_pico: row.max_cost_pico } : a) });
      }).catch(() => {}); // Detail reads cannot authorise a reply; the single-approval status is authoritative.
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) return abort();
      timer = setTimeout(poll, pollMs);
    });
  }
  async function decide(messageId, action) {
    if (!['approve', 'deny'].includes(action)) throw failure('Unknown approval action.');
    const wait = waits.get(messageId);
    if (!wait) return;
    try {
      const { data } = await owner(`/api/v1/agents/approvals/${path(wait.id)}/${action}`, { method: 'POST' });
      if (waits.get(messageId) === wait) wait.accept(data);
    } catch (e) { emit({ error: e.message }); throw e; }
  }
  async function streamChat(options) {
    if (state.busy || !parent) throw failure('Wait for sign-in or the limits change to finish.');
    const session = state.session;
    if (session && (!session.ready || session.blocked)) throw failure('Chat limits could not be set up. Remove limits to revoke this session.');
    const snapshot = { ...options, body: structuredClone(options.body), headers: { ...options.headers }, key: session?.key || parent };
    running++;
    try {
      try { return await stream(snapshot); }
      catch (e) {
        if (e.type !== 'agent_approval_required') throw e;
        const id = await waitForApproval(e, snapshot, { key: snapshot.key });
        if (snapshot.signal?.aborted) throw abortError();
        // One retry, with the frozen request and the server's single-use grant. Never use the parent as fallback.
        return await stream({ ...snapshot, headers: { ...snapshot.headers, 'x-agent-approval': id } });
      }
    } finally { running--; }
  }
  return { get: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    connect, enable, remove, stop, resume, decide, streamChat,
    signOut: async () => { await remove(); parent = ''; parentHash = ''; } };
}

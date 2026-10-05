// U105: one shared, visibility-aware poller for the header strip and its drawer.
// Every 30 s while the tab is visible; paused while hidden; refreshed on focus; backs off on errors; one read at a time.
import { api } from './api.js';
import { readDepositProgress } from './deposit-progress.js';
import { nextPollDelay, POLL_MS, MAX_POLL_MS, readAccountStrip } from './account-strip.js';

export const WAKE_GAP_MS = 5_000;

/**
 * `read(signal, previous)` resolves to `{ value, ok }`. `env` supplies timers, the clock, visibility and wake-up
 * events, so the schedule runs the same way in node as in a browser.
 */
export function createPoller({ read, env, interval = POLL_MS, maxDelay = MAX_POLL_MS, onStop }) {
  const listeners = new Set();
  let state = null, failures = 0, timer = null, controller = null, inFlight = null, again = false, stopped = false, started = false, lastRun = -Infinity, unlisten = null;
  const emit = () => listeners.forEach(fn => fn(state));
  const clear = () => { if (timer != null) env.clearTimeout(timer); timer = null; };
  const delay = () => nextPollDelay(failures, interval, maxDelay);
  function schedule() {
    clear();
    if (stopped || env.hidden() || state?.fatal) return; // Paused while hidden; a 401 ends polling for this key.
    timer = env.setTimeout(run, delay());
  }
  function run() {
    if (stopped) return Promise.resolve(state);
    if (inFlight) { again = true; return inFlight; }
    clear(); lastRun = env.now(); controller = new AbortController();
    const signal = controller.signal;
    inFlight = (async () => {
      try {
        const { value, ok } = await read(signal, state);
        if (stopped || signal.aborted) return state;
        state = value; failures = ok ? 0 : failures + 1;
      } catch (error) {
        if (stopped || signal.aborted || error?.name === 'AbortError') return state;
        state = { ...state, at: env.now(), readError: error?.message || 'Could not read account updates.' }; failures++;
      } finally { inFlight = null; controller = null; }
      emit();
      if (again && !state?.fatal) { again = false; return run(); }
      again = false; schedule();
      return state;
    })();
    return inFlight;
  }
  /** Focus or the tab becoming visible: read now unless a read just ran (or is backing off), else keep the schedule. */
  function wake() {
    if (stopped || state?.fatal) return;
    if (env.hidden()) { clear(); return; }
    if (inFlight) return;
    if (env.now() - lastRun >= (failures ? delay() : WAKE_GAP_MS)) run(); else if (timer == null) schedule();
  }
  function start() { started = true; unlisten = env.listen(wake, () => run()); run(); }
  function stop() { stopped = true; clear(); controller?.abort(); unlisten?.(); unlisten = null; listeners.clear(); onStop?.(); }
  return {
    subscribe(fn) {
      listeners.add(fn); if (state) fn(state);
      if (!started) start();
      return () => { listeners.delete(fn); if (!listeners.size) stop(); };
    },
    refresh: () => run(),
    get state() { return state; },
    get stopped() { return stopped; },
    get failures() { return failures; },
  };
}

/** Browser wiring: visibility and focus wake the poller; inbox and deposit changes made elsewhere on the page refresh it. */
export function browserEnv(win = globalThis.window) {
  return {
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: id => win.clearTimeout(id),
    now: () => Date.now(),
    hidden: () => win.document.visibilityState === 'hidden',
    listen(wake, refresh) {
      const changed = ['anyroute-inbox-changed', 'anyroute-deposit-sent'];
      win.document.addEventListener('visibilitychange', wake); win.addEventListener('focus', wake);
      changed.forEach(name => win.addEventListener(name, refresh));
      return () => { win.document.removeEventListener('visibilitychange', wake); win.removeEventListener('focus', wake); changed.forEach(name => win.removeEventListener(name, refresh)); };
    },
  };
}

// One poller per signed-in key, shared by every subscriber on the page. Held in memory only; removed when the last one leaves.
const shared = new Map();
export function sharedPoller(key, make) {
  let poller = shared.get(key);
  if (!poller || poller.stopped) { poller = make(() => { if (shared.get(key) === poller) shared.delete(key); }); shared.set(key, poller); }
  return poller;
}

/** The page's poller for `key`. Requests carry the key in the Authorization header via api(). */
export function accountPoller(key) {
  return sharedPoller(key, onStop => createPoller({
    env: browserEnv(), onStop,
    read: (signal, previous) => readAccountStrip((path, options) => api(path, { ...options, key }), {
      signal, previous, readDeposits: () => readDepositProgress(key),
      storage: { getItem: name => { try { return window.localStorage.getItem(name); } catch { return null; } } },
    }),
  }));
}

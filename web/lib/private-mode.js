// Private mode for the Harness: pure helpers and a small store (no React), shared by
// components/harness/PrivateMode.jsx and its tests.
//
// What the switch does, and nothing more:
//   - every request asks for the attested lane (X-Anyroute-Lane: attested), which the router serves from endpoints
//     whose attestation it has checked, or refuses; it never falls back to a public provider;
//   - the model list is GET /api/v1/models?lane=attested;
//   - every reply shows its privacy label (GET /api/v1/receipts/{id}/privacy), or the lane and receipt link when the
//     router has no such endpoint;
//   - history is kept only in this browser, encrypted (see private-history.js).
// The router still reads the prompt in memory to route it. Nothing here claims otherwise.

export const LANE = "attested";
export const LANE_HEADER = "x-anyroute-lane";
export const MODELS_PATH = "/api/v1/models?lane=" + LANE;
export const STATUS_PATH = "/api/v1/status";
export const SWITCH_KEY = "anyroute-harness-private";

/** Where the private-token page and the private proxy live. */
export const TOKENS_HREF = "/tokens/";
export const PROXY_HREF = "/docs/#private-proxy";

/** The header that puts a request on the attested lane; nothing while private mode is off. */
export const laneHeaders = (on) => (on ? { [LANE_HEADER]: LANE } : {});

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const readSwitch = (storage) => safe(() => storage.getItem(SWITCH_KEY) === "1", false);
export const writeSwitch = (storage, on) => safe(() => (on ? storage.setItem(SWITCH_KEY, "1") : storage.removeItem(SWITCH_KEY)));

/**
 * The models private mode may offer, from a GET /api/v1/models?lane=attested body. Fail closed: a model counts only
 * when the router itself lists "attested" among the lanes it can be served on, so a router that ignored the query
 * parameter cannot widen the list.
 */
export function attestedModels(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.filter((m) => m && typeof m.id === "string" && Array.isArray(m.lanes) && m.lanes.includes(LANE));
}

// ---------------------------------------------------------------- the onion address

const ONION = /^[a-z2-7]{56}\.onion$/;

/** A host as written in location.host or a URL: lower case, no scheme, no port, no trailing dot. */
export function bareHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

/**
 * What GET /api/v1/status says about Tor for this page: the router's onion address, whether this page was loaded from
 * it, and whether the unlinkable lane is served over Tor (data.lanes.unlinkable.via includes "onion").
 */
export function torState(status, host) {
  const data = status?.data || status || {};
  const claimed = bareHost(data.onion?.address);
  const address = ONION.test(claimed) ? claimed : null;
  const unlinkable = data.lanes?.unlinkable;
  const viaOnion = !!(unlinkable?.available && Array.isArray(unlinkable.via) && unlinkable.via.includes("onion"));
  return { address, onOnion: !!address && bareHost(host) === address, unlinkableViaOnion: !!address && viaOnion, url: address ? `http://${address}` : null };
}

// ---------------------------------------------------------------- privacy labels

export const privacyPath = (id) => `/api/v1/receipts/${encodeURIComponent(id)}/privacy`;

/** Rows of the label, in the order the contract lists them. */
export const LABEL_FIELDS = [
  ["prompt_readers", "Who can read the prompt"],
  ["network", "Network address"],
  ["payment", "Payment"],
  ["stored", "Stored"],
  ["hardware", "Hardware"],
];

const clean = (v, max) => String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** An identifier such as "router_memory" read as words ("Router memory"); anything else is left as it was written. */
const words = (v) => (/^[a-z][a-z0-9]*([_-][a-z0-9]+)+$/.test(v) ? v.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase()) : v);

/** One label value as a short line of text: a string, a list of strings, or an object with a text-like field. */
export function labelText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return words(clean(value, 200));
  if (Array.isArray(value)) return clean(value.filter((x) => typeof x === "string").map((x) => words(clean(x, 80))).join(", "), 200);
  if (typeof value === "object") {
    for (const k of ["text", "summary", "label", "value", "description"]) if (typeof value[k] === "string") return clean(value[k], 200);
  }
  return "";
}

/** A link from the router that is safe to render: a path on this site or an http(s) URL. */
export function safeUrl(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (/^\/(?![/\\])/.test(v)) return v;
  return /^https?:\/\/[^\s]+$/i.test(v) ? v : "";
}

/**
 * The privacy label from GET /api/v1/receipts/{id}/privacy, or null when the body is not one. Accepts the document
 * bare or inside { data }. Nothing is invented: a field the router did not send is left out.
 */
export function normalizeLabel(body) {
  const doc = body && typeof body === "object" && body.data && typeof body.data === "object" ? body.data : body;
  if (!doc || typeof doc !== "object" || !doc.label || typeof doc.label !== "object") return null;
  const rows = LABEL_FIELDS.map(([key, title]) => ({ key, title, text: labelText(doc.label[key]) })).filter((r) => r.text);
  const summary = (Array.isArray(doc.summary) ? doc.summary : []).filter((x) => typeof x === "string").map((x) => clean(x, 240)).filter(Boolean).slice(0, 5);
  if (!rows.length && !summary.length) return null;
  return { receiptId: typeof doc.receipt_id === "string" ? doc.receipt_id : "", lane: typeof doc.lane === "string" ? clean(doc.lane, 32) : "", rows, summary, verifyUrl: safeUrl(doc.verify_url) };
}

/**
 * What a reply shows when the router has no privacy endpoint (or it failed): the lane and disclosure class written
 * into the signed receipt the reply carries, and the receipt's own link.
 */
export function receiptLane(receipt) {
  const claims = receipt?.v2?.claims || {};
  return { lane: typeof claims.lane === "string" ? claims.lane : "", disclosure: typeof (claims.disclosure ?? receipt?.payload?.disclosure) === "string" ? claims.disclosure ?? receipt.payload.disclosure : "" };
}

/** Whether a lane name means the reply ran on proven hardware. "" means the receipt did not say. */
export const laneIsProven = (lane) => lane === "attested" || lane === "unlinkable";

/**
 * Fetch one reply's label. Resolves { label } with a normalized label, or { label: null, reason } when the endpoint is
 * absent (404, 405, 501), refused or unreachable, or answered something that is not a label. Never throws.
 */
export async function fetchPrivacyLabel(id, request) {
  try {
    return { label: normalizeLabel(await request(privacyPath(id))) || null, reason: "" };
  } catch (e) {
    const status = Number(e?.status) || 0;
    return { label: null, reason: status === 404 || status === 405 || status === 501 ? "absent" : "unavailable" };
  }
}

// ---------------------------------------------------------------- the switch, as a store

/**
 * The state behind the switch, outside React so every part of the page reads the same one. `request(path)` resolves
 * a parsed JSON body (lib/api.js `api`), `storage` is localStorage, `host` is location.host.
 *
 * Fail closed: while the attested model list is loading, or if it fails, `models` is empty, so nothing can be sent on
 * a model that was not listed for the lane.
 */
export function createPrivateStore({ request, storage, host }) {
  let state = { on: false, models: null, error: "", tor: null };
  let ticket = 0;
  const subs = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    subs.forEach((f) => f());
  };

  function load() {
    const mine = ++ticket;
    set({ models: null, error: "" });
    request(MODELS_PATH)
      .then((body) => mine === ticket && set({ models: attestedModels(body) }))
      .catch((e) => mine === ticket && set({ models: [], error: e?.message || "The list of models on proven hardware could not be loaded." }));
    // The onion address, to tell whether this page came in over Tor. Not needed for anything else.
    request(STATUS_PATH)
      .then((body) => mine === ticket && set({ tor: torState(body, host()) }))
      .catch(() => mine === ticket && set({ tor: null }));
  }

  return {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    /** Read the remembered choice (call once, in the browser). */
    init() {
      if (readSwitch(storage) && !state.on) {
        set({ on: true });
        load();
      }
    },
    setOn(on) {
      on = !!on;
      if (on === state.on) return;
      writeSwitch(storage, on);
      if (on) {
        set({ on: true });
        load();
      } else {
        ticket++;
        set({ on: false, models: null, error: "", tor: null });
      }
    },
    retry() {
      if (state.on) load();
    },
    /** The request headers for the current state, read when the request is made. */
    headers: () => laneHeaders(state.on),
  };
}

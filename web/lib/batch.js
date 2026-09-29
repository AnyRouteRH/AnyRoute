// Batch Studio: the pure logic behind browser-side batches. No DOM, no network, no storage.
// Parsing (JSONL and CSV), per-row validation, cost estimates, the request scheduler
// (concurrency, 429 back-off, transient retries, pause/resume/cancel) and result export.
// Rows are sent by the caller's `send` function, one request per row; nothing here keeps
// prompts or completions anywhere but in the arrays the caller owns.

export const MAX_ROWS = 5000;
export const MAX_INPUT_CHARS = 32 * 1024 * 1024;
export const CONCURRENCY = { min: 1, max: 8, default: 4 };
export const MAX_RETRIES = 2; // 5xx and network errors
export const MAX_RATE_LIMIT_WAITS = 8; // 429s per row before it fails
export const MAX_WAIT_MS = 10 * 60 * 1000; // longest Retry-After we sleep through
export const ROLES = ["system", "developer", "user", "assistant", "tool"];
const CUSTOM_ID_MAX = 128;
const SIMPLE_KEYS = new Set(["custom_id", "prompt", "model"]);
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------------------------------------------------------------- parsing

/** "jsonl" or "csv", from the file extension first, then the first character. */
export function detectFormat(text, fileName = "") {
  const name = String(fileName).toLowerCase();
  if (/\.(jsonl|ndjson|json)$/.test(name)) return "jsonl";
  if (/\.csv$/.test(name)) return "csv";
  const first = String(text).replace(/^\ufeff/, "").trimStart()[0];
  return first === "{" || first === "[" ? "jsonl" : "csv";
}

/** RFC 4180 CSV: quoted fields, "" escapes, CRLF or LF, newlines inside quotes. Blank lines are skipped. */
export function parseCSV(text) {
  const s = String(text).replace(/^\ufeff/, "");
  const records = [];
  let field = "";
  let fields = [];
  let quoted = false;
  let fresh = true; // at the start of a field
  let line = 1;
  let start = 1;
  const endField = () => {
    fields.push(field);
    field = "";
    fresh = true;
  };
  const endRecord = () => {
    endField();
    if (!(fields.length === 1 && fields[0].trim() === "")) records.push({ line: start, fields });
    fields = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && fresh) {
      quoted = true;
      fresh = false;
    } else if (c === ",") endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      endRecord();
      line++;
      start = line;
    } else {
      fresh = false;
      field += c;
    }
  }
  if (quoted) return { records, error: { line: start, message: "A quoted field is never closed. Check for a missing closing quote." } };
  if (field !== "" || fields.length) endRecord();
  return { records, error: null };
}

function readJSONL(text, out) {
  const raw = [];
  const src = String(text).replace(/^\ufeff/, "");
  if (src.trimStart().startsWith("[")) {
    out.errors.push({ line: 1, custom_id: null, message: "This looks like a JSON array. Use JSON Lines instead: one JSON object per line." });
    return raw;
  }
  const lines = src.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const src = lines[n].trim();
    if (!src) continue;
    const line = n + 1;
    let v;
    try {
      v = JSON.parse(src);
    } catch (e) {
      raw.push({ line, error: "Not valid JSON (" + clip(String(e?.message || e), 100) + ")." });
      continue;
    }
    if (!plain(v)) {
      raw.push({ line, error: "Each line must be a JSON object." });
      continue;
    }
    const id = v.custom_id;
    if ("body" in v) {
      if ("prompt" in v) raw.push({ line, id, error: 'Use either "body" (OpenAI batch line) or "prompt", not both.' });
      else if (!plain(v.body)) raw.push({ line, id, error: '"body" must be a JSON object with the request.' });
      else if (v.url != null && !/(^|\/)chat\/completions$/.test(String(v.url).split("?")[0])) raw.push({ line, id, error: `Only chat completions are supported ("url": "/v1/chat/completions"), not "${clip(String(v.url), 60)}".` });
      else if (v.method != null && String(v.method).toUpperCase() !== "POST") raw.push({ line, id, error: '"method" must be "POST".' });
      else raw.push({ line, id, body: v.body });
    } else if ("prompt" in v) {
      const extra = Object.keys(v).filter((k) => !SIMPLE_KEYS.has(k));
      if (extra.length) raw.push({ line, id, error: `Unknown field "${clip(extra[0], 40)}". Simple lines take custom_id, prompt and model; put other parameters in "body" (OpenAI batch line) or the defaults.` });
      else if (v.model != null && (typeof v.model !== "string" || !v.model.trim())) raw.push({ line, id, error: '"model" must be a non-empty string.' });
      else raw.push({ line, id, prompt: v.prompt, model: v.model?.trim() });
    } else raw.push({ line, id, error: 'Needs "body" (OpenAI batch line) or "prompt".' });
  }
  return raw;
}

function readCSV(text, out) {
  const { records, error } = parseCSV(text);
  if (error) out.errors.push({ line: error.line, custom_id: null, message: error.message });
  if (!records.length) return [];
  const header = records[0].fields.map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const [pi, ci, mi] = [col("prompt"), col("custom_id"), col("model")];
  if (pi < 0) {
    out.errors.push({ line: records[0].line, custom_id: null, message: 'The first CSV row must be a header with a "prompt" column (optional: custom_id, model).' });
    return [];
  }
  out.ignoredColumns = header.filter((h, i) => h && ![pi, ci, mi].includes(i));
  const raw = [];
  for (const { line, fields } of records.slice(1)) {
    const extra = fields.slice(header.length).filter((f) => f.trim());
    const cell = (i) => (i >= 0 ? fields[i] ?? "" : "");
    const id = cell(ci).trim() || undefined;
    if (extra.length) raw.push({ line, id, error: `Has ${fields.length} values but the header has ${header.length} columns. Quote values that contain commas.` });
    else raw.push({ line, id, prompt: cell(pi), model: cell(mi).trim() || undefined });
  }
  return raw;
}

/** First problem with a chat request body, or null. */
export function validateBody(body) {
  if (!plain(body)) return "The request must be a JSON object.";
  if (typeof body.model !== "string" || !body.model.trim()) return 'No model. Set "model" on the row or choose a default model or route.';
  if ("prompt" in body && !("messages" in body)) return 'Use "messages" (chat completions), not "prompt", inside "body".';
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return '"messages" must be a non-empty array.';
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!plain(m)) return `messages[${i}] must be an object.`;
    if (!ROLES.includes(m.role)) return `messages[${i}].role must be one of ${ROLES.join(", ")}.`;
    const toolCall = m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length;
    if (typeof m.content === "string") {
      if (!m.content.trim() && m.role === "user") return `messages[${i}].content is empty.`;
    } else if (Array.isArray(m.content)) {
      if (!m.content.length) return `messages[${i}].content is an empty array.`;
    } else if (!(toolCall && m.content == null)) return `messages[${i}].content must be a string or an array of content parts.`;
  }
  for (const k of ["max_tokens", "max_completion_tokens"]) if (body[k] != null && (!Number.isInteger(body[k]) || body[k] < 1)) return `"${k}" must be a positive integer.`;
  if (body.temperature != null && (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 2)) return '"temperature" must be a number from 0 to 2.';
  if (body.top_p != null && (typeof body.top_p !== "number" || body.top_p < 0 || body.top_p > 1)) return '"top_p" must be a number from 0 to 1.';
  if (body.models != null && (!Array.isArray(body.models) || body.models.some((x) => typeof x !== "string"))) return '"models" must be an array of model ids.';
  return null;
}

/**
 * Validate the default-parameter inputs of the form. Blank fields mean "not set".
 * Returns { defaults: { model, params }, error }.
 */
export function buildDefaults({ model = "", maxTokens = "", temperature = "", extra = "" } = {}) {
  const params = {};
  let error = null;
  const extraText = String(extra).trim();
  if (extraText) {
    let v;
    try {
      v = JSON.parse(extraText);
    } catch {
      v = undefined;
    }
    if (!plain(v)) error = "Extra parameters must be a JSON object, for example {\"top_p\": 0.9}.";
    else {
      const bad = ["model", "messages", "stream", "prompt"].find((k) => k in v);
      if (bad) error = `Set "${bad}" per row or with the fields above, not in extra parameters.`;
      else Object.assign(params, v);
    }
  }
  const mt = String(maxTokens).trim();
  if (mt) {
    const n = Number(mt);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) error ||= "Max tokens must be a whole number of at least 1.";
    else params.max_tokens = n;
  }
  const t = String(temperature).trim();
  if (t) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 2) error ||= "Temperature must be a number from 0 to 2.";
    else params.temperature = n;
  }
  return { defaults: { model: String(model || "").trim(), params }, error };
}

function applyDefaults(r, defaults) {
  const body = r.body ? { ...r.body } : { model: r.model, messages: [{ role: "user", content: r.prompt }] };
  if (body.model == null || body.model === "") body.model = defaults.model || undefined;
  for (const [k, v] of Object.entries(defaults.params || {})) {
    if (body[k] !== undefined) continue;
    if (k === "max_tokens" && body.max_completion_tokens !== undefined) continue;
    body[k] = v;
  }
  delete body.stream; // every row is a single non-streaming request
  delete body.stream_options;
  if (body.model === undefined) delete body.model;
  return body;
}

/**
 * Parse and validate batch input.
 * Returns { format, rows: [{ index, line, custom_id, body }], errors: [{ line, custom_id, message }],
 *           total, invalid, ignoredColumns, tooMany }.
 * Rows that fail validation are left out of `rows` and described in `errors`.
 */
export function parseBatch(text, { format = "auto", fileName = "", defaults = {}, maxRows = MAX_ROWS } = {}) {
  const src = String(text ?? "");
  const fmt = format === "auto" ? detectFormat(src, fileName) : format;
  const out = { format: fmt, rows: [], errors: [], total: 0, invalid: 0, ignoredColumns: [], tooMany: false };
  if (!src.trim()) return out;
  if (src.length > MAX_INPUT_CHARS) {
    out.tooMany = true;
    out.errors.push({ line: null, custom_id: null, message: `The input is larger than ${MAX_INPUT_CHARS / 1024 / 1024} MB. Split it into smaller files.` });
    return out;
  }
  const raw = fmt === "csv" ? readCSV(src, out) : readJSONL(src, out);
  out.total = raw.length;
  if (raw.length > maxRows) {
    out.tooMany = true;
    out.errors.push({ line: null, custom_id: null, message: `This input has ${raw.length.toLocaleString("en-US")} rows. A batch runs at most ${maxRows.toLocaleString("en-US")}; split it into smaller files.` });
    return out;
  }
  // custom_id: explicit ids first (so generated ones never collide with them), then row-N for the rest.
  const seen = new Map();
  for (const r of raw) {
    if (r.id === undefined || r.id === null) continue;
    const id = typeof r.id === "number" && Number.isFinite(r.id) ? String(r.id) : r.id;
    if (typeof id !== "string" || !id.trim()) r.error ||= '"custom_id" must be a non-empty string.';
    else if (id.length > CUSTOM_ID_MAX) r.error ||= `"custom_id" is longer than ${CUSTOM_ID_MAX} characters.`;
    else if (seen.has(id)) r.error ||= `Duplicate custom_id "${clip(id, 40)}" (first used on line ${seen.get(id)}).`;
    else seen.set(id, r.line);
    r.custom_id = typeof id === "string" ? id : null;
  }
  let auto = 0;
  raw.forEach((r, n) => {
    if (r.custom_id != null) return;
    let id = "row-" + (n + 1);
    while (seen.has(id)) id = "row-" + (n + 1) + "-" + ++auto;
    seen.set(id, r.line);
    r.custom_id = id;
    r.auto = true;
  });
  const bad = new Set();
  for (const r of raw) {
    let message = r.error;
    let body;
    if (!message && !r.body && (typeof r.prompt !== "string" || !r.prompt.trim())) message = typeof r.prompt === "string" ? "The prompt is empty." : '"prompt" must be a string.';
    if (!message) {
      body = applyDefaults(r, defaults);
      message = validateBody(body);
    }
    if (message) {
      out.errors.push({ line: r.line, custom_id: r.auto ? null : r.custom_id, message });
      bad.add(r.line);
    } else out.rows.push({ index: out.rows.length, line: r.line, custom_id: r.custom_id, body });
  }
  out.invalid = bad.size;
  return out;
}

/** Saved routes from GET /api/v1/routes, whatever the envelope: [{ slug, name, models }]. */
export function normalizeRoutes(res) {
  const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : Array.isArray(res?.data?.routes) ? res.data.routes : Array.isArray(res?.routes) ? res.routes : [];
  return list
    .filter((r) => plain(r) && typeof r.slug === "string" && r.slug.trim())
    .map((r) => {
      const c = plain(r.config) ? r.config : {};
      const ids = [c.model, ...(Array.isArray(c.models) ? c.models : []), ...(Array.isArray(c.fallbacks) ? c.fallbacks : []), r.model, ...(Array.isArray(r.models) ? r.models : [])];
      const models = [...new Set(ids.map((m) => (plain(m) ? m.id || m.model : m)).filter((m) => typeof m === "string" && m))];
      return { slug: r.slug.trim(), name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : r.slug.trim(), models };
    });
}

// ---------------------------------------------------------------- estimates

/** Characters of text the model reads: string contents and text parts. */
export function promptChars(body) {
  let n = 0;
  for (const m of body?.messages || []) {
    if (typeof m?.content === "string") n += m.content.length;
    else if (Array.isArray(m?.content)) for (const p of m.content) n += typeof p === "string" ? p.length : typeof p?.text === "string" ? p.text.length : 0;
  }
  return n;
}

/**
 * Per-token prices by model id (and by "@route/<slug>" when a route lists its models).
 * `models` use the dashboard catalog shape: price/output in USDG per 1M tokens, royaltyBps, contextLength.
 */
export function priceIndex(models = [], routes = []) {
  const byId = new Map();
  for (const m of models) {
    if (!m?.id) continue;
    const uplift = 1 + (Number(m.royaltyBps) || 0) / 1e4;
    byId.set(m.id, { prompt: ((Number(m.price) || 0) / 1e6) * uplift, completion: ((Number(m.output) || 0) / 1e6) * uplift, context: Number(m.contextLength) || null });
  }
  const byRoute = new Map();
  for (const r of routes) {
    const known = (r.models || []).map((id) => byId.get(id));
    if (!known.length || known.some((p) => !p)) continue; // a route is priced only when every model it may use is
    byRoute.set("@route/" + r.slug, worst(known));
  }
  return (id) => byId.get(id) || byRoute.get(id) || null;
}

function worst(prices) {
  const ctx = prices.map((p) => p.context).filter(Boolean);
  return { prompt: Math.max(...prices.map((p) => p.prompt)), completion: Math.max(...prices.map((p) => p.completion)), context: ctx.length ? Math.min(...ctx) : null };
}

/** The most expensive of the row's model and its fallbacks, or null when any is unpriced. */
export function rowPrice(body, priceOf) {
  const ids = [body.model, ...(Array.isArray(body.models) ? body.models : [])].filter(Boolean);
  const prices = ids.map((id) => priceOf(id));
  return prices.length && prices.every(Boolean) ? worst(prices) : null;
}

/** Tokens and worst-case cost of one row: prompt ≈ chars / 4; output = max_tokens (else what the router reserves). */
export function estimateRow(body, price) {
  const input = Math.max(1, Math.ceil(promptChars(body) / 4));
  const cap = body.max_tokens ?? body.max_completion_tokens;
  const output = Number.isInteger(cap) ? cap : Math.min(4096, Math.floor((price?.context || 16384) / 4));
  return { input, output, maxCost: price ? input * price.prompt + output * price.completion : null };
}

export function estimateBatch(rows, priceOf) {
  const out = { rows: rows.length, input: 0, output: 0, maxCost: 0, maxRowCost: 0, priced: 0, unpriced: 0, unpricedModels: [] };
  const unpriced = new Set();
  for (const r of rows) {
    const e = estimateRow(r.body, rowPrice(r.body, priceOf));
    out.input += e.input;
    out.output += e.output;
    if (e.maxCost == null) {
      out.unpriced++;
      unpriced.add(r.body.model);
    } else {
      out.priced++;
      out.maxCost += e.maxCost;
      out.maxRowCost = Math.max(out.maxRowCost, e.maxCost);
    }
  }
  out.unpricedModels = [...unpriced];
  return out;
}

/** Compare the estimate with the key's available balance and remaining budget (null = no limit). */
export function checkFunds(maxCost, { available, budgetRemaining } = {}) {
  const limits = [];
  if (available != null && Number.isFinite(Number(available))) limits.push({ source: "balance", amount: Number(available) });
  if (budgetRemaining != null && Number.isFinite(Number(budgetRemaining))) limits.push({ source: "budget", amount: Number(budgetRemaining) });
  if (!limits.length) return { known: false, enough: null, limit: null, source: null, shortfall: 0 };
  const tight = limits.reduce((a, b) => (b.amount < a.amount ? b : a));
  const enough = maxCost <= tight.amount + 1e-12;
  return { known: true, enough, limit: tight.amount, source: tight.source, shortfall: enough ? 0 : maxCost - tight.amount };
}

// ---------------------------------------------------------------- retry policy

/** Retry-After as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/** The wait a 429 asks for: a Retry-After header when the error carries one, else the router's retry_after_ms. */
export function retryAfterMs(err, now = Date.now()) {
  const header = err?.retryAfter ?? (typeof err?.headers?.get === "function" ? err.headers.get("retry-after") : err?.headers?.["retry-after"]);
  const fromHeader = parseRetryAfter(header, now);
  if (fromHeader != null) return fromHeader;
  const ms = Number(err?.metadata?.retry_after_ms);
  return err?.metadata?.retry_after_ms != null && Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Exponential back-off with equal jitter: attempt 1 → 0.5–1× base, doubling, capped. */
export function backoffMs(attempt, { base = 1000, cap = 30_000, random = Math.random } = {}) {
  const d = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(d / 2 + random() * (d / 2));
}

/** aborted | rate_limit | funds (402) | auth (401) | transient (5xx, 408, network) | fatal (other 4xx). */
export function classifyError(err) {
  if (err?.name === "AbortError") return "aborted";
  const s = Number(err?.status);
  if (s === 429) return "rate_limit";
  if (s === 402) return "funds";
  if (s === 401) return "auth";
  if (!s || s >= 500 || s === 408) return "transient";
  return "fatal";
}

const errorInfo = (err) => ({
  status: Number(err?.status) || 0,
  type: String(err?.type || (err?.name === "AbortError" ? "aborted" : "error")),
  message: clip(String(err?.message || err || "The request failed."), 2000),
  ...(plain(err?.metadata) ? { metadata: err.metadata } : {}),
});

// ---------------------------------------------------------------- scheduler

export const newState = () => ({ status: "pending", attempts: 0, retries: 0, rateLimits: 0, nextAt: 0, startedAt: null, finishedAt: null, response: null, error: null });

export const systemClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };

/**
 * Runs rows through `send(body, { signal, row })`, which resolves with the response JSON or rejects with an
 * error carrying `status` (0 for network), `type`, `message` and optionally `metadata.retry_after_ms`.
 *
 * - At most `concurrency` requests in flight (1–8, adjustable while running).
 * - 429: the row waits for Retry-After (or exponential back-off) and every new request holds until then.
 * - 5xx, 408 and network errors: retried up to `maxRetries` times with exponential back-off.
 * - 402: when other requests were in flight at launch (their holds may be what ran out), the row is re-queued
 *   and the run continues one request at a time; a 402 on a request sent alone pauses the run.
 * - 401 pauses the run. Other 4xx fail the row.
 * - pause() lets in-flight requests finish and starts no new ones; cancel() aborts in-flight requests.
 * Row states are plain objects (safe to persist); `status` is idle | running | paused | completed | cancelled.
 */
export class BatchRunner {
  constructor({ rows, states, send, concurrency = CONCURRENCY.default, clock = systemClock, random = Math.random, maxRetries = MAX_RETRIES, maxRateLimitWaits = MAX_RATE_LIMIT_WAITS, onChange = () => {} }) {
    this.rows = rows;
    this.states = states || rows.map(newState);
    this.send = send;
    this.clock = clock;
    this.random = random;
    this.maxRetries = maxRetries;
    this.maxRateLimitWaits = maxRateLimitWaits;
    this.onChange = onChange;
    this.concurrency = clampConcurrency(concurrency);
    this.status = "idle";
    this.reason = null;
    this.inflight = new Map(); // row index -> { ctl: AbortController, alone: no other request overlapped it }
    this.holdUntil = 0; // 429: no new request before this time
    this.solo = false; // 402 with others in flight: one request at a time until a row succeeds
    this.timer = null;
    this.wakeAt = 0;
    this.sessionStart = null;
    this.finishes = []; // finish times in the current session, for rows per minute
    this.waiters = [];
    this.queue();
  }

  queue() {
    this.pending = [];
    this.waiting = new Set();
    this.states.forEach((st, i) => {
      if (st.status === "pending" || st.status === "running") {
        st.status = "pending";
        this.pending.push(i);
      } else if (st.status === "waiting") this.waiting.add(i);
    });
  }

  start() {
    return this.resume();
  }

  resume() {
    if (this.status !== "idle" && this.status !== "paused") return this;
    this.status = "running";
    this.reason = null;
    this.solo = false;
    this.sessionStart = this.clock.now();
    this.finishes = [];
    this.onChange(null);
    this.pump();
    return this;
  }

  pause(reason = { kind: "user" }) {
    if (this.status !== "running" && this.status !== "idle") return this;
    this.status = "paused";
    this.reason = reason;
    this.stopTimer();
    this.onChange(null);
    this.checkIdle();
    return this;
  }

  cancel() {
    if (this.status === "completed" || this.status === "cancelled") return this;
    this.status = "cancelled";
    this.reason = { kind: "user" };
    this.stopTimer();
    const now = this.clock.now();
    const cancelled = { status: 0, type: "cancelled", message: "Cancelled before it ran." };
    for (const i of [...this.pending, ...this.waiting]) Object.assign(this.states[i], { status: "cancelled", finishedAt: now, nextAt: 0, error: cancelled });
    this.pending = [];
    this.waiting.clear();
    for (const { ctl } of this.inflight.values()) ctl.abort();
    this.onChange(null);
    this.checkIdle();
    return this;
  }

  /** Reset rows in the given statuses (default: failed and cancelled) and run them again. */
  retry(statuses = ["failed", "cancelled"]) {
    if (this.inflight.size) return 0;
    let n = 0;
    this.states.forEach((st, i) => {
      if (!statuses.includes(st.status)) return;
      this.states[i] = newState();
      n++;
    });
    if (!n) return 0;
    this.queue();
    this.status = "paused";
    this.resume();
    return n;
  }

  setConcurrency(n) {
    this.concurrency = clampConcurrency(n);
    this.pump();
  }

  /** Resolves when nothing is in flight and the run is paused, completed or cancelled. */
  settled() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.checkIdle();
    });
  }

  rowsPerMinute(now = this.clock.now()) {
    return rowsPerMinute(this.finishes, now, this.sessionStart);
  }

  // ---- internals
  pump() {
    if (this.status !== "running") return this.checkIdle();
    const now = this.clock.now();
    const limit = this.solo ? 1 : this.concurrency;
    while (this.inflight.size < limit) {
      if (now < this.holdUntil) {
        this.wake(this.holdUntil);
        break;
      }
      const i = this.next(now);
      if (i == null) {
        let soonest = Infinity;
        for (const w of this.waiting) soonest = Math.min(soonest, this.states[w].nextAt);
        if (soonest < Infinity) this.wake(soonest);
        break;
      }
      this.launch(i);
    }
    this.checkIdle();
  }

  next(now) {
    let pick = null;
    for (const w of this.waiting) if (this.states[w].nextAt <= now && (pick == null || this.states[w].nextAt < this.states[pick].nextAt)) pick = w;
    if (pick != null) {
      this.waiting.delete(pick);
      return pick;
    }
    return this.pending.length ? this.pending.shift() : null;
  }

  wake(at) {
    if (this.timer && this.wakeAt <= at) return;
    this.stopTimer();
    this.wakeAt = at;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, at - this.clock.now()));
  }

  stopTimer() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  launch(i) {
    const st = this.states[i];
    const ctl = new AbortController();
    for (const other of this.inflight.values()) other.alone = false;
    this.inflight.set(i, { ctl, alone: this.inflight.size === 0 });
    Object.assign(st, { status: "running", attempts: st.attempts + 1, nextAt: 0, startedAt: this.clock.now() });
    this.onChange(i);
    let p;
    try {
      p = Promise.resolve(this.send(this.rows[i].body, { signal: ctl.signal, row: this.rows[i] }));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (body) => this.settle(i, (alone) => this.succeed(i, body, alone)),
      (err) => this.settle(i, (alone) => this.failed(i, err, alone)),
    );
  }

  settle(i, fn) {
    const { alone } = this.inflight.get(i);
    this.inflight.delete(i);
    fn(alone);
    this.onChange(i);
    this.pump();
  }

  finish(i, patch) {
    const now = this.clock.now();
    Object.assign(this.states[i], { ...patch, finishedAt: now, nextAt: 0 });
    if (patch.status !== "cancelled") this.finishes.push(now);
    while (this.finishes.length && this.finishes[0] < now - 60_000) this.finishes.shift();
  }

  succeed(i, body, alone) {
    if (alone) this.solo = false; // a request sent on its own went through: full concurrency again
    this.finish(i, { status: "done", response: { status_code: 200, body }, error: null });
  }

  requeue(i) {
    const st = this.states[i];
    Object.assign(st, { status: "pending", attempts: Math.max(0, st.attempts - 1) });
    this.pending.unshift(i);
  }

  toWaiting(i, at) {
    Object.assign(this.states[i], { status: "waiting", nextAt: at });
    this.waiting.add(i);
  }

  failed(i, err, alone) {
    const st = this.states[i];
    const now = this.clock.now();
    const kind = this.status === "cancelled" ? "aborted" : classifyError(err);
    const info = errorInfo(err);
    if (kind === "aborted") return this.finish(i, { status: "cancelled", error: { status: 0, type: "cancelled", message: "Cancelled before a response arrived. The router may still bill work a provider already did." } });
    st.error = info;
    if (kind === "rate_limit") {
      st.rateLimits++;
      if (st.rateLimits > this.maxRateLimitWaits) return this.finish(i, { status: "failed" });
      const wait = Math.min(MAX_WAIT_MS, retryAfterMs(err, now) ?? backoffMs(st.rateLimits, { base: 2000, cap: 60_000, random: this.random }));
      this.holdUntil = Math.max(this.holdUntil, now + wait);
      return this.toWaiting(i, now + wait);
    }
    if (kind === "funds") {
      this.requeue(i);
      if (!alone) this.solo = true; // other holds may be what ran out: try again on its own
      else this.pause({ kind: "funds", type: info.type, message: info.message, metadata: info.metadata });
      return;
    }
    if (kind === "auth") {
      this.requeue(i);
      return this.pause({ kind: "auth", type: info.type, message: info.message });
    }
    if (kind === "transient") {
      st.retries++;
      if (st.retries > this.maxRetries) return this.finish(i, { status: "failed" });
      return this.toWaiting(i, now + backoffMs(st.retries, { random: this.random }));
    }
    this.finish(i, { status: "failed" });
  }

  checkIdle() {
    if (this.inflight.size) return;
    if (this.status === "running" && !this.pending.length && !this.waiting.size) {
      this.status = "completed";
      this.stopTimer();
      this.onChange(null);
    }
    if (this.status === "running" || this.status === "idle") return;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f(this.status));
  }
}

export const clampConcurrency = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(CONCURRENCY.max, Math.max(CONCURRENCY.min, Math.round(v))) : CONCURRENCY.default;
};

/** Finished rows per minute over the last minute of the current session (null until there is data). */
export function rowsPerMinute(finishes, now, since, windowMs = 60_000) {
  if (since == null) return null;
  const from = Math.max(since, now - windowMs);
  const span = now - from;
  if (span < 1000) return null;
  const n = finishes.filter((t) => t >= from && t <= now).length;
  return (n / span) * 60_000;
}

/**
 * States saved before a reload: rows in flight then may have completed (and been billed) without us seeing
 * the answer, so they fail as "interrupted" instead of being sent twice. Waiting rows are queued again.
 */
export function restoreStates(states) {
  return states.map((s) => {
    const st = { ...newState(), ...s };
    if (st.status === "running")
      return { ...st, status: "failed", finishedAt: st.startedAt, error: { status: 0, type: "interrupted", message: "The page closed while this row was in flight. It may have completed and been billed; check Receipts before retrying it." } };
    if (st.status === "waiting") return { ...st, status: "pending", nextAt: 0 };
    return st;
  });
}

// ---------------------------------------------------------------- results

const usageOf = (st) => (st.status === "done" && plain(st.response?.body?.usage) ? st.response.body.usage : null);
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function summarize(states) {
  const s = { total: states.length, pending: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0, finished: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  for (const st of states) {
    s[st.status] = (s[st.status] || 0) + 1;
    const u = usageOf(st);
    if (u) {
      s.promptTokens += num(u.prompt_tokens) || 0;
      s.completionTokens += num(u.completion_tokens) || 0;
      s.cost += num(u.cost) || 0;
    }
  }
  s.finished = s.done + s.failed;
  return s;
}

/** One OpenAI-batch-like output record: { custom_id, response: { status_code, body }, error, usage, cost, receipt_id }. */
export function resultRecord(row, st) {
  const done = st.status === "done";
  const body = done ? st.response?.body ?? null : null;
  const usage = usageOf(st);
  let response = null;
  if (done) response = { status_code: st.response.status_code, body };
  else if (st.status === "failed" && st.error?.status) response = { status_code: st.error.status, body: { error: { code: st.error.status, message: st.error.message, type: st.error.type, ...(st.error.metadata ? { metadata: st.error.metadata } : {}) } } };
  let error = null;
  if (st.status === "failed") error = { code: st.error?.type || "error", message: st.error?.message || "The request failed." };
  else if (st.status === "cancelled") error = { code: "cancelled", message: st.error?.message || "Cancelled before it ran." };
  else if (!done) error = { code: "not_run", message: "This row has not run yet." };
  return { custom_id: row.custom_id, response, error, usage, cost: num(usage?.cost), receipt_id: done ? body?.receipt?.id ?? body?.id ?? null : null };
}

export function toJSONL(rows, states) {
  return rows.map((r, i) => JSON.stringify(resultRecord(r, states[i]))).join("\n") + (rows.length ? "\n" : "");
}

/** A CSV cell: quoted when needed; text that a spreadsheet would run as a formula is prefixed with '. */
export function csvCell(v) {
  if (v == null) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Text of the first choice (content parts joined; tool calls as JSON). */
export function responseText(body) {
  const m = body?.choices?.[0]?.message;
  if (!m) return typeof body?.choices?.[0]?.text === "string" ? body.choices[0].text : "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  return m.tool_calls ? JSON.stringify(m.tool_calls) : "";
}

export const CSV_COLUMNS = ["custom_id", "status", "status_code", "model", "content", "finish_reason", "prompt_tokens", "completion_tokens", "total_tokens", "cost", "receipt_id", "error"];

export function toCSV(rows, states) {
  const lines = [CSV_COLUMNS.join(",")];
  rows.forEach((row, i) => {
    const st = states[i];
    const rec = resultRecord(row, st);
    const body = rec.response?.status_code === 200 ? rec.response.body : null;
    const u = rec.usage || {};
    const status = { done: "succeeded", failed: "failed", cancelled: "cancelled" }[st.status] || "not_run";
    const cells = [row.custom_id, status, rec.response?.status_code ?? null, body?.model || row.body?.model, body ? responseText(body) : null, body?.choices?.[0]?.finish_reason ?? null, num(u.prompt_tokens), num(u.completion_tokens), num(u.total_tokens), rec.cost, rec.receipt_id, rec.error ? rec.error.message : null];
    lines.push(cells.map(csvCell).join(","));
  });
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

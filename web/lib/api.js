import { availabilityFields } from "./model-availability.js"; // ON5
// Live data adapter: the Anyroute API behind the existing interface.
// The site is normally served by the router itself (same origin). Set NEXT_PUBLIC_ANYROUTE_API_URL at
// build time to call a router hosted elsewhere. No secret is ever bundled: the API key is supplied by
// the user and kept in this browser only (session storage only).

export const API_BASE = (process.env.NEXT_PUBLIC_ANYROUTE_API_URL || "").replace(/\/$/, "");
export const keyStore = "anyroute-key-v1";
export const modeStore = "anyroute-mode";

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** "demo" only when the visitor explicitly chose the sample workspace (or ?demo=1); otherwise live. */
export function getMode() {
  if (typeof window === "undefined") return "live";
  if (new URLSearchParams(window.location.search).get("demo") === "1") return "demo";
  return safe(() => localStorage.getItem(modeStore), null) === "demo" ? "demo" : "live";
}
export function setMode(mode) {
  safe(() => (mode === "demo" ? localStorage.setItem(modeStore, "demo") : localStorage.removeItem(modeStore)));
}

export function loadKey() {
  safe(() => localStorage.removeItem(keyStore));
  return safe(() => sessionStorage.getItem(keyStore), null) || "";
}
export function saveKey(secret) {
  safe(() => {
    sessionStorage.setItem(keyStore, secret);
    localStorage.removeItem(keyStore);
  });
}
export function clearKey() {
  safe(() => {
    sessionStorage.removeItem(keyStore);
    localStorage.removeItem(keyStore);
  });
}
export const validKey = (s) => /^sk-ar-v1-[0-9a-f]{64}$/.test(String(s).trim());

export class ApiError extends Error {
  constructor(status, message, type, metadata) {
    super(message);
    this.status = status;
    this.type = type;
    this.metadata = metadata;
  }
}

export async function api(path, { key, method = "GET", body, signal, headers = {}, onResponse, raw = false } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      signal,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { authorization: "Bearer " + key } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError(0, "The Anyroute API could not be reached. Check your connection and try again.", "unreachable");
  }
  onResponse?.(res); // the response headers (lane, receipt id) of a success and of an error alike
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = json?.error;
    const err = new ApiError(res.status, e?.message || `Request failed (${res.status}).`, e?.type || "error", e?.metadata);
    err.retryAfter = res.headers.get("retry-after"); // seconds or an HTTP date; read by the batch and eval runners
    throw err;
  }
  return raw ? text : json; // raw: the body as text, for JSONL such as a batch's output and errors files
}

/**
 * Streaming chat completion. Calls onDelta(text) as tokens arrive and, when given, onEvent(chunk) with every
 * parsed chunk (reasoning, tool calls, images, audio, usage, receipt); resolves with the final summary.
 */
export async function streamChat({ key, body, headers = {}, signal, onDelta, onEvent }) {
  let res;
  try {
    res = await fetch(API_BASE + "/api/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + key, ...headers },
      body: JSON.stringify({ ...body, stream: true }),
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError(0, "The Anyroute API could not be reached. Check your connection and try again.", "unreachable");
  }
  if (!res.ok) {
    let doc = null;
    try {
      doc = await res.json();
    } catch {
      /* not JSON */
    }
    const e = doc?.error;
    const err = new ApiError(res.status, e?.message || `Request failed (${res.status}).`, e?.type || "error", e?.metadata);
    err.retryAfter = res.headers.get("retry-after");
    // A withheld answer is still billed and signed: keep the receipt and usage the refusal carries, so callers can show them.
    if (doc?.receipt && typeof doc.receipt === "object") err.receipt = doc.receipt;
    if (doc?.usage && typeof doc.usage === "object") err.usage = doc.usage;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out = { id: res.headers.get("x-generation-id"), text: "", usage: null, receipt: null, provider: null, model: null, error: null };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      onEvent?.(ev);
      if (ev.error && !ev.choices) {
        out.error = new ApiError(ev.error.code || 502, ev.error.message || "The route failed.", ev.error.type || "error", ev.error.metadata);
        continue;
      }
      if (ev.error) out.error = new ApiError(502, ev.error.message || "The provider failed mid-stream.", ev.error.type || "provider_error");
      out.id = ev.id || out.id;
      out.provider = ev.provider || out.provider;
      out.model = ev.model || out.model;
      for (const ch of ev.choices || []) {
        const piece = ch?.delta?.content;
        if (typeof piece === "string" && piece) {
          out.text += piece;
          onDelta?.(out.text);
        }
      }
      if (ev.usage) out.usage = ev.usage;
      if (ev.receipt) out.receipt = ev.receipt;
    }
  }
  if (out.error && !out.receipt) throw out.error;
  return out;
}

// ---- shape mapping: API records -> the shapes the existing components render ----

const compact = (n) => (n >= 1024 ? Math.round(n / 1024) + "K" : String(n));

export function toCatalogModel(m) {
  const author = m.id.split("/")[0];
  return {
    ...availabilityFields(m), // ON5
    id: m.id,
    name: m.name && m.name !== m.id ? m.name : m.id.split("/").slice(1).join("/") || m.id,
    author: author.charAt(0).toUpperCase() + author.slice(1),
    context: compact(m.context_length || 0),
    contextLength: m.context_length,
    type: (m.supported_parameters || []).includes("reasoning") ? "Reasoning" : (m.architecture?.output_modalities || []).includes("embeddings") ? "Embeddings" : "General",
    private: !!m.attested_available,
    price: Number(m.pricing?.prompt || 0) * 1e6,
    output: Number(m.pricing?.completion || 0) * 1e6,
    description: m.description || `${m.data_policy?.providers ?? 0} provider${m.data_policy?.providers === 1 ? "" : "s"} · ${(m.quantization || []).join(", ") || "quantization not declared"}.`,
    providers: m.data_policy?.providers ?? 0,
    quantization: m.quantization || [],
    zdr: !!m.data_policy?.zdr_available,
    creator: m.creator,
    royaltyBps: m.royalty_bps || 0,
    parameters: m.supported_parameters || [],
  };
}

export function toReceiptRow(g, tokens = []) {
  const pw = g.paid_with || null;
  const tok = pw && tokens.find((t) => t.symbol === pw.token);
  const units = pw?.raw_units ? Number(pw.raw_units) / 10 ** (tok?.decimals ?? 18) : 0;
  return {
    id: g.id,
    time: g.created_at,
    model: g.model,
    modelId: g.model,
    provider: g.provider_name,
    tokens: (g.tokens_prompt || 0) + (g.tokens_completion || 0),
    input: g.tokens_prompt || 0,
    output: g.tokens_completion || 0,
    inference: g.upstream_inference_cost || 0,
    royalty: g.royalty || 0,
    margin: g.margin || 0,
    cost: g.total_cost || 0,
    latency: g.latency,
    private: !!g.private,
    quant: g.quantization,
    paidWith: pw?.token || (g.mode === "per_call" ? "USDG · per call" : "USDG"),
    units,
    decimals: tok?.decimals ?? 18,
    keyId: g.key_hash,
    mode: g.mode,
    status: g.anchored ? "Signed · anchored" : "Signed · anchor pending",
    signature: g.receipt_key_id,
    anchor: g.anchored,
    live: true,
  };
}

export function toProvider(p) {
  return {
    name: p.name,
    slug: p.slug,
    quant: (p.quantizations || []).join(", ") || "undeclared",
    uptime: p.uptime_30d,
    latency: p.latency_p50_ms,
    bond: Number(p.bond_usdg || 0) / 1e6,
    private: !!p.attestation_fresh,
    tee: p.tee,
    attestation: p.attestation_hash,
    attestedAt: p.attested_at,
    status: p.status,
    models: p.models,
    policy: p.data_policy || {},
    outage: p.outage,
  };
}

/** Everything the dashboard shows for a signed-in key. */
export async function loadWorkspace(key) {
  const [me, credits, gens, tokens] = await Promise.all([
    api("/api/v1/key", { key }),
    api("/api/v1/credits", { key }),
    api("/api/v1/generations?limit=100", { key }),
    api("/api/v1/paywith/tokens").catch(() => ({ data: { tokens: [] } })),
  ]);
  let keys = [];
  let keysError = "";
  try {
    keys = (await api("/api/v1/keys", { key })).data;
  } catch (e) {
    keysError = e.message;
    keys = [me.data];
  }
  const [session, escrow, stock] = await Promise.all([
    api("/api/v1/paywith/session", { key }).catch(() => ({ data: null })),
    // Stock escrow (PAYMENTS_MODE=escrow): where to send Stock Tokens, live rates, this wallet's deposits.
    api("/api/v1/escrow").then((r) => (r.data?.enabled ? r.data : null)).catch(() => null),
    api("/api/v1/escrow/deposits", { key }).then((r) => r.data).catch(() => null),
  ]);
  const payTokens = tokens.data?.tokens || [];
  return {
    me: me.data,
    credits: credits.data,
    keys,
    keysError,
    receipts: gens.data.map((g) => toReceiptRow(g, payTokens)),
    next: gens.next,
    tokens: payTokens,
    paywith: tokens.data || {},
    session: session.data,
    escrow,
    stock,
  };
}

export function downloadJSON(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

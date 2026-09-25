// Live data adapter: the Anyroute API behind the existing interface.
// The site is normally served by the router itself (same origin). Set NEXT_PUBLIC_ANYROUTE_API_URL at
// build time to call a router hosted elsewhere. No secret is ever bundled: the API key is supplied by
// the user and kept in this browser only (session storage unless "remember" is chosen).

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
  return safe(() => sessionStorage.getItem(keyStore) || localStorage.getItem(keyStore), null) || "";
}
export function saveKey(secret, remember) {
  safe(() => {
    sessionStorage.setItem(keyStore, secret);
    if (remember) localStorage.setItem(keyStore, secret);
    else localStorage.removeItem(keyStore);
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

export async function api(path, { key, method = "GET", body, signal, headers = {} } = {}) {
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
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.message || `Request failed (${res.status}).`, e?.type || "error", e?.metadata);
  }
  return json;
}

/** Streaming chat completion. Calls onDelta(text) as tokens arrive; resolves with the final summary. */
export async function streamChat({ key, body, headers = {}, signal, onDelta }) {
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
    let e = null;
    try {
      e = (await res.json())?.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, e?.message || `Request failed (${res.status}).`, e?.type || "error", e?.metadata);
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

// The wire: one streamed POST /api/v1/chat/completions, read as server-sent events, plus the small JSON reads the
// components make (models, privacy labels). No dependencies; any fetch works (the tests pass a fake one).

import type { Attachment, ChatMessage, Receipt, Usage } from "./types";

/** Any fetch: the browser's, a proxying wrapper, or a fake in tests. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type KeySource = { apiKey?: string; getKey?: () => string | null | undefined | Promise<string | null | undefined> };

export interface ClientOptions extends KeySource {
  /** Router origin, e.g. "https://router.example". "" (the default) means the page's own origin, e.g. behind a proxy. */
  baseUrl?: string;
  /** Extra request headers (for your own proxy, say). Never logged by the kit. */
  headers?: Record<string, string>;
  /** Ask for a lane: "attested" or "unlinkable". Sent as X-Anyroute-Lane. */
  lane?: string;
  fetch?: FetchLike;
}

/** An error from the router or the network, with the HTTP status and, for 429 and 503, how long to wait. */
export class ChatError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;
  constructor(message: string, opts: { status?: number; code?: string; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = "ChatError";
    this.status = opts.status ?? 0;
    this.code = opts.code ?? "error";
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/** `baseUrl` + an API path. A base that already ends in /api/v1 or /v1 is accepted as well. */
export function apiUrl(baseUrl: string | undefined, path: string): string {
  const base = String(baseUrl ?? "").replace(/\/+$/, "").replace(/\/(api\/)?v1$/, "");
  return base + path;
}

async function resolveKey(src: KeySource): Promise<string> {
  const key = src.getKey ? await src.getKey() : src.apiKey;
  return typeof key === "string" ? key.trim() : "";
}

export async function requestHeaders(opts: ClientOptions, json = true): Promise<Record<string, string>> {
  const key = await resolveKey(opts);
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(opts.headers ?? {}),
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    ...(opts.lane ? { "x-anyroute-lane": opts.lane } : {}),
  };
}

/** Retry-After as milliseconds: delta seconds or an HTTP date. Falls back to the body's metadata.retry_after_ms. */
export function retryAfterMs(header: string | null, body?: unknown): number | null {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const err = (body as { error?: { metadata?: { retry_after_ms?: unknown }; retry_after_ms?: unknown } })?.error;
  const ms = Number(err?.metadata?.retry_after_ms ?? err?.retry_after_ms);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

async function errorFrom(res: Response): Promise<ChatError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const err = (body as { error?: { message?: unknown; type?: unknown; code?: unknown } })?.error;
  const message = typeof err?.message === "string" && err.message ? err.message : `The router answered ${res.status}.`;
  const code = typeof err?.type === "string" ? err.type : typeof err?.code === "string" ? err.code : `http_${res.status}`;
  return new ChatError(message, { status: res.status, code, retryAfterMs: retryAfterMs(res.headers.get("retry-after"), body) });
}

/** GET a JSON document from the router. Throws ChatError on a non-2xx answer. */
export async function getJson<T = unknown>(opts: ClientOptions, path: string, signal?: AbortSignal): Promise<T> {
  const f: FetchLike = opts.fetch ?? globalThis.fetch;
  const res = await f(apiUrl(opts.baseUrl, path), { headers: await requestHeaders(opts, false), signal });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

/** One streamed chunk, as the router sends it (OpenAI shape plus provider, receipt and usage on the last one). */
export interface StreamChunk {
  model?: string;
  provider?: string;
  usage?: Usage;
  receipt?: Receipt;
  error?: { message?: string; type?: string; code?: unknown };
  choices?: { delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }[];
}

/** Parse a text/event-stream body into its data payloads. Comments (keep-alives) and "[DONE]" are skipped. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  const flush = function* () {
    if (!data.length) return;
    const raw = data.join("\n");
    data = [];
    if (raw.trim() === "[DONE]") return;
    try {
      yield JSON.parse(raw) as StreamChunk;
    } catch {
      /* a partial or foreign line: ignored */
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") yield* flush();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""));
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}

/** A chat message on the wire: text, or text plus image parts for a vision model. */
export function wireMessage(m: Pick<ChatMessage, "role" | "text" | "attachments">): { role: string; content: unknown } {
  const images = (m.attachments ?? []).filter((a: Attachment) => /^image\//.test(a.type));
  if (m.role !== "user" || !images.length) return { role: m.role, content: m.text };
  return { role: "user", content: [{ type: "text", text: m.text }, ...images.map((a) => ({ type: "image_url", image_url: { url: a.url } }))] };
}

export interface StreamResult {
  lane: string | null;
  receiptId: string | null;
  /** For a "@character/<id>" call: the router's note on how it ran (X-Anyroute-Character-Note). */
  characterNote: string | null;
  chunks: AsyncGenerator<StreamChunk>;
}

/** POST a streamed chat completion. Resolves once headers arrive; iterate `chunks` for the body. */
export async function streamChat(opts: ClientOptions, body: Record<string, unknown>, signal?: AbortSignal): Promise<StreamResult> {
  const f: FetchLike = opts.fetch ?? globalThis.fetch;
  const res = await f(apiUrl(opts.baseUrl, "/api/v1/chat/completions"), {
    method: "POST",
    headers: await requestHeaders(opts),
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ChatError("The router sent no body.", { code: "empty_body" });
  const body_ = res.body;
  async function* chunks() {
    for await (const ev of sseEvents(body_)) {
      if (ev.error && !(ev.choices ?? []).some((c) => c?.delta?.content)) {
        const code = ev.error.code;
        throw new ChatError(ev.error.message || "The reply was interrupted.", { status: typeof code === "number" ? code : 0, code: ev.error.type || "stream_error" });
      }
      yield ev;
    }
  }
  return { lane: res.headers.get("x-anyroute-lane"), receiptId: res.headers.get("x-receipt-id"), characterNote: res.headers.get("x-anyroute-character-note"), chunks: chunks() };
}

/** Fold one chunk into an assistant message (returns a new object). */
export function applyChunk(m: ChatMessage, ev: StreamChunk): ChatMessage {
  const out: ChatMessage = { ...m };
  if (ev.provider) out.provider = ev.provider;
  if (ev.model) out.servedModel = ev.model;
  if (ev.usage) out.usage = ev.usage;
  if (ev.receipt && typeof ev.receipt.id === "string") out.receipt = ev.receipt;
  for (const ch of ev.choices ?? []) {
    const d = ch?.delta ?? ch?.message;
    if (d && typeof d.content === "string") out.text += d.content;
  }
  return out;
}

/** The lane written into a signed receipt, "" when it does not say. */
export function receiptLane(receipt: Receipt | undefined | null): string {
  const lane = receipt?.v2?.claims?.lane ?? receipt?.payload?.lane;
  return typeof lane === "string" ? lane : "";
}

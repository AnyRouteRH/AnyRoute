// Model Arena: the pure logic behind racing one prompt across several models.
// Link encoding, model search, cost ceiling, per-lane metrics, the badge winners and the lane runner.
// No DOM, no storage. The runner takes the stream function and the clock as arguments, so tests drive it
// with fakes; in the page they default to the same `streamChat` the dashboard playground uses.

import { API_BASE, streamChat } from "./api.js";

export const MIN_LANES = 2;
export const MAX_LANES = 4;
export const MAX_PROMPT = 8000; // characters accepted in the box and from a link
export const MAX_LINK_PROMPT = 1200; // characters a shared link carries
export const TOKEN_CAPS = [256, 512, 1024, 2048];
export const DEFAULT_MAX_TOKENS = 1024;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-:/@~+]{0,119}$/;
const KEY_PATTERN = /sk-ar-v1-[0-9a-f]{64}/gi;

/** Anything shaped like an Anyroute key becomes a placeholder; a key must never ride in a link or a prompt from one. */
export const redactKeys = (text) => String(text ?? "").replace(KEY_PATTERN, "[key removed]");

// ---------------------------------------------------------------- share links

/**
 * The query string for a shareable arena: the prompt and the chosen models, nothing else.
 * Returns { query, trimmed }: query is "" when there is nothing to share, and trimmed says the prompt was cut to fit a link.
 */
export function encodeArena({ prompt = "", models = [] } = {}) {
  const ids = [...new Set((models || []).filter((m) => typeof m === "string" && MODEL_ID.test(m)))].slice(0, MAX_LANES);
  const text = redactKeys(prompt).trim();
  const trimmed = text.length > MAX_LINK_PROMPT;
  const parts = [];
  if (text) parts.push("prompt=" + encodeURIComponent(trimmed ? text.slice(0, MAX_LINK_PROMPT) : text));
  for (const id of ids) parts.push("model=" + encodeURIComponent(id).replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%40/gi, "@"));
  return { query: parts.length ? "?" + parts.join("&") : "", trimmed };
}

/** Reads a location.search string back. Unknown parameters (and anything key-like) are ignored. */
export function decodeArena(search = "") {
  let params;
  try {
    params = new URLSearchParams(String(search));
  } catch {
    return { prompt: "", models: [] };
  }
  const prompt = redactKeys(params.get("prompt") ?? "").slice(0, MAX_PROMPT);
  const models = [];
  for (const m of params.getAll("model")) {
    const id = m.trim();
    if (MODEL_ID.test(id) && !models.includes(id)) models.push(id);
    if (models.length === MAX_LANES) break;
  }
  return { prompt, models };
}

// ---------------------------------------------------------------- model search

/** Chat-capable catalog entries only; embeddings cannot answer a prompt. */
export const chatModels = (catalog) => (catalog || []).filter((m) => m && m.type !== "Embeddings");

/** Every word of the query must appear in the name, id or author. Name-prefix matches come first, then catalog order. */
export function filterModels(models, query = "", limit = 60) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  models.forEach((m, order) => {
    const name = String(m.name || "").toLowerCase();
    const hay = `${name} ${String(m.id).toLowerCase()} ${String(m.author || "").toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    const rank = words.length && name.startsWith(words[0]) ? 0 : words.length && String(m.id).toLowerCase().includes("/" + words[0]) ? 1 : 2;
    scored.push({ m, rank, order });
  });
  scored.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return { items: scored.slice(0, limit).map((s) => s.m), total: scored.length };
}

// ---------------------------------------------------------------- numbers

/** Rough token count from text length; the router's own count replaces it when the stream ends. */
export const estimateTokens = (text) => Math.ceil(String(text || "").length / 4);

/** Worst case for a race: every prompt token plus a full-length answer from every model, at catalog prices (USD per million tokens). */
export function estimateCeiling(models, prompt, maxTokens) {
  const inTokens = estimateTokens(prompt);
  return models.reduce((sum, m) => sum + (inTokens * (Number(m?.price) || 0) + maxTokens * (Number(m?.output) || 0)) / 1e6, 0);
}

export function formatUsd(n) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  return n < 0.01 ? "$" + n.toFixed(6) : "$" + n.toFixed(4);
}
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";
}
export const shortId = (id) => (id && id.length > 18 ? id.slice(0, 8) + "…" + id.slice(-6) : id || "—");
export const receiptHref = (id) => API_BASE + "/api/v1/receipts/" + encodeURIComponent(id);

/** Tokens per second over the generation window (after the first token), or null when it cannot be measured. */
export function tokensPerSecond(tokens, ttft, total) {
  if (!(tokens > 0) || !Number.isFinite(ttft) || !Number.isFinite(total) || total <= ttft) return null;
  return tokens / ((total - ttft) / 1000);
}

// ---------------------------------------------------------------- badges

const complete = (l) => l.status === "done" && !l.partial;

/**
 * Winners per metric among lanes that finished cleanly: lowest time to first token, lowest total time, lowest cost.
 * Needs two finished lanes, and a metric where every finished lane ties has no winner. Ties for the best share the badge.
 */
export function pickWinners(lanes) {
  const done = lanes.map((l, i) => ({ l, i })).filter(({ l }) => complete(l));
  const empty = { first: [], fastest: [], cheapest: [] };
  if (done.length < 2) return empty;
  const best = (get) => {
    const rows = done.map(({ l, i }) => ({ i, v: get(l) })).filter((r) => Number.isFinite(r.v));
    if (rows.length < 2) return [];
    const min = Math.min(...rows.map((r) => r.v));
    const win = rows.filter((r) => r.v === min);
    return win.length === rows.length ? [] : win.map((r) => r.i);
  };
  return { first: best((l) => Math.round(l.ttft)), fastest: best((l) => Math.round(l.total)), cheapest: best((l) => l.cost) };
}

// ---------------------------------------------------------------- the runner

export const blankLane = (model) => ({ model, status: "idle", text: "", ttft: null, total: null, tokens: null, cost: null, receiptId: null, provider: null, error: "", errorType: "", partial: false });

/**
 * Runs one lane and reports patches through onUpdate as it goes; resolves with the final patch.
 * Time to first token is the first visible content delta; total time is when the stream closes with its receipt.
 * A failing lane never rejects: it ends as status "error" (or "stopped" when the visitor cancelled).
 */
export async function raceLane({ model, prompt, maxTokens = DEFAULT_MAX_TOKENS, key, signal, stream = streamChat, now = () => performance.now(), t0 = now(), onUpdate = () => {} }) {
  let ttft = null;
  let last = "";
  onUpdate({ status: "waiting" });
  try {
    const out = await stream({
      key,
      signal,
      body: { model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens },
      onDelta: (text) => {
        last = text;
        if (ttft === null) ttft = now() - t0;
        onUpdate({ status: "streaming", text, ttft, tokens: estimateTokens(text) });
      },
    });
    const total = now() - t0;
    const usage = out.usage || {};
    const patch = {
      status: "done",
      text: out.text ?? last,
      ttft,
      total,
      tokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : estimateTokens(out.text ?? last),
      cost: Number.isFinite(usage.cost) ? usage.cost : null,
      receiptId: out.receipt?.id || null,
      provider: out.provider || null,
      partial: !!out.error,
      error: out.error ? "The provider stopped mid-stream; the delivered part was billed." : "",
    };
    onUpdate(patch);
    return patch;
  } catch (err) {
    const total = now() - t0;
    const stopped = err?.name === "AbortError";
    const patch = { status: stopped ? "stopped" : "error", ttft, total, tokens: stopped ? estimateTokens(last) : null, error: stopped ? "Stopped before the answer finished. The part already delivered is billed." : err?.message || "The route failed.", errorType: err?.type || "" };
    onUpdate(patch);
    return patch;
  }
}

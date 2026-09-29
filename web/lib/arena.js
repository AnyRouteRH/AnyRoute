// Model Arena: the pure logic behind racing one prompt across several models.
// Link encoding, model search, cost ceiling, per-lane metrics, the badge winners, the attested lane and the lane runner.
// No DOM, no storage. The runner takes the stream function and the clock as arguments, so tests drive it
// with fakes; in the page they default to the same `streamChat` the dashboard playground uses.

import { API_BASE, streamChat, toCatalogModel } from "./api.js";
import { providerIdFromSearch } from "./verify.js";

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
 * The query string for a shareable arena: the prompt, the chosen models and the attested-only switch, nothing else.
 * Returns { query, trimmed }: query is "" when there is nothing to share, and trimmed says the prompt was cut to fit a link.
 */
export function encodeArena({ prompt = "", models = [], attested = false } = {}) {
  const ids = [...new Set((models || []).filter((m) => typeof m === "string" && MODEL_ID.test(m)))].slice(0, MAX_LANES);
  const text = redactKeys(prompt).trim();
  const trimmed = text.length > MAX_LINK_PROMPT;
  const parts = [];
  if (text) parts.push("prompt=" + encodeURIComponent(trimmed ? text.slice(0, MAX_LINK_PROMPT) : text));
  if (attested === true) parts.push("attested=1");
  for (const id of ids) parts.push("model=" + encodeURIComponent(id).replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%40/gi, "@"));
  return { query: parts.length ? "?" + parts.join("&") : "", trimmed };
}

/**
 * Reads a location.search string back. Unknown parameters (and anything key-like) are ignored.
 * `attested: true` is present only when the link switched attested-only on; a link without it reads as before.
 */
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
  const attested = ["1", "true"].includes((params.get("attested") ?? "").trim().toLowerCase());
  return attested ? { prompt, models, attested: true } : { prompt, models };
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

// ---------------------------------------------------------------- the attested lane

export const ATTESTED_LANE = "attested";

/**
 * Error types with which the router refuses instead of downgrading: no attested endpoint can serve the lane (503
 * no_attested_endpoint; lane_unavailable from older routers), a disclosure ceiling nothing meets (409, or 503 while
 * every one is down), or the answer's receipt did not show an attested upstream (502, answer withheld).
 */
const FAIL_CLOSED = new Set(["no_attested_endpoint", "lane_unavailable", "disclosure_unavailable", "disclosure_provider_unavailable", "upstream_not_attested"]);
export const isFailClosed = (type) => FAIL_CLOSED.has(String(type || ""));

/**
 * The picker list for attested-only mode, from GET /api/v1/models?lane=attested. The router already filters by lane;
 * a row that does not itself report an attested endpoint is dropped here too, so a router that ignored the parameter
 * can never put an unattested model in this list. `gpuAttested` is the router's own per-model field (null: none seen).
 */
export function attestedCatalog(rows) {
  return chatModels(
    (rows || [])
      .filter((r) => r && typeof r.id === "string" && Number(r.disclosure?.endpoints?.attested) > 0)
      .map((r) => ({ ...toCatalogModel(r), gpuAttested: typeof r.gpu_attested === "boolean" ? r.gpu_attested : null })),
  );
}

/** One-click races. Each lists the models it wants; only those the attested list carries at load time are used. */
export const PRESETS = [
  {
    id: "frontier-attested",
    label: "Frontier, attested",
    attested: true,
    models: ["moonshotai/kimi-k3", "deepseek/deepseek-v4-flash-0731", "z-ai/glm-5.3", "openai/gpt-oss-120b"],
  },
];

/** The preset's models that are in `catalog`, in the preset's order (at most MAX_LANES), and the ones that are not. */
export function presetLanes(preset, catalog) {
  const known = new Set((catalog || []).map((m) => m.id));
  const wanted = preset?.models || [];
  const models = wanted.filter((id) => known.has(id)).slice(0, MAX_LANES);
  return { models, missing: wanted.filter((id) => !known.has(id)), ready: models.length >= MIN_LANES };
}

const CLAIM_STATE = { asserted: "yes", refuted: "no" };
const claimState = (claim) => (claim && typeof claim.status === "string" ? CLAIM_STATE[claim.status] || "unknown" : "unknown");
const CHECK_TEXT = {
  tee: { yes: "TEE attested", no: "TEE not attested", unknown: "TEE status not reported" },
  gpu: { yes: "GPU attested", no: "GPU not attested", unknown: "GPU status not reported" },
  tcb: { yes: "TCB up to date", no: "TCB out of date", unknown: "TCB status not reported" },
};

/**
 * What a signed receipt records about the hardware that answered, for a lane's proof badge. Reads only the receipt's
 * payload (chat.ts `finalize`) and its `upstream_attestation` block (providers/aci.ts `compactUpstream`); nothing is
 * inferred. Each check is "yes", "no" or "unknown":
 *   provider  payload.disclosure is "attested" with an attestation hash and no simulated evidence (and, behind an
 *             aci/1 gateway, the gateway's own receipt shows an attested upstream)
 *   tee, gpu, tcb  the gateway's claims, counted only when the gateway's receipt verified; a receipt that did not
 *             verify establishes no TEE or GPU attestation. Providers without a gateway receipt have no such rows.
 * Returns null when there is no signed receipt to read.
 */
export function proofFromReceipt(receipt) {
  const p = receipt && typeof receipt === "object" ? receipt.payload : null;
  if (!p || typeof p !== "object") return null;
  const ua = p.upstream_attestation && typeof p.upstream_attestation === "object" ? p.upstream_attestation : null;
  const simulated = p.attestation_simulated === true;
  const direct = p.disclosure === "attested" && typeof p.attestation === "string" && p.attestation !== "" && !simulated;
  const attested = direct && (!ua || ua.attested === true);
  const checks = [{ key: "provider", state: attested ? "yes" : "no", text: attested ? "Provider attested" : simulated ? "Provider evidence is development-only" : "Provider not attested" }];
  if (ua) {
    const verified = ua.receipt_verified === true;
    const tee = verified ? claimState(ua.claims?.tee_attested) : "no";
    const gpu = !verified ? "no" : ua.gpu_attested === true ? "yes" : claimState(ua.claims?.gpu_attested) === "unknown" ? "unknown" : "no";
    const tcb = verified ? claimState(ua.claims?.tcb_up_to_date) : "unknown";
    checks.push({ key: "tee", state: tee, text: CHECK_TEXT.tee[tee] }, { key: "gpu", state: gpu, text: CHECK_TEXT.gpu[gpu] }, { key: "tcb", state: tcb, text: CHECK_TEXT.tcb[tcb] });
  }
  let reason = null;
  if (!attested) {
    if (ua && ua.attested !== true) reason = typeof ua.reason === "string" && ua.reason ? ua.reason : "the gateway's receipt does not show an attested upstream";
    else if (simulated) reason = "the attestation evidence is development-only";
    else reason = "served under " + (typeof p.disclosure === "string" && p.disclosure ? p.disclosure : "unknown") + " retention";
  }
  return {
    provider: typeof p.provider === "string" && p.provider ? providerIdFromSearch("?p=" + encodeURIComponent(p.provider)) || null : null,
    attested,
    gateway: !!ua,
    checks,
    reason,
  };
}

// ---------------------------------------------------------------- the runner

export const blankLane = (model) => ({ model, status: "idle", text: "", ttft: null, total: null, tokens: null, cost: null, receiptId: null, provider: null, error: "", errorType: "", partial: false, proof: null });

/**
 * Runs one lane and reports patches through onUpdate as it goes; resolves with the final patch.
 * Time to first token is the first visible content delta; total time is when the stream closes with its receipt.
 * A failing lane never rejects: it ends as status "error" (or "stopped" when the visitor cancelled).
 * With `attested`, the request asks for the attested lane and the patch carries the receipt's proof. A router that
 * refuses (409/503, or 502 with the answer withheld) makes an honest failed lane with the router's own message; a
 * withheld answer is billed, so its receipt, tokens and cost are kept.
 */
export async function raceLane({ model, prompt, maxTokens = DEFAULT_MAX_TOKENS, key, signal, attested = false, stream = streamChat, now = () => performance.now(), t0 = now(), onUpdate = () => {} }) {
  let ttft = null;
  let last = "";
  const proofOf = (receipt) => (attested ? proofFromReceipt(receipt) : null);
  onUpdate({ status: "waiting" });
  try {
    const out = await stream({
      key,
      signal,
      body: { model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, ...(attested ? { provider: { lane: ATTESTED_LANE } } : {}) },
      onDelta: (text) => {
        last = text;
        if (ttft === null) ttft = now() - t0;
        onUpdate({ status: "streaming", text, ttft, tokens: estimateTokens(text) });
      },
    });
    const total = now() - t0;
    const usage = out.usage || {};
    const refusal = attested && isFailClosed(out.error?.type) ? out.error : null;
    const patch = {
      status: refusal ? "error" : "done",
      text: refusal ? "" : out.text ?? last,
      ttft: refusal ? null : ttft,
      total,
      tokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : refusal ? null : estimateTokens(out.text ?? last),
      cost: Number.isFinite(usage.cost) ? usage.cost : null,
      receiptId: out.receipt?.id || null,
      provider: out.provider || null,
      partial: !refusal && !!out.error,
      error: refusal ? refusal.message : out.error ? "The provider stopped mid-stream; the delivered part was billed." : "",
      errorType: refusal ? refusal.type : "",
      proof: proofOf(out.receipt),
    };
    onUpdate(patch);
    return patch;
  } catch (err) {
    const total = now() - t0;
    const stopped = err?.name === "AbortError";
    const patch = { status: stopped ? "stopped" : "error", ttft, total, tokens: stopped ? estimateTokens(last) : null, error: stopped ? "Stopped before the answer finished. The part already delivered is billed." : err?.message || "The route failed.", errorType: err?.type || "" };
    // A refusal that still produced a signed receipt (the answer was withheld, the call billed) keeps it.
    if (!stopped && err?.receipt?.id) {
      const u = err.usage || {};
      Object.assign(patch, { receiptId: err.receipt.id, proof: proofOf(err.receipt), cost: Number.isFinite(u.cost) ? u.cost : null, tokens: Number.isFinite(u.completion_tokens) ? u.completion_tokens : null });
    }
    onUpdate(patch);
    return patch;
  }
}

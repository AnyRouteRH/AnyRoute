import { canonicalJson, decrypt, encrypt, sha256 } from "../lib/util.ts";

// Opt-in response cache (body `cache: {mode: "exact" | "semantic", ttl}` or header
// `X-Anyroute-Cache`). Never written to Postgres: entries live in memory (or Redis with a TTL),
// encrypted, and scoped to the caller's account so nothing is ever shared across accounts.
// "semantic" is a lexical near-duplicate match (hashed unigram+bigram cosine), not an LLM embedding.

const DIMS = 1024;
const IGNORED = new Set(["stream", "stream_options", "user", "cache", "provider", "usage", "debug", "models", "route"]);

export type CacheMode = "exact" | "semantic";
type Entry = { scope: string; model: string; vector?: Float32Array; payload: string; expires: number; upstream: string };

export function cacheKey(scope: string, body: Record<string, unknown>) {
  const shape: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!IGNORED.has(k)) shape[k] = v;
  return sha256(scope + "\u0000" + canonicalJson(shape));
}

function textOf(body: Record<string, unknown>) {
  const msgs = Array.isArray(body.messages) ? (body.messages as any[]) : [];
  return msgs
    .map((m) => `${m?.role}: ${typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p: any) => p?.text ?? "").join(" ") : ""}`)
    .join("\n");
}

export function lexicalVector(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  const words = text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const add = (t: string) => {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    v[(h >>> 0) % DIMS] += (h & 1) === 0 ? 1 : -1;
  };
  words.forEach((w, i) => {
    add(w);
    if (i) add(words[i - 1] + " " + w);
  });
  let n = 0;
  for (let i = 0; i < DIMS; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIMS; i++) v[i] /= n;
  return v;
}
const cosine = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

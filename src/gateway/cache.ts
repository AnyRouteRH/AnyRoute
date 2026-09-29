import { canonicalJson, decrypt, encrypt, sha256 } from "../lib/util.ts";

// Opt-in response cache (body `cache: {mode: "exact" | "semantic", ttl}` or header
// `X-Anyroute-Cache`). Never written to Postgres: entries live in memory (or Redis with a TTL),
// encrypted, and scoped to the caller's account so nothing is ever shared across accounts.
// "semantic" is a lexical near-duplicate match (hashed unigram+bigram cosine), not an LLM embedding.

const DIMS = 1024;
// Only fields that never reach the provider (or are folded into the caller's scope) may be ignored.
// `user` is forwarded upstream as the end-user identity, so it stays in the key; the caller's
// scope also carries it, which keeps semantic matches within one end user.
const IGNORED = new Set(["stream", "stream_options", "cache", "provider", "usage", "debug", "models", "route"]);

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

export class ResponseCache {
  private entries = new Map<string, Entry>();
  constructor(private secret: string, private maxEntries = 5_000, readonly redis?: import("ioredis").Redis) {}

  private seal(scope: string, v: unknown) {
    return encrypt(this.secret + ":" + scope, JSON.stringify(v));
  }
  private open(scope: string, s: string) {
    return JSON.parse(decrypt(this.secret + ":" + scope, s));
  }

  async get(mode: CacheMode, scope: string, body: Record<string, unknown>, threshold: number): Promise<{ response: any; upstream: bigint; similarity: number } | null> {
    const key = cacheKey(scope, body);
    const now = Date.now();
    if (this.redis) {
      const raw = await this.redis.get(`cache:${key}`);
      if (raw) {
        const e = JSON.parse(raw) as { payload: string; upstream: string };
        return { response: this.open(scope, e.payload), upstream: BigInt(e.upstream), similarity: 1 };
      }
    }
    const exact = this.entries.get(key);
    if (exact && exact.expires > now) return { response: this.open(scope, exact.payload), upstream: BigInt(exact.upstream), similarity: 1 };
    if (mode !== "semantic") return null;
    const q = lexicalVector(textOf(body));
    let best: Entry | null = null;
    let bestSim = -1;
    for (const e of this.entries.values()) {
      if (e.scope !== scope || e.model !== body.model || !e.vector || e.expires <= now) continue;
      const s = cosine(q, e.vector);
      if (s > bestSim) {
        bestSim = s;
        best = e;
      }
    }
    return best && bestSim >= threshold ? { response: this.open(scope, best.payload), upstream: BigInt(best.upstream), similarity: bestSim } : null;
  }

  async put(mode: CacheMode, scope: string, body: Record<string, unknown>, response: unknown, upstream: bigint, ttlS: number) {
    const key = cacheKey(scope, body);
    const payload = this.seal(scope, response);
    if (this.redis) await this.redis.set(`cache:${key}`, JSON.stringify({ payload, upstream: upstream.toString() }), "PX", ttlS * 1000);
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, {
      scope,
      model: String(body.model),
      vector: mode === "semantic" ? lexicalVector(textOf(body)) : undefined,
      payload,
      expires: Date.now() + ttlS * 1000,
      upstream: upstream.toString(),
    });
  }

  size() {
    return this.entries.size;
  }
}

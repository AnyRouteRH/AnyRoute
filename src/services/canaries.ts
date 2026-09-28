import { and, desc, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Candidate } from "../catalog/catalog.ts";
import { canaries, canaryReferences } from "../db/schema.ts";
import { callUpstream, providerKey, upstreamBody } from "../providers/upstream.ts";
import { log } from "../lib/util.ts";

// Quant canaries. Every hour, for each model x provider (live and shadow):
//  - fingerprint: a fixed greedy continuation with logprobs (top-5). Different weight precisions
//    shift the logit distribution in a measurable way; we compare against reference fingerprints
//    recorded from trusted (attested) full-precision providers and classify the nearest precision.
//  - benchmark: a small exact-match set -> accuracy -> qualityScore in [0.5, 1.0].
// 3 consecutive quantization mismatches are slash evidence (see slasher.ts).

export const EXACT_SET: { q: string; a: string }[] = [
  { q: "What is 17 * 23? Reply with only the number.", a: "391" },
  { q: "What is the capital of Australia? Reply with one word.", a: "canberra" },
  { q: "Spell the word 'router' backwards. Reply with only the result.", a: "retuor" },
  { q: "What is 2 to the power of 10? Reply with only the number.", a: "1024" },
  { q: "Which planet is closest to the sun? Reply with one word.", a: "mercury" },
  { q: "How many sides does a hexagon have? Reply with only the number.", a: "6" },
  { q: "What is the chemical symbol for gold? Reply with only the symbol.", a: "au" },
  { q: "What is 144 divided by 12? Reply with only the number.", a: "12" },
];
export const FINGERPRINT_PROMPT = "Continue this text with the next ten words, lowercase, no punctuation: the quick brown fox jumps over the";

export type Fingerprint = { token: string; logprob: number; top: { token: string; logprob: number }[] }[];
const FAMILY: Record<string, string> = { fp32: "full", bf16: "full", fp16: "full", fp8: "8bit", int8: "8bit", fp6: "6bit", fp4: "4bit", int4: "4bit" };
export const family = (q: string) => FAMILY[q.toLowerCase()] ?? "unknown";

export function fingerprintDistance(ref: Fingerprint, obs: Fingerprint): number {
  const n = Math.min(ref.length, obs.length, 12);
  if (!n) return 1;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const r = ref[i];
    const o = obs[i];
    if (r.token !== o.token) {
      d += 1;
      continue;
    }
    let pos = Math.min(1, Math.abs(r.logprob - o.logprob));
    // Compare the shape of the alternatives the two share.
    const obsTop = new Map(o.top.map((t) => [t.token, t.logprob]));
    let shared = 0;
    let diff = 0;
    for (const t of r.top) {
      const lp = obsTop.get(t.token);
      if (lp == null) continue;
      shared++;
      diff += Math.min(1, Math.abs(t.logprob - lp));
    }
    pos = 0.5 * pos + 0.5 * (shared ? diff / shared : 1);
    d += pos;
  }
  return d / n;
}

export function classify(obs: Fingerprint, refs: { quant: string; fingerprint: Fingerprint }[], threshold: number) {
  if (!refs.length || !obs.length) return { guess: null as string | null, distance: null as number | null };
  let best = { quant: refs[0].quant, d: fingerprintDistance(refs[0].fingerprint, obs) };
  for (const r of refs.slice(1)) {
    const d = fingerprintDistance(r.fingerprint, obs);
    if (d < best.d) best = { quant: r.quant, d };
  }
  // With a single (full-precision) reference, anything far from it is "lower precision than declared".
  if (refs.length === 1 && best.d > threshold) return { guess: "lower", distance: best.d };
  return { guess: best.quant, distance: best.d };
}

function readFingerprint(json: any): Fingerprint {
  const content = json?.choices?.[0]?.logprobs?.content;
  if (!Array.isArray(content)) return [];
  return content.map((t: any) => ({
    token: String(t.token),
    logprob: Number(t.logprob),
    top: Array.isArray(t.top_logprobs) ? t.top_logprobs.map((x: any) => ({ token: String(x.token), logprob: Number(x.logprob) })) : [],
  }));
}

async function ask(ctx: Ctx, c: Candidate, body: Record<string, unknown>) {
  const r = await callUpstream({
    appSecret: ctx.cfg.appSecret,
    candidate: c,
    path: "/chat/completions",
    body: upstreamBody(c, { ...body, model: c.modelId }, false).body,
    stream: false,
    apiKey: providerKey(c, ctx.cfg.appSecret),
    signal: AbortSignal.timeout(60_000),
    timeoutMs: 60_000,
    firstTokenTimeoutMs: 30_000,
    production: ctx.cfg.production,
  });
  ctx.health.record({ modelId: c.modelId, providerId: c.providerId, ok: r.ok, errorKind: r.ok ? null : r.errorKind, latencyMs: r.latencyMs, source: "canary" });
  return r.ok && r.kind === "json" ? r.json : null;
}

export async function runCanaryFor(ctx: Ctx, c: Candidate, threshold = 0.35) {
  const supportsLogprobs = (c.supportedParameters ?? []).includes("logprobs");
  let fp: Fingerprint = [];
  if (supportsLogprobs) {
    const j = await ask(ctx, c, { messages: [{ role: "user", content: FINGERPRINT_PROMPT }], temperature: 0, max_tokens: 12, logprobs: true, top_logprobs: 5, seed: 7 });
    fp = readFingerprint(j);
  }
  let correct = 0;
  let answered = 0;
  for (const item of EXACT_SET) {
    const j = await ask(ctx, c, { messages: [{ role: "user", content: item.q }], temperature: 0, max_tokens: 8, seed: 7 });
    const text = String(j?.choices?.[0]?.message?.content ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (j) answered++;
    if (text === item.a) correct++;
  }
  const accuracy = answered ? correct / EXACT_SET.length : 0;

  // Trusted reference: an attested provider declaring full precision records the reference.
  const declared = family(c.quant);
  if (fp.length && c.provider.attested && declared === "full") {
    await ctx.db
      .insert(canaryReferences)
      .values({ modelId: c.modelId, quant: c.quant.toLowerCase(), fingerprint: { fp, accuracy }, source: c.providerId })
      .onConflictDoUpdate({ target: [canaryReferences.modelId, canaryReferences.quant], set: { fingerprint: { fp, accuracy }, source: c.providerId, createdAt: new Date() } });
  }
  const refRows = await ctx.db.select().from(canaryReferences).where(eq(canaryReferences.modelId, c.modelId));
  const refs = refRows.map((r) => ({ quant: r.quant, fingerprint: (r.fingerprint as { fp: Fingerprint }).fp, accuracy: (r.fingerprint as { accuracy?: number }).accuracy }));
  const { guess, distance } = classify(fp, refs, threshold);
  const quantMatch = guess == null || declared === "unknown" ? null : guess === "lower" ? declared !== "full" : family(guess) === declared;
  const refAcc = Math.max(0.01, ...refs.map((r) => r.accuracy ?? 0), accuracy);
  const quality = answered ? 0.5 + 0.5 * Math.min(1, accuracy / refAcc) : null;
  await ctx.db.insert(canaries).values({
    modelId: c.modelId,
    providerId: c.providerId,
    quantMatch,
    quantGuess: guess,
    distance,
    quality,
    detail: { accuracy, answered, declared: c.quant, logprobs: supportsLogprobs, fingerprint_tokens: fp.length },
  });
  if (quality != null) ctx.health.setQuality(c.modelId, c.providerId, quality);
  return { model: c.modelId, provider: c.providerId, quantMatch, guess, distance, quality, accuracy };
}

export async function runCanaries(ctx: Ctx, opts: { threshold?: number; limit?: number } = {}) {
  await ctx.catalog.ensureFresh(0);
  const all = [...ctx.catalog.offersByModel.values()].flat().filter((o) => (o.status === "live" || o.status === "shadow") && ["live", "shadow"].includes(o.provider.status));
  // Attested full-precision providers first, so references exist before the others are compared.
  all.sort((a, b) => Number(b.provider.attested) - Number(a.provider.attested));
  const results = [];
  for (const c of all.slice(0, opts.limit ?? 10_000)) {
    try {
      results.push(await runCanaryFor(ctx, c, opts.threshold));
    } catch (e) {
      log.warn("canary failed", { model: c.modelId, provider: c.providerId, error: (e as Error).message });
    }
  }
  return { ran: results.length, mismatches: results.filter((r) => r.quantMatch === false).length, results };
}

/** Latest N canaries for model x provider (used by slasher). */
export async function latestCanaries(ctx: Ctx, providerId: string, modelIds: string[], n = 3) {
  if (!modelIds.length) return new Map<string, (typeof canaries.$inferSelect)[]>();
  const rows = await ctx.db.select().from(canaries).where(and(eq(canaries.providerId, providerId), inArray(canaries.modelId, modelIds))).orderBy(desc(canaries.ts));
  const map = new Map<string, (typeof canaries.$inferSelect)[]>();
  for (const r of rows) {
    const list = map.get(r.modelId) ?? [];
    if (list.length < n) list.push(r);
    map.set(r.modelId, list);
  }
  return map;
}

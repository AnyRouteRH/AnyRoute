import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Candidate } from "../catalog/catalog.ts";
import type { Ctx } from "../context.ts";
import { laneCandidates, laneEvals, models, modelsLane } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import { callUpstream, providerKey, upstreamBody } from "../providers/upstream.ts";
import { profileOf } from "../router/disclosure.ts";
import { isRestricted, restrictedExclusion, type Variant } from "../router/lane.ts";
import { candidateDisclosure } from "../router/select.ts";
import { runCanaryFor } from "./canaries.ts";
import { CAPABILITY_SET, REFUSAL_PROBES, isRefusal, type CapabilityKind, type RefusalCategory } from "./dayzero-sets.ts";
import * as hf from "./hf.ts";
import { currentMeasurement } from "./measurements.ts";

// Day-zero pipeline for the Lane. A new open-weights release under a permissive license is followed within
// hours by modified uploads that remove refusals. This service finds those uploads, checks them, and prepares
// them to be served, with a person and an attested provider in the loop:
//
//   discover   watch Hugging Face for new fine-tunes of the allow-listed base models whose model card carries an
//              allowed license (MIT or Apache-2.0 by default). Each becomes a candidate row, or a rejected row
//              that says why. Off unless DAYZERO_ENABLED.
//   link       an operator says which provider offer serves the candidate's weights (the offer's model must
//              declare the candidate's repository as its hugging_face_id)
//   evaluate   run the endpoint against a benign refusal probe set, a capability regression set with exact
//              checks, and the router's canary set (services/canaries.ts). Scores are stored per run.
//   approve    an operator approves a candidate whose scores passed
//   promote    servable = approved AND an attested provider that reports the classifier serves it now. Only then
//              does the model get a servable lane record; until then it is routed to nobody.
//
// The probe sets contain only benign, lawful prompts (see dayzero-sets.ts).

type FetchFn = typeof fetch;
export type CandidateRow = typeof laneCandidates.$inferSelect;
export type Deps = {
  /** Hugging Face fetch; defaults to ctx.hfFetch, then the global fetch. */
  fetch?: FetchFn;
  /** Send one prompt to the candidate endpoint and return the reply text, or null when it did not answer. */
  chat?: (prompt: string, maxTokens: number) => Promise<string | null>;
  /** The canary run for the endpoint; defaults to the router's own (services/canaries.ts). */
  canary?: (offer: Candidate) => Promise<{ accuracy: number | null; quantMatch: boolean | null }>;
};

export const CANDIDATE_STATUSES = ["discovered", "rejected", "evaluated", "failed", "approved", "servable"] as const;

// ---- Discovery ---------------------------------------------------------------------------------------------

/** Why a repository is not accepted as a candidate; null when it is. Reads only the Hub's model info. */
export function judgeUpload(info: hf.HfModel, baseRepo: string, licenses: string[]): string | null {
  if (info.private || info.disabled) return "repository is private or disabled";
  if (info.gated) return "gated repository: the weights cannot be fetched without the owner's approval";
  if (!info.baseModels.includes(baseRepo.toLowerCase())) return "model card does not name the base model";
  if (!info.license) return "model card names no license";
  if (!licenses.includes(info.license)) return `license ${info.license} is not on the allow-list`;
  if (!info.sha) return "repository has no readable revision";
  return null;
}

/** abliterated when the name or tags say so; any other match on the keywords is a low-refusal fine-tune. */
export function variantFor(id: string, tags: string[]): Exclude<Variant, "mainstream"> {
  return /abliterat/i.test(`${id} ${tags.join(" ")}`) ? "abliterated" : "native_low_refusal";
}

export async function discover(ctx: Ctx, deps: Deps = {}) {
  const f = deps.fetch ?? ctx.hfFetch ?? fetch;
  const { baseModels, licenses, keywords, maxPerRun } = ctx.cfg.lane.dayzero;
  const hub = ctx.cfg.hfBaseUrl;
  const out = { bases: 0, listed: 0, created: 0, rejected: 0, errors: [] as string[] };
  const known = new Set((await ctx.db.select({ hfRepo: laneCandidates.hfRepo }).from(laneCandidates)).map((r) => r.hfRepo.toLowerCase()));
  let budget = maxPerRun;
  for (const baseRepo of baseModels) {
    if (budget <= 0) break;
    try {
      const base = await hf.modelInfo(f, hub, baseRepo);
      if (!base) {
        out.errors.push(`${baseRepo}: base model not found`);
        continue;
      }
      // The allow-list is a list of names; the license is read from the base model's own card every run.
      if (!base.license || !licenses.includes(base.license)) {
        out.errors.push(`${baseRepo}: base model license ${base.license ?? "missing"} is not on the allow-list`);
        continue;
      }
      out.bases++;
      const listed = await hf.listDerived(f, hub, baseRepo, Math.min(100, maxPerRun * 2));
      out.listed += listed.length;
      for (const item of listed) {
        if (budget <= 0) break;
        const text = `${item.id} ${item.tags.join(" ")}`.toLowerCase();
        if (!keywords.some((k) => text.includes(k)) || known.has(item.id.toLowerCase())) continue;
        budget--;
        const info = await hf.modelInfo(f, hub, item.id);
        if (!info) continue;
        known.add(item.id.toLowerCase());
        const reason = judgeUpload(info, baseRepo, licenses);
        const inserted = await ctx.db
          .insert(laneCandidates)
          .values({
            hfRepo: info.id,
            baseModel: baseRepo,
            revision: info.sha,
            license: info.license,
            variant: variantFor(info.id, info.tags),
            creatorHandle: info.owner,
            status: reason ? "rejected" : "discovered",
            reason,
            sourceCreatedAt: info.createdAt ? new Date(info.createdAt) : null,
          })
          .onConflictDoNothing()
          .returning({ id: laneCandidates.id });
        if (!inserted.length) continue;
        if (reason) out.rejected++;
        else out.created++;
      }
    } catch (e) {
      out.errors.push(`${baseRepo}: ${(e as Error).message}`);
    }
  }
  if (out.created || out.rejected) await ctx.catalog.refresh(); // a new candidate holds back any model already listed for its repository
  return out;
}

// ---- Candidates ---------------------------------------------------------------------------------------------

async function candidate(ctx: Ctx, id: number): Promise<CandidateRow> {
  const [row] = Number.isInteger(id) ? await ctx.db.select().from(laneCandidates).where(eq(laneCandidates.id, id)) : [];
  if (!row) fail(404, "Unknown candidate.", "not_found");
  return row;
}

export async function listCandidates(ctx: Ctx, status?: string) {
  const rows = await ctx.db.select().from(laneCandidates).where(status ? eq(laneCandidates.status, status) : undefined).orderBy(desc(laneCandidates.createdAt)).limit(200);
  const evals = rows.length ? await ctx.db.select().from(laneEvals).orderBy(desc(laneEvals.ts)).limit(1000) : [];
  return rows.map((r) => candidateView(r, evals.find((e) => e.candidateId === r.id) ?? null));
}

export function candidateView(r: CandidateRow, last: typeof laneEvals.$inferSelect | null) {
  return {
    id: r.id,
    hugging_face_id: r.hfRepo,
    base_model: r.baseModel,
    revision: r.revision,
    license: r.license,
    variant: r.variant,
    creator_handle: r.creatorHandle,
    status: r.status,
    reason: r.reason,
    model: r.modelId,
    provider: r.endpointProvider,
    discovered_at: r.createdAt.toISOString(),
    approved_by: r.approvedBy,
    approved_at: r.approvedAt?.toISOString() ?? null,
    servable_at: r.servableAt?.toISOString() ?? null,
    last_evaluation: last
      ? {
          at: last.ts.toISOString(),
          passed: last.passed,
          refusal_rate: last.refusalRate,
          capability_score: last.capabilityScore,
          canary_accuracy: last.canaryAccuracy,
          canary_quant_match: last.canaryQuantMatch,
          detail: last.detail,
        }
      : null,
  };
}

export async function viewCandidate(ctx: Ctx, id: number) {
  const row = await candidate(ctx, id);
  const [last] = await ctx.db.select().from(laneEvals).where(eq(laneEvals.candidateId, id)).orderBy(desc(laneEvals.ts)).limit(1);
  return candidateView(row, last ?? null);
}

/** Say which provider offer serves this candidate's weights. */
export async function linkEndpoint(ctx: Ctx, id: number, input: { provider: string; model: string }) {
  const c = await candidate(ctx, id);
  if (c.status === "rejected") fail(409, `This candidate was rejected: ${c.reason}.`, "candidate_rejected");
  await ctx.catalog.ensureFresh(0);
  const modelId = input.model.toLowerCase();
  const model = ctx.catalog.models.get(modelId);
  const offer = ctx.catalog.offers(modelId).find((o) => o.providerId === input.provider);
  if (!model || !offer) fail(404, "That provider does not list that model.", "not_found");
  // The served model must declare the repository that was checked, so an evaluation of one set of weights can
  // never approve a different model.
  if ((model.hfRepo ?? "").toLowerCase() !== c.hfRepo.toLowerCase())
    fail(409, `The provider's model list must set hugging_face_id to ${c.hfRepo} for this model (it is ${model.hfRepo ? model.hfRepo : "not set"}).`, "repo_mismatch");
  if (c.status === "approved" || c.status === "servable") fail(409, "This candidate is already approved; evaluate it again or start over before changing its endpoint.", "invalid_state");
  await ctx.db.update(laneCandidates).set({ modelId, endpointProvider: input.provider, status: "discovered", reason: null, updatedAt: new Date() }).where(eq(laneCandidates.id, id));
  await ctx.catalog.refresh();
  return viewCandidate(ctx, id);
}

// ---- Evaluation --------------------------------------------------------------------------------------------

function offerFor(ctx: Ctx, c: CandidateRow): Candidate {
  const offer = c.modelId ? ctx.catalog.offers(c.modelId).find((o) => o.providerId === c.endpointProvider) : undefined;
  if (!offer) fail(409, "Link an endpoint (provider and model) before evaluating this candidate.", "no_endpoint");
  if (!["live", "shadow"].includes(offer.status) || !["live", "shadow"].includes(offer.provider.status)) fail(409, "The linked endpoint is not live.", "endpoint_unavailable");
  return offer;
}

function chatVia(ctx: Ctx, offer: Candidate): NonNullable<Deps["chat"]> {
  return async (prompt, maxTokens) => {
    const r = await callUpstream({
      appSecret: ctx.cfg.appSecret,
      candidate: offer,
      path: "/chat/completions",
      body: upstreamBody(offer, { model: offer.modelId, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens, seed: 7 }, false).body,
      stream: false,
      apiKey: providerKey(offer, ctx.cfg.appSecret),
      signal: AbortSignal.timeout(60_000),
      timeoutMs: 60_000,
      firstTokenTimeoutMs: 30_000,
      production: ctx.cfg.production,
    });
    if (!r.ok || r.kind !== "json") return null;
    const text = r.json?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text : null;
  };
}

const share = (n: number, d: number) => (d ? n / d : null);
const round = (x: number | null) => (x == null ? null : Number(x.toFixed(4)));

/** Score an endpoint. Pure with respect to the router's state: it only sends the fixed probe sets through `chat`. */
export async function scoreEndpoint(chat: NonNullable<Deps["chat"]>) {
  const refused: string[] = [];
  const byCategory: Record<RefusalCategory, { refused: number; answered: number }> = { fiction: { refused: 0, answered: 0 }, security_education: { refused: 0, answered: 0 }, medical: { refused: 0, answered: 0 }, legal: { refused: 0, answered: 0 } };
  let answered = 0;
  for (const p of REFUSAL_PROBES) {
    const reply = await chat(p.prompt, 300);
    if (reply == null || !reply.trim()) continue;
    answered++;
    byCategory[p.category].answered++;
    if (isRefusal(reply)) {
      refused.push(p.id);
      byCategory[p.category].refused++;
    }
  }
  const byKind: Record<CapabilityKind, { correct: number; total: number }> = { arithmetic: { correct: 0, total: 0 }, json: { correct: 0, total: 0 }, instruction: { correct: 0, total: 0 } };
  const wrong: string[] = [];
  let correct = 0;
  let capabilityAnswered = 0;
  for (const item of CAPABILITY_SET) {
    const reply = await chat(item.prompt, 120);
    byKind[item.kind].total++;
    if (reply != null && reply.trim()) capabilityAnswered++;
    if (reply != null && item.check(reply)) {
      correct++;
      byKind[item.kind].correct++;
    } else wrong.push(item.id);
  }
  return {
    refusalRate: share(refused.length, answered),
    refusalAnswered: answered,
    refusalTotal: REFUSAL_PROBES.length,
    refused,
    // The score counts unanswered items as wrong: an endpoint that times out does not pass by staying silent.
    capabilityScore: share(correct, CAPABILITY_SET.length),
    capabilityAnswered,
    capabilityTotal: CAPABILITY_SET.length,
    wrong,
    byCategory,
    byKind,
  };
}

export async function evaluateCandidate(ctx: Ctx, id: number, deps: Deps = {}) {
  const c = await candidate(ctx, id);
  if (c.status === "rejected") fail(409, `This candidate was rejected: ${c.reason}.`, "candidate_rejected");
  await ctx.catalog.ensureFresh(0);
  const offer = offerFor(ctx, c);
  const chat = deps.chat ?? chatVia(ctx, offer);
  const t = ctx.cfg.lane.dayzero;

  const s = await scoreEndpoint(chat);
  // The router's existing canary run: the exact-match set and, where the endpoint returns logprobs, the precision check.
  const canary = deps.canary
    ? await deps.canary(offer)
    : await runCanaryFor(ctx, offer).then((r) => ({ accuracy: r.accuracy as number | null, quantMatch: r.quantMatch as boolean | null }), () => ({ accuracy: null as number | null, quantMatch: null as boolean | null }));

  const failures: string[] = [];
  const answeredShare = (s.refusalAnswered + s.capabilityAnswered) / (s.refusalTotal + s.capabilityTotal);
  if (answeredShare < 0.9) failures.push(`the endpoint answered ${Math.round(answeredShare * 100)}% of the probes`);
  if (s.refusalRate == null || s.refusalRate > t.maxRefusalRate) failures.push(`refusal rate ${s.refusalRate == null ? "unknown" : round(s.refusalRate)} is above ${t.maxRefusalRate}`);
  if (s.capabilityScore == null || s.capabilityScore < t.minCapability) failures.push(`capability score ${round(s.capabilityScore)} is below ${t.minCapability}`);
  if (canary.accuracy == null || canary.accuracy < t.minCanary) failures.push(`canary accuracy ${round(canary.accuracy)} is below ${t.minCanary}`);
  if (canary.quantMatch === false) failures.push("canary precision check does not match the declared quantization");
  const passed = failures.length === 0;

  const detail = {
    thresholds: { max_refusal_rate: t.maxRefusalRate, min_capability: t.minCapability, min_canary: t.minCanary },
    refusal: { answered: s.refusalAnswered, total: s.refusalTotal, refused: s.refused, by_category: s.byCategory },
    capability: { answered: s.capabilityAnswered, total: s.capabilityTotal, wrong: s.wrong, by_kind: s.byKind },
    failures,
  };
  await ctx.db.insert(laneEvals).values({
    candidateId: c.id,
    providerId: offer.providerId,
    modelId: offer.modelId,
    refusalRate: round(s.refusalRate),
    capabilityScore: round(s.capabilityScore),
    canaryAccuracy: round(canary.accuracy),
    canaryQuantMatch: canary.quantMatch,
    passed,
    detail,
  });
  const wasLive = c.status === "approved" || c.status === "servable";
  if (passed) {
    if (!wasLive) await ctx.db.update(laneCandidates).set({ status: "evaluated", reason: null, updatedAt: new Date() }).where(eq(laneCandidates.id, c.id));
  } else {
    // A candidate that stops passing loses its approval, and a model already promoted stops being served.
    await ctx.db.update(laneCandidates).set({ status: "failed", reason: failures.join("; ").slice(0, 500), approvedBy: null, approvedAt: null, approvalNote: null, servableAt: null, updatedAt: new Date() }).where(eq(laneCandidates.id, c.id));
    if (wasLive && c.modelId) await ctx.db.update(modelsLane).set({ status: "candidate", updatedAt: new Date() }).where(eq(modelsLane.modelId, c.modelId));
  }
  await ctx.catalog.refresh();
  return viewCandidate(ctx, c.id);
}

// ---- Approval and promotion --------------------------------------------------------------------------------

export async function approveCandidate(ctx: Ctx, id: number, input: { by?: string; note?: string; variant?: Variant }) {
  const c = await candidate(ctx, id);
  if (c.status !== "evaluated") fail(409, `Only an evaluated candidate can be approved; this one is ${c.status}${c.reason ? ` (${c.reason})` : ""}.`, "invalid_state");
  const variant = input.variant ?? (c.variant as Variant);
  if (!isRestricted(variant)) fail(400, "A day-zero candidate is abliterated or native_low_refusal.", "invalid_request");
  await ctx.db
    .update(laneCandidates)
    .set({ status: "approved", variant, approvedBy: (input.by ?? "operator").slice(0, 64), approvedAt: new Date(), approvalNote: input.note?.slice(0, 500) ?? null, updatedAt: new Date() })
    .where(and(eq(laneCandidates.id, id), eq(laneCandidates.status, "evaluated")));
  await ctx.catalog.refresh();
  return viewCandidate(ctx, id);
}

/**
 * Make an approved candidate servable, if an attested provider that reports the classifier serves it right now.
 * The check is the routing rule itself (restrictedExclusion over the router's own disclosure class), so a model is
 * never marked servable that routing would then refuse to send anywhere.
 */
export async function promoteCandidate(ctx: Ctx, id: number): Promise<{ promoted: boolean; reason: string | null; candidate: Awaited<ReturnType<typeof viewCandidate>> }> {
  const c = await candidate(ctx, id);
  if (c.status === "servable") return { promoted: true, reason: null, candidate: await viewCandidate(ctx, id) };
  if (c.status !== "approved") fail(409, `Only an approved candidate can be promoted; this one is ${c.status}.`, "invalid_state");
  await ctx.catalog.ensureFresh(0);
  const offer = offerFor(ctx, c);
  if (offer.status !== "live" || offer.provider.status !== "live") return { promoted: false, reason: "the linked endpoint is not live yet", candidate: await viewCandidate(ctx, id) };
  const cls = candidateDisclosure(offer, profileOf(ctx.catalog.disclosure.get(offer.providerId)), ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production);
  const why = restrictedExclusion(cls, offer.provider.classifierEnabled);
  if (why) return { promoted: false, reason: why, candidate: await viewCandidate(ctx, id) };

  // When the provider's verified attestation recorded the model digest it runs, that digest is kept with the weights.
  const measured = await currentMeasurement(ctx, offer.providerId).catch(() => null);
  const weightsDigest = measured ? `sha256:${measured.modelDigest.replace(/^0x/, "")}` : null;
  const modelId = c.modelId!;
  const lane = {
    modelId,
    variant: c.variant,
    status: "servable",
    baseModel: c.baseModel,
    license: c.license,
    weightsSource: `huggingface:${c.hfRepo}`,
    weightsRevision: c.revision,
    weightsDigest,
    creatorHandle: c.creatorHandle,
    updatedAt: new Date(),
  };
  await ctx.db.insert(modelsLane).values(lane).onConflictDoUpdate({ target: modelsLane.modelId, set: lane });
  await ctx.db.update(models).set({ hfRepo: c.hfRepo, hidden: false }).where(eq(models.id, modelId));
  await ctx.db.update(laneCandidates).set({ status: "servable", servableAt: new Date(), updatedAt: new Date() }).where(eq(laneCandidates.id, id));
  await ctx.catalog.refresh();
  return { promoted: true, reason: null, candidate: await viewCandidate(ctx, id) };
}

// ---- The job -----------------------------------------------------------------------------------------------

export async function runDayzero(ctx: Ctx, deps: Deps = {}) {
  const found = await discover(ctx, deps);
  const evaluated: { id: number; passed: boolean | null; error?: string }[] = [];
  // Newly linked candidates are evaluated once; a re-evaluation is an operator's call.
  const pending = await ctx.db
    .select()
    .from(laneCandidates)
    .where(and(eq(laneCandidates.status, "discovered"), isNotNull(laneCandidates.modelId), isNotNull(laneCandidates.endpointProvider), sql`NOT EXISTS (SELECT 1 FROM lane_evals e WHERE e.candidate_id = ${laneCandidates.id})`))
    .orderBy(asc(laneCandidates.createdAt))
    .limit(2);
  for (const c of pending) {
    try {
      const v = await evaluateCandidate(ctx, c.id, deps);
      evaluated.push({ id: c.id, passed: v.last_evaluation?.passed ?? null });
    } catch (e) {
      log.warn("day-zero evaluation failed", { candidate: c.id, error: (e as Error).message });
      evaluated.push({ id: c.id, passed: null, error: (e as Error).message });
    }
  }
  const promoted: number[] = [];
  for (const c of await ctx.db.select({ id: laneCandidates.id }).from(laneCandidates).where(eq(laneCandidates.status, "approved"))) {
    try {
      if ((await promoteCandidate(ctx, c.id)).promoted) promoted.push(c.id);
    } catch (e) {
      log.warn("day-zero promotion failed", { candidate: c.id, error: (e as Error).message });
    }
  }
  return { ...found, evaluated, promoted };
}

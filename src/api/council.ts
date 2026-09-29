import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import type { HolderTier } from "../config.ts";
import type { Candidate, ModelRow, Modifier } from "../catalog/catalog.ts";
import { fail, isApiError, ApiError } from "../lib/errors.ts";
import { type Pico, maxPico, picoToUsd, picoToUsdString, usdToPico } from "../lib/money.ts";
import { genId, sha256 } from "../lib/util.ts";
import { release, reserve } from "../ledger/ledger.ts";
import { estimatePromptTokens, maxOutputTokens, readUsage, worstCase, type Mode, type Usage } from "../router/pricing.ts";
import { route, type Attempt, type RouteSuccess, type RouteTarget } from "../router/execute.ts";
import type { ProviderPrefs } from "../router/select.ts";
import type { DisclosureRequest } from "../router/disclosure.ts";
import { providerKey } from "../providers/upstream.ts";
import { applyGuardrails, mergeGuardrails, redactOutput, type GuardrailConfig } from "../gateway/guardrails.ts";
import { payPerCall } from "../pay/percall.ts";
import { holderTier, scaleLimit } from "../holders/tiers.ts";
import {
  COUNCIL_MODEL,
  DUAL_SEED,
  JUDGE_MAX_TOKENS,
  attestationRefOf,
  compareOutputs,
  judgeMessages,
  labelFor,
  outputText,
  parseCouncilSpec,
  parseJudgeChoice,
  transcript,
  weakestServed,
  type AttestationRef,
} from "../router/council.ts";
import type { KeyRow } from "./auth.ts";
import { servedDisclosure } from "./disclosure.ts";
import { generationHeaders, sharedPolicyHash } from "./common.ts";
import type * as Chat from "./chat.ts";

// Council mode (`model: "anyroute/council"`) and dual verification (`verify: "dual"`).
//
// Both fan one request out into several ordinary provider calls. Every call goes through the same
// routing, hold, settle and receipt path as a single request (`finalize` in chat.ts), so each one is
// billed and receipted on its own. The worst case of all calls is held before anything is sent, so the
// caller's balance and key budget bound the whole request, and every hold that is not settled is
// released on every exit.
//
// Attested mode (`council.attested: true`, or lane "attested" on either request): every call, the judge included, goes
// only to providers whose retention is declared "attested" and whose attestation the router holds fresh (the same test
// as the attested lane). Nothing is downgraded or dropped: a council with any member, or a judge, that has no attested
// provider, or a dual verification without two different attested providers of the model, is refused with a 409 before
// anything is held or sent. Each call's receipt records the attestation reference the router verified for its provider.

export { COUNCIL_MODEL };
export type Toolkit = typeof Chat.toolkit;
type Fin = Awaited<ReturnType<Toolkit["finalize"]>>;
type JsonSuccess = Extract<RouteSuccess, { kind: "json" }>;

type Base = {
  ctx: Ctx;
  c: Context;
  kind: Chat.Kind;
  body: Record<string, unknown>;
  bodySha: string;
  t0: number;
  key: KeyRow | null;
  wallet: { accountId: string; wallet: string } | null;
  tier: HolderTier | null;
  /** Routing preferences with the disclosure ceiling and lane already folded in. */
  prefs: ProviderPrefs;
  disc: DisclosureRequest;
};

// ---- Request checks --------------------------------------------------------------------------------

/**
 * Checks shared by both modes. Runs before the caller is known (and again once key aliases have been
 * applied), so it only reads the body. Without the feature flag `anyroute/council` is an ordinary
 * unknown model, and `verify` is refused rather than silently ignored.
 */
export function validateMulti(ctx: Ctx, kind: Chat.Kind, body: Record<string, unknown>) {
  const council = ctx.cfg.features.council && body.model === COUNCIL_MODEL;
  const verify = body.verify != null;
  if (verify && !ctx.cfg.features.council) fail(400, "`verify` is not enabled on this router.", "feature_disabled");
  if (!council && !verify) return;
  if (verify && body.verify !== "dual") fail(400, "`verify` must be \"dual\".", "invalid_verify");
  if (council && verify) fail(400, "`verify` cannot be combined with model anyroute/council.", "invalid_request");
  const what = council ? "Council mode" : "Dual verification";
  const type = council ? "invalid_council" : "invalid_verify";
  if (body.stream === true) fail(400, `${what} does not support streaming. Send stream: false.`, "streaming_unsupported");
  if (council && kind !== "chat") fail(400, "Council mode is available on /chat/completions only.", type);
  for (const k of ["n", "best_of"]) if (body[k] != null && body[k] !== 1) fail(400, `${what} needs \`${k}\` to be 1.`, type);
  if (Array.isArray(body.models) && body.models.length) fail(400, `${what} uses ${council ? "\`council.models\`" : "one model"}; \`models\` is not supported.`, type);
  if (body.cache != null) fail(400, `\`cache\` cannot be combined with ${council ? "council mode" : "\`verify\`"}.`, type);
  if (council && Array.isArray(body.transforms) && body.transforms.includes("middle-out")) fail(400, "The middle-out transform is not supported in council mode.", type);
}

/** Dual verification decodes deterministically: temperature 0 and a fixed seed (the caller's `seed` wins). */
export function applyDualDecoding(body: Record<string, unknown>) {
  if (body.temperature != null && body.temperature !== 0) fail(400, "`verify: \"dual\"` decodes at temperature 0; omit `temperature` or set it to 0.", "invalid_verify");
  if (body.seed != null && !Number.isInteger(body.seed)) fail(400, "`seed` must be an integer.", "invalid_verify");
  body.temperature = 0;
  body.seed ??= DUAL_SEED;
}

// ---- Shared pieces -----------------------------------------------------------------------------------

type Leg = {
  label: string;
  model: ModelRow;
  requested: string;
  body: Record<string, unknown>;
  targets: RouteTarget[];
  promptTokens: number;
  holdId: string;
  hold: Pico;
};

type LegResult =
  | { ok: true; r: JsonSuccess; doneAt: number }
  | { ok: false; attempts: Attempt[]; last?: Parameters<Toolkit["allFailed"]>[1]; thrown?: unknown };

/** A finished call, ready to be settled: usage read, output redacted (when the key asks), text taken. */
type Done = { leg: Leg; r: JsonSuccess; json: any; usage: Usage; text: string; redactions: number; doneAt: number };

/** The hold for a request: the dearest worst case over the providers that may be tried. */
function holdFor(ctx: Ctx, targets: RouteTarget[], body: Record<string, unknown>, promptTokens: number, mode: Mode, byok: Map<string, string>): Pico {
  const fees = { royaltyBps: 0, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
  const attemptable = targets.flatMap((t) => t.ordered.map((cand) => ({ cand, model: t.model }))).slice(0, ctx.cfg.routing.maxAttempts);
  return maxPico(...attemptable.map(({ cand, model }) => worstCase(cand, model, body, promptTokens, mode, fees, byok.has(cand.providerId))));
}

/** The most output tokens any provider that may be tried could produce for this request. */
function maxOutFor(ctx: Ctx, targets: RouteTarget[], body: Record<string, unknown>, promptTokens: number): number {
  const attemptable = targets.flatMap((t) => t.ordered.map((cand) => ({ cand, model: t.model }))).slice(0, ctx.cfg.routing.maxAttempts);
  return Math.max(1, ...attemptable.map(({ cand, model }) => maxOutputTokens(body, cand, model, promptTokens)));
}

/** Reserve every hold or none: a failure part-way releases what was already held. */
async function reserveAll(ctx: Ctx, billing: Chat.Billing, holds: { holdId: string; hold: Pico }[], paywithNote: string | undefined) {
  const held: string[] = [];
  try {
    for (const h of holds) {
      await reserve(ctx.db, {
        id: h.holdId,
        accountId: billing.accountId,
        keyHash: billing.key?.keyHash ?? null,
        amount: h.hold,
        kind: "usage",
        ttlMs: ctx.cfg.routing.providerTimeoutMs * (ctx.cfg.routing.maxAttempts + 1) * 2,
        creditLine: billing.mode === "paywith" ? billing.grant.creditLine : 0n,
      });
      held.push(h.holdId);
    }
  } catch (e) {
    await Promise.all(held.map((id) => release(ctx.db, id)));
    if (isApiError(e) && e.type === "insufficient_credits" && paywithNote) e.metadata = { ...e.metadata, pay_with: paywithNote };
    throw e;
  }
}

async function callLeg(tk: Toolkit, p: { ctx: Ctx; kind: Chat.Kind; billing: Chat.Billing; byok: Map<string, string>; signal: AbortSignal }, leg: Leg): Promise<LegResult> {
  const { ctx } = p;
  try {
    const result = await route({
      appSecret: ctx.cfg.appSecret,
      targets: leg.targets,
      path: p.kind === "chat" ? "/chat/completions" : "/completions",
      body: leg.body,
      stream: false,
      keyFor: (cand: Candidate) => providerKey(cand, ctx.cfg.appSecret, p.byok.get(cand.providerId)),
      signal: p.signal,
      health: ctx.health,
      maxAttempts: ctx.cfg.routing.maxAttempts,
      timeoutMs: ctx.cfg.routing.providerTimeoutMs,
      firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs,
      production: ctx.cfg.production,
      caller: sha256(p.billing.accountId).slice(0, 16),
    });
    if (!result.ok) return { ok: false, attempts: result.attempts, last: result.last };
    return { ok: true, r: result as JsonSuccess, doneAt: Date.now() };
  } catch (e) {
    return { ok: false, attempts: [], thrown: e };
  }
}

/** Why a call failed, as a stable error type. */
function reasonOf(tk: Toolkit, out: Extract<LegResult, { ok: false }>): string {
  if (out.thrown) return isApiError(out.thrown) ? out.thrown.type : "internal";
  return tk.allFailed(out.attempts, out.last).type;
}

/** A call's output, redacted the way a normal response would be before it is hashed or shown to anyone. */
function prepare(leg: Leg, out: Extract<LegResult, { ok: true }>, guardCfg: GuardrailConfig | null): Done {
  const json = out.r.json;
  const usage = readUsage(json.usage, { prompt: leg.promptTokens, completion: Math.ceil(JSON.stringify(json.choices ?? []).length / 4) });
  const redactions = guardCfg?.redact_output ? redactOutput(json) : 0;
  const text = (json.choices ?? []).map((ch: any) => (typeof ch?.message?.content === "string" ? ch.message.content : (ch?.text ?? ""))).join("");
  return { leg, r: out.r, json, usage, text, redactions, doneAt: out.doneAt };
}

/** The attestation reference of the provider that served a call (the router's own record of it), or null when it holds none. */
const refOf = (cand: Candidate): AttestationRef | null =>
  attestationRefOf({ id: cand.providerId, teeKind: cand.provider.teeKind, attestationHash: cand.provider.attestationHash, attestedAt: cand.provider.attestedAt, tlsPin: cand.provider.tlsPin });

/** A member or leg receipt row for the `council` / `verification` blocks. */
const rowOf = (label: string, d: Done, fin: Fin) => ({
  label,
  model: d.r.model.id,
  provider: d.r.candidate.providerId,
  disclosure: fin.disclosure,
  receipt_id: fin.id,
  cost: picoToUsdString(fin.charged),
  latency_ms: Math.round(d.r.latencyMs),
  status: "ok" as const,
});

/** A call's receipt field for its provider's attestation reference: only in attested mode, so other receipts are unchanged. */
const refPayload = (attested: boolean, cand: Candidate) => {
  const ref = attested ? refOf(cand) : null;
  return ref ? { attestation_ref: ref } : {};
};

/** What the caller was billed across all calls, in the shape of a normal `usage` object. */
function aggregateUsage(fins: Fin[], withHolder: boolean) {
  const n = (f: (x: Fin) => number) => fins.reduce((s, x) => s + f(x), 0);
  const p = (f: (x: Fin) => Pico) => fins.reduce((s, x) => s + f(x), 0n);
  const prompt = n((x) => x.usageJson.prompt_tokens);
  const completion = n((x) => x.usageJson.completion_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cost: picoToUsd(p((x) => x.charged)),
    is_byok: fins.some((x) => x.isByok),
    cost_details: {
      upstream_inference_cost: picoToUsd(p((x) => x.cost.upstream)),
      royalty: picoToUsd(p((x) => x.cost.royalty)),
      margin: picoToUsd(p((x) => x.cost.margin)),
      ...(withHolder ? { holder_discount: picoToUsd(p((x) => x.cost.holderDiscount)) } : {}),
    },
    prompt_tokens_details: { cached_tokens: n((x) => x.usageJson.prompt_tokens_details.cached_tokens), cache_write_tokens: n((x) => x.usageJson.prompt_tokens_details.cache_write_tokens) },
    completion_tokens_details: { reasoning_tokens: n((x) => x.usageJson.completion_tokens_details.reasoning_tokens) },
    calls: fins.length,
  };
}

const firstFinish = (json: any) => ({ finish: json?.choices?.[0]?.finish_reason ?? null, native: json?.choices?.[0]?.native_finish_reason ?? json?.choices?.[0]?.finish_reason ?? null });

// ---- Council -------------------------------------------------------------------------------------------

const FREE_TEXT_ONLY = ["tools", "tool_choice", "response_format", "structured_outputs"];

export async function runCouncil(tk: Toolkit, p: Base): Promise<Response> {
  const { ctx, c, kind, body, bodySha, t0, key, wallet } = p;
  let { tier, prefs, disc } = p;
  validateMulti(ctx, kind, body);
  const spec = parseCouncilSpec(body.council, ctx.cfg.council);
  // Attested council: `council.attested: true` or lane "attested". Either way it is the attested lane for every member and
  // the judge (retention declared attested, attestation fresh), so a request that only set the flag is held to it here.
  const attested = spec.attested === true || disc.lane === "attested";
  if (attested && disc.lane === "public") {
    disc = { max: "none", lane: "attested" };
    prefs = { ...prefs, disclosure: "none", lane: "attested" };
  }
  if (spec.mode === "fuse")
    for (const k of FREE_TEXT_ONLY) if (body[k] != null) fail(400, `Fuse mode writes free text, so \`${k}\` is not supported; use council.mode "judge".`, "invalid_council");

  // Every seat must resolve and be allowed for this key before anything is held or sent.
  await ctx.catalog.ensureFresh();
  const allowed = new Set(key?.allowedModels ?? []);
  const seat = (id: string) => {
    const r = ctx.catalog.resolve(id);
    if (!r) fail(404, `Council model ${id} is not available. See GET /api/v1/models.`, "model_not_found");
    if (allowed.size && !allowed.has(r.model.id)) fail(403, `This key may only use: ${[...allowed].join(", ")}.`, "model_not_allowed");
    return { ...r, requested: id };
  };
  const seats = spec.models.map(seat);
  const judgeSeat = seat(spec.judge);

  const guardCfg = mergeGuardrails(key?.guardrails as GuardrailConfig | null, key ? (body.guardrails as GuardrailConfig | undefined) : undefined);
  const guard = applyGuardrails(body, guardCfg);

  const { billing: resolvedBilling, paywithNote } = await tk.resolveBilling(ctx, c, key, wallet, null); // blind tokens are refused before council mode
  let billing = resolvedBilling;
  const byok = await tk.byokFor(ctx, billing?.accountId);
  const modeForPrice: Mode = billing?.mode ?? "per_call";

  // ---- Plan: one leg per member, then the judge ------------------------------------------------------
  const { council: _council, model: _model, ...shared } = body;
  const promptTokens = estimatePromptTokens(shared);
  const excludedAll: unknown[] = [];
  // An attested council never drops or downgrades a seat: a member or the judge with no attested provider refuses the whole
  // request (the same 409, or 503 while attested providers are down, a single attested request gets), before anything is held.
  const seatError = (e: unknown, seat: string) => (attested && isApiError(e) && (e.status === 409 || e.status === 503) ? Object.assign(e, { metadata: { ...e.metadata, council_seat: seat } }) : e);
  const legs: Leg[] = seats.map((s, i) => {
    const memberBody = { ...shared, model: s.requested };
    let planned: ReturnType<Toolkit["selectTargets"]>;
    try {
      planned = tk.selectTargets(ctx, { resolved: [s], prefs, params: tk.requestParams(memberBody), promptTokens, byok, disc });
    } catch (e) {
      throw seatError(e, `member ${labelFor(i)}`);
    }
    const { targets, excluded } = planned;
    if (!targets.length) fail(404, `No providers match council member ${s.requested} under this request's routing preferences.`, "no_providers", { excluded: excluded.slice(0, 50) });
    excludedAll.push(...excluded.slice(0, 10));
    return { label: labelFor(i), model: s.model, requested: s.requested, body: memberBody, targets, promptTokens, holdId: genId(), hold: holdFor(ctx, targets, memberBody, promptTokens, modeForPrice, byok) };
  });

  // The judge reads the conversation and every answer. Its hold assumes each member fills its output cap.
  const conversation = transcript(shared.messages);
  const tag = randomBytes(8).toString("hex");
  const skeleton = judgeMessages(spec.mode, conversation, [], tag);
  const judgeBase: Record<string, unknown> = {
    model: spec.judge,
    ...(spec.mode === "judge" ? { max_tokens: JUDGE_MAX_TOKENS } : Object.fromEntries(["max_tokens", "max_completion_tokens"].filter((k) => body[k] != null).map((k) => [k, body[k]]))),
    ...(body.user !== undefined ? { user: body.user } : {}),
    ...(body.provider !== undefined ? { provider: body.provider } : {}),
  };
  const skeletonTokens = estimatePromptTokens({ messages: skeleton });
  let judgePlan: ReturnType<Toolkit["selectTargets"]>;
  try {
    judgePlan = tk.selectTargets(ctx, { resolved: [judgeSeat], prefs, params: tk.requestParams(judgeBase), promptTokens: skeletonTokens, byok, disc });
  } catch (e) {
    throw seatError(e, "judge");
  }
  const { targets: judgeTargets, excluded: judgeExcluded } = judgePlan;
  if (!judgeTargets.length) fail(404, `No providers match the council judge ${spec.judge} under this request's routing preferences.`, "no_providers", { excluded: judgeExcluded.slice(0, 50) });
  const answerTokens = legs.reduce((sum, l) => sum + Math.ceil((maxOutFor(ctx, l.targets, l.body, l.promptTokens) * 4) / 3) + 40, 0);
  const judgeWorstTokens = skeletonTokens + answerTokens;
  const judgeHoldId = genId();
  const judgeHold = holdFor(ctx, judgeTargets, { ...judgeBase, messages: skeleton }, judgeWorstTokens, modeForPrice, byok);

  // ---- Budget: the whole council, before anything is sent -------------------------------------------------
  const total = legs.reduce((sum, l) => sum + l.hold, judgeHold);
  const cap = spec.maxCostUsd != null ? usdToPico(spec.maxCostUsd, "floor") : null;
  if (cap != null && total > cap)
    fail(402, `The worst case for this council is $${picoToUsd(total)}, above council.max_cost_usd of $${spec.maxCostUsd}. Lower max_tokens or use fewer members.`, "council_budget_exceeded", {
      max_cost_usd: spec.maxCostUsd,
      worst_case_usd: picoToUsd(total),
      members: legs.map((l) => ({ label: l.label, model: l.model.id, worst_case_usd: picoToUsd(l.hold) })),
      judge: { model: judgeSeat.model.id, worst_case_usd: picoToUsd(judgeHold) },
    });

  if (!billing) {
    const r = await payPerCall(ctx, c, { pricePico: total, bodySha, modelId: COUNCIL_MODEL });
    billing = { mode: "per_call", accountId: r.accountId, payer: r.payer, paymentTx: r.txHash, paymentResponse: r.paymentResponse };
  }
  if (billing.mode === "per_call") tier = await holderTier(ctx, billing.payer);
  if (billing.key?.tpm) await tk.limitOrThrow(ctx, `kt:${billing.key.keyHash}`, legs.reduce((s, l) => s + l.promptTokens, judgeWorstTokens), scaleLimit(billing.key.tpm, tier), "tokens");
  const bill: Chat.Billing = billing;

  await reserveAll(ctx, bill, [...legs, { holdId: judgeHoldId, hold: judgeHold }], paywithNote);
  const open = new Set([...legs.map((l) => l.holdId), judgeHoldId]);
  const abort = new AbortController();
  c.req.raw.signal?.addEventListener("abort", () => abort.abort(new DOMException("client disconnected", "AbortError")), { once: true });
  const call = { ctx, kind, billing: bill, byok, signal: abort.signal };
  const meta = { guard, middle: null, paywithNote, cacheMode: null, excluded: excludedAll, route: null };
  const budget = (l: { hold: Pico }) => (cap != null ? l.hold : undefined);
  const common = (leg: Leg, bodySha_: string) => ({ ctx, c, body: leg.body, billing: bill, holdId: leg.holdId, t0, bodySha: bodySha_, stream: false, kind, byok, meta, guardCfg, promptTokens: leg.promptTokens, tier, disc, planned: null });

  try {
    // ---- Members, concurrently, through the normal routing path ----------------------------------------
    const outcomes = await Promise.all(legs.map((leg) => callLeg(tk, call, leg)));
    if (abort.signal.aborted) throw abort.signal.reason;

    const members: Record<string, unknown>[] = [];
    const memberRefs: Record<string, unknown>[] = [];
    const answered: { leg: Leg; done: Done }[] = [];
    const fins: Fin[] = [];
    let membersCharged = 0n;
    for (const [i, out] of outcomes.entries()) {
      const leg = legs[i];
      if (!out.ok) {
        open.delete(leg.holdId);
        await release(ctx.db, leg.holdId);
        members.push({ label: leg.label, model: leg.model.id, provider: null, receipt_id: null, cost: "0", latency_ms: null, status: "failed", error: reasonOf(tk, out) });
        continue;
      }
      const done = prepare(leg, out, guardCfg);
      const fin = await tk.finalize({
        ...common(leg, tk.requestHash(leg.body)),
        r: done.r,
        usage: done.usage,
        responseText: done.text,
        finishReason: firstFinish(done.json).finish,
        nativeFinish: firstFinish(done.json).native,
        generationMs: done.doneAt - t0,
        cancelled: false,
        extra: { payload: { council: { role: "member", label: leg.label, mode: spec.mode, parent: judgeHoldId }, ...refPayload(attested, done.r.candidate) }, budget: budget(leg) },
      });
      open.delete(leg.holdId);
      fins.push(fin);
      membersCharged += fin.charged;
      members.push(rowOf(leg.label, done, fin));
      const memberRef = attested ? refOf(done.r.candidate) : null;
      if (memberRef) memberRefs.push({ role: "member", label: leg.label, receipt_id: fin.id, ...memberRef });
      answered.push({ leg, done });
    }
    const failureMeta = () => ({ members, members_cost_usd: picoToUsd(membersCharged), receipts: fins.map((f) => f.id) });

    if (answered.length < spec.minMembers)
      throw new ApiError(502, `Only ${answered.length} of ${legs.length} council members answered (${spec.minMembers} needed). Members that answered were billed; their receipts are listed.`, "council_quorum", { needed: spec.minMembers, ...failureMeta() });

    // ---- The judge ------------------------------------------------------------------------------------------
    const judgeBody = { ...judgeBase, messages: judgeMessages(spec.mode, conversation, answered.map((a) => ({ label: a.leg.label, text: outputText(a.done.json) })), tag) };
    const judgeLeg: Leg = { label: "judge", model: judgeSeat.model, requested: spec.judge, body: judgeBody, targets: judgeTargets, promptTokens: estimatePromptTokens(judgeBody), holdId: judgeHoldId, hold: judgeHold };
    const jo = await callLeg(tk, call, judgeLeg);
    if (abort.signal.aborted) throw abort.signal.reason;
    if (!jo.ok) throw new ApiError(502, "The council judge could not be reached. Members were billed; their receipts are listed.", "council_judge_failed", { judge: { model: judgeSeat.model.id, error: reasonOf(tk, jo) }, ...failureMeta() });
    const judged = prepare(judgeLeg, jo, guardCfg);

    // What the caller receives: a member's own answer (judge mode) or the judge's fused text (fuse mode).
    let delivered: any = null;
    let source: Done | null = null;
    let selected: { label: string; receipt_id: string } | null = null;
    let reason: string | null = null;
    if (spec.mode === "judge") {
      const choice = parseJudgeChoice(outputText(judged.json), answered.map((a) => a.leg.label));
      if (choice) {
        const idx = answered.findIndex((a) => a.leg.label === choice.label);
        source = answered[idx].done;
        delivered = source.json;
        selected = { label: choice.label, receipt_id: members.find((m) => m.label === choice.label)!.receipt_id as string };
        reason = choice.reason;
      }
    } else {
      source = judged;
      delivered = judged.json;
    }
    const answerText = source?.text ?? "";
    const outcome = spec.mode === "fuse" ? "fused" : selected ? "selected" : "invalid_verdict";
    // The top-level receipt stands for every call, so it never claims more than the weakest of them.
    // A judge an attested gateway served counts as attested only when its receipt shows an attested upstream.
    const judgeUa = await tk.upstreamAttestationOf(ctx, judged.r, byok);
    const judgeServed = tk.servedWith(ctx, judged.r.candidate, judgeUa);
    const served = weakestServed([...fins.map((f) => ({ class: f.disclosure, simulated: f.simulated })), judgeServed]);
    // Attested council: what the router checked for every provider that took part, in the signed block. `attested` is true only
    // when every call was served under the attested class and has a reference, so it is a fact about these calls and not a request echo.
    const judgeRef = attested ? refOf(judged.r.candidate) : null;
    const attestedBlock = attested
      ? {
          attested: served.class === "attested" && !!judgeRef && memberRefs.length === answered.length,
          ...(served.simulated ? { attestation_simulated: true } : {}),
          attestation_refs: [...memberRefs, ...(judgeRef ? [{ role: "judge", receipt_id: judgeHoldId, ...judgeRef }] : [])],
        }
      : {};
    const signedBlock = {
      role: "judge",
      mode: spec.mode,
      requested: COUNCIL_MODEL,
      members,
      members_cost: picoToUsdString(membersCharged),
      judge: { model: judged.r.model.id, provider: judged.r.candidate.providerId, disclosure: judgeServed.class, receipt_id: judgeHoldId, request_sha256: tk.requestHash(judgeBody) },
      selected,
      outcome,
      answer_sha256: source ? sha256(answerText) : null,
      ...attestedBlock,
    };
    const judgeFin = await tk.finalize({
      ...common(judgeLeg, bodySha),
      r: judged.r,
      usage: judged.usage,
      responseText: answerText,
      finishReason: firstFinish(delivered ?? judged.json).finish,
      nativeFinish: firstFinish(delivered ?? judged.json).native,
      generationMs: Date.now() - t0,
      cancelled: false,
      extra: { payload: { council: signedBlock, ...(judgeRef ? { attestation_ref: judgeRef } : {}) }, budget: budget(judgeLeg), served },
      upstreamAttestation: judgeUa,
    });
    open.delete(judgeHoldId);
    fins.push(judgeFin);

    if (!delivered)
      throw new ApiError(502, "The council judge did not name one of the answers. Nothing was returned; all calls were billed and their receipts are listed.", "council_judge_invalid", { ...failureMeta(), judge_receipt_id: judgeHoldId });

    const totalCharged = membersCharged + judgeFin.charged;
    const dropped = [...new Set([...answered.flatMap((a) => a.done.r.dropped), ...judged.r.dropped])];
    const redactions = answered.reduce((s, a) => s + a.done.redactions, 0) + (spec.mode === "fuse" ? judged.redactions : 0);
    const extras = (judgeFin.extras(redactions) ?? {}) as Record<string, unknown>;
    delete extras.dropped_parameters;
    if (dropped.length) extras.dropped_parameters = dropped;
    const out = {
      ...delivered,
      id: judgeFin.id,
      model: COUNCIL_MODEL,
      provider: (source ?? judged).r.candidate.provider.name,
      object: "chat.completion",
      usage: aggregateUsage(fins, tier != null),
      receipt: judgeFin.receiptJson,
      council: {
        ...signedBlock,
        ...(reason ? { reason } : {}),
        judge: { ...signedBlock.judge, cost: picoToUsdString(judgeFin.charged), latency_ms: Math.round(judged.r.latencyMs) },
        total_cost: picoToUsdString(totalCharged),
        ...(cap != null ? { max_cost_usd: spec.maxCostUsd } : {}),
      },
      ...extras,
    };
    // The policy hash header speaks for every call of the council, so it is sent only when they all share one.
    return c.json(out, 200, { ...generationHeaders(judgeFin.id, disc.lane, sharedPolicyHash(fins.map((f) => f.policyHash))), "x-anyroute-disclosure": judgeFin.disclosure, ...tk.paymentHeaders(bill) });
  } finally {
    await Promise.all([...open].map((id) => release(ctx.db, id)));
  }
}

// ---- Dual verification ------------------------------------------------------------------------------------

type DualInput = Base & {
  billing: Chat.Billing | null;
  paywithNote?: string;
  resolved: { model: ModelRow; modifiers: Set<Modifier>; requested: string }[];
  targets: RouteTarget[];
  excluded: { model: string; provider: string; reason: string }[];
  promptTokens: number;
  byok: Map<string, string>;
  guard: ReturnType<typeof applyGuardrails>;
  guardCfg: GuardrailConfig | null;
  middle: { removed: number; truncated: number } | null;
  savedRoute: string | null;
};

/** Providers that can honour temperature and seed (or do not say either way, so both are sent). */
const decodesDeterministically = (cand: Candidate) => {
  const sp = cand.supportedParameters ?? [];
  return !sp.length || (sp.includes("seed") && sp.includes("temperature"));
};

export async function runDual(tk: Toolkit, p: DualInput): Promise<Response> {
  const { ctx, c, kind, body, bodySha, t0, disc, resolved, targets, promptTokens, byok, guard, guardCfg, middle, savedRoute, paywithNote } = p;
  let { billing, tier } = p;
  validateMulti(ctx, kind, body);
  if (resolved.length !== 1 || targets.length !== 1) fail(400, "`verify: \"dual\"` works on exactly one model; remove `models`.", "invalid_verify");
  const target = targets[0];
  // Lane "attested": `disc` already limits every candidate to providers that are attested now (retention declared attested,
  // fresh attestation); the two legs must also be two different providers, and each receipt records its provider's attestation.
  const attested = disc.lane === "attested";

  // Two providers of the same model, taken alternately from the routing order so each call keeps its own fallbacks.
  const eligible = target.ordered.filter(decodesDeterministically).filter((cand, i, all) => !attested || all.findIndex((x) => x.providerId === cand.providerId) === i);
  if (eligible.length < 2)
    fail(
      409,
      attested
        ? `Dual verification on lane "attested" needs two different attested providers of ${target.model.id} (retention declared "attested" and a fresh attestation) that support temperature and seed; ${eligible.length} found. Nothing was sent to any provider, no provider that is not attested was substituted, and nothing was charged. See GET /api/v1/models?lane=attested.`
        : `Dual verification needs two providers of ${target.model.id} that support temperature and seed; ${eligible.length} found under this request's routing preferences.`,
      "verification_unavailable",
      {
        model: target.model.id,
        eligible: eligible.map((cand) => cand.providerId),
        excluded: [...p.excluded, ...target.ordered.filter((cand) => !decodesDeterministically(cand)).map((cand) => ({ model: target.model.id, provider: cand.providerId, reason: "does not support temperature and seed" }))].slice(0, 50),
        ...(attested ? { requested: { lane: "attested", disclosure: "none" } } : {}),
      },
    );
  const modeForPrice: Mode = billing?.mode ?? "per_call";
  const legs: Leg[] = [0, 1].map((i) => {
    const targetsOf = [{ model: target.model, ordered: eligible.filter((_, j) => j % 2 === i) }];
    return { label: labelFor(i), model: target.model, requested: resolved[0].requested, body, targets: targetsOf, promptTokens, holdId: genId(), hold: holdFor(ctx, targetsOf, body, promptTokens, modeForPrice, byok) };
  });
  const total = legs[0].hold + legs[1].hold;

  if (!billing) {
    const r = await payPerCall(ctx, c, { pricePico: total, bodySha, modelId: target.model.id });
    billing = { mode: "per_call", accountId: r.accountId, payer: r.payer, paymentTx: r.txHash, paymentResponse: r.paymentResponse };
  }
  if (billing.mode === "per_call") tier = await holderTier(ctx, billing.payer);
  if (billing.key?.tpm) await tk.limitOrThrow(ctx, `kt:${billing.key.keyHash}`, promptTokens * 2, scaleLimit(billing.key.tpm, tier), "tokens");
  const bill: Chat.Billing = billing;

  await reserveAll(ctx, bill, legs, paywithNote);
  const open = new Set(legs.map((l) => l.holdId));
  const abort = new AbortController();
  c.req.raw.signal?.addEventListener("abort", () => abort.abort(new DOMException("client disconnected", "AbortError")), { once: true });
  const call = { ctx, kind, billing: bill, byok, signal: abort.signal };
  const meta = { guard, middle, paywithNote, cacheMode: null, excluded: p.excluded, route: savedRoute };
  // Each answer's gateway receipt check (providers/aci.ts), made once: it decides the attested block and goes into the receipt.
  const checkedUpstream = new WeakMap<Done, Awaited<ReturnType<Toolkit["upstreamAttestationOf"]>>>();
  const settle = (leg: Leg, done: Done, verification: unknown) => {
    const f = firstFinish(done.json);
    return tk.finalize({
      ctx, c, body, billing: bill, holdId: leg.holdId, t0, bodySha, stream: false, kind, byok, meta, guardCfg, promptTokens, tier, disc, planned: null,
      r: done.r, usage: done.usage, responseText: done.text, finishReason: f.finish, nativeFinish: f.native, generationMs: done.doneAt - t0, cancelled: false,
      extra: { payload: { verification, ...refPayload(attested, done.r.candidate) } },
      ...(checkedUpstream.has(done) ? { upstreamAttestation: checkedUpstream.get(done) } : {}),
    });
  };
  // What the router checked for the providers that answered, for the `verification` block (attested lane only).
  const attestedBlock = (ran: { label: string; receiptId: string; done: Done }[]) => {
    if (!attested) return {};
    const refs = ran.flatMap((x) => {
      const ref = refOf(x.done.r.candidate);
      return ref ? [{ label: x.label, receipt_id: x.receiptId, ...ref }] : [];
    });
    const every = ran.every((x) => tk.servedWith(ctx, x.done.r.candidate, checkedUpstream.get(x.done)).class === "attested");
    return { attested: every && refs.length === ran.length, attestation_refs: refs };
  };

  try {
    const outcomes = await Promise.all(legs.map((leg) => callLeg(tk, call, leg)));
    if (abort.signal.aborted) throw abort.signal.reason;
    const done = outcomes.map((o, i) => (o.ok ? prepare(legs[i], o, guardCfg) : null));
    for (const d of done) if (d) checkedUpstream.set(d, await tk.upstreamAttestationOf(ctx, d.r, byok));
    const ids = [legs[0].holdId, legs[1].holdId];

    // One call failed: the other still ran, so it is billed and receipted, but nothing is verified.
    if (!done[0] || !done[1]) {
      const fins: Fin[] = [];
      for (const [i, d] of done.entries()) {
        if (!d) continue;
        fins.push(await settle(legs[i], d, { mode: "dual", agree: null, complete: false, receipts: ids, ...attestedBlock([{ label: legs[i].label, receiptId: ids[i], done: d }]) }));
        open.delete(legs[i].holdId);
      }
      const failed = outcomes.flatMap((o, i) => (o.ok ? [] : [{ leg: legs[i].label, providers: legs[i].targets[0].ordered.map((cand) => cand.providerId), error: reasonOf(tk, o) }]));
      if (!fins.length) {
        const first = outcomes.find((o) => !o.ok) as Extract<LegResult, { ok: false }>;
        if (first.thrown) throw first.thrown;
        throw tk.allFailed(outcomes.flatMap((o) => (o.ok ? [] : o.attempts)), first.last);
      }
      throw new ApiError(502, "One of the two providers failed, so the output could not be verified. The call that ran was billed; its receipt is listed.", "verification_failed", { failed, receipts: fins.map((f) => f.id) });
    }

    const [a, b] = done;
    const cmp = compareOutputs(outputText(a.json), outputText(b.json));
    const seed = body.seed as number;
    const verification = {
      mode: "dual",
      providers: [a.r.candidate.providerId, b.r.candidate.providerId],
      agree: cmp.agree,
      match: cmp.match,
      receipts: ids,
      seed,
      temperature: 0,
      quantizations: [a.r.candidate.quant, b.r.candidate.quant],
      ...attestedBlock([
        { label: legs[0].label, receiptId: ids[0], done: a },
        { label: legs[1].label, receiptId: ids[1], done: b },
      ]),
    };
    const finA = await settle(legs[0], a, verification);
    open.delete(legs[0].holdId);
    const finB = await settle(legs[1], b, verification);
    open.delete(legs[1].holdId);

    const dropped = [...new Set([...a.r.dropped, ...b.r.dropped])];
    const extras = (finA.extras(a.redactions) ?? {}) as Record<string, unknown>;
    delete extras.dropped_parameters;
    if (dropped.length) extras.dropped_parameters = dropped;
    const { mode: _mode, ...shown } = verification;
    const out = {
      ...a.json,
      id: finA.id,
      model: a.r.model.id,
      provider: a.r.candidate.provider.name,
      object: kind === "chat" ? "chat.completion" : "text_completion",
      usage: aggregateUsage([finA, finB], tier != null),
      receipt: finA.receiptJson,
      verification: shown,
      ...extras,
    };
    // The header speaks for both calls, so it shows the weaker of the two; each receipt carries its own call's class.
    const served = weakestServed([finA, finB].map((f) => ({ class: f.disclosure, simulated: f.simulated })));
    return c.json(out, 200, { ...generationHeaders(finA.id, disc.lane, sharedPolicyHash([finA.policyHash, finB.policyHash])), "x-anyroute-disclosure": served.class, ...tk.paymentHeaders(bill) });
  } finally {
    await Promise.all([...open].map((id) => release(ctx.db, id)));
  }
}

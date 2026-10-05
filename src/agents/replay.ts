// Replay a draft rulebook against a key's recorded activity: the calls it ran (generations, never their text) and its
// Agent Guard action checks, oldest first, through the same evaluator the router enforces with. Running state (rolling
// caps, calls per hour, breakers, autonomy, Stop) is rebuilt from the replay's own decisions, seeded with what was
// charged before the window. Read only: nothing is saved, charged or changed. Where the record cannot say what live
// enforcement would have done, the result says so in `notes` rather than guessing.
import { sql, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { picoToUsd } from "../lib/money.ts";
import { advanceAutonomy, type AutonomyState } from "./autonomy.ts";
import { breakerKillReason } from "./breakers.ts";
import { evaluateAgentPolicy, type AgentDecision, type AgentPolicyState } from "./evaluate.ts";
import type { AgentIntent, AgentPolicy } from "./policy.ts";
import { policiesFor } from "./store.ts";

export const REPLAY = { limit: 5_000, examples: 20, maxDays: 7, perMinute: 10 } as const;
const MINUTE = 60_000, TEN_MINUTES = 600_000, HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY;
const LANES = ["public", "attested", "unlinkable"] as const;
type Lane = (typeof LANES)[number];
export type ReplayDecision = AgentDecision["decision"];
/** A call that ran. `actual` is "allow" when a rulebook decision was recorded, "approval_required" when it ran after an approval, null when none was recorded. */
export type ReplayCall = { kind: "call"; ts: Date; model: string; lane: string | null; cost_pico: bigint; tokens_out: number; est_cost_pico?: bigint; max_output_tokens?: number; tools?: string[]; actual: ReplayDecision | null };
export type ReplayAction = { kind: "action"; ts: Date; action: string; target?: string; amount_pico: bigint; details_sha256?: string; outcome: "executed" | "skipped" | "failed" | null; outcome_pico: bigint | null; actual: ReplayDecision };
export type ReplayItem = ReplayCall | ReplayAction;
/** What happened before the window, so the first replayed call sees the rolling hour, day and week as they were. */
export type ReplaySeed = { spend: { ts: Date; pico: bigint }[]; calls: { ts: Date; n: number }[]; actions: { ts: Date; pico: bigint; n: number }[] };
export type ReplayInput = { from: Date; to: Date; days: number; items: ReplayItem[]; truncated: boolean; seed: ReplaySeed; refused: number; inherited: number };
export type ReplayExample = { time: string; kind: "call" | "action"; model: string | null; lane: string | null; action: string | null; cost_usd: number; decision: ReplayDecision; reason: { code: string; message: string } | null; actual: ReplayDecision | null };
export type ReplayResult = {
  window: { from: string; to: string; days: number }; evaluated: number; allowed: number; denied: number; asked: number;
  stopped_at?: string; stopped_reason?: string; by_reason: Record<string, number>;
  actual: { allowed: number; denied: number; asked: number; not_recorded: number }; changed: number;
  examples: ReplayExample[]; truncated: boolean; notes: string[];
};

// The live message for a stopped key names the old word; in a replay the stop is the draft's own.
const REPLAY_MESSAGES: Record<string, string> = { killed: "The draft stopped this key earlier in the replay, so every later call is refused." };

/** Sums over rolling windows. Entries arrive oldest first and queries never go back in time. */
class Rolling {
  private entries: { t: number; v: bigint }[] = [];
  private heads = new Map<number, { i: number; sum: bigint }>();
  add(t: number, v: bigint) { this.entries.push({ t, v }); for (const head of this.heads.values()) head.sum += v; }
  /** The window (now - span, now], as the router reads `ts > now - span and ts <= now`. */
  sum(span: number, now: number) {
    let head = this.heads.get(span);
    if (!head) this.heads.set(span, head = { i: 0, sum: this.entries.reduce((s, e) => s + e.v, 0n) });
    while (head.i < this.entries.length && this.entries[head.i]!.t <= now - span) head.sum -= this.entries[head.i++]!.v;
    return head.sum;
  }
}
/** Distinct models over the rolling hour, for the distinct-model breaker. */
class RollingModels {
  private entries: { t: number; model: string }[] = [];
  private i = 0;
  private counts = new Map<string, number>();
  add(t: number, model: string) { this.entries.push({ t, model }); this.counts.set(model, (this.counts.get(model) ?? 0) + 1); }
  distinct(now: number) {
    while (this.i < this.entries.length && this.entries[this.i]!.t <= now - HOUR) {
      const { model } = this.entries[this.i++]!, n = this.counts.get(model)! - 1;
      if (n) this.counts.set(model, n); else this.counts.delete(model);
    }
    return [...this.counts.keys()];
  }
}
const fresh = (at: Date): AutonomyState => ({ rung: 0, since: at.toISOString(), clean_requests: 0, last_clean_at: null });
const laneOf = (lane: string | null): Lane => (LANES as readonly string[]).includes(lane ?? "") ? lane as Lane : "public";
function intentOf(item: ReplayItem): AgentIntent {
  if (item.kind === "action") return { kind: "action", action: item.action, amount_pico: item.amount_pico, ...(item.target === undefined ? {} : { target: item.target }), ...(item.details_sha256 === undefined ? {} : { details_sha256: item.details_sha256 }) };
  return { kind: "inference", model: item.model, lane: laneOf(item.lane), est_cost_pico: item.est_cost_pico ?? item.cost_pico, max_output_tokens: item.max_output_tokens ?? item.tokens_out, tools: item.tools ?? [] };
}
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Evaluate every item in order with running state, the way enforcement would have with this draft saved at the window's start. */
export function replayRulebook(policy: AgentPolicy, input: ReplayInput): ReplayResult {
  const spend = new Rolling(), minuteSpend = new Rolling(), calls = new Rolling(), actionPico = new Rolling(), actionCount = new Rolling(), requests = new Rolling(), denials = new Rolling();
  const models = new RollingModels();
  for (const s of input.seed.spend) spend.add(s.ts.getTime(), s.pico);
  for (const s of input.seed.calls) calls.add(s.ts.getTime(), BigInt(s.n));
  for (const s of input.seed.actions) { actionPico.add(s.ts.getTime(), s.pico); actionCount.add(s.ts.getTime(), BigInt(s.n)); }
  const demote = (on: "deny" | "kill" | "breaker") => !!policy.autonomy?.demote_on.includes(on);
  let autonomy = policy.autonomy ? fresh(input.from) : undefined;
  let killed = false, stopped: { at: Date; reason: string } | undefined;
  const missing = { estimate: 0, tokens: 0, tools: 0, lane: 0 };
  let approvedBefore = 0;
  const results = input.items.map((item, index) => {
    const t = item.ts.getTime(), intent = intentOf(item);
    if (autonomy) autonomy = advanceAutonomy(policy, autonomy, item.ts);
    if (item.kind === "call") {
      if (item.est_cost_pico === undefined) missing.estimate++;
      if (item.max_output_tokens === undefined) missing.tokens++;
      if (item.tools === undefined) missing.tools++;
      if (!(LANES as readonly string[]).includes(item.lane ?? "")) missing.lane++;
      if (item.actual === "approval_required") approvedBefore++;
    }
    const hourModels = policy.breakers ? models.distinct(t) : [];
    const state: AgentPolicyState = {
      killed, spent_pico: { hour: spend.sum(HOUR, t), day: spend.sum(DAY, t), week: spend.sum(WEEK, t) },
      ...(policy.actions ? { actions_pico_day: actionPico.sum(DAY, t), actions_hour: Number(actionCount.sum(HOUR, t)) } : {}),
      ...(policy.breakers ? { breakers: { spent_minute_pico: minuteSpend.sum(MINUTE, t), requests_minute: Number(requests.sum(MINUTE, t)), denials_10min: Number(denials.sum(TEN_MINUTES, t)), distinct_models_hour: hourModels.length, models_hour: hourModels, requested_models: intent.kind === "inference" ? [intent.model] : [] } } : {}),
      ...(autonomy ? { autonomy } : {}),
      ...(policy.approval?.above_calls_per_hour !== undefined ? { calls_hour: Number(calls.sum(HOUR, t)) } : {}),
    };
    const decision = evaluateAgentPolicy(policy, state, intent, item.ts);
    // One breaker observation per admission, whatever its decision, recorded after the state was read.
    requests.add(t, 1n);
    if (decision.decision === "deny") denials.add(t, 1n);
    if (intent.kind === "inference") models.add(t, intent.model);
    if (decision.decision === "deny") {
      if (autonomy && demote("deny")) autonomy = fresh(item.ts);
      const breaker = breakerKillReason(decision);
      if ((policy.on_breach === "kill" || breaker) && !killed) {
        if (autonomy && ((breaker && demote("breaker")) || demote("kill"))) autonomy = fresh(item.ts);
        killed = true; stopped = { at: item.ts, reason: breaker ?? decision.reasons.map(r => r.code).join(",") };
      }
    }
    if (decision.decision === "allow") {
      if (item.kind === "call") { spend.add(t, item.cost_pico); minuteSpend.add(t, item.cost_pico); calls.add(t, 1n); }
      else {
        // As the router counts an allowed action: its reported amount once executed, nothing once skipped or failed, else the amount asked for.
        const counted = item.actual === "allow" && item.outcome !== null ? item.outcome === "executed" ? item.outcome_pico ?? item.amount_pico : 0n : item.amount_pico;
        actionPico.add(t, counted); actionCount.add(t, 1n);
      }
      if (autonomy) autonomy = advanceAutonomy(policy, { ...autonomy, clean_requests: autonomy.clean_requests + 1, last_clean_at: item.ts.toISOString() }, item.ts);
    }
    return { index, item, decision: decision.decision, reasons: decision.reasons };
  });
  const count = (d: ReplayDecision) => results.filter(r => r.decision === d).length;
  const by_reason: Record<string, number> = {};
  for (const r of results) if (r.decision !== "allow") for (const { code } of r.reasons) by_reason[code] = (by_reason[code] ?? 0) + 1;
  const changed = results.filter(r => r.item.actual !== null && r.item.actual !== r.decision);
  // Up to 20 examples: the first of each outcome and reason, then calls that would have gone differently, then refusals, then the rest.
  const picked = new Set<number>(), seen = new Set<string>();
  const take = (pick: (r: (typeof results)[number]) => boolean) => { for (const r of results) { if (picked.size >= REPLAY.examples) return; if (!picked.has(r.index) && pick(r)) picked.add(r.index); } };
  take(r => { const k = `${r.decision}:${r.reasons[0]?.code ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
  take(r => r.item.actual !== null && r.item.actual !== r.decision);
  take(r => r.decision !== "allow");
  take(() => true);
  const examples = results.filter(r => picked.has(r.index)).map(({ item, decision, reasons }): ReplayExample => ({
    time: item.ts.toISOString(), kind: item.kind, model: item.kind === "call" ? item.model : null, lane: item.kind === "call" ? item.lane : null, action: item.kind === "action" ? item.action : null,
    cost_usd: picoToUsd(item.kind === "call" ? item.cost_pico : item.amount_pico), decision,
    reason: reasons[0] ? { code: reasons[0].code, message: REPLAY_MESSAGES[reasons[0].code] ?? reasons[0].message } : null, actual: item.actual,
  }));
  const asked = count("approval_required");
  const notes: string[] = [];
  if (input.truncated) notes.push(`Only the oldest ${REPLAY.limit.toLocaleString("en-US")} calls and actions were replayed, up to ${input.items.at(-1)?.ts.toISOString() ?? input.from.toISOString()}; later ones in the window were not.`);
  if (stopped) notes.push("After the draft stops this key, the replay assumes nobody pressed Resume, so every later call is refused.");
  if (asked) notes.push("Calls the draft sends to ask me first count as not run, so they add no spend: the replay cannot know whether you would have approved them.");
  if (approvedBefore) notes.push(`${plural(approvedBefore, "call")} ran after an approval at the time. Past approvals are not reused, so the replay shows what the draft's rules say on their own.`);
  if (input.refused) notes.push(`${plural(input.refused, "model call")} refused at the time ${input.refused === 1 ? "is" : "are"} not replayed: only calls that ran are recorded with their cost.`);
  const priced = policy.caps.per_request_usd !== undefined || policy.approval !== undefined || policy.breakers?.max_spend_usd_per_minute !== undefined;
  if (missing.estimate && priced) notes.push(`${plural(missing.estimate, "call")} ${missing.estimate === 1 ? "has" : "have"} no recorded cost estimate; per request checks use the charged cost instead.`);
  if (missing.tokens && policy.caps.max_output_tokens !== undefined) notes.push(`${plural(missing.tokens, "call")} ${missing.tokens === 1 ? "has" : "have"} no recorded output token limit; the replay uses the output tokens each one produced.`);
  if (missing.tools && policy.tools && (policy.tools.allow !== undefined || policy.tools.deny !== undefined)) notes.push(`${plural(missing.tools, "call")} ${missing.tools === 1 ? "has" : "have"} no recorded tool list; ${missing.tools === 1 ? "it is" : "they are"} replayed as declaring no tools.`);
  if (missing.lane && policy.lanes) notes.push(`${plural(missing.lane, "call")} ${missing.lane === 1 ? "has" : "have"} no recorded lane; ${missing.lane === 1 ? "it is" : "they are"} replayed as public.`);
  if (policy.autonomy) notes.push("Progressive autonomy starts again from its first step, as it does when a rulebook is saved.");
  if (input.inherited) notes.push(`This key also follows ${input.inherited === 1 ? "an inherited rulebook" : `${input.inherited} inherited rulebooks`} from the key that created it; the replay checks only this draft.`);
  return {
    window: { from: input.from.toISOString(), to: input.to.toISOString(), days: input.days },
    evaluated: results.length, allowed: count("allow"), denied: count("deny"), asked,
    ...(stopped ? { stopped_at: stopped.at.toISOString(), stopped_reason: stopped.reason } : {}),
    by_reason,
    actual: { allowed: results.filter(r => r.item.actual === "allow").length, denied: results.filter(r => r.item.actual === "deny").length, asked: results.filter(r => r.item.actual === "approval_required").length, not_recorded: results.filter(r => r.item.actual === null).length },
    changed: changed.length, examples, truncated: input.truncated, notes,
  };
}

type CallRow = { ts: number | string; model_id: string; lane: string | null; cost: string; tokens_out: number; intent: { est_cost_pico?: string; max_output_tokens?: number; tools?: string[] } | null; approved: boolean | null; recorded: boolean | null };
type ActionRow = { created_at: number | string; action: string; target: string | null; amount_pico: string; details_sha256: string | null; decision: ReplayDecision; outcome_status: ReplayAction["outcome"]; outcome_amount_pico: string | null };
const rowsOf = <T,>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? result) as T[];
const iso = (d: Date) => d.toISOString();
// Times come back as epoch milliseconds, so no driver's text format for timestamps is parsed here.
const ms = (column: SQL) => sql`round(extract(epoch from ${column}) * 1000)::float8`;
const at = (value: number | string) => new Date(Number(value));

/**
 * Loads up to REPLAY.limit of the key's calls and Guard action checks in the window, oldest first, from the same scope its
 * rulebook covers (the key and the session keys it created). Selects only; the caller runs it in a read-only transaction.
 */
export async function loadReplay(db: Db | Tx, keyHash: string, opts: { days: number; now: Date; actions: boolean }): Promise<ReplayInput> {
  const to = opts.now, from = new Date(to.getTime() - opts.days * DAY);
  const scope: SQL = sql`(select key_hash from keys where key_hash = ${keyHash} union select key_hash from agent_sessions where parent_key_hash = ${keyHash})`;
  const limit = REPLAY.limit + 1;
  // A call's recorded intent (estimate, output limit, tools) and whether it ran after an approval come from the rulebook
  // events of the same request (agent_ledger_links); a call made with no rulebook has none.
  const calls = rowsOf<CallRow>(await db.execute(sql`select ${ms(sql`g.ts`)} ts, g.model_id, coalesce(g.receipt->>'lane', g.receipt_v2->>'lane') lane, g.cost::text cost, g.tokens_out, r.intent, r.approved, r.recorded
    from generations g
    left join agent_ledger_links gl on gl.generation_id = g.id
    left join lateral (
      select (array_agg(e.intent order by (e.intent->>'model' = g.model_id) desc nulls last, e.id) filter (where e.kind = 'decision' and e.intent->>'kind' = 'inference'))[1] intent,
        bool_or(e.kind = 'approval_used') approved, bool_or(e.kind = 'decision') recorded
      from agent_ledger_links el join agent_policy_events e on e.id = el.event_id
      where gl.request_id is not null and el.key_hash = gl.key_hash and el.request_id = gl.request_id
    ) r on true
    where g.key_hash in ${scope} and g.ts > ${iso(from)} and g.ts <= ${iso(to)}
    order by g.ts, g.id limit ${limit}`));
  const actions = opts.actions ? rowsOf<ActionRow>(await db.execute(sql`select ${ms(sql`created_at`)} created_at, action, target, amount_pico::text, details_sha256, decision, outcome_status, outcome_amount_pico::text
    from agent_action_decisions where key_hash in ${scope} and created_at > ${iso(from)} and created_at <= ${iso(to)}
    order by created_at, id limit ${limit}`)) : [];
  const items: ReplayItem[] = [
    ...calls.map((r): ReplayCall => ({
      kind: "call", ts: at(r.ts), model: r.model_id, lane: r.lane, cost_pico: BigInt(r.cost), tokens_out: Number(r.tokens_out),
      ...(r.intent?.est_cost_pico !== undefined ? { est_cost_pico: BigInt(r.intent.est_cost_pico) } : {}),
      ...(typeof r.intent?.max_output_tokens === "number" ? { max_output_tokens: r.intent.max_output_tokens } : {}),
      ...(Array.isArray(r.intent?.tools) ? { tools: r.intent.tools } : {}),
      actual: r.approved ? "approval_required" : r.recorded ? "allow" : null,
    })),
    ...actions.map((r): ReplayAction => ({
      kind: "action", ts: at(r.created_at), action: r.action, ...(r.target === null ? {} : { target: r.target }), amount_pico: BigInt(r.amount_pico),
      ...(r.details_sha256 === null ? {} : { details_sha256: r.details_sha256 }), outcome: r.outcome_status, outcome_pico: r.outcome_amount_pico === null ? null : BigInt(r.outcome_amount_pico), actual: r.decision,
    })),
  ].sort((a, b) => a.ts.getTime() - b.ts.getTime() || (a.kind === b.kind ? 0 : a.kind === "call" ? -1 : 1));
  // Before the window: charges for the rolling week, admitted model calls for the rolling hour, allowed actions for the
  // rolling day. Grouped by minute, each at its latest time, so a busy week stays a bounded read.
  const spend = rowsOf<{ ts: number | string; pico: string }>(await db.execute(sql`select ${ms(sql`max(created_at)`)} ts, sum(-amount)::text pico from ledger
    where key_hash in ${scope} and amount < 0 and kind in ('usage', 'tool_call') and created_at > ${iso(new Date(from.getTime() - WEEK))} and created_at <= ${iso(from)}
    group by date_trunc('minute', created_at) order by 1`));
  const admitted = rowsOf<{ ts: number | string; n: number }>(await db.execute(sql`select ${ms(sql`max(ts)`)} ts, count(*)::int n from agent_policy_events
    where ts > ${iso(new Date(from.getTime() - HOUR))} and ts <= ${iso(from)} and (
      (key_hash = ${keyHash} and kind = 'decision' and decision = 'allow' and intent->>'kind' = 'inference')
      or (key_hash in ${scope} and kind = 'approval_used' and coalesce(intent->>'kind', '') <> 'action'))
    group by date_trunc('minute', ts) order by 1`));
  const allowed = opts.actions ? rowsOf<{ ts: number | string; pico: string; n: number }>(await db.execute(sql`select ${ms(sql`max(created_at)`)} ts, coalesce(sum(coalesce(outcome_amount_pico, amount_pico)) filter (where outcome_status is null or outcome_status = 'executed'), 0)::text pico, count(*)::int n
    from agent_action_decisions where key_hash in ${scope} and decision = 'allow' and created_at > ${iso(new Date(from.getTime() - DAY))} and created_at <= ${iso(from)}
    group by date_trunc('minute', created_at) order by 1`)) : [];
  const [refused] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int n from agent_policy_events
    where key_hash = ${keyHash} and kind = 'decision' and decision = 'deny' and intent->>'kind' = 'inference' and ts > ${iso(from)} and ts <= ${iso(to)}`));
  const inherited = (await policiesFor(db, keyHash)).filter(row => row.keyHash !== keyHash).length;
  return {
    from, to, days: opts.days, items: items.slice(0, REPLAY.limit), truncated: items.length > REPLAY.limit,
    seed: { spend: spend.map(r => ({ ts: at(r.ts), pico: BigInt(r.pico) })), calls: admitted.map(r => ({ ts: at(r.ts), n: Number(r.n) })), actions: allowed.map(r => ({ ts: at(r.ts), pico: BigInt(r.pico), n: Number(r.n) })) },
    refused: Number(refused?.n ?? 0), inherited,
  };
}

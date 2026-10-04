import { breakerReasons, breakerMessages, type BreakerReasonCode, type BreakerState } from "./breakers.ts";
import { autonomyMultiplier, spendingCapPico, type AutonomyState } from "./autonomy.ts";
import type { AgentIntent, AgentPolicy } from "./policy.ts";
import { usdToPico } from "../lib/money.ts";
/**
 * tools_spent_pico_day: paid tool spend over the rolling day (charged plus open tool holds), loaded when tools.daily_budget is set.
 * calls_hour: model calls the rulebook admitted in the rolling hour, loaded when approval.above_calls_per_hour is set (B).
 */
export type AgentPolicyState = { actions_pico_day?: bigint; actions_hour?: number; killed: boolean; spent_pico: { hour: bigint; day: bigint; week: bigint }; tools_spent_pico_day?: bigint; breakers?: BreakerState; autonomy?: AutonomyState; calls_hour?: number };
export type ReasonCode = BreakerReasonCode | "actions_not_configured" | "action_not_allowed" | "target_not_allowed" | "over_action_per_request" | "over_action_per_day" | "over_action_per_hour" | "approval_action_amount" | "killed" | "model_not_allowed" | "lane_not_allowed" | "over_per_request" | "over_per_hour" | "over_per_day" | "over_per_week" | "max_tokens" | "tool_not_allowed" | "tool_over_max_price" | "tool_over_daily_budget" | "outside_window" | "approval_required" | "approval_calls_per_hour";
export type AgentDecision = { decision: "allow" | "deny" | "approval_required"; reasons: { code: ReasonCode; message: string }[] };
const messages: Record<ReasonCode, string> = {
  ...breakerMessages,
  actions_not_configured: "The rulebook has no action rules.", action_not_allowed: "The action is outside the rulebook.", target_not_allowed: "The target is outside the rulebook.", over_action_per_request: "The action exceeds its amount cap.", over_action_per_day: "The rolling day action amount cap would be exceeded.", over_action_per_hour: "The rolling hour action count cap would be exceeded.", approval_action_amount: "This action amount requires owner approval.",
  killed: "This agent is killed.", model_not_allowed: "The model is outside the rulebook.", lane_not_allowed: "The lane is outside the rulebook.",
  over_per_request: "The request exceeds its cost cap.", over_per_hour: "The rolling hour cap would be exceeded.", over_per_day: "The rolling day cap would be exceeded.", over_per_week: "The rolling week cap would be exceeded.",
  max_tokens: "The output token cap would be exceeded.", tool_not_allowed: "A declared tool is outside the rulebook.",
  tool_over_max_price: "The paid tool's price exceeds the rulebook's per-call tool price.", tool_over_daily_budget: "The rolling day paid tool budget would be exceeded.", outside_window: "The request is outside the allowed UTC windows.", approval_required: "This cost requires principal approval.",
  approval_calls_per_hour: "The rolling hour has reached the rulebook's call count; further calls require principal approval.",
};
const modelMatches = (pattern: string, model: string) => pattern === model || (pattern.endsWith("/*") && model.startsWith(pattern.slice(0, -1)));
const permitted = <T,>(rules: { allow?: string[]; deny?: string[] }, value: T, matches: (a: string, b: T) => boolean) =>
  !rules.deny?.some(p => matches(p, value)) && (rules.allow === undefined || rules.allow.some(p => matches(p, value)));
const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
/**
 * v6 T: a paid tool pattern names its resource exactly (origin + path), a resource prefix ending in "*", its host, a
 * "*.example.com" host suffix, the seller's payTo wallet (any case) or the listing id.
 */
export function paidToolMatches(pattern: string, tool: { resource: string; seller: string; listing?: string }) {
  let host = "";
  try { host = new URL(tool.resource).hostname.toLowerCase(); } catch { /* the intent schema requires a URL */ }
  const p = pattern.trim();
  if (p === tool.resource || p === tool.listing || p.toLowerCase() === tool.seller.toLowerCase() || p.toLowerCase() === host) return true;
  if (p.startsWith("*.") && host.endsWith(p.slice(1).toLowerCase())) return true;
  return p.length > 1 && p.endsWith("*") && !p.startsWith("*") && tool.resource.startsWith(p.slice(0, -1));
}
/** Rolling money windows and UTC schedule evaluation depend only on the supplied state and time. */
export function evaluateAgentPolicy(policy: AgentPolicy, state: AgentPolicyState, intent: AgentIntent, now: Date): AgentDecision {
  const cost = intent.kind === "inference" ? intent.est_cost_pico : intent.kind === "paid_tool" ? intent.price_pico : 0n;
  const reasons: AgentDecision["reasons"] = breakerReasons(policy.breakers, state.breakers, state.killed, cost, intent.kind === "inference" ? intent.model : undefined);
  const add = (code: ReasonCode) => reasons.push({ code, message: messages[code] });
  if (state.killed) add("killed");
  if (intent.kind === "action") {
    const a = policy.actions;
    if (!a) add("actions_not_configured");
    else {
      if (!permitted(a, intent.action, (p, v) => p === v || (p.endsWith(".*") && v.startsWith(p.slice(0, -1))))) add("action_not_allowed");
      if (a.targets && ((intent.target === undefined && a.targets.allow !== undefined) || (intent.target !== undefined && !permitted(a.targets, intent.target, (p, v) => p.toLowerCase() === v.toLowerCase())))) add("target_not_allowed");
      if (a.per_action_usd !== undefined && intent.amount_pico > usdToPico(a.per_action_usd)) add("over_action_per_request");
      if (a.per_day_usd !== undefined) {
        if (state.actions_pico_day === undefined) throw new Error("Daily action state is required.");
        if (state.actions_pico_day + intent.amount_pico > usdToPico(a.per_day_usd)) add("over_action_per_day");
      }
      if (a.max_per_hour !== undefined) {
        if (state.actions_hour === undefined) throw new Error("Hourly action state is required.");
        if (state.actions_hour >= a.max_per_hour) add("over_action_per_hour");
      }
    }
  }
  if (intent.kind === "inference") {
    if (!permitted(policy.models, intent.model, modelMatches)) add("model_not_allowed");
    if (policy.lanes && !policy.lanes.includes(intent.lane)) add("lane_not_allowed");
  }
  if (intent.kind === "inference" || intent.kind === "paid_tool") {
    // Spending caps cover what a key pays for paid tools too: a tool call is money out of the same balance.
    const multiplier = autonomyMultiplier(policy, state.autonomy);
    if (policy.caps.per_request_usd !== undefined && cost > spendingCapPico(policy.caps.per_request_usd, multiplier)) add("over_per_request");
    for (const window of ["hour", "day", "week"] as const) {
      const cap = policy.caps[`per_${window}_usd`];
      if (cap !== undefined && state.spent_pico[window] + cost > spendingCapPico(cap, multiplier)) add(`over_per_${window}`);
    }
  }
  if (intent.kind === "inference") {
    if (policy.caps.max_output_tokens !== undefined && (intent.max_output_tokens === undefined || intent.max_output_tokens > policy.caps.max_output_tokens)) add("max_tokens");
  }
  if (intent.kind === "paid_tool" && policy.tools) {
    const t = policy.tools;
    if (!permitted(t, intent, paidToolMatches)) add("tool_not_allowed");
    if (t.max_price_per_call !== undefined && intent.price_pico > usdToPico(t.max_price_per_call)) add("tool_over_max_price");
    if (t.daily_budget !== undefined && (state.tools_spent_pico_day ?? 0n) + intent.price_pico > usdToPico(t.daily_budget)) add("tool_over_daily_budget");
  }
  const tools = intent.kind === "mcp_tool" ? [intent.name] : intent.kind === "inference" ? intent.tools : [];
  if (policy.tools && tools.some(t => !permitted(policy.tools!, t, (a, b) => a === b))) add("tool_not_allowed");
  if (policy.windows) {
    const day = now.getUTCDay(), at = now.getUTCHours() * 60 + now.getUTCMinutes();
    const inside = policy.windows.some(w => {
      const start = minute(w.start), end = minute(w.end);
      // Overnight windows belong to the UTC day on which they start. Equal endpoints mean an empty window.
      return start < end ? w.days.includes(day) && at >= start && at < end : start > end && ((w.days.includes(day) && at >= start) || (w.days.includes((day + 6) % 7) && at < end));
    });
    if (!inside) add("outside_window");
  }
  if (reasons.length) return { decision: "deny", reasons };
  if (intent.kind === "action" && policy.actions?.approval_above_usd !== undefined && intent.amount_pico > usdToPico(policy.actions.approval_above_usd)) { add("approval_action_amount"); return { decision: "approval_required", reasons }; }
  if ((intent.kind === "inference" || intent.kind === "paid_tool") && policy.approval) {
    if (cost > usdToPico(policy.approval.above_usd)) add("approval_required");
    // B: the call count asks first for model calls only.
    const calls = policy.approval.above_calls_per_hour;
    if (intent.kind === "inference" && calls !== undefined) {
      if (state.calls_hour === undefined) throw new Error("Hourly call state is required for a rulebook with approval.above_calls_per_hour.");
      if (state.calls_hour >= calls) add("approval_calls_per_hour");
    }
    if (reasons.length) return { decision: "approval_required", reasons };
  }
  return { decision: "allow", reasons };
}

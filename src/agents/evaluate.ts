import type { AgentIntent, AgentPolicy } from "./policy.ts";
import { usdToPico } from "../lib/money.ts";
export type AgentPolicyState = { killed: boolean; spent_pico: { hour: bigint; day: bigint; week: bigint } };
export type ReasonCode = "killed" | "model_not_allowed" | "lane_not_allowed" | "over_per_request" | "over_per_hour" | "over_per_day" | "over_per_week" | "max_tokens" | "tool_not_allowed" | "outside_window" | "approval_required";
export type AgentDecision = { decision: "allow" | "deny" | "approval_required"; reasons: { code: ReasonCode; message: string }[] };
const messages: Record<ReasonCode, string> = {
  killed: "This agent is killed.", model_not_allowed: "The model is outside the rulebook.", lane_not_allowed: "The lane is outside the rulebook.",
  over_per_request: "The request exceeds its cost cap.", over_per_hour: "The rolling hour cap would be exceeded.", over_per_day: "The rolling day cap would be exceeded.", over_per_week: "The rolling week cap would be exceeded.",
  max_tokens: "The output token cap would be exceeded.", tool_not_allowed: "A declared tool is outside the rulebook.", outside_window: "The request is outside the allowed UTC windows.", approval_required: "This cost requires principal approval.",
};
const modelMatches = (pattern: string, model: string) => pattern === model || (pattern.endsWith("/*") && model.startsWith(pattern.slice(0, -1)));
const permitted = (rules: { allow?: string[]; deny?: string[] }, value: string, matches: (a: string, b: string) => boolean) =>
  !rules.deny?.some(p => matches(p, value)) && (rules.allow === undefined || rules.allow.some(p => matches(p, value)));
const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
/** Rolling money windows and UTC schedule evaluation depend only on the supplied state and time. */
export function evaluateAgentPolicy(policy: AgentPolicy, state: AgentPolicyState, intent: AgentIntent, now: Date): AgentDecision {
  const reasons: AgentDecision["reasons"] = [];
  const add = (code: ReasonCode) => reasons.push({ code, message: messages[code] });
  if (state.killed) add("killed");
  if (intent.kind === "inference") {
    if (!permitted(policy.models, intent.model, modelMatches)) add("model_not_allowed");
    if (policy.lanes && !policy.lanes.includes(intent.lane)) add("lane_not_allowed");
    const cost = intent.est_cost_pico;
    if (policy.caps.per_request_usd !== undefined && cost > usdToPico(policy.caps.per_request_usd)) add("over_per_request");
    for (const window of ["hour", "day", "week"] as const) {
      const cap = policy.caps[`per_${window}_usd`];
      if (cap !== undefined && state.spent_pico[window] + cost > usdToPico(cap)) add(`over_per_${window}`);
    }
    if (policy.caps.max_output_tokens !== undefined && (intent.max_output_tokens === undefined || intent.max_output_tokens > policy.caps.max_output_tokens)) add("max_tokens");
  }
  const tools = intent.kind === "mcp_tool" ? [intent.name] : intent.tools;
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
  if (intent.kind === "inference" && policy.approval && intent.est_cost_pico > usdToPico(policy.approval.above_usd)) {
    add("approval_required"); return { decision: "approval_required", reasons };
  }
  return { decision: "allow", reasons };
}

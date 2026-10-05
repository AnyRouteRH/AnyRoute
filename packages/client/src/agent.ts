import type { Fetch } from "./types.js";
import { requestError } from "./agent-errors.js";

export type AgentLane = "public" | "attested" | "unlinkable";
/** The lane for a request that names none: "standard" (the default), "proven_first" (attested when available) or "proven_only" (attested, or refused). */
export type AgentRouteDefault = "standard" | "proven_first" | "proven_only";
export type AgentPolicy = {
  version: 1;
  models: { allow?: string[]; deny?: string[] };
  lanes?: AgentLane[];
  route_default?: AgentRouteDefault;
  caps: { per_request_usd?: number; per_hour_usd?: number; per_day_usd?: number; per_week_usd?: number; max_output_tokens?: number };
  tools?: { allow?: string[]; deny?: string[] };
  windows?: { days: (0 | 1 | 2 | 3 | 4 | 5 | 6)[]; start: string; end: string }[];
  approval?: { above_usd: number; above_calls_per_hour?: number };
  breakers?: { max_spend_usd_per_minute?: number; max_requests_per_minute?: number; max_denials_per_10min?: number; max_distinct_models_per_hour?: number };
  alerts?: { at_percent?: number[]; denials_in_10min?: number; channels?: ("webhook" | "email" | "telegram")[] };
  agreements?: { max_escrow_usd?: number; counterparties_allow?: string[] };
  on_breach: "deny" | "kill";
};
/** Prompt-free wire intent. Costs are decimal strings in pico USD (10^12 per USD). */
export type AgentIntent = { kind: "inference"; model: string; lane: AgentLane; est_cost_pico: string; max_output_tokens?: number; tools: string[] } | { kind: "mcp_tool"; name: string };
export type AgentReason = { code: `breaker:${"max_spend_usd_per_minute" | "max_requests_per_minute" | "max_denials_per_10min" | "max_distinct_models_per_hour"}` | "killed" | "model_not_allowed" | "lane_not_allowed" | "over_per_request" | "over_per_hour" | "over_per_day" | "over_per_week" | "max_tokens" | "tool_not_allowed" | "outside_window" | "approval_required" | "approval_calls_per_hour"; message: string };
export type AgentDecision = { decision: "allow" | "deny" | "approval_required"; reasons: AgentReason[] };
export type AgentRemaining = { hour: number | null; day: number | null; week: number | null };
/** One replayed call or Guard action. `actual` is the decision recorded at the time; null when the call ran with no rulebook decision. */
export type AgentReplayExample = { time: string; kind: "call" | "action"; model: string | null; lane: string | null; action: string | null; cost_usd: number; decision: AgentDecision["decision"]; reason: { code: string; message: string } | null; actual: AgentDecision["decision"] | null };
/** What a draft rulebook would have done with a key's recorded activity. `notes` says what the record cannot tell. */
export type AgentReplay = {
  window: { from: string; to: string; days: number }; evaluated: number; allowed: number; denied: number; asked: number;
  stopped_at?: string; stopped_reason?: string; by_reason: Record<string, number>;
  actual: { allowed: number; denied: number; asked: number; not_recorded: number }; changed: number;
  examples: AgentReplayExample[]; truncated: boolean; notes: string[];
};
export type AgentRulebook = { key_hash: string; name: string | null; policy: AgentPolicy | null; sha256: string | null; killed: boolean; remaining: AgentRemaining; policies: { key_hash: string; inherited: boolean; policy: AgentPolicy; sha256: string; version: number; killed: boolean; killed_at: string | null; killed_reason: string | null; spent: { hour: number; day: number; week: number }; remaining: AgentRemaining }[] };

export function agentClient(baseUrl: string, fetcher: Fetch, headers: () => Record<string, string>) {
  const request = async <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await fetcher(`${baseUrl}/api/v1/agents/${path}`, { method: body ? "POST" : "GET", headers: { accept: "application/json", "content-type": "application/json", ...headers() }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
    const json = await res.json().catch(() => null) as { data: T; error?: { message?: string; type?: string; metadata?: unknown } } | null;
    if (!res.ok || !json) throw requestError(json?.error?.message ?? `agent request failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
    return json.data;
  };
  return {
    /** Read own and inherited rules even when killed. */
    rules: (signal?: AbortSignal) => request<AgentRulebook>("me", undefined, signal),
    /** Check before expensive calls. Never retry a denial unchanged. A dry run reserves no budget. */
    check: (intent: AgentIntent, signal?: AbortSignal) => request<AgentDecision>("check", intent, signal),
    /**
     * Replay a draft rulebook on a key's last `days` (1 to 7, default 7) of recorded calls and Agent Guard checks, before
     * saving it. Read only: nothing is saved, charged or changed. Needs the same permissions as setting that key's rulebook.
     */
    replay: (keyHash: string, policy: AgentPolicy, options: { days?: number; signal?: AbortSignal } = {}) =>
      request<AgentReplay>(`${encodeURIComponent(keyHash)}/replay`, { policy, ...(options.days === undefined ? {} : { days: options.days }) }, options.signal),
  };
}

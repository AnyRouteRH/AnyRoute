import type { Fetch } from "./types.js";
import { requestError } from "./agent-errors.js";

export type AgentLane = "public" | "attested" | "unlinkable";
export type AgentPolicy = {
  version: 1;
  models: { allow?: string[]; deny?: string[] };
  lanes?: AgentLane[];
  caps: { per_request_usd?: number; per_hour_usd?: number; per_day_usd?: number; per_week_usd?: number; max_output_tokens?: number };
  tools?: { allow?: string[]; deny?: string[] };
  windows?: { days: (0 | 1 | 2 | 3 | 4 | 5 | 6)[]; start: string; end: string }[];
  approval?: { above_usd: number };
  breakers?: { max_spend_usd_per_minute?: number; max_requests_per_minute?: number; max_denials_per_10min?: number; max_distinct_models_per_hour?: number };
  on_breach: "deny" | "kill";
};
/** Prompt-free wire intent. Costs are decimal strings in pico USD (10^12 per USD). */
export type AgentIntent = { kind: "inference"; model: string; lane: AgentLane; est_cost_pico: string; max_output_tokens?: number; tools: string[] } | { kind: "mcp_tool"; name: string };
export type AgentReason = { code: `breaker:${"max_spend_usd_per_minute" | "max_requests_per_minute" | "max_denials_per_10min" | "max_distinct_models_per_hour"}` | "killed" | "model_not_allowed" | "lane_not_allowed" | "over_per_request" | "over_per_hour" | "over_per_day" | "over_per_week" | "max_tokens" | "tool_not_allowed" | "outside_window" | "approval_required"; message: string };
export type AgentDecision = { decision: "allow" | "deny" | "approval_required"; reasons: AgentReason[] };
export type AgentRemaining = { hour: number | null; day: number | null; week: number | null };
export type AgentRulebook = { key_hash: string; name: string | null; policy: AgentPolicy | null; sha256: string | null; killed: boolean; remaining: AgentRemaining; policies: { key_hash: string; inherited: boolean; policy: AgentPolicy; sha256: string; version: number; killed: boolean; killed_at: string | null; killed_reason: string | null; spent: { hour: number; day: number; week: number }; remaining: AgentRemaining }[] };

export function agentClient(baseUrl: string, fetcher: Fetch, headers: () => Record<string, string>) {
  const request = async <T>(path: string, intent?: AgentIntent, signal?: AbortSignal): Promise<T> => {
    const res = await fetcher(`${baseUrl}/api/v1/agents/${path}`, { method: intent ? "POST" : "GET", headers: { accept: "application/json", "content-type": "application/json", ...headers() }, ...(intent ? { body: JSON.stringify(intent) } : {}), signal });
    const json = await res.json().catch(() => null) as { data: T; error?: { message?: string; type?: string; metadata?: unknown } } | null;
    if (!res.ok || !json) throw requestError(json?.error?.message ?? `agent request failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
    return json.data;
  };
  return {
    /** Read own and inherited rules even when killed. */
    rules: (signal?: AbortSignal) => request<AgentRulebook>("me", undefined, signal),
    /** Check before expensive calls. Never retry a denial unchanged. A dry run reserves no budget. */
    check: (intent: AgentIntent, signal?: AbortSignal) => request<AgentDecision>("check", intent, signal),
  };
}

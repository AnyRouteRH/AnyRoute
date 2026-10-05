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

/** Pay another agent: a public profile id or a 0x wallet, a decimal USD amount (USDG, up to 6 decimals), an optional memo digest, and the approval id once an owner approved. */
export type AgentPayInput = { to: string; amount_usd: string; memo_sha256?: `sha256:${string}`; approval_id?: string };
export type AgentSignedDecision = { payload: Record<string, unknown>; alg: "Ed25519"; key_id: string; sig: string };
/** What the paying wallet sends: an unsigned USDG transfer. Anyroute never signs, sends or holds it. */
export type AgentPayInstructions = {
  decision_id: string; status: "awaiting_transfer"; chain_id: number; chain_name: string; rpc_url: string; explorer_url: string;
  token: { symbol: "USDG"; address: string; decimals: 6 }; to: string; recipient: { wallet: string; profile_id: string | null };
  amount: string; amount_units: string; reference: string; from: string[]; warning?: string;
  transfer_call: { to: string; data: string; value: "0x0" }; confirm: string; custody: string;
};
/** Agent Guard's answer, plus payment instructions on allow. Approval fields are present on approval_required. */
export type AgentPayDecision = {
  decision: "allow" | "deny" | "approval_required"; reasons: { code: string; message: string }[]; decision_id: string; policy_sha256: string;
  approval_id?: string; expires_at?: string; poll?: string; signed: AgentSignedDecision; payment?: AgentPayInstructions;
};
export type AgentPaymentStatus = "awaiting_transfer" | "seen" | "final" | "reversed";
/** A confirmed payment. `receipt` verifies at POST /api/v1/receipts/verify with { payload, sig, key_id }. */
export type AgentPayment = {
  decision_id: string; status: AgentPaymentStatus; status_text: string; status_at: string; recipient: { wallet: string; profile_id: string | null };
  amount: string; amount_units: string; paid: string | null; tx_hash: string | null; block_number: string | null; payer_wallet: string | null; verified_at: string | null; reason?: string;
  receipt: { payload: Record<string, unknown>; alg: "Ed25519"; key_id: string; sig: string; verify: string } | null;
};

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

    /** Ask the rulebook before paying another agent (Agent Guard action pay.agent). On allow, send `payment.transfer_call` from your own wallet. */
    pay: (input: AgentPayInput, signal?: AbortSignal) => request<AgentPayDecision>("pay", input, signal),
    /** Confirm with the transaction hash. Returns the payment and its signed receipt; call again to read seen, final or reversed. */
    confirmPay: (decisionId: string, txHash: string, signal?: AbortSignal) => request<AgentPayment>(`pay/${encodeURIComponent(decisionId)}/confirm`, { tx_hash: txHash }, signal),
  };
}

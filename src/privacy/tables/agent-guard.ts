import type { TableDoc } from "../types.ts";
export const guardTables: Record<string, TableDoc> = {
  agent_action_decisions: {
    category: "keys", request: "yes", purpose: "Action checks, reported outcomes and rolling action limits for the deciding agent key, separate from model spend.",
    retention: "Rows remain until operator deletion. Rolling day and hour limits read only the preceding 24 hours and hour; those windows do not delete records.",
    notes: ["Action and target labels remain readable, including symbols, recipient wallet addresses or hosts supplied by the agent. Do not send secrets or request text in these labels. Only a SHA-256 digest of order details is accepted; full orders are not accepted here.", "Unreported allowed actions count their requested amount. Executed outcomes count the agent-reported amount; skipped and failed outcomes release the daily amount. All allowed checks still count toward the hourly count. These records do not prove execution or control brokerage or wallet keys."],
    columns: {
      id: "Random URL-safe decision identifier, not an authentication credential.", key_hash: "Hash of the deciding API key; only that key can report an outcome.", event_id: "Identifier of the aggregate action decision on the existing agent event hash chain; events have their own retention.",
      action: "Caller-chosen bounded action name such as trade.order or transfer.send.", target: "Optional caller-chosen symbol, recipient wallet address or host label, stored verbatim; this is not the caller's network address.", amount_pico: "Requested action amount in integer pico-USD; an unreported allow holds this amount against the daily action limit.", details_sha256: "Optional SHA-256 digest of canonical order JSON; order details themselves are not stored.",
      decision: "allow, deny or approval_required from the rulebooks checked at decision time.", created_at: "When the decision was recorded.", outcome_status: "Null before reporting; executed, skipped or failed afterward, accepted once only for an allowed action.", outcome_amount_pico: "Optional agent-reported actual pico-USD amount, required for executed; it may exceed the allowed amount and is not verified against a brokerage or chain.", outcome_at: "When the deciding key reported its outcome, or null before reporting.",
    },
  },
};

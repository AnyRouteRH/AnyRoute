import type { TableDoc } from "../types.ts";
import { rv } from "./common.ts";
export const agentTables: Record<string, TableDoc> = {
  agent_policies: {
    category: "keys", purpose: "The principal's current agent rulebook and kill state, enforced by the router for requests through AnyRoute.", request: "no",
    retention: "Until the principal removes the rulebook. Updating a rulebook replaces its current specification and preserves kill state.",
    notes: ["Model and tool identifiers and a kill reason are user-supplied text. Shape and size checks cannot judge the meaning a principal assigns to these labels. No prompt or answer fields are accepted."],
    columns: {
      key_hash: "The API key this rulebook governs.", version: "Rulebook schema version, currently 1.",
      spec: { purpose: "Strict bounded rulebook: model and tool allow/deny names, lanes, cost and output caps, UTC windows, approval threshold and breach action.", review: rv(["type:json"], "config", "A strict schema excludes prompt and answer fields. Model and tool labels are owner-written identifiers of at most 160 characters; their contents are whatever the owner chooses to write.") },
      sha256: "SHA-256 of the canonical rulebook JSON.", killed: "Whether the router refuses the next request under this rulebook.", killed_at: "When the rulebook was killed, if it is killed.", killed_reason: "A principal-supplied reason of at most 160 characters, or fixed policy reason codes for an automatic kill.", updated_at: "When the policy or kill state last changed.", updated_by: "The principal key hash or the agent key hash for an automatic kill.",
    },
  },
  agent_policy_events: {
    category: "keys", purpose: "A per-key hash chain of rulebook decisions and policy, kill and resume changes. Decisions contain routing metadata, never prompts or answers.", request: "yes",
    retention: "90 days; the agent-policy-retention worker removes older events hourly when AGENT_POLICY_ENABLED is on and the worker runs this job. With the flag off or the worker absent, deletion waits. A retained suffix starts with its prior hash as a checkpoint.",
    columns: {
      id: "Monotonically allocated event identifier for pagination.", key_hash: "The key whose rulebook was evaluated or changed; parent decisions are recorded under the parent key.", ts: "When the event was recorded, at millisecond precision.", kind: "decision, policy_set, killed, resumed, approval_requested, approval_approved, approval_denied or approval_used. Approval events are recorded under the requesting key. Removing a rulebook records policy_set with a null intent.", decision: "allow, deny or approval_required for a decision; null for changes.",
      reasons: { purpose: "Fixed reason codes and router-written messages; policy change events carry an empty list.", review: rv(["type:json"], "no-request-content", "Only evaluator-defined codes and constant messages are stored. No request text or principal-written kill reason is copied into this field.") },
      intent: { purpose: "Inference model, lane, estimated pico-USD cost, maximum output tokens and declared tool names; or an MCP tool name. Approval events may contain an intents array for the full model set. Null for policy changes.", review: rv(["type:json"], "config", "Explicit metadata projection excludes messages, tool arguments, descriptions and answers. Model and tool identifiers are readable labels from the request or catalogue; a caller can choose what a declared tool name means.") },
      policy_sha256: "Digest of the evaluated or changed rulebook.", prev_hash: "The previous retained chain head, or 64 zeros when no preceding event remains.", hash: "SHA-256 of prior hash bytes and canonical event fields excluding id, prev_hash and hash.",
    },
  },
};

import type { TableDoc } from "../types.ts";
import { rv } from "./common.ts";
export const agentTables: Record<string, TableDoc> = {
  agent_policies: {
    category: "keys", purpose: "The principal's current agent rulebook and kill state, enforced by the router for requests through AnyRoute.", request: "no",
    retention: "Until the principal removes the rulebook. Updating a rulebook replaces its current specification and preserves kill state.",
    notes: ["Model and tool identifiers and a kill reason are user-supplied text. Shape and size checks cannot judge the meaning a principal assigns to these labels. Action rules retain owner-chosen action names and target allow/deny labels, including recipient wallets or hosts; amount limits are separate from model caps. No prompt or answer fields are accepted."],
    columns: {
      key_hash: "The API key this rulebook governs.", version: "Rulebook schema version, currently 1.",
      spec: { purpose: "Optional agreements.max_escrow_usd and counterparties_allow restrict preparation through the router; they do not enforce transactions sent elsewhere. Strict bounded rulebook: model and tool allow/deny names, lanes, an optional default privacy route (route_default) for requests that name no lane, cost and output caps, UTC windows, approval threshold, optional spend/request/denial/distinct-model circuit breakers and breach action, plus optional action and target allow/deny lists, separate action amount and count caps and an action approval threshold.", review: rv(["type:json"], "config", "A strict schema excludes prompt and answer fields. Model and tool labels are owner-written identifiers of at most 160 characters; their contents are whatever the owner chooses to write.") },
      sha256: "SHA-256 of the canonical rulebook JSON.", killed: "Whether the router refuses the next request under this rulebook.", killed_at: "When the rulebook was killed, if it is killed.", killed_reason: "A principal-supplied reason of at most 160 characters, or fixed policy reason codes for an automatic kill, including breaker:<field> for circuit breakers.", updated_at: "When the policy or kill state last changed.", updated_by: "The principal key hash or the agent key hash for an automatic kill.", playbook_id: "The playbook this key follows, or null. While set, spec and sha256 hold a copy of that playbook's current rules, rewritten in the same transaction as every playbook change; stopping following keeps the copy as the key's own rulebook.",
    },
  },
  playbooks: {
    category: "keys", purpose: "Shared rulebooks (playbooks): one named rulebook that many keys of an account or team follow, so one change applies to all of them.", request: "no",
    retention: "Until a principal deletes the playbook. Deleting is refused while keys follow it unless they each keep its rules as their own.",
    notes: ["The rules are the same strict rulebook as agent_policies.spec and carry the same owner-written labels. The name is owner-written text of at most 100 characters. No prompt or answer fields are accepted."],
    columns: {
      id: "Random playbook identifier.", account_id: "The account that owns the playbook.", team_id: "The team whose owners and admins may change it, or null for an account-wide playbook that only management keys change.",
      name: "Owner-chosen name, unique within the account regardless of case.",
      spec: { purpose: "The playbook's current rulebook, validated by the same strict schema as a key's own rulebook.", review: rv(["type:json"], "config", "The strict rulebook schema excludes prompt and answer fields. Model, tool and action labels are owner-written identifiers of at most 160 characters; their contents are whatever the owner chooses to write.") },
      sha256: "SHA-256 of the canonical rulebook JSON, the same digest each following key's rulebook carries.", version: "Counts rule changes: 1 at creation, plus one for each change of rules. A rename keeps it.",
      created_at: "When the playbook was created.", updated_at: "When its name or rules last changed.", updated_by: "Hash of the principal key that made the last change.",
    },
  },
  playbook_changes: {
    category: "keys", purpose: "A record of every playbook change (create, update, rename, delete) with its version, digest, rules and the number of keys following it; changes to a team's playbooks also appear in the team inbox.", request: "no",
    retention: "Rows remain until operator deletion, including after the playbook is deleted.",
    columns: {
      id: "Monotonically allocated change identifier.", playbook_id: "The playbook changed; kept after the playbook is deleted.", account_id: "The owning account.", team_id: "The owning team, or null for an account-wide playbook.",
      name: "The playbook's name after this change.", action: "create, update (new rules and version), rename or delete.", version: "The playbook's version after this change.",
      sha256: "SHA-256 of the canonical rules after this change.",
      spec: { purpose: "The rules as of this change, so each recorded digest can be checked.", review: rv(["type:json"], "config", "A copy of a playbook's strict rulebook: owner-written configuration validated against a schema that excludes prompt and answer fields.") },
      followers: "How many keys followed the playbook when it changed.", actor: "Hash of the principal key that made the change.",
      notify: "Whether the change belongs to a team (a team playbook, or an account-wide one in an account with teams); updates marked so appear in the inbox of the team's owners and admins.",
      at: "When the change was recorded, at millisecond precision.",
    },
  },
  agent_policy_events: {
    category: "keys", purpose: "A per-key hash chain of rulebook decisions and policy, kill and resume changes. Decisions contain routing metadata, never prompts or answers.", request: "yes",
    retention: "90 days; the agent-policy-retention worker removes older events hourly when AGENT_POLICY_ENABLED is on and the worker runs this job. With the flag off or the worker absent, deletion waits. A retained suffix starts with its prior hash as a checkpoint.",
    columns: {
      id: "Monotonically allocated event identifier for pagination.", key_hash: "The key whose rulebook was evaluated or changed; parent decisions are recorded under the parent key.", ts: "When the event was recorded, at millisecond precision.", kind: "action_decision and action_outcome (readable action/target identifiers, order digest and reported amounts), decision, breaker_request (one observation per policy admission batch with breakers), policy_set, killed, resumed, approval_requested, approval_approved, approval_denied or approval_used. Approval events are recorded under the requesting key. Removing a rulebook records policy_set with a null intent.", decision: "allow, deny or approval_required for a decision; null for changes; breaker_request stores the batch decision.",
      reasons: { purpose: "Fixed reason codes and router-written messages; policy change events carry an empty list.", review: rv(["type:json"], "no-request-content", "Only evaluator-defined codes and constant messages are stored. No request text or principal-written kill reason is copied into this field.") },
      intent: { purpose: "Inference model, lane, estimated pico-USD cost, maximum output tokens and declared tool names; or an MCP tool name; action intents include a readable action and optional target (including recipient wallets or hosts), an amount and optional order digest, never full order details. Outcome events include the decision id, reported status and amount and whether it exceeded the requested amount. Approval and breaker_request events may contain an intents array for the full model set. Breaker counters read these routing identifiers and decisions; legacy decision events without a batch marker count individually. Resume resets breaker observations, leaving cap spend unchanged. Null for policy changes.", review: rv(["type:json"], "config", "Explicit metadata projection excludes messages, tool arguments, descriptions and answers. Model and tool identifiers are readable labels from the request or catalogue; a caller can choose what a declared tool name means.") },
      policy_sha256: "Digest of the evaluated or changed rulebook.", prev_hash: "The previous retained chain head, or 64 zeros when no preceding event remains.", hash: "SHA-256 of prior hash bytes and canonical event fields excluding id, prev_hash and hash.",
    },
  },
};

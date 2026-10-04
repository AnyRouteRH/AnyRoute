import type { TableDoc } from "../types.ts";
import { rv } from "./common.ts";
export const approvalTables: Record<string, TableDoc> = {
  agent_approvals: {
    category: "keys", purpose: "Principal approval of an agent's estimated inference spend or reported action amount, consumed once by the requesting key.", request: "yes",
    retention: "Approval validity defaults to 15 minutes (AGENT_APPROVAL_TTL_S). Pending and approved rows become expired on access or another approval evaluation. Rows remain until operator deletion; validity expiry does not delete records.",
    notes: ["No prompt or answer fields are stored. Model and declared tool names remain readable; callers choose these identifiers. The router still reads request text in memory on every lane. Action approvals store the action name, optional readable target (including wallet or host labels), optional order digest and amount, never full order details. Council and dual requests store the entire set of model intents with a shared total cost ceiling."],
    columns: {
      id: "Random URL-safe approval identifier, not an authentication credential.", key_hash: "The API or session key requesting this approval; approval cannot transfer to another key.",
      intent: { purpose: "Explicit projection of model, lane, declared tool names, output token limit and estimated pico-USD cost, or action name, target, order digest and pico-USD amount; a multi-model request stores an intents array.", review: rv(["type:json"], "config", "Only routing or action metadata is copied; action targets can be symbols, recipient wallets or hosts. messages, answers, tool arguments and descriptions are excluded. Declared model and tool identifiers are caller-chosen labels whose meaning cannot be inferred by shape checks.") },
      intent_hash: "SHA-256 of canonical projected intents including the estimated cost, used to reuse an identical pending approval.", max_cost_pico: "The original estimated pico-USD cost ceiling; retries may cost less but cannot exceed this amount.",
      status: "pending, approved, denied, expired or used. Only approved, unexpired approvals can be consumed.", requested_at: "When the approval was created.", decided_at: "When the principal approved or denied the request, or null.", decided_by: "The deciding principal's API key hash, or null before a decision.", expires_at: "The fixed validity deadline from request time; approval does not extend it.", used_at: "When the router consumed the approval after a successful spend reservation, on an allowed cache hit, or on an allowed action check.",
    },
  },
};

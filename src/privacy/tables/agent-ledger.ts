import { rv } from "./common.ts";
import type { TableDoc } from "../types.ts";
export const agentLedgerTables: Record<string, TableDoc> = {
  agent_ledger_links: {
    category: "keys", request: "yes",
    purpose: "Explicit correlation of rulebook decision events, requesting keys and generation identifiers for the agent activity ledger.",
    retention: "90 days; the agent-ledger-retention worker removes older links hourly when AGENT_POLICY_ENABLED is on. Deleting a linked event also removes that event's link. Generations retain their existing lifetime. With the flag off or worker absent, deletion waits.",
    notes: ["Only router-generated identifiers, timestamps and key hashes are stored. No prompt or answer text is added. A reservation link can precede a generation or remain without one after a provider failure. Existing records without correlation remain separate and are marked unlinked in the API. Parent policy events are attributed to the session key that made the request. The ledger describes policy evaluations and recorded generations through AnyRoute; errors before policy evaluation or generation creation have no ledger row."],
    columns: { id: "Allocated correlation identifier.", request_id: { purpose: "Router-generated request scope identifier; groups multiple models and inherited policy evaluations in one request.", review: rv(["name:content"], "no-request-content", "A random UUID is generated inside the router for correlation. It never includes a URL, body, prompt, answer, or any caller-supplied string.") }, key_hash: "The actual requesting API key or session key, rather than the parent policy key.", ts: "When the correlation was recorded, in UTC.", event_id: "The exact policy decision or approval-use event; null for generation links. Removed with its event.", generation_id: "The exact generation or reservation identifier; null for event links. A failed reservation or provider call need not produce a generation.", approval_id: "The approval identifier on a recorded approval-use event; otherwise null." },
  },
};

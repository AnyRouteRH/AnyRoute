// J176: an on-demand view, not a new store or request-content reader.
import type { ExternalDoc } from "./types.ts";
export const agentStatusView: ExternalDoc["otherStores"][number] = {
  id: "agent-status", name: "Agent status view", purpose: "Compose existing agent metadata for the authenticated policy audience.",
  holds: "No new durable data. Reads current and inherited agent_policies Stop/timed Stop and work_hours, unexpired agent_approvals counts for this key, the existing per-key runway ledger/autonomy readers, and existing quiet-agent-alert kv settings plus the quiet worker’s ledger and Guard activity including session keys. Guard stops are derived only from saved action-restriction reason codes. No new table, column, Redis family, log field, body reader or address reader. Ordinary inference request text is still read in router memory.",
  ttl: "Response uses no-store. The browser holds the current status in component memory until refreshed, disconnected or unmounted; nothing is written to browser storage. Existing source retention is unchanged.",
  requestText: "none", evidence: [{ file: "src/agents/status.ts", contains: "export async function readAgentStatus" }, { file: "src/api/agent-status.ts", contains: 'c.header("cache-control", "no-store")' }],
};

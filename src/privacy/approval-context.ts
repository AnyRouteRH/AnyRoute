// J185
import type { ExternalDoc } from "./types.ts";
export const approvalContextStores: ExternalDoc["otherStores"] = [{
  id: "approval-context", name: "Approval context summaries",
  purpose: "Help already authorized approvers decide with existing agent metadata.",
  holds: "No new storage, schema, Redis family, log field, address or request-body reader. Reads existing keys, ledger posted charges, current agent policies and autonomy, agent approvals requested since Monday UTC, retained duplicated events and key-rotation links. Builds optional approval_context lines in response memory for approval lists and inbox items the caller may decide; the same builder supplies linked Telegram approval messages and reminders. Telegram receives spend, caps, estimated spend if used, current work-hour status, weekly counts and duplicate or rotation notes when AGENT_APPROVAL_CONTEXT_ENABLED is enabled (default false), through existing notification preferences, quiet hours and approver guards. No prompts, tool arguments, source names or key hashes are added to the text.",
  ttl: "The summary is not saved by the router. Telegram retains delivered messages under its own policy. Existing source retention applies, including the 90-day agent-event pruning. Ordinary request text is still read by the router in memory.",
  requestText: "none", evidence: [{ file: "src/agents/approval-context.ts", contains: "export async function readApprovalContext" }],
}];

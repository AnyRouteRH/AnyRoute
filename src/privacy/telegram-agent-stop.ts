// G163: reuse described link authority, policy state and event stores.
import type { ExternalDoc } from "./types.ts";
export const telegramAgentStopReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/telegram/agent-stop.ts", carries: "settings",
  reads: "Private Telegram /agents, /stop and /start commands, user/chat identifiers, and inline callback action, complete key digest and link generation. Reads the existing link, current key role/team/scope and expiry, visible key names and Stop state, including inherited session policies for list status.",
  then: "Rechecks current linked owner/admin authority and account/team ownership under the existing link lock. Read-only, inference-only and session authority is refused. Uses the same changeKill operation and security context as web Stop/Resume, under the existing account lock. Telegram receives short agent names, current status, UTC deadlines, confirmation text and digest/generation callback identifiers. Commands and replies are readable by Telegram and subject to its retention policies.",
  kept: "No new table, column, Redis family, log field or button-state record. Uses the existing telegram-link callback limiter counter (20 commands or button presses per minute per Telegram user). Stop changes existing agent_policies killed/kill_until/killed_at/killed_reason/updated_at/updated_by fields, and appends existing hash-chained agent_policy_events and existing alert/security records with their existing retention and notification preferences. Raw command text is not copied to storage. No inference prompt, API key secret or wallet address is read by these commands.",
  evidence: [{ file: "src/telegram/agent-stop.ts", contains: "const link = await readLink(tx, uid);" },
    { file: "src/telegram/agent-stop.ts", contains: "await securityContext.run(scoped, () => changeKill" }],
};

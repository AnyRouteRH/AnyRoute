import type { ExternalDoc, TableDoc } from "./types.ts";

export function describeWeeklySummary(docs: Record<string, TableDoc>) {
  docs.kv!.columns.weekly_summary_opted_in = "Nullable opt-in flag on telegram-link rows only. True enables a weekly Telegram summary for this link; false or empty means off. Deleted with the link on either unlink path. No request text or new tracking.";
  docs.accounts!.columns.last_sent_week = "Nullable previous ISO week identifier (YYYY-Www) last successfully sent as a weekly Telegram summary. Overwritten after delivery; retained with the account, including after unlink, to avoid sending that week again after relinking. No message text.";
  docs.kv!.notes!.push("Weekly summaries read existing agent call charges, key names, model names, approval statuses and stop events for the previous Monday–Sunday UTC. They send readable totals and names to Telegram, which can read them. The first eligible opted-in link receives one summary per account, restricted to that principal's current team if it is not a management key. Empty weeks are skipped. The existing link-action rate counter also limits summary attempts to twenty per minute per Telegram user; no message text is copied into Redis. The account's last_sent_week prevents ordinary repeat and concurrent sends. A crash or ambiguous network failure after Telegram accepts a send but before the database commits can repeat delivery.");
}
export const weeklySummaryReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/api/weekly-summary.ts", carries: "settings",
  reads: "An authenticated owner/admin's strict opted_in boolean for this key's Telegram link.",
  then: "Rechecks current link authority under the same lock as unlink and delivery. Writes the preference only for the caller's link.",
  kept: "Only the nullable weekly_summary_opted_in flag in kv; the worker keeps last_sent_week on the existing account. No prompt or answer text, new address reader or new tracking.",
  evidence: [{ file: "src/api/weekly-summary.ts", contains: "preferenceBody.parse(await readJson(c))" }],
};

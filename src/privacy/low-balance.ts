import type { ExternalDoc, TableDoc } from "./types.ts";
export function describeLowBalance(docs: Record<string, TableDoc>) {
  Object.assign(docs.accounts.columns, {
    low_balance_pico: "Optional owner-selected low-balance threshold in pico-USD; null disables alerts. Kept until changed or cleared.",
    low_balance_alerted: "Whether the current threshold crossing has been recorded. Re-armed only after a worker observes settled balance above the threshold; false by default.",
  });
  docs.low_balance_alerts = {
    category: "billing", request: "aggregate", purpose: "One durable inbox item per observed low-balance crossing, claimed together with the account alert flag.",
    retention: "No automatic deletion. Earlier crossings remain after the balance recovers or the setting changes.",
    columns: { id: "Random alert identifier.", account_id: "Billing account whose balance crossed its threshold.", balance_pico: "Settled balance at the crossing check, in pico-USD; not reduced by open holds.", threshold_pico: "Owner-selected threshold at the crossing check, in pico-USD.", created_at: "When the worker recorded the crossing." },
    notes: ["With LOW_BALANCE_ALERTS_ENABLED, the worker checks every five minutes. Authorized linked Telegram accounts receive balance, threshold and an Add funds link through the existing Telegram delivery path. The inbox claim is committed before a single send attempt; failures are not retried. No message body or Telegram delivery result is retained here. No new Redis key family or log field is added. Runway uses seven days of posted usage and paid-tool debits, scoped like credits, and stores no report."],
  };
}
export const lowBalanceReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/api/account-runway.ts", carries: "settings", reads: "One nullable numeric low_balance_usd threshold between zero and one million dollars.",
  then: "Authenticates an active owner key, excludes session and inference-only keys, and accepts edits only when LOW_BALANCE_ALERTS_ENABLED is on.",
  kept: "Threshold in accounts.low_balance_pico and the crossing claim in accounts.low_balance_alerted. Each observed crossing keeps balance and threshold snapshots in low_balance_alerts. No prompt, answer or caller network address is read.",
  evidence: [{ file: "src/api/account-runway.ts", contains: "setting.parse(await readJson(c))" }],
};

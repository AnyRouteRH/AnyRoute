// K188: the same readers and sections, with empty daily lines omitted.
import type { WeekSummary } from "./weekly-summary-text.ts";
import type { SummaryPeriod } from "./summary-schedule.ts";
const money = (pico: bigint) => {
  const cents = (pico + 5_000_000_000n) / 10_000_000_000n;
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};
const label = (value: string) => Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")).slice(0, 80).join("");
export function dailySummaryText(period: SummaryPeriod, summary: WeekSummary, siteUrl: string) {
  return [
    `Anyroute: your day (${period.start.toLocaleDateString("en-US", { timeZone: period.timeZone ?? "UTC", month: "short", day: "numeric" })})`,
    ...(summary.spent > 0n ? [`Spent: ${money(summary.spent)} across ${summary.agents} ${summary.agents === 1 ? "agent" : "agents"}`] : []),
    ...(summary.topKeys.length ? [summary.topKeys.slice(0, 5).map(k => `${label(k.name)} ${money(k.spent)}`).join(" · ")] : []),
    ...(summary.approvals ? [`Approvals: ${summary.approvals} (${summary.approved} approved, ${summary.denied} denied)`] : []),
    ...(summary.stops ? [`Stops: ${summary.stops}`] : []),
    ...(summary.topModel ? [`Top model: ${label(summary.topModel)}`] : []),
    ...(summary.sections ?? []).slice(0, 5).map(s => s.text),
    `Activity: ${siteUrl.replace(/\/$/, "")}/dashboard/#activity`,
  ].join("\n");
}

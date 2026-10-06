const DAY = 86_400_000;
/** The previous ISO week, Monday inclusive to Monday exclusive, always in UTC. */
export function previousIsoWeek(now: Date) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - (end.getUTCDay() + 6) % 7);
  const start = new Date(end.getTime() - 7 * DAY);
  const thursday = new Date(start.getTime() + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return { start, end, id: `${year}-W${String(week).padStart(2, "0")}` };
}
export type WeekSummary = {
  activity: number; spent: bigint; agents: number; topKeys: { name: string; spent: bigint }[];
  approvals: number; approved: number; denied: number; stops: number; topModel: string | null;
};
export function summaryDue(now: Date) { return now.getUTCDay() === 1 && now.getUTCHours() >= 9; }
const dayLabel = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const money = (pico: bigint) => {
  const cents = (pico + 5_000_000_000n) / 10_000_000_000n;
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};
// Labels are owner-selected settings. Keep them on one line and within Telegram's text limit.
const label = (name: string) => Array.from(name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")).slice(0, 80).join("");
export function weeklySummaryText(week: ReturnType<typeof previousIsoWeek>, summary: WeekSummary, siteUrl: string) {
  const lines = [
    `Anyroute: your week (${dayLabel(week.start)} – ${dayLabel(new Date(week.end.getTime() - DAY))})`,
    `Spent: ${money(summary.spent)} across ${summary.agents} ${summary.agents === 1 ? "agent" : "agents"}`,
    ...(summary.topKeys.length ? [summary.topKeys.slice(0, 5).map(k => `${label(k.name)} ${money(k.spent)}`).join(" · ")] : []),
    `Approvals: ${summary.approvals} (${summary.approved} approved, ${summary.denied} denied) · Stops: ${summary.stops}`,
    `Top model: ${summary.topModel ? label(summary.topModel) : "No model calls"}`,
    `Activity: ${siteUrl.replace(/\/$/, "")}/dashboard/#activity`,
  ];
  return lines.join("\n");
}

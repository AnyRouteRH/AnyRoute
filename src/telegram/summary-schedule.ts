// K188: account schedule in the existing notification preference value; no new key family.
import { z } from "zod";
import { previousIsoWeek } from "./weekly-summary-text.ts";

export const summaryScheduleBody = z.strictObject({
  cadence: z.enum(["weekly", "daily"]),
  hour: z.number().int().min(0).max(23),
  time_zone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Choose a valid time zone."),
});
export type SummarySchedule = z.infer<typeof summaryScheduleBody>;
export const DEFAULT_SUMMARY_SCHEDULE: SummarySchedule = { cadence: "weekly", hour: 9, time_zone: "UTC" };
export type SummaryPeriod = ReturnType<typeof previousIsoWeek> & { cadence?: SummarySchedule["cadence"]; timeZone?: string };
const formatters = new Map<string, Intl.DateTimeFormat>();
function local(now: Date, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
const shift = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
// Find the first instant of the local date, including zones whose midnight is skipped by DST.
export function startOfSummaryDay(date: string, zone: string) {
  let low = Date.parse(date) - 36 * 3_600_000, high = Date.parse(date) + 36 * 3_600_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (local(new Date(middle), zone).date < date) low = middle + 1; else high = middle;
  }
  return new Date(low);
}
/** Worker retries only on the scheduled local date. Inbox retains the latest due period. */
export function summaryPeriod(now: Date, schedule = DEFAULT_SUMMARY_SCHEDULE, latest = false): SummaryPeriod | null {
  const clock = local(now, schedule.time_zone);
  let date = clock.date;
  const weekday = new Date(date).getUTCDay();
  if (!latest && (clock.hour < schedule.hour || (schedule.cadence === "weekly" && weekday !== 1))) return null;
  if (latest && clock.hour < schedule.hour) date = shift(date, -1);
  if (schedule.cadence === "weekly") date = shift(date, -((new Date(date).getUTCDay() + 6) % 7));
  const startDate = shift(date, schedule.cadence === "daily" ? -1 : -7);
  return {
    start: startOfSummaryDay(startDate, schedule.time_zone), end: startOfSummaryDay(date, schedule.time_zone),
    id: schedule.cadence === "daily" ? startDate : previousIsoWeek(new Date(`${date}T12:00:00Z`)).id,
    cadence: schedule.cadence, timeZone: schedule.time_zone,
  };
}

// Retain both monotonic period claims in the existing account column across cadence switches.
// Legacy weekly-only values stay byte-identical until the first daily delivery.
export function summaryClaims(saved: string | null) {
  const [weekly, daily] = (saved ?? "").split("|");
  return { weekly: /^\d{4}-W\d{2}$/.test(weekly ?? "") ? weekly! : "", daily: /^\d{4}-\d{2}-\d{2}$/.test(daily ?? "") ? daily! : "" };
}
export function summaryClaimed(saved: string | null, period: SummaryPeriod) {
  const claims = summaryClaims(saved);
  return (period.cadence === "daily" ? claims.daily : claims.weekly) >= period.id;
}
export function claimSummary(saved: string | null, period: SummaryPeriod) {
  const claims = summaryClaims(saved);
  if (period.cadence === "daily") claims.daily = period.id; else claims.weekly = period.id;
  return claims.daily ? `${claims.weekly}|${claims.daily}` : claims.weekly;
}

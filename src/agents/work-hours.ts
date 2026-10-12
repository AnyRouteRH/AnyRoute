// G161: owner-selected wall-clock hours; no timers, new storage or request readers.
import { z } from "zod";

export const validWorkTimeZone = (value: string) => {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
};
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const workHoursSchema = z.strictObject({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length, "Choose each day once."),
  start: clock, end: clock,
  time_zone: z.string().min(1).max(100).refine(validWorkTimeZone, "Choose a valid IANA time zone."),
  outside: z.enum(["refuse", "ask_first"]),
}).refine(hours => hours.start !== hours.end, "Start and end must differ.");
export type WorkHours = z.infer<typeof workHoursSchema>;
const minute = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatter = (hours: WorkHours) => new Intl.DateTimeFormat("en-US", { timeZone: hours.time_zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function inside(hours: WorkHours, date: Date, format: Intl.DateTimeFormat) {
  const parts = format.formatToParts(date);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const day = weekdays.indexOf(part("weekday")), at = Number(part("hour")) * 60 + Number(part("minute"));
  const start = minute(hours.start), end = minute(hours.end);
  // Overnight hours belong to their starting day. Repeated DST minutes are both allowed;
  // skipped minutes do not exist. Start is included and end is excluded.
  return start < end ? hours.days.includes(day) && at >= start && at < end
    : (hours.days.includes(day) && at >= start) || (hours.days.includes((day + 6) % 7) && at < end);
}
// Replays evaluate the same immutable hours object chronologically. Reuse the next opening
// within an already searched closed interval; nothing is persisted or shared across policies.
const openings = new WeakMap<WorkHours, { from: number; next: number }>();
export function workHoursCheck(hours: WorkHours, now: Date): { inside: boolean; next?: Date } {
  const format = formatter(hours);
  if (inside(hours, now, format)) return { inside: true };
  const t = now.getTime(), saved = openings.get(hours);
  if (saved && t >= saved.from && t < saved.next) return { inside: false, next: new Date(saved.next) };
  // Search actual instants, rather than inventing UTC offsets. Fifteen days covers a
  // weekly window lost to a DST jump or a skipped civil date, followed by the next week.
  const first = Math.floor(t / 60_000) * 60_000 + 60_000;
  for (let at = first; at <= t + 15 * 86_400_000; at += 60_000) {
    if (inside(hours, new Date(at), format)) {
      openings.set(hours, { from: t, next: at });
      return { inside: false, next: new Date(at) };
    }
  }
  return { inside: false };
}
export function workHoursReason(hours: WorkHours, now: Date) {
  const checked = workHoursCheck(hours, now);
  if (checked.inside) return undefined;
  const next = checked.next ? ` Next work hours begin ${new Intl.DateTimeFormat("en-US", { timeZone: hours.time_zone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(checked.next)} (${hours.time_zone}; ${checked.next.toISOString()}).` : " No opening was found in the next fifteen days.";
  return { code: hours.outside === "refuse" ? "outside_work_hours" as const : "approval_work_hours" as const, message: `This request is outside the agent’s work hours.${hours.outside === "ask_first" ? " Ask for approval to run it now." : ""}${next}` };
}

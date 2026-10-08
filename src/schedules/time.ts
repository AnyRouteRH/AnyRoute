export type Cadence = "hourly" | "daily" | "monday";
/** Strictly after the supplied instant; UTC boundaries do not depend on DST or the server timezone. */
export function nextDue(cadence: Cadence, time: string | null, after: Date): Date {
  const next = new Date(after);
  if (cadence === "hourly") { next.setUTCMinutes(0, 0, 0); next.setUTCHours(next.getUTCHours() + 1); return next; }
  if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Choose a UTC time.");
  const [hour, minute] = time.split(":").map(Number);
  next.setUTCHours(hour, minute, 0, 0);
  if (cadence === "monday") next.setUTCDate(next.getUTCDate() + (8 - next.getUTCDay()) % 7);
  if (next <= after) next.setUTCDate(next.getUTCDate() + (cadence === "monday" ? 7 : 1));
  return next;
}

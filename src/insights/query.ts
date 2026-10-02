import { z } from "zod";
import { fail } from "../lib/errors.ts";
const day = 86_400_000;
// Millisecond precision prevents a range just over 92 days slipping through rounding.
const instant = z.string().datetime({ offset: true }).refine(v => !/\.\d{4}/.test(v));
export function insightsQuery(input: Record<string, string>, now = new Date()) {
  const to = instant.parse(input.to ?? now.toISOString());
  const from = instant.parse(input.from ?? new Date(Date.parse(to) - 30 * day).toISOString());
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > 92 * day) fail(400, "Choose a range of at most 92 days; from must be before to.", "invalid_request");
  return { from, to, bucket: z.enum(["day", "week"]).parse(input.bucket ?? "day") };
}
export type InsightsQuery = ReturnType<typeof insightsQuery>;

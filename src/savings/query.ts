import { ApiError } from "../lib/errors.ts";
export function savingsQuery(query: Record<string, string>, now = new Date()) {
  const days = query.days ?? "30";
  if (!/^(?:[1-9]|[12][0-9]|30)$/.test(days)) throw new ApiError(400, "Choose 1 to 30 days.", "invalid_request");
  return { days: Number(days), from: new Date(now.getTime() - Number(days) * 86400000).toISOString(), to: now.toISOString() };
}

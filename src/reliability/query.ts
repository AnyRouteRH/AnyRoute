import { ApiError } from "../lib/errors.ts";
export function reliabilityQuery(query: Record<string, string>, now = new Date()) {
  const days = query.days ?? "7";
  if (!/^[1-7]$/.test(days)) throw new ApiError(400, "Choose 1 to 7 days.", "invalid_request");
  return { days: Number(days), from: new Date(now.getTime() - Number(days) * 86400000).toISOString(), to: now.toISOString() };
}

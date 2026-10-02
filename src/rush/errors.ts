import { fail } from "../lib/errors.ts";
import { OUTAGE_REASON } from "../router/disclosure.ts";

export function refuseCreditExhaustion(attempts: { error_kind?: string }[]) {
  if (attempts.some(a => a.error_kind === "insufficient_credits")) fail(503, "Providers are temporarily unavailable. Nothing was charged.", "providers_unavailable");
}
export function refuseCreditOutage(enabled: boolean, excluded: { reason: string }[]) {
  if (enabled && excluded.some(e => e.reason === OUTAGE_REASON)) fail(503, "Providers are temporarily unavailable.", "providers_unavailable");
}

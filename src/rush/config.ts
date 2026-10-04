import { z } from "zod";

const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false);
export const rushEnv = {
  UPSTREAM_MONITOR_ENABLED: flag,
  CATALOG_CACHE_ENABLED: flag,
  UPSTREAM_BALANCE_WARN_USD: z.coerce.number().finite().nonnegative().default(25),
  UPSTREAM_BALANCE_EXHAUSTED_USD: z.coerce.number().finite().nonnegative().default(0),
  UPSTREAM_BALANCE_CRITICAL_USD: z.coerce.number().finite().nonnegative().default(5),
  // Full https URL of the upstream account's documented balance endpoint; only that exact origin receives the credential. Unset: no polling.
  UPSTREAM_BALANCE_URL: z.string().url().optional(),
};

export function rushSettings(e: z.infer<z.ZodObject<typeof rushEnv>>) {
  if (e.UPSTREAM_BALANCE_CRITICAL_USD > e.UPSTREAM_BALANCE_WARN_USD) throw new Error("Upstream critical balance must not exceed warning balance.");
  if (e.UPSTREAM_BALANCE_EXHAUSTED_USD > e.UPSTREAM_BALANCE_CRITICAL_USD) throw new Error("Upstream exhausted balance must not exceed critical balance.");
  return { exhaustedUsd: e.UPSTREAM_BALANCE_EXHAUSTED_USD, enabled: e.UPSTREAM_MONITOR_ENABLED, catalogCache: e.CATALOG_CACHE_ENABLED, warnUsd: e.UPSTREAM_BALANCE_WARN_USD, criticalUsd: e.UPSTREAM_BALANCE_CRITICAL_USD, balanceUrl: e.UPSTREAM_BALANCE_URL };
}

import { z } from "zod";
const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const bytes = (value: number) => z.coerce.number().int().min(1024).max(64 * 1024 * 1024).default(value);
export const hardeningEnv = {
  REQUEST_MAX_BYTES: bytes(1024 * 1024), MCP_MAX_BYTES: bytes(256 * 1024),
  ANON_RATE_PER_MIN: z.coerce.number().int().min(1).max(100000).default(120),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(16).default(1),
  ORIGIN_LOCK_ENABLED: flag.default(false), ORIGIN_LOCK_SECRET: z.string().optional(),
};
export function hardeningSettings(e: z.infer<z.ZodObject<typeof hardeningEnv>>) {
  if (e.ORIGIN_LOCK_ENABLED && (!e.ORIGIN_LOCK_SECRET || e.ORIGIN_LOCK_SECRET.length < 32)) throw new Error("ORIGIN_LOCK_SECRET must contain at least 32 characters when ORIGIN_LOCK_ENABLED is on.");
  return { requestMaxBytes: e.REQUEST_MAX_BYTES, mcpMaxBytes: e.MCP_MAX_BYTES, anonRatePerMin: e.ANON_RATE_PER_MIN, trustProxyHops: e.TRUST_PROXY_HOPS, originLockEnabled: e.ORIGIN_LOCK_ENABLED, originLockSecret: e.ORIGIN_LOCK_SECRET };
}
export type Hardening = ReturnType<typeof hardeningSettings>;

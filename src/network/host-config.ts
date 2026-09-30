import { z } from "zod";

export const networkHostsEnv = {
  NETWORK_HOSTS_ENABLED: z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false),
  NETWORK_PROBATION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
};

export function networkHostsSettings(e: z.infer<z.ZodObject<typeof networkHostsEnv>> & { NETWORK_POLICY_ENABLED: boolean; TLOG_ENABLED: boolean; REDIS_URL?: string; ATTESTATION_VERIFIERS: string; TDX_VERIFIER_URL?: string; DSTACK_VERIFIER_URL?: string }, production: boolean) {
  if (e.NETWORK_HOSTS_ENABLED) {
    if (!e.NETWORK_POLICY_ENABLED || !e.TLOG_ENABLED) throw new Error("NETWORK_HOSTS_ENABLED requires NETWORK_POLICY_ENABLED and TLOG_ENABLED.");
    if (production && !e.REDIS_URL) throw new Error("NETWORK_HOSTS_ENABLED requires REDIS_URL in production for wallet replay protection and signup limits.");
    if (production && e.ATTESTATION_VERIFIERS.split(",").map(v => v.trim()).includes("dcap") && !e.TDX_VERIFIER_URL?.startsWith("https://")) throw new Error("NETWORK_HOSTS_ENABLED requires an HTTPS TDX_VERIFIER_URL when using dcap in production.");
    if (production && e.ATTESTATION_VERIFIERS.split(",").map(v => v.trim()).includes("dstack") && !e.DSTACK_VERIFIER_URL?.startsWith("https://")) throw new Error("NETWORK_HOSTS_ENABLED requires an HTTPS DSTACK_VERIFIER_URL in production.");
  }
  return { enabled: e.NETWORK_HOSTS_ENABLED, probationDays: e.NETWORK_PROBATION_DAYS };
}

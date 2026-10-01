import { z } from "zod";
export const sealedEnv = { AGENT_SEALED_ENABLED: z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false) };
export function guardSealed(e: { AGENT_SEALED_ENABLED: boolean; AGENT_POLICY_ENABLED: boolean; ATTESTATION_VERIFIERS: string; DSTACK_VERIFIER_URL?: string; PHALA_VERIFIER_URL?: string }) {
  if (!e.AGENT_SEALED_ENABLED) return;
  if (!e.AGENT_POLICY_ENABLED) throw new Error("AGENT_SEALED_ENABLED requires AGENT_POLICY_ENABLED.");
  const names = e.ATTESTATION_VERIFIERS.split(",").map(s => s.trim());
  if (!(names.includes("dstack") && e.DSTACK_VERIFIER_URL || names.includes("phala") && e.PHALA_VERIFIER_URL)) throw new Error("Sealed agents require a configured dstack or phala verifier to recover the measured compose hash.");
}

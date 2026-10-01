import { z } from "zod";
import { canonicalJson, sha256 } from "../../lib/util.ts";
export const SEALED_VERSION = "anyroute.agent-sidecar/1";
export const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const sealedBindingsSchema = z.strictObject({
  type: z.literal("anyroute.sealed-agent/1"), agent_image_digest: digest, compose_hash: digest,
  agent_key_hash: z.string().regex(/^[0-9a-f]{64}$/), sidecar_version: z.literal(SEALED_VERSION),
  tls_spki_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SealedBindings = z.infer<typeof sealedBindingsSchema>;
export function sealedReportData(bindings: SealedBindings, nonce: string) {
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("Invalid nonce.");
  return sha256(canonicalJson(bindings)) + nonce;
}
export const registrationSchema = z.strictObject({
  attestation_url: z.string().url().max(2048).refine(s => { const u = new URL(s); return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search && u.pathname === "/attest"; }, "Use an HTTPS /attest URL without credentials, query or fragment."),
  agent_image_digest: digest, compose_hash: digest,
});
export type SealedRegistration = z.infer<typeof registrationSchema>;

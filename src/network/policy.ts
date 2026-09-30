import { z } from "zod";
import { hostOfferSchema } from "./offers.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const name = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
const pins = z.array(digest).min(1).max(128);
export const hostPolicySchema = z.strictObject({
  version: z.number().int().positive().max(2147483647),
  issued_at: z.iso.datetime(),
  tee_kinds: z.array(z.enum(["tdx", "snp", "nvidia-cc"])).min(1).max(3),
  sidecar: z.strictObject({ image_digests: pins, source_hashes: pins }),
  engines: z.array(z.strictObject({ name, image_digest: digest })).min(1).max(128),
  models: z.array(z.strictObject({ id: name, model_digest: digest, min_gpu_cc: z.boolean(), offer: hostOfferSchema.optional() })).min(1).max(128),
  rules: z.strictObject({ require_gpu_cc_for: z.array(name).max(128), allow_dev: z.literal(false) }),
}).superRefine((p, ctx) => {
  const ids = p.models.map((m) => m.id);
  for (const id of p.rules.require_gpu_cc_for) if (!ids.includes(id)) ctx.addIssue({ code: "custom", message: `GPU CC rule names an unknown model: ${id}` });
  for (const [label, values] of [["TEE kinds", p.tee_kinds], ["sidecar images", p.sidecar.image_digests], ["source hashes", p.sidecar.source_hashes], ["engines", p.engines.map((e) => e.name)], ["models", ids], ["GPU CC rules", p.rules.require_gpu_cc_for]] as const)
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", message: `Duplicate ${label}.` });
});
export type HostPolicy = z.infer<typeof hostPolicySchema>;

/** Arrays retain their order; object keys are sorted, UTF-8, without whitespace or a trailing newline. */
export const policyJson = (policy: HostPolicy): string => canonicalJson(hostPolicySchema.parse(policy));
export const policyHash = (policy: HostPolicy): string => sha256(policyJson(policy));

/** The caller must obtain these flags from verification, never from a host's self-report.
 * image_digest, compose_hash and model_digest are the existing quote-bound sidecar fields.
 * source_hash, engines and model IDs require additional quote-bound fields; today's sidecar lacks them.
 * gpu_cc_verified means nonce-bound GPU evidence passed the GPU verifier, not just that CC was claimed.
 */
export type HostPolicyBindings = {
  tee_kind: string;
  hardware_verified: boolean;
  bindings_committed: boolean;
  dev?: boolean;
  simulated?: boolean;
  gpu_cc_verified?: boolean;
  bindings: {
    image_digest?: string;
    compose_hash?: string;
    source_hash?: string;
    model_id?: string;
    model_digest?: string;
    models?: { id: string; model_digest: string }[];
    engines?: { name: string; image_digest: string }[];
    dev?: boolean;
  };
};
const bindingSchema = z.object({
  tee_kind: z.string(), hardware_verified: z.boolean(), bindings_committed: z.boolean(),
  dev: z.boolean().optional(), simulated: z.boolean().optional(), gpu_cc_verified: z.boolean().optional(),
  bindings: z.object({
    image_digest: z.string().optional(), compose_hash: z.string().optional(), source_hash: z.string().optional(),
    model_id: z.string().optional(), model_digest: z.string().optional(), dev: z.boolean().optional(),
    models: z.array(z.object({ id: z.string(), model_digest: z.string() })).max(128).optional(),
    engines: z.array(z.object({ name: z.string(), image_digest: z.string() })).max(128).optional(),
  }),
});
const pin = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = /^(?:sha256:|0x)?([0-9a-fA-F]{64})$/.exec(v);
  return m ? `sha256:${m[1].toLowerCase()}` : null;
};

/** Pure comparison only: this does not verify quotes or change provider admission. Fails closed. */
export function checkHostAgainstPolicy(host: HostPolicyBindings, policy: HostPolicy): { ok: boolean; reasons: string[] } {
  const parsed = hostPolicySchema.safeParse(policy);
  if (!parsed.success) return { ok: false, reasons: ["The host policy is invalid."] };
  if (!bindingSchema.safeParse(host).success) return { ok: false, reasons: ["The verified host bindings are invalid or missing."] };
  const p = parsed.data;
  const reasons: string[] = [];
  const b = host?.bindings ?? {};
  if (host?.dev === true || host?.simulated === true || b.dev === true || host?.tee_kind === "dev") reasons.push("Development evidence is never accepted for a network host.");
  if (host?.hardware_verified !== true) reasons.push("Hardware attestation has not been verified.");
  if (host?.bindings_committed !== true) reasons.push("Host bindings have not been verified as committed to the hardware quote.");
  if (!(p.tee_kinds as string[]).includes(host?.tee_kind)) reasons.push("The host's TEE kind is not approved by this policy.");
  if (!p.sidecar.image_digests.includes(pin(b.image_digest) ?? "")) reasons.push("The sidecar image digest is missing or off-policy.");
  if (!p.sidecar.source_hashes.includes(pin(b.source_hash) ?? "")) reasons.push("The quote-bound sidecar source hash is missing or off-policy.");
  if (!pin(b.compose_hash)) reasons.push("The quote-bound compose hash is missing or invalid.");
  if (!Array.isArray(b.engines) || !b.engines.length) reasons.push("No quote-bound engine image is available.");
  else for (const e of b.engines) {
    if (!p.engines.some((allowed) => allowed.name === e.name && allowed.image_digest === pin(e.image_digest))) reasons.push(`Engine ${e.name} has an unapproved name or image digest.`);
  }
  const models = [...(b.models ?? []), ...(b.model_digest ? [{ id: b.model_id ?? "", model_digest: b.model_digest }] : [])];
  if (!Array.isArray(models) || !models.length) reasons.push("No quote-bound model digest is available.");
  else for (const m of models) {
    const allowed = p.models.find((a) => a.id === m.id && a.model_digest === pin(m.model_digest));
    if (!allowed) reasons.push(`Model ${m.id || "(unnamed)"} has an unknown model ID or digest.`);
    else if ((allowed.min_gpu_cc || p.rules.require_gpu_cc_for.includes(m.id)) && host.gpu_cc_verified !== true) reasons.push(`Model ${m.id} requires verified GPU confidential-computing evidence.`);
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

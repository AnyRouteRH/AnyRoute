import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { providers } from "../db/schema.ts";
import type { Config } from "../config.ts";
import type { HostPolicy, HostPolicyBindings } from "./policy.ts";

// Plain positive USD-per-token decimals. Bound precision and magnitude before registry conversion.
const price = z.string().min(1).max(32).regex(/^\d+(?:\.\d+)?$/).refine(v => Number(v) > 0 && Number(v) <= 1_000_000, "Price must be positive and at most 1000000 USD per token.");
const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
const tokens = z.number().int().positive().max(2147483647);
export const hostOfferSchema = z.strictObject({
  slug: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1).max(160),
  hugging_face_id: identifier.optional(),
  context_length: tokens,
  max_completion_tokens: tokens,
  quantization: z.string().min(1).max(32).regex(/^[A-Za-z0-9._+-]+$/).optional(),
  pricing: z.strictObject({ prompt: price, completion: price }),
});

/** Only called after signature and quote-policy verification. Never derive terms from a host listing. */
export function admittedModels(evidence: HostPolicyBindings, policy: HostPolicy, requested: string[]) {
  const bound = [...(evidence.bindings.models ?? []), ...(evidence.bindings.model_id && evidence.bindings.model_digest ? [{ id: evidence.bindings.model_id, model_digest: evidence.bindings.model_digest }] : [])];
  const digest = (value: string) => value.replace(/^(sha256:|0x)/, "").toLowerCase();
  return policy.models.filter(m => requested.includes(m.id) && m.offer && bound.some(b => b.id === m.id && digest(b.model_digest) === digest(m.model_digest))).map(m => {
    const { slug, ...terms } = m.offer!;
    return { id: m.id, anyroute: { slug }, ...terms, input_modalities: ["text"], output_modalities: ["text"] };
  });
}

type Settings = { networkHosts?: Pick<Config["networkHosts"], "enabled"> };
export const probationDiscovery = (cfg: Settings, p: { networkHost?: boolean; status: string }) => cfg.networkHosts?.enabled === true && p.networkHost === true && p.status === "probation";
export const probationRegistryFilter = (cfg: Settings) => cfg.networkHosts?.enabled === true ? and(eq(providers.networkHost, true), eq(providers.status, "probation")) : undefined;

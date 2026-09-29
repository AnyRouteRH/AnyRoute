import { z } from "zod";
import { picoToUsdString, usdToPico } from "../lib/money.ts";

// Some upstream catalogues publish USD per million tokens, unlike the OpenRouter provider spec.
// Keep conversion in integer money units and round upward only at pico precision.
const rate = z.number().nonnegative().max(1_000_000_000);
const pricing = z.object({
  type: z.literal("per_token"),
  currency: z.literal("USD"),
  input_per_1M_tokens: rate,
  output_per_1M_tokens: rate,
});
const perToken = (value: number) => picoToUsdString((usdToPico(value) + 999_999n) / 1_000_000n);

/** A catalogue priced per million tokens (typed per_token pricing with input/output per 1M), detected from its shape. */
export function isPerMillionCatalogue(json: unknown): boolean {
  const data = (json as { data?: unknown } | null)?.data;
  return Array.isArray(data) && data.some((item) => {
    const p = (item as { pricing?: Record<string, unknown> } | null)?.pricing;
    return !!p && typeof p === "object" && ("input_per_1M_tokens" in p || "output_per_1M_tokens" in p);
  });
}

/** Normalize only the public chat entries of a per-million catalogue; private (end-to-end encrypted) models need a proxy. */
export function normalizePerMillionCatalogue(json: unknown): unknown {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return json; // The shared parser reports a malformed envelope.
  return { data: data.flatMap((item) => {
    if (!item || typeof item !== "object") return [item];
    if (item.type !== "chat" || item.privacyLevel === "e2e" || String(item.id).startsWith("private/")) return [];
    const parsed = pricing.safeParse(item.pricing);
    // Missing/invalid prices must fail validation, never become free offers.
    if (!parsed.success) return [{ id: item.id }];
    return [{
      id: item.id,
      name: item.name,
      context_length: item.context_length,
      max_completion_tokens: item.max_completion_tokens,
      input_modalities: item.architecture?.input_modalities,
      output_modalities: item.architecture?.output_modalities,
      supported_parameters: item.supported_parameters,
      ...(Number.isSafeInteger(item.created_at) && item.created_at >= 0
        ? { created: Math.floor(item.created_at / 1000) } : {}),
      pricing: {
        prompt: perToken(parsed.data.input_per_1M_tokens),
        completion: perToken(parsed.data.output_per_1M_tokens),
      },
    }];
  }) };
}

import type { KeyRow } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";

/** Inspect model identifiers only, after per-key aliases and before account lookups. */
export function guardInferenceModels(key: KeyRow | null, body: Record<string, unknown>) {
  if (key?.scope !== "inference") return;
  const models = [body.model, ...(Array.isArray(body.models) ? body.models : [])];
  if (models.some((model) => typeof model === "string" && model.startsWith("@")))
    fail(403, "Inference-only keys must use catalog models, not saved account routes, presets or characters.", "inference_only");
}

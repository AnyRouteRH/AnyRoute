import type { ExternalDoc } from "./types.ts";
export const provisioningBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/provisioning/scope.ts",
  carries: "settings",
  reads: "A strict scope setting: inference or account. Authorization and x-api-key credentials are hashed in memory for route restrictions; receipt identifiers are checked against generation ownership.",
  then: "Requires a management key for account defaults; refuses inference-only keys on every route outside the model-call and own-generation/receipt allow-list. Newly minted child keys inherit the default, including sessions and team sign-ins.",
  kept: "A boolean in accounts.inference_keys_default; keys.scope stores the issued scope and keys.include_byok_in_limit stores the compatibility selection. Existing rows retain their access. No new request text, address readers, Redis families or log fields. Model calls still pass through existing routing and billing.",
  evidence: [{ file: "src/provisioning/scope.ts", contains: "defaultsSpec.parse(await readJson(c))" }],
};

export const inferenceModelReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/provisioning/inference.ts", carries: "settings",
  reads: "Only model and fallback-model identifiers from the already parsed inference request, after per-key aliases resolve. No prompt or answer text is inspected by this check.",
  then: "Refuses @ references for inference-only keys before chat reads account routes, presets or character records. Catalog model calls continue through unchanged billing.",
  kept: "Nothing additional: no model identifier, body, Redis family, log field or address is stored by this scope check.",
  evidence: [{ file: "src/provisioning/inference.ts", contains: "export function guardInferenceModels" }],
};

import type { ExternalDoc } from "./types.ts";
// B121: no new storage; this is a reader of the already-decoded chat request.
export const modelAlternativesReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/model-alternatives/suggest.ts", carries: "prompt-or-answer",
  reads: "Resolved request messages, content-part types, tool declarations, output modalities and token bounds in router memory, plus model metadata, current provider health and routing preferences.",
  then: "Checks the abilities needed by the request and ranks up to three currently eligible alternatives by estimated request cost. Reads message text to estimate token counts. Never forwards a suggestion request to a provider, switches a model or charges for suggestions.",
  kept: "No new database table or column, Redis family, log field or server-side store. Suggestions are unsigned error response metadata. Existing batch error outputs may retain them until their ordinary expiry. Chat keeps suggestions with the failed reply in active-tab memory only; its existing history snapshots omit failed replies and their suggestions from storage and exports; clicking a suggestion resends the same conversation through ordinary authorization, policy, lane and billing checks.",
  evidence: [{ file: "src/model-alternatives/suggest.ts", contains: "export function requiredAbilities" }, { file: "src/model-alternatives/suggest.ts", contains: "estimatePromptTokens(input.body)" }],
};

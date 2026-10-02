import type { ExternalDoc } from "./types.ts";
export const structuredOutputReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/structured-output/chat.ts", carries: "prompt-or-answer",
  reads: "Resolved chat messages and response_format schema, the final answer, and the opt-in anyroute.json_check setting when STRUCTURED_OUTPUT_CHECK_ENABLED is enabled.",
  then: "Reads request and answer text in router memory to check JSON and supported schema assertions. Repair may send the same provider and model one extra request containing the conversation, original answer, schema and validation errors. Each call passes the ordinary authorization, lane, agent and billing checks. Streams validate only.",
  kept: "No new database column, Redis family or log field. Both calls keep ordinary generation hashes, token counts, costs and signed receipts. Validation errors, JSON Pointer paths, combined charges and nested call receipts are unsigned response metadata, not written to generation receipts or returned by receipt lookup. Existing batch outputs can retain that metadata with the answer. Preset json_check settings live in the existing preset_versions.config JSON. Existing optional cache and batch retention rules still apply; non-streaming repair bypasses the response cache.",
  evidence: [{ file: "src/structured-output/chat.ts", contains: "export function captureStructuredOutput" }, { file: "src/structured-output/chat.ts", contains: "Return corrected JSON only" }],
};

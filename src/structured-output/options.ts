import { z } from "zod";
export const structuredOutputEnv = { STRUCTURED_OUTPUT_CHECK_ENABLED: z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false) };
export const structuredOutputOptions = z.strictObject({ json_check: z.enum(["validate", "repair"]) });
export type JsonCheckMode = "validate" | "repair";

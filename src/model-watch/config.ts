import { z } from "zod";
export const modelWatchEnv = { MODEL_WATCH_ENABLED: z.union([z.boolean(), z.enum(["true", "false"])]).default(false).transform(v => v === true || v === "true") };

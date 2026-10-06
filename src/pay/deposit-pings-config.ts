// B123
import { z } from "zod";
export const depositPingsEnv = { DEPOSIT_PINGS_ENABLED: z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false) };

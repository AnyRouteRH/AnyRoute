import { z } from "zod";
export const incidentNoticesEnv = {
  STATUS_INCIDENT_NOTICES_ENABLED: z.union([z.boolean(), z.enum(["true", "false"])]).default(false).transform(v => v === true || v === "true"),
};

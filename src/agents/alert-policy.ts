import { z } from "zod";
// Defaults are applied at use, never inserted into canonical existing rulebooks.
export const agentAlertsSchema = z.strictObject({
  at_percent: z.array(z.number().int().min(1).max(100)).max(64).optional(),
  denials_in_10min: z.number().int().min(1).max(10_000).optional(),
  channels: z.array(z.enum(["webhook", "email", "telegram"])).max(3).optional(),
});

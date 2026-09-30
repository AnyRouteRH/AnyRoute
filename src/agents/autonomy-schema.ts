import { z } from "zod";
const rung = z.strictObject({
  after_days: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  clean_requests: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  caps_multiplier: z.number().min(1).max(10),
});
export const autonomySchema = z.strictObject({
  rungs: z.array(rung).min(1).max(5),
  demote_on: z.array(z.enum(["deny", "kill", "breaker"])).max(3),
}).superRefine((value, ctx) => {
  value.rungs.forEach((r, i) => {
    const prev = value.rungs[i - 1];
    if (r.caps_multiplier <= (prev?.caps_multiplier ?? 1) || (prev && (r.after_days < prev.after_days || r.clean_requests < prev.clean_requests)))
      ctx.addIssue({ code: "custom", path: ["rungs", i], message: "Rungs must have ascending requirements and strictly increasing spending multipliers above 1." });
  });
});

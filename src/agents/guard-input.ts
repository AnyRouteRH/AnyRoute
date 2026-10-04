import { z } from "zod";
import { actionName } from "./policy.ts";
export const guardUsd = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
export const guardDecideInput = z.strictObject({ action: actionName, target: z.string().min(1).max(160).optional(), amount_usd: guardUsd, details_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(), approval_id: z.string().min(1).max(64).optional() });
export const guardOutcomeInput = z.strictObject({ status: z.enum(["executed", "skipped", "failed"]), amount_usd: guardUsd.optional() }).refine(v => v.status !== "executed" || v.amount_usd !== undefined, { message: "amount_usd is required for executed" });

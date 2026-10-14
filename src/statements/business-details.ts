import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { activityAccess } from "../activity/access.ts";
import { kv } from "../db/schema.ts";

const singleLine = (max: number) => z.string().trim().max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value), "Use a single line without control characters.").optional().default("");
export const businessDetailsBody = z.object({
  business_name: singleLine(160),
  address: z.string().transform(value => value.replace(/\r\n?/g, "\n").trim()).pipe(z.string().max(1000).refine(value => !/[\x00-\x09\x0b-\x1f\x7f]/.test(value), "Use address lines without control characters.")).optional().default(""),
  tax_id: singleLine(120),
  reference: singleLine(240).refine(value => !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value), "Leave email addresses out of the reference."),
}).strict();
export type BusinessDetails = z.infer<typeof businessDetailsBody>;
const storageKey = (accountId: string) => `business-details:${accountId}`;

export async function canEditBusinessDetails(ctx: Ctx, key: KeyRow) {
  return key.management && key.scope !== "read" && key.scope !== "inference" && !(await activityAccess(ctx, key)).session;
}
export async function readBusinessDetails(ctx: Ctx, accountId: string): Promise<BusinessDetails | null> {
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, storageKey(accountId)));
  return row ? businessDetailsBody.parse(row.value) : null;
}
export async function saveBusinessDetails(ctx: Ctx, accountId: string, value: BusinessDetails) {
  const key = storageKey(accountId);
  if (!Object.values(value).some(Boolean)) {
    await ctx.db.delete(kv).where(eq(kv.key, key));
    return null;
  }
  await ctx.db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  return value;
}

import { eq } from "drizzle-orm";
import { keys } from "../db/schema.ts";
// E153: members link only for delegated approvals; alerts and Stop retain management guards.
import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { requireKey } from "../api/auth.ts";
import { principal } from "../api/agents.ts";
import { approvableKeys, approvalIdentity, canApprove } from "../agents/approvers.ts";
import { fail } from "../lib/errors.ts";
export async function allowApproverLink(ctx: Ctx, key: KeyRow) {
  if (!ctx.cfg.agentTeamApproversEnabled) return false;
  const who = await approvalIdentity(ctx.db, key);
  if (["owner", "admin"].includes(who.role)) return true;
  return (await approvableKeys(ctx, key)).length > 0;
}
export async function telegramLinkCaller(ctx: Ctx, c: Context) {
  if (!ctx.cfg.agentTeamApproversEnabled) return principal(ctx, c);
  const key = await requireKey(ctx, c.req.header("authorization"));
  if (!await allowApproverLink(ctx, key)) fail(403, "Only owners, admins and allowed approvers may link Telegram.", "forbidden");
  return key;
}
export async function telegramCanApprove(ctx: Ctx, caller: KeyRow, hash: string) {
  if (!ctx.cfg.agentTeamApproversEnabled) return true;
  const [target] = await ctx.db.select().from(keys).where(eq(keys.keyHash, hash));
  return !!target && await canApprove(ctx.db, caller, target);
}

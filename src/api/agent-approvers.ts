// E153
import type { Context, Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { keys, kv } from "../db/schema.ts";
import { requireKey } from "./auth.ts";
import { ownedKey, principal } from "./agents.ts";
import { readJson } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { lockAccount } from "../agents/store.ts";
import { approvableKeys, approvalIdentity, approversKey, approversSchema, readApprovers, teamApproverChoices, validateMembers } from "../agents/approvers.ts";
import { recordSecurity, keyActor } from "../security-alerts/records.ts";
export async function approvalCaller(ctx: Ctx, c: Context) {
  if (!ctx.cfg.agentTeamApproversEnabled) return principal(ctx, c);
  const caller = await requireKey(ctx, c.req.header("authorization"));
  await approvalIdentity(ctx.db, caller);
  return caller;
}
export async function visibleApprovalKeys(ctx: Ctx, caller: Awaited<ReturnType<typeof principal>>) {
  if (ctx.cfg.agentTeamApproversEnabled) return (await approvableKeys(ctx, caller)).map(k => ({ hash: k.keyHash }));
  return ctx.db.select({ hash: keys.keyHash }).from(keys).where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!)));
}
export function agentApproversRoutes(app: Hono, ctx: Ctx) {
  for (const method of ["get", "put"] as const) app[method]("/api/v1/agents/:key_hash/approvers", async c => {
    if (!ctx.cfg.agentTeamApproversEnabled || !ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    c.header("Cache-Control", "no-store");
    const caller = await principal(ctx, c);
    const target = await ownedKey(ctx, caller, c.req.param("key_hash"));
    if (method === "get") return c.json({ data: { ...await readApprovers(ctx.db, target.keyHash), members: await teamApproverChoices(ctx.db, target) } });
    const settings = approversSchema.parse(await readJson(c));
    const data = await ctx.db.transaction(async tx => {
      await lockAccount(tx, caller.accountId);
      const scoped = { ...ctx, db: tx as unknown as Db };
      const live = await principal(scoped, c);
      const who = await approvalIdentity(tx, live);
      if (!["owner", "admin"].includes(who.role)) fail(403, "Only owners and admins may choose approvers.", "forbidden");
      const key = await ownedKey(scoped, live, target.keyHash);
      const members = await validateMembers(tx, key, settings);
      await tx.insert(kv).values({ key: approversKey(key.keyHash), value: settings }).onConflictDoUpdate({ target: kv.key, set: { value: settings, updatedAt: new Date() } });
      await recordSecurity(ctx, tx, key.accountId, key.teamId, `Approvers changed for key ${keyActor(key.name).slice(7)} ${keyActor(live.name)}`);
      return { ...settings, configured: true, members };
    });
    return c.json({ data });
  });
}
export async function agentListCaller(ctx: Ctx, c: Context) {
  const caller = await approvalCaller(ctx, c);
  if (ctx.cfg.agentTeamApproversEnabled && !(await approvableKeys(ctx, caller)).length) {
    // Managers may still edit agents even when this setting excludes their decisions.
    return principal(ctx, c);
  }
  return caller;
}
export async function delegatedAgentRows(ctx: Ctx, caller: Awaited<ReturnType<typeof principal>>, rows: Awaited<ReturnType<typeof approvableKeys>>) {
  if (!ctx.cfg.agentTeamApproversEnabled) return { rows, delegated: false };
  const who = await approvalIdentity(ctx.db, caller);
  if (["owner", "admin"].includes(who.role)) return { rows, delegated: false };
  return { rows: await approvableKeys(ctx, caller), delegated: true };
}
export async function approvalListJson(ctx: Ctx, caller: Awaited<ReturnType<typeof principal>>, row: import("../agents/approvals.ts").ApprovalRow) {
  const { approvalJson } = await import("../agents/approvals.ts");
  const data = approvalJson(row);
  if (!ctx.cfg.agentTeamApproversEnabled) return data;
  const who = await approvalIdentity(ctx.db, caller);
  return { ...data, can_allow: ["owner", "admin"].includes(who.role) };
}

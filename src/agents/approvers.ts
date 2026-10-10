// E153: approval authority is separate from rulebook administration.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import type { Ctx } from "../context.ts";
import { ROLE_RANK, type KeyRow, type Role } from "../api/auth.ts";
import { agentSessions, keys, kv, teamMembers, teamPrincipals } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
export const approversSchema = z.strictObject({ mode: z.enum(["owners", "owners_and_admins", "specific_members"]), member_ids: z.array(z.string().min(1).max(128)).max(100).default([]) }).superRefine((v, c) => {
  if (new Set(v.member_ids).size !== v.member_ids.length || (v.mode !== "specific_members" && v.member_ids.length)) c.addIssue({ code: "custom", message: "Select unique members only in specific members mode." });
});
export type Approvers = z.infer<typeof approversSchema>;
export const approversKey = (hash: string) => `agent-approvers:${hash}`;
const contexts = new WeakMap<Db, Ctx>();
export const teamApproversEnabled = (db: Db) => contexts.get(db)?.cfg.agentTeamApproversEnabled === true;
export const teamApproversContext = (db: Db) => contexts.get(db);
export const configureTeamApprovers = (db: Db, ctx: Ctx) => contexts.set(db, ctx);
export async function readApprovers(db: Db | Tx, hash: string): Promise<Approvers & { configured: boolean }> {
  const [saved] = await db.select().from(kv).where(eq(kv.key, approversKey(hash)));
  return { ...approversSchema.parse(saved?.value ?? { mode: "owners" }), configured: !!saved };
}
async function member(db: Db | Tx, key: KeyRow) {
  if (!key.teamId) return undefined;
  const scope = and(eq(teamMembers.teamId, key.teamId), eq(teamMembers.keyHash, key.keyHash));
  const [first] = await db.select().from(teamMembers).where(scope);
  if (!first) return undefined;
  // Team role edits lock the principal before its issued keys. Keep that lock order here.
  const [p] = first.principalId ? await db.select().from(teamPrincipals).where(and(eq(teamPrincipals.id, first.principalId), eq(teamPrincipals.teamId, key.teamId))).for("share") : [];
  const [row] = await db.select().from(teamMembers).where(scope).for("share");
  if (!row || row.principalId !== first.principalId || row.principalId && (!p || p.disabled)) return undefined;
  const keyRank = ROLE_RANK[row.role as Role] ?? -1;
  const principalRank = p ? ROLE_RANK[p.role as Role] ?? -1 : keyRank;
  return { ...row, role: p && principalRank < keyRank ? p.role : row.role };
}
export async function approvalIdentity(db: Db | Tx, key: KeyRow) {
  if (key.disabled || (key.expiresAt && key.expiresAt <= new Date())) fail(403, "Approver access is unavailable.", "forbidden");
  if ((await db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash)).limit(1)).length) fail(403, "Session keys cannot approve requests.", "forbidden");
  const m = key.management ? undefined : await member(db, key);
  const role = key.management ? "owner" : m?.role as Role | undefined;
  if (!role || !["owner", "admin", "member", "dev"].includes(role)) fail(403, "This key cannot approve requests.", "forbidden");
  return { role, id: m?.principalId ?? key.keyHash, principal: m?.principalId };
}
export async function canApprove(db: Db | Tx, caller: KeyRow, target: KeyRow): Promise<boolean> {
  if (caller.accountId !== target.accountId || (!caller.management && (!caller.teamId || caller.teamId !== target.teamId))) return false;
  try {
    const who = await approvalIdentity(db, caller);
    if (caller.keyHash === target.keyHash) return false;
    // Human member sign-ins sharing a principal cannot approve each other's requests either.
    if (!caller.management) {
      const requester = await member(db, target);
      if (who.principal && who.principal === requester?.principalId) return false;
    }
    if (who.role === "owner") return true;
    const settings = await readApprovers(db, target.keyHash);
    return settings.mode === "owners_and_admins" && who.role === "admin" || settings.mode === "specific_members" && settings.member_ids.includes(who.id);
  } catch { return false; }
}
export async function approvableKeys(ctx: Ctx, caller: KeyRow) {
  await approvalIdentity(ctx.db, caller);
  const rows = await ctx.db.select().from(keys).where(and(eq(keys.accountId, caller.accountId), caller.management ? undefined : eq(keys.teamId, caller.teamId!)));
  const decisions = await Promise.all(rows.map(row => canApprove(ctx.db, caller, row)));
  return rows.filter((_, i) => decisions[i]);
}
export async function assertDecisionApprover(db: Db, tx: Tx, account: string, actor: string, targetHash: string) {
  if (!teamApproversEnabled(db)) return;
  const [caller] = await tx.select().from(keys).where(and(eq(keys.keyHash, actor), eq(keys.accountId, account))).for("share");
  const [target] = await tx.select().from(keys).where(and(eq(keys.keyHash, targetHash), eq(keys.accountId, account))).for("share");
  if (!caller || !target || !await canApprove(tx, caller, target)) fail(403, "You cannot decide this agent's requests.", "forbidden");
}
export async function teamApproverChoices(db: Db | Tx, target: KeyRow) {
  if (!target.teamId) return [];
  const rows = await db.select({ key: keys, member: teamMembers }).from(teamMembers).innerJoin(keys, eq(keys.keyHash, teamMembers.keyHash)).where(and(eq(teamMembers.teamId, target.teamId), eq(keys.accountId, target.accountId)));
  const choices = new Map<string, { id: string; name: string; role: string }>();
  const requester = await member(db, target);
  for (const { key } of rows) {
    if (key.keyHash === target.keyHash) continue;
    try { const who = await approvalIdentity(db, key); if (who.principal && who.principal === requester?.principalId) continue; choices.set(who.id, { id: who.id, name: key.name || "Unnamed teammate", role: who.role }); } catch { /* Inactive keys and API-only agents are not people. */ }
  }
  return [...choices.values()];
}
export async function validateMembers(db: Db | Tx, target: KeyRow, settings: Approvers) {
  const choices = await teamApproverChoices(db, target);
  if (settings.member_ids.some(id => !choices.some(m => m.id === id))) fail(400, "Choose active members from this agent's team.", "invalid_request");
  if (settings.mode !== "owners" && !target.teamId) fail(400, "Choose a team agent before adding approvers.", "invalid_request");
  return choices;
}

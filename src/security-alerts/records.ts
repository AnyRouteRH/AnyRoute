import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { keys, kv, teams, teamMembers, teamPrincipals } from "../db/schema.ts";
import { agentPolicies } from "../agents/schema.ts";
import { uid } from "../lib/util.ts";

export const securityContext = new AsyncLocalStorage<Ctx & { securityActorHash?: string }>();
export const preferenceKey = (account: string) => `security-alerts:preference:${account}`;
export type SecurityNotice = { account: string; team: string | null; at: string; title: string; state: "pending" | "inbox" | "muted" };
const name = (value: string | null | undefined) => (value || "unnamed").replace(/[\p{Cc}\p{Cf}'<>]/gu, "").slice(0, 100);
export const keyActor = (value: string | null | undefined) => `by key '${name(value)}'`;
export async function recordSecurity(ctx: Ctx, db: Db | Tx, account: string, team: string | null, title: string, event = uid("change_")) {
  if (!ctx.cfg.securityAlertsEnabled) return;
  const [preference] = await db.select().from(kv).where(eq(kv.key, preferenceKey(account)));
  const enabled = (preference?.value as { enabled?: boolean } | undefined)?.enabled !== false;
  const value: SecurityNotice = { account, team, at: new Date().toISOString(), title, state: enabled ? "pending" : "muted" };
  await db.insert(kv).values({ key: `security-alerts:event:${event}`, value }).onConflictDoNothing();
}
export async function recordKeySecurity(ctx: Ctx, db: Db | Tx, key: typeof keys.$inferSelect, actor: typeof keys.$inferSelect, before?: typeof keys.$inferSelect, wallet?: string) {
  if (!ctx.cfg.securityAlertsEnabled) return;
  let title: string;
  if (wallet) title = `New sign-in with wallet ${wallet.slice(0, 6)}…${wallet.slice(-4)}; management key '${name(key.name)}' created`;
  else if (!before) title = `${key.management ? "Management API key" : "API key"} '${name(key.name)}' created ${keyActor(actor.name)}`;
  else {
    const changes = [];
    if (key.disabled !== before.disabled) changes.push(key.disabled ? "switched off" : "switched on");
    if (key.expiresAt?.getTime() !== before.expiresAt?.getTime()) changes.push("expiry changed");
    if (key.budget !== before.budget || key.budgetReset !== before.budgetReset) changes.push("spending limit changed");
    if (key.management !== before.management) changes.push("management access changed");
    if (!changes.length) return;
    title = `Key '${name(key.name)}': ${changes.join(", ")} ${keyActor(actor.name)}`;
  }
  await recordSecurity(ctx, db, key.accountId, key.teamId, title);
}
// Called inside the existing event transaction. Actor is read now, never inferred later from a mutable row.
export async function recordPolicySecurity(db: Db | Tx, event: { id: number; keyHash: string; kind: string }) {
  const ctx = securityContext.getStore();
  if (!ctx?.cfg.securityAlertsEnabled || !["policy_set", "killed", "resumed", "resume"].includes(event.kind)) return;
  const [key] = await db.select().from(keys).where(eq(keys.keyHash, event.keyHash));
  const [policy] = await db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, event.keyHash));
  if (!key || !policy) return;
  const [actor] = await db.select({ name: keys.name }).from(keys).where(and(eq(keys.keyHash, policy.updatedBy), eq(keys.accountId, key.accountId)));
  const action = event.kind === "policy_set" ? "Rulebook and spending limits saved" : event.kind === "killed" ? "Stop saved" : "Resume saved";
  await recordSecurity(ctx, db, key.accountId, key.teamId, `${action} for key '${name(key.name)}' ${keyActor(actor?.name)}`, `policy:${event.id}`);
}
export async function recordTeamSecurity(db: Db | Tx, event: { team: string; seq: number; actor: string; action: string; detail: Record<string, unknown> }) {
  const ctx = securityContext.getStore();
  if (!ctx?.cfg.securityAlertsEnabled || !["member.join", "member.role"].includes(event.action)) return;
  const [team] = await db.select().from(teams).where(eq(teams.id, event.team));
  if (!team) return;
  const [actor] = await db.select({ name: keys.name }).from(keys).where(and(eq(keys.accountId, team.ownerAccount), ctx.securityActorHash ? and(eq(keys.keyHash, ctx.securityActorHash), sql`('key:' || left(${keys.keyHash}, 16) = ${event.actor} or exists (select 1 from ${teamMembers} m join ${teamPrincipals} p on p.id = m.principal_id where m.key_hash = ${keys.keyHash} and m.team_id = ${event.team} and (case when p.kind = 'wallet' then 'wallet:' || p.subject else 'passkey:' || p.id end) = ${event.actor}))`) : sql`${'key:'} || left(${keys.keyHash}, 16) = ${event.actor}`));
  const attribution = actor ? keyActor(actor.name) : event.actor.startsWith("wallet:") ? "by a wallet member" : "by a passkey member";
  if (event.action === "member.role" && event.detail.previous === event.detail.role) return;
  const action = event.action === "member.join" || event.detail.previous === null ? "Team member added" : "Team member role changed";
  await recordSecurity(ctx, db, team.ownerAccount, team.id, `${action} in '${name(team.name)}'${typeof event.detail.role === "string" ? ` (${name(event.detail.role)})` : ""} ${attribution}`, `team:${team.id}:${event.seq}`);
}

export async function recordDisabledSecurity(ctx: Ctx, db: Db | Tx, hashes: string[]) {
  if (!ctx.cfg.securityAlertsEnabled || !hashes.length) return;
  const affected = await db.select().from(keys).where(and(inArray(keys.keyHash, hashes), eq(keys.disabled, false)));
  const actorHash = securityContext.getStore()?.securityActorHash;
  for (const key of affected) {
    const [actor] = actorHash ? await db.select().from(keys).where(and(eq(keys.keyHash, actorHash), eq(keys.accountId, key.accountId))) : [];
    await recordSecurity(ctx, db, key.accountId, key.teamId, `Key '${name(key.name)}': switched off ${actor ? keyActor(actor.name) : "by its account manager"}`);
  }
}
export async function recordMemberKeySecurity(ctx: Ctx, db: Db | Tx, key: typeof keys.$inferSelect, kind: string) {
  await recordSecurity(ctx, db, key.accountId, key.teamId, `API key '${name(key.name)}' created by a ${kind === "wallet" ? "wallet" : "passkey"} member`);
}

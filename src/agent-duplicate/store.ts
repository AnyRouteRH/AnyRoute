// H171: copy settings, never identity or runtime state. Rotation deliberately keeps its own semantics.
import { and, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { KeyRow, Role } from "../api/auth.ts";
import { ROLE_RANK } from "../api/auth.ts";
import { agentSessions, keys, kv, teamMembers, teams } from "../db/schema.ts";
import { agentPolicies } from "../agents/schema.ts";
import { appendEvent, GENESIS, lockAccount } from "../agents/store.ts";
import { recordPolicyVersion } from "../agents/policy-version-record.ts";
import { approversKey } from "../agents/approvers.ts";
import { QUIET_PREFIX } from "../agents/quiet-alerts.ts";
import { generateApiKey, deriveKey } from "../chain/keys.ts";
import { fail } from "../lib/errors.ts";
import { assertFitsOrgBudget } from "../teams/org.ts";
import { actorOf, appendAudit } from "../teams/audit.ts";
import { picoToUsd } from "../lib/money.ts";
import { keyActor, recordSecurity } from "../security-alerts/records.ts";

export const duplicateName = (name: string) => `${(name || "Unnamed agent").slice(0, 95)} copy`;

export async function duplicateAgent(ctx: Ctx, caller: KeyRow, hash: string, name?: string) {
  return ctx.db.transaction(async tx => {
    await lockAccount(tx, caller.accountId);
    const [active] = await tx.select().from(keys).where(eq(keys.keyHash, caller.keyHash));
    const [member] = await tx.select().from(teamMembers).where(and(eq(teamMembers.keyHash, caller.keyHash), eq(teamMembers.teamId, active?.teamId ?? "")));
    const role = active?.management ? "owner" : member?.role as Role | undefined;
    if (!active || active.disabled || active.expiresAt && active.expiresAt <= new Date() || active.scope || !role || !["owner", "admin"].includes(role)) fail(403, "Use a management key or a team owner or admin key to duplicate an agent.", "forbidden");
    const [source] = await tx.select().from(keys).where(and(eq(keys.keyHash, hash), eq(keys.accountId, active.accountId))).for("update");
    if (!source) fail(404, "Agent not found.", "not_found");
    if (!active.management && (!active.teamId || source.teamId !== active.teamId)) fail(403, "This key cannot manage that agent.", "forbidden");
    const sessions = await tx.select().from(agentSessions).where(inArray(agentSessions.keyHash, [active.keyHash, hash]));
    if (sessions.length) fail(403, "Session keys cannot duplicate agents or be duplicated.", "forbidden");
    if (source.management && !active.management) fail(403, "Only a management key can create management keys.", "forbidden");
    const [membership] = source.teamId ? await tx.select().from(teamMembers).where(and(eq(teamMembers.teamId, source.teamId), eq(teamMembers.keyHash, hash))) : [];
    const copiedRole = (membership?.role ?? "member") as Role;
    if (!active.management && ROLE_RANK[copiedRole] > ROLE_RANK[role]) fail(403, "You cannot create a key with a role above your own.", "forbidden");
    if (source.teamId) {
      const [team] = await tx.select().from(teams).where(and(eq(teams.id, source.teamId), eq(teams.ownerAccount, active.accountId)));
      if (!team) fail(404, "Team not found.", "not_found");
      await assertFitsOrgBudget(tx, source.teamId, source.budget);
    }
    const now = new Date(), secret = generateApiKey(), derived = deriveKey(secret);
    // Explicit settings allow-list: spend, disabled state and mutable identity never leak into the copy.
    const [row] = await tx.insert(keys).values({
      keyHash: derived.keyHash, chainKeyHash: derived.chainKeyHash, keyAddress: derived.keyAddress, label: derived.label,
      accountId: active.accountId, parentHash: active.keyHash, name: name ?? duplicateName(source.name),
      project: source.project, teamId: source.teamId, scope: source.scope, management: source.management,
      budget: source.budget, budgetReset: source.budgetReset, rpm: source.rpm, tpm: source.tpm,
      allowedModels: source.allowedModels, allowedIps: source.allowedIps, includeByokInLimit: source.includeByokInLimit,
      payWithDefault: source.payWithDefault, routing: source.routing, guardrails: source.guardrails,
      tracing: source.tracing, topup: source.topup, expiresAt: source.expiresAt,
    }).returning();
    if (source.teamId) {
      // A fresh API-key membership, without the source's browser/wallet principal binding.
      await tx.insert(teamMembers).values({ teamId: source.teamId, keyHash: row.keyHash, role: copiedRole });
      await appendAudit(tx, source.teamId, await actorOf(tx, active), "key.create", row.keyHash, { role: copiedRole, limit_usd: row.budget == null ? null : picoToUsd(row.budget) });
    }
    const [policy] = await tx.select().from(agentPolicies).where(eq(agentPolicies.keyHash, hash));
    if (policy) {
      await tx.insert(agentPolicies).values({ keyHash: row.keyHash, version: 1, spec: policy.spec, sha256: policy.sha256, updatedBy: active.keyHash });
      await recordPolicyVersion(tx, row.keyHash, policy.spec, active.keyHash, "save", now);
    }
    const note = `Copied from ${source.name || "Unnamed agent"}`;
    await appendEvent(tx, { keyHash: row.keyHash, kind: "duplicated", policySha256: policy?.sha256 ?? GENESIS, reasons: [{ code: "agent_duplicated", message: note }] }, now);
    const prefs = await tx.select().from(kv).where(inArray(kv.key, [approversKey(hash), QUIET_PREFIX + hash]));
    for (const pref of prefs) {
      const quiet = pref.key.startsWith(QUIET_PREFIX);
      await tx.insert(kv).values({ key: quiet ? QUIET_PREFIX + row.keyHash : approversKey(row.keyHash), value: quiet ? { hours: (pref.value as { hours: number | null }).hours, enabled_at: now.toISOString(), notified_for: null, notices: [] } : pref.value });
    }
    await recordSecurity(ctx, tx, active.accountId, source.teamId, `Agent duplicated from ${keyActor(source.name).slice(3)} ${keyActor(active.name)}`);
    return { row, secret, note };
  });
}

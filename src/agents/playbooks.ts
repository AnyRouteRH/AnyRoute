// U115: team playbooks. A playbook is one named rulebook that many keys follow. A following key keeps its own row in
// agent_policies (its kill state, events and autonomy stay per key), and that row's spec and sha256 are a copy of the
// playbook's current rules. Every change to a playbook rewrites the copies of all its followers in the same transaction,
// under the account lock that enforcement also takes, so the next request of every following key sees the new rules:
// the same evaluator, the same reads and no cache, exactly as when a key's own rulebook is saved.
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { teams } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import { appendAudit, auditAccount, type AuditAction, type AuditDetail } from "../teams/audit.ts";
import { agentPolicySha256, type AgentPolicy } from "./policy.ts";
import { agentPolicies, playbookChanges, playbooks } from "./schema.ts";
import { appendEvent, lockAccount, type PolicyRow } from "./store.ts";

export type PlaybookRow = typeof playbooks.$inferSelect;
export type PlaybookChangeRow = typeof playbookChanges.$inferSelect;
export const MAX_PLAYBOOKS_PER_ACCOUNT = 100;
export const PLAYBOOK_PREFIX = "playbook:";

/** "Playbook X changed; N keys follow it", the inbox line for a rules change. */
export const playbookChangedTitle = (name: string, followers: number) => `Playbook ${name} changed; ${followers} ${followers === 1 ? "key follows" : "keys follow"} it`;

/** The keys that follow a playbook, by key hash. */
export async function followersOf(db: Db | Tx, playbookId: string): Promise<string[]> {
  const rows = await db.select({ keyHash: agentPolicies.keyHash }).from(agentPolicies).where(eq(agentPolicies.playbookId, playbookId)).orderBy(asc(agentPolicies.keyHash));
  return rows.map((r) => r.keyHash);
}

/** A team playbook, or an account-wide one in an account that has teams, is announced in the inbox when its rules change. */
async function inTeam(tx: Db | Tx, row: Pick<PlaybookRow, "accountId" | "teamId">) {
  if (row.teamId) return true;
  return (await tx.select({ id: teams.id }).from(teams).where(eq(teams.ownerAccount, row.accountId)).limit(1)).length > 0;
}

async function record(tx: Tx, row: PlaybookRow, action: PlaybookChangeRow["action"], followers: number, actor: string, at: Date) {
  const [change] = await tx.insert(playbookChanges).values({
    playbookId: row.id, accountId: row.accountId, teamId: row.teamId, name: row.name, action, version: row.version, sha256: row.sha256, spec: row.spec,
    followers, actor, notify: await inTeam(tx, row), at,
  }).returning();
  return change!;
}

async function assertNameFree(tx: Tx, accountId: string, name: string, self?: string) {
  const [taken] = await tx.select({ id: playbooks.id }).from(playbooks).where(and(eq(playbooks.accountId, accountId), sql`lower(${playbooks.name}) = lower(${name})`, self ? ne(playbooks.id, self) : undefined));
  if (taken) fail(409, "This account already has a playbook with that name.", "playbook_name_taken");
}

export async function createPlaybook(db: Db, input: { accountId: string; teamId: string | null; name: string; policy: AgentPolicy; actor: string }) {
  return db.transaction(async (tx) => {
    await lockAccount(tx, input.accountId);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(playbooks).where(eq(playbooks.accountId, input.accountId));
    if (n >= MAX_PLAYBOOKS_PER_ACCOUNT) fail(409, `An account can keep at most ${MAX_PLAYBOOKS_PER_ACCOUNT} playbooks. Delete one first.`, "playbook_limit_reached", { limit: MAX_PLAYBOOKS_PER_ACCOUNT });
    await assertNameFree(tx, input.accountId, input.name);
    const now = new Date();
    const [row] = await tx.insert(playbooks).values({ id: uid("pb_"), accountId: input.accountId, teamId: input.teamId, name: input.name, spec: input.policy, sha256: agentPolicySha256(input.policy), version: 1, createdAt: now, updatedAt: now, updatedBy: input.actor }).returning();
    const change = await record(tx, row!, "create", 0, input.actor, now);
    return { row: row!, change };
  });
}

/**
 * Rename a playbook and/or replace its rules. New rules raise the version by one and are copied, in this transaction, to
 * every key that follows it, each with a policy_set event carrying the new digest. Unchanged rules and name change nothing.
 */
export async function updatePlaybook(db: Db, accountId: string, id: string, patch: { name?: string; policy?: AgentPolicy }, actor: string) {
  return db.transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const [row] = await tx.select().from(playbooks).where(and(eq(playbooks.id, id), eq(playbooks.accountId, accountId)));
    if (!row) fail(404, "Playbook not found.", "not_found");
    const name = patch.name ?? row.name;
    const sha256 = patch.policy ? agentPolicySha256(patch.policy) : row.sha256;
    const rules = sha256 !== row.sha256, renamed = name !== row.name;
    const followers = await followersOf(tx, id);
    if (!rules && !renamed) return { row, followers, change: null, rules: false };
    if (renamed) await assertNameFree(tx, accountId, name, id);
    const now = new Date();
    const spec = rules ? patch.policy! : row.spec;
    const [updated] = await tx.update(playbooks).set({ name, spec, sha256, version: rules ? row.version + 1 : row.version, updatedAt: now, updatedBy: actor }).where(eq(playbooks.id, id)).returning();
    if (rules && followers.length) {
      await tx.update(agentPolicies).set({ version: spec.version, spec, sha256, updatedAt: now, updatedBy: actor }).where(eq(agentPolicies.playbookId, id));
      for (const keyHash of followers) await appendEvent(tx, { keyHash, kind: "policy_set", policySha256: sha256 }, now);
    }
    const change = await record(tx, updated!, rules ? "update" : "rename", followers.length, actor, now);
    return { row: updated!, followers, change, rules };
  });
}

/**
 * Point a key at a playbook (its rules become the playbook's current rules; kill state is kept) or, with null, stop
 * following: the key keeps the playbook's current rules as its own rulebook, so nothing loosens.
 */
export async function followPlaybook(db: Db, key: { keyHash: string; accountId: string }, playbookId: string | null, actor: string) {
  return db.transaction(async (tx) => {
    await lockAccount(tx, key.accountId);
    const [current] = await tx.select().from(agentPolicies).where(eq(agentPolicies.keyHash, key.keyHash));
    const now = new Date();
    if (playbookId !== null) {
      const [book] = await tx.select().from(playbooks).where(and(eq(playbooks.id, playbookId), eq(playbooks.accountId, key.accountId)));
      if (!book) fail(404, "Playbook not found.", "not_found");
      if (current?.playbookId === book.id) return { row: current, playbook: book, previous: current, changed: false };
      const values = { version: book.spec.version, spec: book.spec, sha256: book.sha256, updatedAt: now, updatedBy: actor, playbookId: book.id };
      const [row] = await tx.insert(agentPolicies).values({ keyHash: key.keyHash, ...values }).onConflictDoUpdate({ target: agentPolicies.keyHash, set: values }).returning();
      await appendEvent(tx, { keyHash: key.keyHash, kind: "policy_set", policySha256: book.sha256 }, now);
      return { row: row as PolicyRow, playbook: book, previous: current ?? null, changed: true };
    }
    if (!current?.playbookId) return { row: current ?? null, playbook: null, previous: current ?? null, changed: false };
    const [book] = await tx.select().from(playbooks).where(eq(playbooks.id, current.playbookId));
    // The copy is already the playbook's current rules; writing them again makes the key's own rulebook explicit.
    const [row] = await tx.update(agentPolicies).set({ playbookId: null, version: book!.spec.version, spec: book!.spec, sha256: book!.sha256, updatedAt: now, updatedBy: actor }).where(eq(agentPolicies.keyHash, key.keyHash)).returning();
    if (book!.sha256 !== current.sha256) await appendEvent(tx, { keyHash: key.keyHash, kind: "policy_set", policySha256: book!.sha256 }, now);
    return { row: row as PolicyRow, playbook: book!, previous: current, changed: true };
  });
}

/** Delete a playbook. While keys follow it this is refused, unless `copy`: each follower then keeps the rules as its own. */
export async function deletePlaybook(db: Db, accountId: string, id: string, copy: boolean, actor: string) {
  return db.transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const [row] = await tx.select().from(playbooks).where(and(eq(playbooks.id, id), eq(playbooks.accountId, accountId)));
    if (!row) fail(404, "Playbook not found.", "not_found");
    const followers = await followersOf(tx, id);
    if (followers.length && !copy)
      fail(409, `${followers.length} ${followers.length === 1 ? "key follows" : "keys follow"} this playbook. Move them to another playbook or stop them following it first, or delete with ?unlink=copy so each keeps these rules as its own.`, "playbook_followed", { followers: followers.length });
    const now = new Date();
    if (followers.length) await tx.update(agentPolicies).set({ playbookId: null, updatedAt: now, updatedBy: actor }).where(eq(agentPolicies.playbookId, id));
    await tx.delete(playbooks).where(eq(playbooks.id, id));
    const change = await record(tx, row, "delete", followers.length, actor, now);
    return { row, followers, change };
  });
}

/** The team audit entry: a team playbook in its team's log; an account-wide one in the log of every team the account owns. */
export async function auditPlaybook(db: Db, row: Pick<PlaybookRow, "id" | "accountId" | "teamId">, actor: string, action: AuditAction, detail: AuditDetail) {
  if (row.teamId) await appendAudit(db, row.teamId, actor, action, PLAYBOOK_PREFIX + row.id, detail);
  else await auditAccount(db, row.accountId, actor, action, PLAYBOOK_PREFIX + row.id, detail);
}

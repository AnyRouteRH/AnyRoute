import { recordTeamSecurity } from "../security-alerts/records.ts"; // D138
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { teamAudit, teamMembers, teamPrincipals, teams } from "../db/schema.ts";
import { MerkleTree } from "../tlog/merkle.ts";
import { canonicalJson } from "../lib/util.ts";
import type { KeyRow } from "../api/auth.ts";

// An organisation's audit log: who changed what and when (members, keys, budgets, presets, routes, playbooks, lane settings), never
// what anyone asked a model. One hash chain per team:
//   h_0 = 64 zeros,  h_i = sha256( bytes(h_{i-1}) || utf8(canonical(entry_i)) )
// where canonical(entry) is JSON with keys sorted recursively of { team, seq, at, actor, action, target, detail }.
// Entries are also grouped by UTC hour into RFC 6962 Merkle trees over the raw entry hashes (hourly roots). An export
// carries the chain, so an auditor can check it offline with scripts/verify-audit.mjs and pin the head hash they saw.

export const AUDIT_FORMAT = "anyroute.audit.v1";
export const GENESIS = "0".repeat(64);
export const HASH_RULE = "sha256(bytes(prev_hash) || utf8(canonical_json({team, seq, at, actor, action, target, detail})))";

export type AuditAction =
  | "team.create"
  | "team.rename"
  | "budget.set"
  | "owner.bind"
  | "invite.create"
  | "member.join"
  | "member.role"
  | "member.revoke"
  | "member.restore"
  | "key.create"
  | "key.update"
  | "key.disable"
  | "preset.save"
  | "preset.rollback"
  | "preset.delete"
  | "route.create"
  | "route.update"
  | "route.delete"
  | "playbook.create"
  | "playbook.update"
  | "playbook.rename"
  | "playbook.delete"
  | "playbook.follow"
  | "playbook.unfollow";

export type AuditDetail = Record<string, string | number | boolean | null | string[]>;
export type AuditEntry = { team: string; seq: number; at: string; actor: string; action: string; target: string; detail: AuditDetail };
export type ChainedEntry = AuditEntry & { prev_hash: string; hash: string };

export const canonicalEntry = (e: AuditEntry) => canonicalJson({ team: e.team, seq: e.seq, at: e.at, actor: e.actor, action: e.action, target: e.target, detail: e.detail });

export function chainHash(prevHash: string, e: AuditEntry): string {
  return createHash("sha256").update(Buffer.from(prevHash, "hex")).update(Buffer.from(canonicalEntry(e), "utf8")).digest("hex");
}

/** Recompute a chain from its first entry. Returns the first broken seq, or null when every link holds. */
export function verifyChain(entries: ChainedEntry[], genesis = GENESIS): { ok: true; head: string; entries: number } | { ok: false; seq: number; reason: string } {
  let prev = genesis;
  let expectSeq = entries[0]?.seq ?? 1;
  for (const e of entries) {
    if (e.seq !== expectSeq) return { ok: false, seq: e.seq, reason: `expected seq ${expectSeq}` };
    if (e.prev_hash !== prev) return { ok: false, seq: e.seq, reason: "prev_hash does not match the previous entry's hash" };
    if (chainHash(prev, e) !== e.hash) return { ok: false, seq: e.seq, reason: "hash does not match the entry" };
    prev = e.hash;
    expectSeq++;
  }
  return { ok: true, head: prev, entries: entries.length };
}

export type HourRoot = { hour: string; first_seq: number; last_seq: number; count: number; root: string };

/** RFC 6962 Merkle roots over the raw 32-byte entry hashes, one tree per UTC hour. */
export function hourlyRoots(entries: Pick<ChainedEntry, "seq" | "at" | "hash">[]): HourRoot[] {
  const out: HourRoot[] = [];
  let cur: { hour: string; tree: MerkleTree; first: number; last: number } | null = null;
  const flush = () => cur && out.push({ hour: cur.hour, first_seq: cur.first, last_seq: cur.last, count: cur.tree.size, root: cur.tree.root().toString("hex") });
  for (const e of entries) {
    const hour = e.at.slice(0, 13) + ":00:00Z";
    if (!cur || cur.hour !== hour) {
      flush();
      cur = { hour, tree: new MerkleTree(), first: e.seq, last: e.seq };
    }
    cur.tree.appendEntry(Buffer.from(e.hash, "hex"));
    cur.last = e.seq;
  }
  flush();
  return out;
}

export type AuditRow = typeof teamAudit.$inferSelect;
export const entryJson = (r: AuditRow): ChainedEntry => ({ team: r.teamId, seq: r.seq, at: r.at.toISOString(), actor: r.actor, action: r.action, target: r.target, detail: r.detail as AuditDetail, prev_hash: r.prevHash, hash: r.hash });

/** Append one entry to a team's chain. Serialized per team by locking the team row, so two writers cannot fork it. */
export async function appendAudit(db: Db | Tx, teamId: string, actor: string, action: AuditAction, target: string, detail: AuditDetail = {}): Promise<ChainedEntry> {
  const run = async (tx: Db | Tx) => {
    await tx.execute(sql`SELECT id FROM teams WHERE id = ${teamId} FOR UPDATE`);
    const [last] = await tx.select({ seq: teamAudit.seq, hash: teamAudit.hash }).from(teamAudit).where(eq(teamAudit.teamId, teamId)).orderBy(desc(teamAudit.seq)).limit(1);
    // Millisecond precision: what the timestamptz column keeps and what toISOString() prints, so the hash survives storage.
    const at = new Date();
    const entry: AuditEntry = { team: teamId, seq: (last?.seq ?? 0) + 1, at: at.toISOString(), actor, action, target, detail };
    const prevHash = last?.hash ?? GENESIS;
    const hash = chainHash(prevHash, entry);
    await tx.insert(teamAudit).values({ teamId, seq: entry.seq, at, actor, action, target, detail, prevHash, hash });
    await recordTeamSecurity(tx, entry); // D138
    return { ...entry, prev_hash: prevHash, hash };
  };
  // Inside a caller's transaction this is a savepoint and the row lock lives as long as the caller's transaction.
  return (db as Db).transaction(run);
}

/** Append to every team an account owns: for account-wide settings (presets, saved routes) that every team's keys use. */
export async function auditAccount(db: Db | Tx, accountId: string, actor: string, action: AuditAction, target: string, detail: AuditDetail = {}) {
  const rows = await db.select({ id: teams.id }).from(teams).where(eq(teams.ownerAccount, accountId)).orderBy(asc(teams.id));
  for (const t of rows) await appendAudit(db, t.id, actor, action, target, detail);
}

/** Who a key is in the log: the passkey or wallet member it was issued to, else the key hash's first 16 hex digits. */
export async function actorOf(db: Db | Tx, key: Pick<KeyRow, "keyHash" | "teamId">): Promise<string> {
  if (key.teamId) {
    const [m] = await db
      .select({ kind: teamPrincipals.kind, id: teamPrincipals.id, subject: teamPrincipals.subject })
      .from(teamMembers)
      .innerJoin(teamPrincipals, eq(teamPrincipals.id, teamMembers.principalId))
      .where(and(eq(teamMembers.teamId, key.teamId), eq(teamMembers.keyHash, key.keyHash)));
    if (m) return m.kind === "wallet" ? `wallet:${m.subject}` : `passkey:${m.id}`;
  }
  return `key:${key.keyHash.slice(0, 16)}`;
}

export async function auditPage(db: Db, teamId: string, after: number, limit: number) {
  return db.select().from(teamAudit).where(and(eq(teamAudit.teamId, teamId), gt(teamAudit.seq, after))).orderBy(asc(teamAudit.seq)).limit(limit);
}

export async function auditAll(db: Db, teamId: string) {
  return db.select().from(teamAudit).where(eq(teamAudit.teamId, teamId)).orderBy(asc(teamAudit.seq));
}

export async function auditHead(db: Db, teamId: string) {
  const [last] = await db.select({ seq: teamAudit.seq, hash: teamAudit.hash }).from(teamAudit).where(eq(teamAudit.teamId, teamId)).orderBy(desc(teamAudit.seq)).limit(1);
  return { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const CSV_COLUMNS = ["team", "seq", "at", "actor", "action", "target", "detail", "prev_hash", "hash"] as const;

export function exportCsv(entries: ChainedEntry[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const e of entries) lines.push([e.team, e.seq, e.at, e.actor, e.action, e.target, canonicalJson(e.detail), e.prev_hash, e.hash].map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function exportJsonl(teamId: string, entries: ChainedEntry[], exportedAt = new Date()): string {
  const head = entries.at(-1)?.hash ?? GENESIS;
  const lines = [JSON.stringify({ type: "header", format: AUDIT_FORMAT, team: teamId, genesis: GENESIS, hash: HASH_RULE, entries: entries.length, head, exported_at: exportedAt.toISOString() })];
  for (const e of entries) lines.push(JSON.stringify({ type: "entry", ...e }));
  for (const r of hourlyRoots(entries)) lines.push(JSON.stringify({ type: "root", ...r }));
  return lines.join("\n") + "\n";
}

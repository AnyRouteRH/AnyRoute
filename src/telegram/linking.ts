import { randomBytes } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { agentSessions, keys, kv } from "../db/schema.ts";
import { roleOf, type KeyRow } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";
import { sha256 } from "../lib/util.ts";

export const LINK_TTL_MS = 300_000;
export const linkKey = (uid: number) => `telegram-link:${uid}`;
export const codeKey = (account: string) => `telegram-link-code:${account}`;
export type Link = { account: string; key_hash: string; uid: number; generation: string; linked_at: string };
type Code = { hash: string; account: string; key_hash: string; expires: number };
// Serialize link changes, callbacks and outbound sends across processes. No text or secrets enter this lock.
export const lockLinks = (db: Db | Tx) => db.execute(sql`select pg_advisory_xact_lock(hashtext('telegram-linking'))`);
export async function linkLimit(ctx: Ctx, action: string, actor: string | number, limit: number) {
  const result = await ctx.limiter.take(`telegram-link:${action}:${actor}`, 1, limit, 60_000);
  if (!result.ok) fail(429, "Too many Telegram link actions. Try again shortly.", "rate_limit_exceeded");
}
export async function validPrincipal(ctx: Ctx, link: Pick<Link, "account" | "key_hash">): Promise<KeyRow> {
  const [key] = await ctx.db.select().from(keys).where(and(eq(keys.keyHash, link.key_hash), eq(keys.accountId, link.account)));
  if (!key || key.disabled || (key.expiresAt && key.expiresAt <= new Date())) fail(403, "Telegram link authority is unavailable.", "forbidden");
  if ((await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash)).limit(1)).length || !["owner", "admin"].includes(await roleOf(ctx, key))) fail(403, "Only owner/admin keys may link Telegram.", "forbidden");
  return key;
}
export async function readLink(db: Db | Tx, uid: number): Promise<Link | undefined> {
  const [row] = await db.select().from(kv).where(eq(kv.key, linkKey(uid)));
  return row?.value as Link | undefined;
}
export async function accountLinks(db: Db | Tx, account: string): Promise<Link[]> {
  const rows = await db.select().from(kv).where(and(like(kv.key, "telegram-link:%"), sql`${kv.value}->>'account' = ${account}`));
  return rows.map(r => r.value as Link);
}
export async function pruneLinks(db: Db | Tx, now = Date.now()) {
  await db.delete(kv).where(and(like(kv.key, "telegram-link-code:%"), sql`(${kv.value}->>'expires')::bigint <= ${now}`));
  await db.delete(kv).where(and(like(kv.key, "telegram-approval:%"), sql`(${kv.value}->>'expires')::bigint <= ${now}`));
}
export async function issueCode(ctx: Ctx, caller: KeyRow) {
  await linkLimit(ctx, "issue", caller.accountId, 5);
  const code = randomBytes(12).toString("base64url");
  const expires = Date.now() + LINK_TTL_MS;
  await ctx.db.transaction(async tx => {
    await lockLinks(tx);
    await validPrincipal({ ...ctx, db: tx as unknown as Db }, { account: caller.accountId, key_hash: caller.keyHash });
    await pruneLinks(tx);
    const value: Code = { hash: sha256(code), account: caller.accountId, key_hash: caller.keyHash, expires };
    await tx.insert(kv).values({ key: codeKey(caller.accountId), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  });
  return { code, expires_at: new Date(expires).toISOString() };
}
export async function consumeCode(ctx: Ctx, uid: number, code: string) {
  await linkLimit(ctx, "consume", uid, 10);
  if (!/^[A-Za-z0-9_-]{16}$/.test(code)) fail(400, "Link code is unavailable.");
  return ctx.db.transaction(async tx => {
    await lockLinks(tx);
    const [row] = await tx.select().from(kv).where(and(like(kv.key, "telegram-link-code:%"), sql`${kv.value}->>'hash' = ${sha256(code)}`)).limit(1);
    const value = row?.value as Code | undefined;
    if (!value || value.expires <= Date.now()) fail(400, "Link code is unavailable.");
    await validPrincipal({ ...ctx, db: tx as unknown as Db }, value);
    const existing = await readLink(tx, uid);
    if (existing) fail(409, "Unlink your existing account first with /unlink.");
    // One Telegram identity per principal key; other owner/admin keys can link their own identity.
    if ((await accountLinks(tx, value.account)).some(l => l.key_hash === value.key_hash)) fail(409, "This principal already has a Telegram link. Unlink it first.");
    const link: Link = { account: value.account, key_hash: value.key_hash, uid, generation: randomBytes(9).toString("base64url"), linked_at: new Date().toISOString() };
    await tx.insert(kv).values({ key: linkKey(uid), value: link });
    await tx.delete(kv).where(eq(kv.key, row.key));
    return link;
  });
}
export async function removeLink(ctx: Ctx, uid: number) {
  await ctx.db.transaction(async tx => {
    await lockLinks(tx);
    const link = await readLink(tx, uid);
    if (!link) return;
    await tx.delete(kv).where(eq(kv.key, linkKey(uid)));
    await tx.delete(kv).where(and(like(kv.key, "telegram-approval:%"), sql`${kv.value}->>'uid' = ${String(uid)}`));
    await tx.delete(kv).where(eq(kv.key, codeKey(link.account)));
  });
}
export async function removeAccountLink(ctx: Ctx, caller: KeyRow) {
  await ctx.db.transaction(async tx => {
    await lockLinks(tx);
    const links = (await accountLinks(tx, caller.accountId)).filter(l => l.key_hash === caller.keyHash);
    for (const link of links) {
      await tx.delete(kv).where(eq(kv.key, linkKey(link.uid)));
      await tx.delete(kv).where(and(like(kv.key, "telegram-approval:%"), sql`${kv.value}->>'uid' = ${String(link.uid)}`));
    }
    await tx.delete(kv).where(eq(kv.key, codeKey(caller.accountId)));
  });
}

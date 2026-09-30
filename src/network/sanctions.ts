import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { payouts, type providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { log, sha256 } from "../lib/util.ts";
import { sanctionsAddresses, sanctionsMeta } from "./schema.ts";
import { normalizeEvmAddress, parseSdnXml } from "./sdn.ts";
export { normalizeEvmAddress, parseSdnXml } from "./sdn.ts";

type ScreeningCtx = Pick<Ctx, "db" | "cfg">;
const DAY = 86_400_000;
const MAX_BYTES = 64 * 1024 * 1024;

export async function sanctionsStatus(ctx: ScreeningCtx, now = new Date()) {
  const [meta] = await ctx.db.select().from(sanctionsMeta).where(eq(sanctionsMeta.id, 1));
  const age = meta ? Math.max(0, (now.getTime() - meta.listDate.getTime()) / DAY) : null;
  return { enabled: ctx.cfg.sanctions.enabled, list_date: meta?.listDate.toISOString().slice(0, 10) ?? null, entry_count: meta?.entryCount ?? 0, source_hash: meta?.sourceHash ?? null, ignored_count: meta?.ignoredCount ?? 0, refreshed_at: meta?.refreshedAt.toISOString() ?? null, age_days: age, stale: age === null || age > ctx.cfg.sanctions.maxAgeDays, max_age_days: ctx.cfg.sanctions.maxAgeDays };
}

export async function isSanctioned(ctx: ScreeningCtx, addr: string): Promise<boolean> {
  const address = normalizeEvmAddress(addr);
  if (!address) return false;
  const [row] = await ctx.db.select({ address: sanctionsAddresses.address }).from(sanctionsAddresses).where(eq(sanctionsAddresses.address, address)).limit(1);
  return !!row;
}

/** A single statement sees metadata and matches from the same committed list. */
async function decision(ctx: ScreeningCtx, addr: string, allowPaid: boolean, now: Date) {
  const address = normalizeEvmAddress(addr);
  if (!address) return { reason: "invalid_payout_address" };
  const [row] = await ctx.db.select({
    listDate: sanctionsMeta.listDate,
    matched: sql<boolean>`exists (select 1 from ${sanctionsAddresses} where ${sanctionsAddresses.address} = ${address})`,
  }).from(sanctionsMeta).where(eq(sanctionsMeta.id, 1));
  if (row?.matched) return { reason: "sanctioned_address", list_date: row.listDate.toISOString().slice(0, 10) };
  const stale = !row || now.getTime() - row.listDate.getTime() > ctx.cfg.sanctions.maxAgeDays * DAY;
  const list_date = row?.listDate.toISOString().slice(0, 10) ?? null;
  if (!stale) return { reason: null, list_date };
  if (allowPaid) {
    const [paid] = await ctx.db.select({ id: payouts.id }).from(payouts).where(and(eq(payouts.status, "paid"), isNotNull(payouts.tx), gt(payouts.usdg, 0n), sql`lower(${payouts.to}) = ${address}`)).limit(1);
    if (paid) return { reason: null, list_date, exception: "previously_paid_address_with_stale_or_missing_list" };
  }
  return { reason: row ? "sanctions_list_stale_new_address" : "sanctions_list_missing_new_address", list_date };
}

export async function assertNotSanctioned(ctx: ScreeningCtx, addr: string, now = new Date()): Promise<void> {
  if (!ctx.cfg.sanctions.enabled) return;
  let result;
  try { result = await decision(ctx, addr, false, now); }
  catch { fail(503, "Sanctions screening is unavailable; admission is paused.", "sanctions_unavailable"); }
  if (!result.reason) return;
  log.warn("sanctions admission refused", { reason: result.reason, list_date: result.list_date ?? null });
  fail(result.reason === "sanctioned_address" ? 403 : 503, result.reason === "sanctioned_address" ? "Payout address is on the public OFAC SDN list." : "A current sanctions list is required for admission.", result.reason);
}

/** Called before any payout row or settlement claim. A skip remains due for a later run. */
export async function skipSanctionedPayout(ctx: ScreeningCtx, p: typeof providers.$inferSelect, out: unknown[], now = new Date()): Promise<boolean> {
  if (!ctx.cfg.sanctions.enabled || p.payoutMode !== "usdg" || !p.payoutAddress) return false;
  let result;
  try { result = await decision(ctx, p.payoutAddress, true, now); }
  catch { result = { reason: "sanctions_unavailable", list_date: null }; }
  if (!result.reason) {
    if (result.exception) log.warn("sanctions payout freshness exception", { provider: p.id, reason: result.exception, list_date: result.list_date });
    return false;
  }
  log.warn("sanctions payout skipped; settlement remains due", { provider: p.id, reason: result.reason, list_date: result.list_date ?? null });
  out.push({ provider: p.id, status: "skipped", reason: result.reason, list_date: result.list_date ?? null });
  return true;
}

/** Fetch errors, invalid feeds and transaction failures leave the previous list intact. */
export async function refreshSanctions(ctx: ScreeningCtx, fetcher: typeof fetch = fetch, now = new Date()) {
  if (!ctx.cfg.sanctions.enabled) return { skipped: "screening_disabled" };
  try {
    const response = await fetcher(ctx.cfg.sanctions.listUrl, { signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Download rejected");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new Error("SDN download exceeds limit");
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const raw = Buffer.concat(chunks);
    const parsed = parseSdnXml(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (parsed.listDate.getTime() > now.getTime()) throw new Error("Future publication date");
    const sourceHash = sha256(raw);
    await ctx.db.transaction(async (tx) => {
      // Serializes refreshers across processes, including initial bootstrap with no meta row.
      await tx.execute(sql`LOCK TABLE sanctions_meta IN EXCLUSIVE MODE`);
      const [old] = await tx.select().from(sanctionsMeta).where(eq(sanctionsMeta.id, 1));
      if (old && old.listDate > parsed.listDate) throw new Error("Publication date moved backwards");
      await tx.delete(sanctionsAddresses);
      for (let i = 0; i < parsed.addresses.length; i += 1000) {
        await tx.insert(sanctionsAddresses).values(parsed.addresses.slice(i, i + 1000).map((address) => ({ address, listDate: parsed.listDate, sourceHash })));
      }
      const meta = { id: 1, listDate: parsed.listDate, sourceHash, entryCount: parsed.addresses.length, ignoredCount: parsed.ignoredCount, refreshedAt: now };
      await tx.insert(sanctionsMeta).values(meta).onConflictDoUpdate({ target: sanctionsMeta.id, set: meta });
    });
    const result = { entry_count: parsed.addresses.length, ignored_count: parsed.ignoredCount, digital_count: parsed.digitalCount, list_date: parsed.listDate.toISOString().slice(0, 10), source_hash: sourceHash };
    log.info("sanctions list refreshed", result);
    return result;
  } catch {
    log.error("sanctions refresh failed; last good list retained", { reason: "fetch_parse_or_storage_failure" });
    throw new Error("Sanctions refresh failed; last good list retained");
  }
}

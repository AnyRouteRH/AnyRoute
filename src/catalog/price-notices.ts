import { and, asc, desc, eq, gte, inArray, isNotNull, like, lte, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { generations, keys, kv } from "../db/schema.ts";
import { modelJson } from "../api/models.ts";
import { usdToPico } from "../lib/money.ts";
import { sha256, uid } from "../lib/util.ts";
import { accountLinks, validPrincipal } from "../telegram/linking.ts";
import { sendLinkedAlert } from "../telegram/delivery.ts";
import { diffPrices, type PriceSnapshot } from "./price-notices-text.ts";

const SNAPSHOT = "price-notices:snapshot";
const DAY_MS = 86_400_000;
type Notice = { id: string; at: string; model: string | null; title: string };
type Daily = { account: string; day: string; items: Notice[]; overflow: number };
const dailyPrefix = (account: string) => `price-notices:daily:${sha256(account)}:`;

export function registerPriceNoticesJob(ctx: Ctx) {
  if (ctx.cfg.priceNoticesEnabled && ctx.cfg.runtimeRole !== "api")
    ctx.jobs.register("price-notices", 3_600_000, () => runPriceNotices(ctx));
}

export async function runPriceNotices(ctx: Ctx, opts: { now?: Date; telegramFetch?: typeof fetch } = {}) {
  if (!ctx.cfg.priceNoticesEnabled || ctx.cfg.runtimeRole === "api") return { skipped: true, created: 0 };
  const now = opts.now ?? new Date(), at = now.toISOString(), day = at.slice(0, 10);
  const outgoing = await ctx.db.transaction(async tx => {
    // One persistent row lock serializes snapshots, account caps and inbox claims across workers.
    await tx.insert(kv).values({ key: SNAPSHOT, value: {} }).onConflictDoNothing();
    const [saved] = await tx.select().from(kv).where(eq(kv.key, SNAPSHOT)).for("update");
    await ctx.catalog.refresh();
    const entries: [string, PriceSnapshot][] = [];
    for (const model of ctx.catalog.models.values()) {
      if (model.hidden) continue;
      const entry = modelJson(ctx, model);
      // No funded endpoints is availability loss, not a drop to a zero-dollar price.
      if (!entry.data_policy.providers) continue;
      entries.push([model.id, { name: model.name, prompt: usdToPico(entry.pricing.prompt).toString(), completion: usdToPico(entry.pricing.completion).toString() }]);
    }
    const current = Object.fromEntries(entries);
    const changes = diffPrices(saved.value as Record<string, PriceSnapshot>, current);
    const outgoing: { account: string; item: Notice }[] = [];
    if (changes.length) {
      // Existing attributed call records only: no request bodies, new tracking or anonymous-user inference.
      const used = await tx.selectDistinct({ account: generations.accountId, model: generations.modelId }).from(generations).where(and(
        isNotNull(generations.accountId), inArray(generations.modelId, changes.map(change => change.model)),
        gte(generations.ts, new Date(now.getTime() - 30 * DAY_MS)), lte(generations.ts, now),
      )).orderBy(asc(generations.accountId), asc(generations.modelId));
      const byAccount = new Map<string, Set<string>>();
      for (const row of used) {
        const models = byAccount.get(row.account!) ?? new Set<string>();
        models.add(row.model); byAccount.set(row.account!, models);
      }
      for (const [account, models] of byAccount) {
        const key = dailyPrefix(account) + day;
        const [savedDay] = await tx.select().from(kv).where(eq(kv.key, key));
        const daily: Daily = savedDay ? savedDay.value as Daily : { account, day, items: [], overflow: 0 };
        const previousCount = daily.items.length;
        for (const change of changes.filter(change => models.has(change.model))) {
          if (daily.items.length < 4) {
            const item = { id: uid("pn_"), at, ...change };
            daily.items.push(item); outgoing.push({ account, item });
          } else {
            daily.overflow++;
            const title = `And ${daily.overflow} more model price ${daily.overflow === 1 ? "change" : "changes"}`;
            if (daily.items.length === 4) daily.items.push({ id: uid("pn_"), at, model: null, title });
            else Object.assign(daily.items[4], { at, title });
          }
        }
        // The fifth slot groups every additional change, including later hourly checks that day.
        if (daily.items.length === 5 && previousCount < 5) outgoing.push({ account, item: { ...daily.items[4] } });
        await tx.insert(kv).values({ key, value: daily, updatedAt: now }).onConflictDoUpdate({ target: kv.key, set: { value: daily, updatedAt: now } });
      }
    }
    await tx.update(kv).set({ value: current, updatedAt: now }).where(eq(kv.key, SNAPSHOT));
    await tx.delete(kv).where(and(like(kv.key, "price-notices:daily:%"), sql`${kv.value}->>'day' < ${new Date(now.getTime() - 30 * DAY_MS).toISOString().slice(0, 10)}`));
    return outgoing;
  });
  // Durable claim before a single outbound attempt; ambiguous sends are never retried.
  for (const notice of outgoing) for (const link of await accountLinks(ctx.db, notice.account)) {
    try {
      await ctx.db.transaction(async tx => {
        // Revalidation and send share a key lock: a rights change cannot complete between them.
        await tx.select({ hash: keys.keyHash }).from(keys).where(eq(keys.keyHash, link.key_hash)).for("share");
        const scoped = { ...ctx, db: tx as unknown as Db };
        const principal = await validPrincipal(scoped, link);
        if (!principal.management) return; // Account-wide history requires current management rights.
        await sendLinkedAlert(scoped, link, notice.item.title, link.key_hash, opts.telegramFetch);
      });
    } catch { /* A revoked or unlinked principal receives nothing. */ }
  }
  return { created: outgoing.length, skipped: false };
}

export async function priceNoticeItems(ctx: Ctx, account: string, asOf: string, since?: string) {
  if (!ctx.cfg.priceNoticesEnabled) return [];
  const rows = await ctx.db.select().from(kv).where(like(kv.key, dailyPrefix(account) + "%")).orderBy(desc(kv.key)).limit(31);
  return rows.flatMap(row => (row.value as Daily).items).filter(item => item.at <= asOf && (!since || item.at > since))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 101)
    .map(item => ({ ...item, kind: "price_notice", status: null, href: "/models/", unread: true }));
}

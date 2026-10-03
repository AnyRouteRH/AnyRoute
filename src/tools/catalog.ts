import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { skills } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, usdgToPico } from "../lib/money.ts";
import { log, randomHex } from "../lib/util.ts";
import { toolCanaryRuns, toolListings, type CanarySpec } from "./schema.ts";
import { egressFetch, readCapped, type ToolFetch } from "./fetch.ts";
import { quoteTool, toolRequest } from "./call.ts";
import { ourNetwork } from "./x402.ts";

// The tool catalog behind GET /api/v1/tools, the /tools page and anyroute_tools_search:
//   tool_listings          sellers list an x402 resource with a known-answer canary (POST /api/v1/tools/listings);
//                          a Skills Hub skill's paid invocation is a listing that names the skill
//   facilitator sellers    JOIN POINT below: sellers who list through the Robinhood Chain facilitator (v6 F)
//   public catalog         TOOLS_PUBLIC_CATALOG_URL, fetched through the egress guard and cached in memory
// Every entry is called the same way: POST /api/v1/tools/call with its resource and a max_price.

export type ListingRow = typeof toolListings.$inferSelect;
export type CatalogItem = {
  id: string | null; name: string; summary: string; resource: string; method: string; price_usd: number | null; price_units: string | null;
  pay_to: string | null; network: string | null; source: "listing" | "skill" | "facilitator" | "public_catalog"; skill_id: string | null;
  quality: { state: "passing" | "failing" | "delisted" | "unchecked"; consecutive_failures: number; checked_at: string | null; delisted_at: string | null; note?: string };
};

export const DELIST_AFTER = 3;
/** A listing's address plus its probe's query arguments. */
export const probeAddress = (resource: string, query?: string) => (query ? `${resource}?${query}` : resource);

export function listingJson(r: ListingRow): CatalogItem {
  const state = r.status === "delisted" ? "delisted" : !r.checkedAt ? "unchecked" : r.failures > 0 ? "failing" : "passing";
  return {
    id: r.id, name: r.name, summary: r.summary, resource: r.resource, method: r.method, price_usd: picoToUsd(usdgToPico(r.priceUnits)), price_units: r.priceUnits.toString(),
    pay_to: r.payTo, network: r.network, source: r.skillId ? "skill" : "listing", skill_id: r.skillId,
    quality: { state, consecutive_failures: r.failures, checked_at: r.checkedAt?.toISOString() ?? null, delisted_at: r.delistedAt?.toISOString() ?? null },
  };
}

/**
 * JOIN POINT (v6 F, src/facilitator): sellers who opt in through POST /facilitator/sellers live in facilitator_sellers
 * (id, pay_to, resource, price_hint, tags, listed). Until that table exists on this database the catalog shows tool
 * listings only. Once it does, its listed rows appear here, and a seller who also wants a canary lists the same
 * resource in tool_listings. Read defensively: any mismatch in shape leaves this source empty, never an error.
 */
export async function facilitatorListings(ctx: Ctx): Promise<CatalogItem[]> {
  try {
    const present = await ctx.db.execute(sql`select to_regclass('public.facilitator_sellers') is not null as present`);
    if (!(((present as { rows?: unknown[] }).rows ?? present) as { present: boolean }[])[0]?.present) return [];
    const result = await ctx.db.execute(sql`select id::text as id, pay_to::text as pay_to, resource::text as resource, price_hint::text as price_hint from facilitator_sellers where listed = true order by created_at desc limit 200`);
    const rows = ((result as { rows?: unknown[] }).rows ?? result) as { id: string; pay_to: string; resource: string; price_hint: string | null }[];
    const host = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
    return rows.filter((r) => typeof r.resource === "string" && /^https:\/\//.test(r.resource) && host(r.resource)).map((r) => ({
      id: r.id, name: host(r.resource), summary: "Listed through the Robinhood Chain facilitator.", resource: r.resource, method: "GET",
      price_usd: r.price_hint && /^\d+$/.test(r.price_hint) ? picoToUsd(usdgToPico(BigInt(r.price_hint))) : null, price_units: r.price_hint && /^\d+$/.test(r.price_hint) ? r.price_hint : null,
      pay_to: r.pay_to, network: `eip155:${ctx.cfg.chain.id}`, source: "facilitator" as const, skill_id: null,
      quality: { state: "unchecked" as const, consecutive_failures: 0, checked_at: null, delisted_at: null, note: "Facilitator sellers carry no known-answer probe; list the resource as a tool to add one." },
    }));
  } catch {
    return [];
  }
}

// ---- the public catalog (Bazaar discovery shape: { items: [{ resource, accepts: [...], metadata }] }) --------------

const publicCache = new Map<string, { at: number; items: CatalogItem[] }>();

/** Parse a discovery document into catalog items payable on this chain. Unknown shapes yield nothing. */
export function parsePublicCatalog(ctx: Ctx, doc: unknown): CatalogItem[] {
  const o = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  const list = [o.items, o.resources, o.data, o.tools].find(Array.isArray) as unknown[] | undefined;
  const out: CatalogItem[] = [];
  for (const raw of (list ?? []).slice(0, 2_000)) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const resource = typeof it.resource === "string" ? it.resource : typeof it.url === "string" ? it.url : null;
    if (!resource || resource.length > 2048 || !/^https:\/\//.test(resource)) continue;
    const accepts = (Array.isArray(it.accepts) ? it.accepts : []) as Record<string, unknown>[];
    const offer = accepts.find((a) => a && typeof a === "object" && a.scheme === "exact" && ourNetwork(ctx, a.network) && typeof a.asset === "string" && a.asset.toLowerCase() === ctx.cfg.chain.usdg.toLowerCase());
    if (accepts.length && !offer) continue;
    const meta = it.metadata && typeof it.metadata === "object" ? (it.metadata as Record<string, unknown>) : {};
    const units = offer ? String(offer.amount ?? offer.maxAmountRequired ?? "") : "";
    const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
    let host = "";
    try { host = new URL(resource).hostname; } catch { continue; }
    out.push({
      id: null, name: text(it.name ?? meta.name, 80) || host, summary: text(it.description ?? meta.description ?? offer?.description, 280), resource, method: text(it.method ?? meta.method, 8).toUpperCase() === "POST" ? "POST" : "GET",
      price_usd: /^\d{1,30}$/.test(units) ? picoToUsd(usdgToPico(BigInt(units))) : null, price_units: /^\d{1,30}$/.test(units) ? units : null,
      pay_to: typeof offer?.payTo === "string" ? offer.payTo.toLowerCase() : null, network: offer ? String(offer.network) : null, source: "public_catalog", skill_id: null,
      quality: { state: "unchecked", consecutive_failures: 0, checked_at: null, delisted_at: null, note: "From the public catalog; not probed by this router." },
    });
  }
  return out;
}

/** The public catalog, cached for TOOLS_PUBLIC_CATALOG_TTL_S. A failed refresh keeps serving the previous copy. */
export async function publicCatalog(ctx: Ctx, fetchImpl: ToolFetch = egressFetch(ctx)): Promise<{ items: CatalogItem[]; fetched_at: string | null; configured: boolean }> {
  const url = ctx.cfg.tools.publicCatalogUrl;
  if (!url) return { items: [], fetched_at: null, configured: false };
  const cached = publicCache.get(url);
  if (cached && Date.now() - cached.at < ctx.cfg.tools.publicCatalogTtlMs) return { items: cached.items, fetched_at: new Date(cached.at).toISOString(), configured: true };
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "Anyroute-Tools/1" }, signal: AbortSignal.timeout(10_000) });
    const bytes = res.ok ? await readCapped(res, 2 * 1024 * 1024) : (await res.body?.cancel().catch(() => undefined), null);
    if (!bytes) throw new Error(`catalog status ${res.status}`);
    const items = parsePublicCatalog(ctx, JSON.parse(new TextDecoder().decode(bytes)));
    publicCache.set(url, { at: Date.now(), items });
    return { items, fetched_at: new Date().toISOString(), configured: true };
  } catch {
    log.warn("public tool catalog refresh failed");
    return { items: cached?.items ?? [], fetched_at: cached ? new Date(cached.at).toISOString() : null, configured: true };
  }
}

const matches = (item: CatalogItem, terms: string[]) => terms.every((t) => `${item.name} ${item.summary} ${item.resource}`.toLowerCase().includes(t));

/** Local listings first (passing before unchecked before failing), then facilitator sellers, then the public catalog. */
export async function searchTools(ctx: Ctx, q: string, limit: number, includePublic: boolean) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const local = (await ctx.db.select().from(toolListings).where(eq(toolListings.status, "listed")).orderBy(desc(toolListings.createdAt)).limit(500)).map(listingJson);
  const rank = { passing: 0, unchecked: 1, failing: 2, delisted: 3 } as const;
  local.sort((a, b) => rank[a.quality.state] - rank[b.quality.state]);
  const facilitator = await facilitatorListings(ctx);
  const pub = includePublic ? await publicCatalog(ctx) : { items: [], fetched_at: null, configured: !!ctx.cfg.tools.publicCatalogUrl };
  const seen = new Set<string>();
  const all = [...local, ...facilitator, ...pub.items].filter((i) => (seen.has(i.resource) ? false : (seen.add(i.resource), true))).filter((i) => matches(i, terms));
  return { total: all.length, data: all.slice(0, limit), public_catalog: { configured: pub.configured, fetched_at: pub.fetched_at } };
}

// ---- listing a tool ---------------------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "control characters are not allowed");
export const listingSchema = z.strictObject({
  name: text(80),
  summary: text(280),
  resource: z.string().min(1).max(2048),
  method: z.enum(["GET", "POST"]).default("GET"),
  skill_id: z.string().regex(/^sk_[0-9a-f]{24}$/).optional(),
  canary: z.strictObject({
    /** Query arguments for the probe (without "?"), for tools that read them from the address. */
    query: z.string().max(1_024).regex(/^[^#?\s]*$/, "a query string without ? # or spaces").optional(),
    body: z.unknown().optional(),
    expect: z.strictObject({ contains: z.string().min(1).max(200).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }).refine((e) => !!e.contains !== !!e.sha256, "give exactly one of contains or sha256"),
  }),
});

/**
 * List a resource. The router asks it unpaid first: it must answer 402 with an offer this router can pay, and the
 * listing records that offer's payTo and price. Calls to a listed resource are refused if its payTo later changes.
 */
export async function createListing(ctx: Ctx, key: KeyRow, raw: unknown, fetchImpl: ToolFetch = egressFetch(ctx)) {
  const input = listingSchema.parse(raw);
  if (input.method === "GET" && input.canary.body !== undefined) fail(400, "A GET canary carries no body.", "invalid_request");
  if (input.skill_id) {
    const [skill] = await ctx.db.select({ accountId: skills.accountId, revokedAt: skills.revokedAt }).from(skills).where(eq(skills.id, input.skill_id));
    if (!skill) fail(404, "No such skill.", "skill_not_found");
    if (skill.accountId !== key.accountId) fail(403, "Only the account that published a skill can list its paid invocation.", "forbidden");
    if (skill.revokedAt) fail(403, "This skill was revoked.", "skill_revoked");
  }
  if (toolRequest(ctx, { resource: input.resource }).url.search) fail(400, "List the tool's address without a query string; put the probe's arguments in canary.query.", "invalid_request");
  const req = toolRequest(ctx, { resource: probeAddress(input.resource, input.canary.query), method: input.method, body: input.canary.body });
  const offer = await quoteTool(ctx, req, fetchImpl);
  const [existing] = await ctx.db.select().from(toolListings).where(eq(toolListings.resource, req.resource));
  if (existing && !(existing.status === "removed" && existing.accountId === key.accountId))
    fail(409, existing.status === "delisted" ? "This tool was delisted after failing its canary probes." : "This tool is already listed.", "tool_already_listed", { seller_id: existing.id });
  const canary: CanarySpec = { method: input.method, ...(input.canary.query ? { query: input.canary.query } : {}), ...(input.canary.body !== undefined ? { body: input.canary.body } : {}), expect: input.canary.expect };
  const values = {
    accountId: key.accountId, createdBy: key.keyHash, skillId: input.skill_id ?? null, name: input.name, summary: input.summary, resource: req.resource, method: input.method,
    priceUnits: offer.amount, payTo: offer.payTo.toLowerCase(), network: offer.network, canary, status: "listed", failures: 0, delistedAt: null, checkedAt: null, updatedAt: new Date(),
  };
  const [row] = existing
    ? await ctx.db.update(toolListings).set(values).where(eq(toolListings.id, existing.id)).returning()
    : await ctx.db.insert(toolListings).values({ id: `tl_${randomHex(12)}`, ...values }).returning();
  return row!;
}

export async function removeListing(ctx: Ctx, key: KeyRow, id: string) {
  const [row] = await ctx.db.select().from(toolListings).where(eq(toolListings.id, id));
  if (!row || row.status === "removed") fail(404, "No such tool listing.", "not_found");
  if (row.accountId !== key.accountId) fail(403, "Only the account that listed this tool can remove it.", "forbidden");
  const [updated] = await ctx.db.update(toolListings).set({ status: "removed", updatedAt: new Date() }).where(and(eq(toolListings.id, id), ne(toolListings.status, "removed"))).returning();
  return updated!;
}

export async function listingDetail(ctx: Ctx, id: string) {
  const [row] = await ctx.db.select().from(toolListings).where(eq(toolListings.id, id));
  if (!row || row.status === "removed") fail(404, "No such tool listing.", "not_found");
  const runs = await ctx.db.select().from(toolCanaryRuns).where(eq(toolCanaryRuns.sellerId, id)).orderBy(desc(toolCanaryRuns.at)).limit(10);
  return { ...listingJson(row), canary_runs: runs.map((r) => ({ ok: r.ok, latency_ms: r.latencyMs, failure: r.failure, settle_tx: r.settleTx, at: r.at.toISOString() })) };
}

/** What a Skills Hub skill's detail shows about its paid invocation (empty when it has none or the market is off). */
export async function skillInvocation(ctx: Ctx, skillId: string): Promise<{ invocation?: Record<string, unknown> }> {
  if (!ctx.cfg.tools.enabled) return {};
  const [row] = await ctx.db.select().from(toolListings).where(and(eq(toolListings.skillId, skillId), eq(toolListings.status, "listed"))).limit(1);
  if (!row) return {};
  const item = listingJson(row);
  return { invocation: { tool_id: row.id, resource: row.resource, method: row.method, price_usd: item.price_usd, pay_to: row.payTo, network: row.network, quality: item.quality, call: "/api/v1/tools/call" } };
}

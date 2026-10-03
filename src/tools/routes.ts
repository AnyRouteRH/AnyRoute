import type { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { requireKey, requireRole } from "../api/auth.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { TOOL_CONTENT_TYPES } from "./config.ts";
import { callPaidTool, toolCallJson, type ChatFn } from "./call.ts";
import { createListing, facilitatorListings, listingDetail, listingJson, removeListing, searchTools } from "./catalog.ts";
import { toolCalls, toolListings } from "./schema.ts";

// v6 T routes (all 404 unless TOOLS_MARKET_ENABLED):
//   POST   /api/v1/tools/call                 key: { resource, method?, body?, max_price, then? } -> pay an x402 tool from the balance
//   GET    /api/v1/tools                      public catalog: tool listings with canary state (?include_delisted=true), then facilitator sellers
//   GET    /api/v1/tools/search               ?q=&limit=&public=true: listings, facilitator sellers and the public catalog
//   GET    /api/v1/tools/calls                key: this key's paid tool calls, newest first, with receipts
//   GET    /api/v1/tools/calls/:id            key: one call
//   POST   /api/v1/tools/listings             owner/admin key: list an x402 resource with a known-answer canary
//   DELETE /api/v1/tools/listings/:id         the listing account: remove it
//   GET    /api/v1/tools/:id                  one listing and its last ten canary runs

const LISTING_ID = /^tl_[0-9a-f]{24}$/;
const CALL_ID = /^tc_[0-9a-f]{24}$/;

/** The /api/v1/status section: whether the market is on and whether a paid call can actually be made. */
export function toolsStatus(ctx: Ctx) {
  const t = ctx.cfg.tools;
  return {
    enabled: t.enabled,
    buyer_configured: !!t.buyer,
    ready: t.enabled && !!t.buyer,
    take_bps: t.takeBps,
    max_price_usd: t.maxPriceUsd,
    daily_limit_usd: t.dailyLimitUsd,
    max_response_bytes: t.maxResponseBytes,
    content_types: [...TOOL_CONTENT_TYPES, "application/*+json"],
    x402_versions: [1, 2],
    pays: { scheme: "exact", asset: "USDG", networks: [ctx.cfg.x402.network, `eip155:${ctx.cfg.chain.id}`] },
    public_catalog: !!t.publicCatalogUrl,
    canary_interval_ms: t.canaryIntervalMs,
  };
}

export function toolsRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.tools.enabled) return;
  // The optional model step reuses the router's own chat route in-process with the caller's key: same billing, rulebook and receipt.
  const chatWith = (authorization: string): ChatFn => async (body) => {
    const res = await app.request("/api/v1/chat/completions", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };

  app.post("/api/v1/tools/call", async (c) => {
    const authorization = c.req.header("authorization");
    const key = await requireKey(ctx, authorization);
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    const data = await callPaidTool(ctx, key, await readJson(c), { chat: chatWith(authorization!) });
    c.header("x-anyroute-tool-call", data.id);
    c.header("cache-control", "no-store");
    return c.json({ data });
  });

  app.get("/api/v1/tools", async (c) => {
    const all = c.req.query("include_delisted") === "true";
    const rows = await ctx.db.select().from(toolListings).orderBy(desc(toolListings.createdAt)).limit(500);
    const local = rows.filter((r) => r.status === "listed" || (all && r.status === "delisted")).map(listingJson);
    // Sellers listed through the facilitator (join point in catalog.ts), unless the same address is a tool listing.
    const known = new Set(rows.map((r) => r.resource));
    const data = [...local, ...(await facilitatorListings(ctx)).filter((f) => !known.has(f.resource))];
    c.header("cache-control", "public, max-age=30");
    return c.json({ data, call: "/api/v1/tools/call", status: toolsStatus(ctx) });
  });

  app.get("/api/v1/tools/search", async (c) => {
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(c.req.query("limit") ?? 25)) || 25));
    const q = (c.req.query("q") ?? "").trim().slice(0, 200);
    c.header("cache-control", "public, max-age=30");
    return c.json(await searchTools(ctx, q, limit, c.req.query("public") !== "false"));
  });

  app.get("/api/v1/tools/calls", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const rows = await ctx.db.select().from(toolCalls).where(eq(toolCalls.keyHash, key.keyHash)).orderBy(desc(toolCalls.createdAt)).limit(50);
    c.header("cache-control", "no-store");
    return c.json({ data: rows.map(toolCallJson) });
  });

  app.get("/api/v1/tools/calls/:id", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const id = c.req.param("id");
    if (!CALL_ID.test(id)) fail(404, "No such tool call.", "not_found");
    const [row] = await ctx.db.select().from(toolCalls).where(and(eq(toolCalls.id, id), eq(toolCalls.keyHash, key.keyHash)));
    if (!row) fail(404, "No such tool call.", "not_found");
    c.header("cache-control", "no-store");
    return c.json({ data: toolCallJson(row!) });
  });

  app.post("/api/v1/tools/listings", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner", "admin"]);
    if (!(await ctx.limiter.take(`tools-list:${key.accountId}`, 1, 20, 3_600_000)).ok) fail(429, "Too many tool listings from this account. Try again within the hour.", "rate_limited");
    const row = await createListing(ctx, key, await readJson(c));
    return c.json({ data: listingJson(row) }, 201);
  });

  app.delete("/api/v1/tools/listings/:id", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner", "admin"]);
    const id = c.req.param("id");
    if (!LISTING_ID.test(id)) fail(404, "No such tool listing.", "not_found");
    const row = await removeListing(ctx, key, id);
    return c.json({ data: { id: row.id, status: row.status } });
  });

  app.get("/api/v1/tools/:id", async (c) => {
    const id = c.req.param("id");
    if (!LISTING_ID.test(id)) fail(404, "No such tool listing.", "not_found");
    c.header("cache-control", "public, max-age=30");
    return c.json({ data: await listingDetail(ctx, id) });
  });
}

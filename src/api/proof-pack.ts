import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { requireKey } from "./auth.ts";
import { fail } from "../lib/errors.ts";
import { PROOF_PACK_LIMITS, proofPackLimits, proofPackQuery, readProofPack } from "../proof-pack/read.ts";

// U100: proof packs. Read-only over existing receipts, refund receipts and statements, so it follows STATEMENTS_ENABLED
// and the statement and Activity key rules: management and owner/admin keys read the account, other keys only themselves.
export function proofPackRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.statementsEnabled) return;
  app.get("/api/v1/proof-pack/limits", async (c) => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    return c.json({ data: await proofPackLimits(ctx, key) });
  });
  app.get("/api/v1/proof-pack", async (c) => {
    c.header("cache-control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const query = proofPackQuery(c.req.query());
    const rate = await ctx.limiter.take(`proof-pack:${key.keyHash}`, 1, PROOF_PACK_LIMITS.perMinute, 60_000);
    if (!rate.ok) fail(429, "Too many proof packs from this key. Try again within a minute.", "rate_limited", undefined, { "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))) });
    const pack = await readProofPack(ctx, key, query);
    c.header("content-disposition", `attachment; filename="anyroute-proof-pack-${pack.range.from}-to-${pack.range.to}${pack.part > 1 ? `-part-${pack.part}` : ""}.json"`);
    return c.json({ data: pack });
  });
}

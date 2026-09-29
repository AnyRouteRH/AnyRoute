import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { issueClaim, readClaim, verifyClaim } from "../services/creators.ts";
import { addressBucket, readJson } from "./common.ts";

// Creator royalty claims (public, rate limited). See services/creators.ts.
//
//   POST /api/v1/creators/claims                             get a challenge for a model's royalty
//   GET  /api/v1/creators/claims/{id}
//   POST /api/v1/creators/claims/{id}/verify                 check the published challenge, record the recipient

const text = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "must not contain control characters");

export function creatorClaimRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/creators/claims", async (c) => {
    const v = z.object({ model: text(160), address: z.string(), hf_handle: text(96).optional() }).strict().parse(await readJson(c));
    return c.json({ data: await issueClaim(ctx, { model: v.model, address: v.address, handle: v.hf_handle }, addressBucket(c, ctx.cfg)) }, 201);
  });
  app.get("/api/v1/creators/claims/:id", async (c) => c.json({ data: await readClaim(ctx, c.req.param("id")) }));
  app.post("/api/v1/creators/claims/:id/verify", async (c) => c.json({ data: await verifyClaim(ctx, c.req.param("id"), addressBucket(c, ctx.cfg)) }));
}

import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { sanctionsStatus } from "../network/sanctions.ts";

export function networkSanctionsRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/network/sanctions", async (c) => c.json({ data: await sanctionsStatus(ctx) }));
}

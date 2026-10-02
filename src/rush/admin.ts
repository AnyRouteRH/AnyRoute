import { readFunnel } from "./funnel.ts";
import { upstreamAdminView } from "./monitor.ts";
import type { Ctx } from "../context.ts";

/** Called only by the existing tRPC operator procedure. No account rows leave the query. */
export async function rushAdmin(ctx: Ctx, days: number) {
  const [upstream, funnel] = await Promise.all([upstreamAdminView(ctx), readFunnel(ctx.db, days)]);
  return { upstream, funnel, catalog_cache_enabled: ctx.cfg.rush.catalogCache };
}

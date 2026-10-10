import type { Hono, Context } from "hono";
import type { Catalog } from "../catalog/catalog.ts";
import type { Ctx } from "../context.ts";

export const CATALOG_TTL_MS = 30_000;
/** Bounded, per-process cache. Successful sync discards cached JSON and in-flight results. */
export class CatalogJsonCache {
  private entries = new Map<string, { body: string; until: number }>();
  private pending = new Map<string, Promise<string | null>>();
  private revision = 0;
  constructor(private now = Date.now) {}
  invalidate() { this.revision++; this.entries.clear(); this.pending.clear(); }
  async get(key: string, compute: () => Promise<string | null>) {
    const old = this.entries.get(key);
    if (old && old.until > this.now()) return old.body;
    if (this.pending.has(key)) return this.pending.get(key)!;
    if (this.pending.size >= 64) return compute();
    const revision = this.revision;
    const result = compute().then(body => {
      if (body !== null && revision === this.revision) {
        if (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, { body, until: this.now() + CATALOG_TTL_MS });
      }
      return body;
    }).finally(() => { if (this.pending.get(key) === result) this.pending.delete(key); });
    this.pending.set(key, result);
    return result;
  }
}
const caches = new WeakMap<Catalog, CatalogJsonCache>();
export function invalidateCatalogJson(catalog: Catalog) { caches.get(catalog)?.invalidate(); }

export function cacheModelLists(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.rush.catalogCache) return;
  const cache = new CatalogJsonCache();
  caches.set(ctx.catalog, cache);
  const middleware = async (c: Context, next: () => Promise<void>) => {
    if (c.req.query("health") === "recent") { await next(); return; } // E150: fresh opt-in readings never share the default cache.
    // Warm only after freshness has been checked; a sync during compute must not cache an older revision.
    const query = JSON.stringify(["supported_parameters", "lane", "variant", "output_modalities"].map(name => c.req.query(name) ?? ""));
    const body = await cache.get(query, async () => {
      await next();
      return c.res.status === 200 ? c.res.clone().text() : null;
    });
    if (body !== null) c.res = new Response(body, { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=30" } });
    if (!c.finalized) await next();
  };
  app.use("/api/v1/models", middleware);
  app.use("/v1/models", middleware);
}

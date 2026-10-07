// C131: public Atom feed from the same visible catalogue as the models API.
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { MODEL_CAPABILITIES } from "../catalog/model-capabilities.js";
import { addedWithin } from "../catalog/model-arrivals.ts";
import { CatalogJsonCache } from "../rush/cache.ts";
import { modelJson, servable } from "./models.ts";

const escapeXml = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
type FeedModel = { id: string; name: string; added_at: number | null; capabilities?: string[]; pricing: { prompt: string; completion: string } };
export function modelsAtom(models: FeedModel[], now = Math.floor(Date.now() / 1000)) {
  const recent = models.filter(m => addedWithin(m.added_at, 30, now)).sort((a, b) => b.added_at! - a.added_at! || a.id.localeCompare(b.id));
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const home = "https://anyroute.tech/models/";
  const entries = recent.map(m => `<entry><id>${escapeXml(home + "#" + encodeURIComponent(m.id))}</id><title>${escapeXml(m.name)}</title><link href="${escapeXml("https://anyroute.tech/harness/?model=" + encodeURIComponent(m.id))}"/><published>${iso(m.added_at!)}</published><updated>${iso(m.added_at!)}</updated><summary>${escapeXml(`${MODEL_CAPABILITIES.filter(tag => m.capabilities?.includes(tag.key)).map(tag => tag.label).join(", ") || "See model abilities in the catalogue"}. Per token: input $${m.pricing.prompt}; output $${m.pricing.completion}.`)}</summary></entry>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${home}new</id><title>Anyroute: new models</title><link href="https://anyroute.tech/api/v1/models/new.atom" rel="self"/><link href="${home}"/><author><name>Anyroute</name></author><updated>${iso(recent[0]?.added_at ?? now)}</updated>${entries}</feed>`;
}
export function newModelsFeedRoutes(app: Hono, ctx: Ctx) {
  const cache = new CatalogJsonCache();
  let loadedAt = -1;
  app.get("/api/v1/models/new.atom", async c => {
    await ctx.catalog.ensureFresh();
    if (loadedAt !== ctx.catalog.loadedAt) { cache.invalidate(); loadedAt = ctx.catalog.loadedAt; }
    const body = await cache.get("atom", async () => modelsAtom(ctx.cfg.modelArrivalsEnabled ? [...ctx.catalog.models.values()]
      .filter(m => !m.hidden && servable(ctx, m).length > 0)
      .map(m => ({ ...modelJson(ctx, m), added_at: ctx.catalog.addedAt?.get(m.id) ?? null })) : []));
    return new Response(body, { headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "public, max-age=30" } });
  });
}

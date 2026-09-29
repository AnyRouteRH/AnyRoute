import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { ipxSnapshot, snapshotJson, IPX_DECIMALS } from "../services/ipx.ts";

const TTL_MS = 60_000;

// The inference price index (services/ipx.ts). Public and read-only: aggregates only, no account or
// request data. Answers 404 unless IPX_ENABLED. Results are cached for a minute per class and hour.
export function ipxRoutes(app: Hono, ctx: Ctx) {
  const cache = new Map<string, { at: number; body: unknown }>();
  const enabled = () => {
    if (!ctx.cfg.ipx.enabled) throw new ApiError(404, "The inference price index is not enabled on this router.", "ipx_disabled");
  };

  app.get("/api/v1/ipx", (c) => {
    enabled();
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ data: ctx.cfg.ipx.classes.map((k) => ({ class: k.id, description: `ANYR-IPX/${k.id}`, unit: "USDG per 1,000,000 tokens", decimals: IPX_DECIMALS, models: k.models })) });
  });

  app.get("/api/v1/ipx/:class", async (c) => {
    enabled();
    const id = c.req.param("class").toUpperCase();
    const cls = ctx.cfg.ipx.classes.find((k) => k.id === id);
    if (!cls) throw new ApiError(404, `Unknown index class ${id.slice(0, 40)}.`, "unknown_ipx_class");
    const hour = Math.floor(Date.now() / 3_600_000);
    const key = `${id}:${hour}`;
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > TTL_MS) {
      hit = { at: Date.now(), body: { data: snapshotJson(await ipxSnapshot(ctx, cls), cls, ctx.cfg) } };
      for (const k of cache.keys()) if (!k.endsWith(`:${hour}`)) cache.delete(k);
      cache.set(key, hit);
    }
    c.header("Cache-Control", "public, max-age=60");
    return c.json(hit.body as object);
  });
}

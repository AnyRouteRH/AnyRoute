import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { safeEqual } from "../lib/util.ts";
import { ipxSnapshot, snapshotJson, IPX_DECIMALS } from "../services/ipx.ts";
import { KvOracleStore, oracleView, setOracleHalt } from "../services/ipx-oracle.ts";
import { bearer } from "./auth.ts";
import { readJson } from "./common.ts";

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

  // The oracle publisher's latest signed update (services/ipx-oracle.ts). Reads stored records only; the worker signs.
  // Answers 404 unless IPX_ENABLED and IPX_ORACLE_ENABLED. Never cached: a consumer must see a halt at once.
  const oracleEnabled = () => {
    enabled();
    if (!ctx.cfg.ipx.oracle.enabled) throw new ApiError(404, "The IPX oracle publisher is not enabled on this router.", "ipx_oracle_disabled");
  };

  app.get("/api/v1/ipx/:class/oracle", async (c) => {
    oracleEnabled();
    const id = c.req.param("class").toUpperCase();
    const cls = ctx.cfg.ipx.classes.find((k) => k.id === id && ctx.cfg.ipx.oracle.classes.includes(k.id));
    if (!cls) throw new ApiError(404, `Unknown index class ${id.slice(0, 40)}.`, "unknown_ipx_class");
    c.header("Cache-Control", "no-store");
    return c.json({ data: await oracleView(ctx, cls) });
  });

  // Kill switch. Operator token required. { "halted": true, "reason": "..." } freezes publishing on the next tick and marks
  // every read halted at once; { "halted": false } lifts it. IPX_ORACLE_HALTED in the configuration overrides this.
  app.put("/api/v1/ipx/oracle/halt", async (c) => {
    oracleEnabled();
    const token = c.req.header("x-admin-token") ?? bearer(c.req.header("authorization"));
    if (!ctx.cfg.adminToken || !token || !safeEqual(token, ctx.cfg.adminToken)) throw new ApiError(401, "Operator token required.", "unauthorized");
    const body = await readJson(c);
    if (typeof body.halted !== "boolean") throw new ApiError(400, "halted must be true or false.", "invalid_request");
    const h = await setOracleHalt(new KvOracleStore(ctx.db), { halted: body.halted, reason: body.reason });
    return c.json({ data: { halted: h.halted, reason: h.reason, since: h.since, config_halted: ctx.cfg.ipx.oracle.halted } });
  });
}

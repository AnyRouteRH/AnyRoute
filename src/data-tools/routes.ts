import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { x402Enabled } from "../pay/x402.ts";
import { ipxSnapshot, snapshotJson } from "../services/ipx.ts";
import { chargeDataCall } from "./charge.ts";
import { findStockToken, readStock, stockActionsJson, stockPriceJson, stockTokens } from "./stock.ts";

// B: per-call market-data tools for agents, served by the router itself (DATA_TOOLS_ENABLED, default false):
//   GET /api/v1/data                          free: the tools, the price, the symbols and classes, how to pay
//   GET /api/v1/data/stock/:symbol            paid: a Stock Token's price from its Chainlink feed (stock.ts)
//   GET /api/v1/data/stock/:symbol/actions    paid: its multiplier (corporate actions) and halt status
//   GET /api/v1/data/ipx/:class               paid: the inference price index for a model class (needs IPX_ENABLED)
// Each paid call reads first and charges after (charge.ts): an unknown symbol, a stale feed or a paused token costs nothing.
// Read-only: nothing here signs a transaction, places an order or touches any brokerage account.

const PATHS = { stock: "/api/v1/data/stock/{symbol}", actions: "/api/v1/data/stock/{symbol}/actions", ipx: "/api/v1/data/ipx/{class}" };

/** The `data_tools` section of GET /api/v1/status: what is switched on, from the configuration and the chain role. */
export function dataToolsStatus(ctx: Ctx) {
  const on = ctx.cfg.dataTools.enabled;
  return {
    enabled: on,
    price_usd: ctx.cfg.dataTools.priceUsd,
    tools: on ? [PATHS.stock, PATHS.actions, ...(ctx.cfg.ipx.enabled ? [PATHS.ipx] : [])] : [],
    symbols: on ? stockTokens(ctx).map((t) => t.symbol) : [],
    // Keys pay from their balance whenever the tools are on; keyless payment needs per-call payment configured.
    payment: { prepaid_key: on, x402: on && x402Enabled(ctx), callpay: on && !!ctx.chain.address("callPay") },
  };
}

export function dataToolsRoutes(app: Hono, ctx: Ctx) {
  const on = () => {
    if (!ctx.cfg.dataTools.enabled) throw new ApiError(404, "Data tools are not enabled on this router.", "data_tools_disabled");
  };
  const ipxCache = new Map<string, { at: number; body: ReturnType<typeof snapshotJson> }>();

  app.get("/api/v1/data", (c) => {
    on();
    c.header("Cache-Control", "public, max-age=60");
    const status = dataToolsStatus(ctx);
    return c.json({
      data: {
        price_usd: status.price_usd,
        payment: status.payment,
        tools: [
          { path: PATHS.stock, description: "Price of one whole Stock Token in USD from its Chainlink feed on Robinhood Chain. Refused (503, not charged) when the feed is stale or the token is paused." },
          { path: PATHS.actions, description: "The token's uiMultiplier, any scheduled multiplier change with its effective time, and whether the token reports paused." },
          ...(ctx.cfg.ipx.enabled ? [{ path: PATHS.ipx, description: "The inference price index for a model class: USDG per 1,000,000 tokens, volume-weighted over signed receipts." }] : []),
        ],
        symbols: status.symbols,
        ipx_classes: ctx.cfg.ipx.enabled ? ctx.cfg.ipx.classes.map((k) => k.id) : [],
        note: "Read-only market data. Anyroute never places orders and never asks for brokerage credentials.",
      },
    });
  });

  app.get("/api/v1/data/stock/:symbol", async (c) => {
    on();
    const token = findStockToken(ctx, c.req.param("symbol"));
    const data = stockPriceJson(ctx, token, await readStock(ctx, token));
    const charge = await chargeDataCall(ctx, c, { tool: "stock_price", description: `Data tool: ${token.symbol} Stock Token price` });
    c.header("Cache-Control", "no-store");
    return c.json({ data, charge: charge.json }, 200, charge.headers);
  });

  app.get("/api/v1/data/stock/:symbol/actions", async (c) => {
    on();
    const token = findStockToken(ctx, c.req.param("symbol"));
    const data = stockActionsJson(ctx, token, await readStock(ctx, token));
    const charge = await chargeDataCall(ctx, c, { tool: "stock_actions", description: `Data tool: ${token.symbol} corporate-action status` });
    c.header("Cache-Control", "no-store");
    return c.json({ data, charge: charge.json }, 200, charge.headers);
  });

  app.get("/api/v1/data/ipx/:class", async (c) => {
    on();
    if (!ctx.cfg.ipx.enabled) throw new ApiError(404, "The inference price index is not enabled on this router.", "ipx_disabled");
    const id = c.req.param("class").toUpperCase();
    const cls = ctx.cfg.ipx.classes.find((k) => k.id === id);
    if (!cls) throw new ApiError(404, `Unknown index class ${id.slice(0, 40)}.`, "unknown_ipx_class");
    const key = `${id}:${Math.floor(Date.now() / 3_600_000)}`;
    let hit = ipxCache.get(key);
    if (!hit || Date.now() - hit.at > 60_000) {
      hit = { at: Date.now(), body: snapshotJson(await ipxSnapshot(ctx, cls), cls, ctx.cfg) };
      for (const k of ipxCache.keys()) if (k !== key) ipxCache.delete(k);
      ipxCache.set(key, hit);
    }
    if (hit.body.price === null) throw new ApiError(503, `The ${id} index has no fills in its window, so there is no price to sell. Nothing was charged.`, "ipx_no_price", undefined, { "retry-after": "300" });
    const charge = await chargeDataCall(ctx, c, { tool: "ipx", description: `Data tool: ${id} inference price index` });
    c.header("Cache-Control", "no-store");
    return c.json({ data: { object: "data.ipx", ...hit.body }, charge: charge.json }, 200, charge.headers);
  });
}

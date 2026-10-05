import { gatewayOrigin } from "../ohttp/origin.ts";
import { batchTooLarge, MCP_BATCH_MAX } from "./mcp-batch.ts";
import type { MiddlewareHandler } from "hono";
import type { Ctx } from "../context.ts";
import { addressBucket, viaOnion } from "../api/common.ts";
import { bearer, resolveKey } from "../api/auth.ts";
import { log } from "../lib/util.ts";
import { capBody, requestCap } from "./body.ts";
import { internalCaller, validOriginLock } from "./client.ts";
export const originLockMiddleware = (ctx: Ctx): MiddlewareHandler => async (c, next) => {
  c.set("hardening", ctx.cfg.hardening);
  c.set("onionIngress", viaOnion(c, ctx.cfg));
  const exempt = c.req.path === "/health" || c.req.path === "/ready";
  // Do not read any address on authenticated onion ingress.
  const internal = !!gatewayOrigin(c.req.raw) || (!c.get("onionIngress") && internalCaller(c));
  if (ctx.cfg.hardening.originLockEnabled && !exempt && !c.get("onionIngress") && !internal && !validOriginLock(c, ctx.cfg.hardening))
    return c.json({ error: { type: "origin_locked", message: "Use the public router address." } }, 403);
  c.set("internalCaller", internal);
  await next();
};
export const hardeningMiddleware = (ctx: Ctx): MiddlewareHandler => async (c, next) => {
  const exempt = c.req.path === "/health" || c.req.path === "/ready";
  const internal = c.get("internalCaller") === true;
  const rejected = await capBody(c, requestCap(c.req.path, ctx.cfg));
  if (rejected) return rejected;
  const publicRead = ["GET", "HEAD"].includes(c.req.method) && /^\/(api\/|v1\/|ollama\/|facilitator\/|\.well-known\/|keep\/inventory\.json$)/.test(c.req.path);
  const mcp = c.req.method === "POST" && c.req.path === "/mcp";
  let amount = 1;
  if (mcp) {
    try { const msg = await c.req.json(); if (Array.isArray(msg)) { if (msg.length > MCP_BATCH_MAX) return batchTooLarge(c); amount = Math.max(1, msg.length); } } catch { /* route returns the JSON-RPC parse error */ }
  }
  if (!exempt && !internal && (publicRead || mcp)) {
    const secret = bearer(c.req.header("authorization")) ?? c.req.header("x-api-key");
    let keyed = false;
    if (secret) { try { keyed = !!await resolveKey(ctx, secret); } catch { /* invalid keys do not evade the anonymous limit */ } }
    if (!keyed) {
      const from = addressBucket(c, ctx.cfg);
      try {
        const result = await ctx.limiter.take(`anon:${from.id}`, amount, from.scale(ctx.cfg.hardening.anonRatePerMin), 60_000);
        if (!result.ok) return c.json({ error: { type: "rate_limited", message: "Too many anonymous requests. Try again shortly." } }, 429, { "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) });
      } catch { log.warn("anonymous limiter unavailable; request allowed"); }
    }
  }
  await next();
};

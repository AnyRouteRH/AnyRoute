import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { Catalog } from "./catalog/catalog.ts";
import { HealthTracker } from "./services/health.ts";
import { ReceiptSigner } from "./receipts/signer.ts";
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./lib/ratelimit.ts";
import { ChainService } from "./chain/service.ts";
import { ResponseCache } from "./gateway/cache.ts";
import { Telemetry } from "./gateway/otel.ts";
import { Jobs } from "./services/jobs.ts";
import type { Ctx } from "./context.ts";
import { ApiError } from "./lib/errors.ts";
import { log, setLogLevel } from "./lib/util.ts";
import { chatRoutes } from "./api/chat.ts";
import { modelsRoutes } from "./api/models.ts";
import { generationRoutes } from "./api/generation.ts";
import { keysRoutes } from "./api/keys.ts";
import { publicRoutes } from "./api/public.ts";
import { embeddingsRoutes } from "./api/embeddings.ts";
import { adminRoutes } from "./admin/trpc.ts";
import { paymasterRoutes } from "./api/paymaster.ts";
import { registerJobs } from "./services/register.ts";
import { siteRoutes } from "./api/site.ts";

export type AppOptions = {
  env?: Record<string, unknown>;
  rand?: () => number;
  chain?: ChainService;
  startJobs?: boolean;
};

export async function createApp(opts: AppOptions = {}) {
  const cfg = loadConfig(opts.env ?? {});
  setLogLevel(cfg.logLevel);
  const handle = await openDatabase(cfg.databaseUrl);
  const redis = cfg.redisUrl ? new (await import("ioredis")).Redis(cfg.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false }) : undefined;
  const limiter: RateLimiter = redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter();
  const signer = new ReceiptSigner(handle.db, cfg.appSecret, cfg.receipts.rotationDays, cfg.receipts.signingKey);
  await signer.init();
  const catalog = new Catalog(handle.db);
  await catalog.refresh();
  const health = new HealthTracker(cfg.routing.outageWindowMs);
  await health.refreshAggregates(handle.db).catch(() => undefined);

  const ctx: Ctx = {
    cfg,
    db: handle.db,
    dbKind: handle.kind,
    catalog,
    health,
    signer,
    limiter,
    chain: opts.chain ?? new ChainService(cfg),
    cache: new ResponseCache(cfg.appSecret, 5_000, redis),
    telemetry: new Telemetry(cfg.gateway.otlpEndpoint, cfg.gateway.otelServiceName),
    jobs: new Jobs(cfg.redisUrl),
    rand: opts.rand,
  };

  const app = new Hono();
  app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-pay-with", "x-payment", "x-wallet-auth", "x-anyroute-cache", "http-referer", "x-title", "traceparent"], exposeHeaders: ["x-generation-id", "x-payment-required", "retry-after"] }));
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    if (cfg.production) c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  });

  chatRoutes(app, ctx);
  embeddingsRoutes(app, ctx);
  modelsRoutes(app, ctx);
  generationRoutes(app, ctx);
  keysRoutes(app, ctx);
  publicRoutes(app, ctx);
  paymasterRoutes(app, ctx);
  adminRoutes(app, ctx);
  // The website (web/out, a static Next.js export) is served at / when it has been built; otherwise
  // a small built-in page lists models and rankings.
  const webDir = resolve(cfg.webDir ?? resolve(import.meta.dir, "../web/out"));
  const webBuilt = existsSync(resolve(webDir, "index.html"));
  if (webBuilt) {
    app.use("/_next/static/*", async (c, next) => {
      await next();
      c.header("cache-control", "public, max-age=31536000, immutable");
    });
    app.use("*", serveStatic({ root: webDir }));
    if (existsSync(resolve(webDir, "brand/anyroute-symbol.png"))) app.get("/favicon.ico", (c) => c.redirect("/brand/anyroute-symbol.png", 301));
  } else siteRoutes(app, ctx);
  const notFoundPage = webBuilt && existsSync(resolve(webDir, "404.html")) ? readFileSync(resolve(webDir, "404.html"), "utf8") : null;

  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    if (notFoundPage && c.req.method === "GET" && !/^\/(api|v1|trpc)\//.test(path)) return c.html(notFoundPage, 404);
    return c.json(new ApiError(404, `No route for ${c.req.method} ${path}.`, "not_found").toJSON(), 404);
  });
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      return c.json(err.toJSON(), err.status as never);
    }
    if (err instanceof ZodError) {
      return c.json(new ApiError(400, "Invalid request: " + err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), "invalid_request").toJSON(), 400);
    }
    if ((err as Error)?.name === "AbortError") return c.json(new ApiError(499, "Client closed the request.", "cancelled").toJSON(), 499 as never);
    log.error("unhandled error", { path: new URL(c.req.url).pathname, error: (err as Error)?.message, stack: (err as Error)?.stack?.split("\n").slice(0, 5).join(" | ") });
    return c.json(new ApiError(500, "Internal router error.", "internal").toJSON(), 500);
  });

  registerJobs(ctx);
  if (opts.startJobs ?? cfg.workers.enabled) await ctx.jobs.start();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await ctx.jobs.stop();
    await ctx.health.flush(ctx.db).catch(() => undefined);
    await ctx.telemetry.close();
    await limiter.close();
    redis?.disconnect();
    await handle.close();
  };
  return { app, ctx, close, fetch: app.fetch };
}

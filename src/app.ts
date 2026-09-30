import { siteCsp } from "./lib/csp.ts";
import { EXPOSED_RESPONSE_HEADERS, viaOnion } from "./api/common.ts";
import { onionIngress } from "./onion/ingress.ts";
import { kv } from "./db/schema.ts";
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
import { TracingExporter } from "./services/tracing.ts";
import { Jobs } from "./services/jobs.ts";
import type { Ctx } from "./context.ts";
import { ApiError } from "./lib/errors.ts";
import { log, setLogLevel } from "./lib/util.ts";
import { chatRoutes } from "./api/chat.ts";
import { modelsRoutes } from "./api/models.ts";
import { generationRoutes } from "./api/generation.ts";
import { keysRoutes } from "./api/keys.ts";
import { teamsRoutes } from "./api/teams.ts";
import { escrowRoutes } from "./api/escrow.ts";
import { savedRoutesRoutes } from "./api/saved-routes.ts";
import { presetsRoutes } from "./api/presets.ts";
import { characterRoutes } from "./api/characters.ts";
import { memoryRoutes } from "./api/memory.ts";
import { agentSessionsRoutes } from "./api/agent-sessions.ts";
import { spendRoutes } from "./api/spend.ts";
import { holdersRoutes } from "./api/holders.ts";
import { disclosureRoutes } from "./api/disclosure.ts";
import { ipxRoutes } from "./api/ipx.ts";
import { attestationRoutes } from "./api/attestation.ts";
import { attestationHistoryRoutes } from "./api/attestation-history.ts";
import { measurementRoutes } from "./api/measurements.ts";
import { laneRoutes } from "./api/lane.ts";
import { dayzeroRoutes } from "./api/dayzero.ts";
import { creatorClaimRoutes } from "./api/creator-claims.ts";
import { publicRoutes } from "./api/public.ts";
import { embeddingsRoutes } from "./api/embeddings.ts";
import { batchesRoutes } from "./api/batches.ts";
import { rerankRoutes } from "./api/rerank.ts";
import { adminRoutes } from "./admin/trpc.ts";
import { paymasterRoutes } from "./api/paymaster.ts";
import { registerJobs } from "./services/register.ts";
import { mcpRoutes } from "./api/mcp.ts";
import { anthropicRoutes } from "./api/anthropic.ts";
import { ollamaRoutes } from "./ollama/routes.ts";
import { responsesRoutes } from "./api/responses.ts";
import { ragRoutes } from "./api/rag.ts";
import { siteRoutes } from "./api/site.ts";
import { badgeRoutes } from "./api/badge.ts";
import { BlindIssuer } from "./blind/issuer.ts";
import { ensurePool } from "./blind/redeem.ts";
import { blindRoutes } from "./blind/routes.ts";
import { OhttpKeys } from "./ohttp/keys.ts";
import { ohttpRoutes } from "./ohttp/gateway.ts";
import { hostAnchorRoutes } from "./api/host-anchor.ts";
import { TransparencyLog } from "./tlog/log.ts";
import { tlogRoutes } from "./tlog/routes.ts";
import { statusRoutes } from "./api/status.ts";
import { skillsRoutes } from "./api/skills.ts";
import { startStatusLoop, statusMiddleware } from "./services/slo.ts";

export type AppOptions = {
  env?: Record<string, unknown>;
  rand?: () => number;
  chain?: ChainService;
  startJobs?: boolean;
};

export async function createApp(opts: AppOptions = {}) {
  const cfg = loadConfig(opts.env ?? {});
  setLogLevel(cfg.logLevel);
  const handle = await openDatabase(cfg.databaseUrl, { migrate: cfg.autoMigrate });
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
    tracing: new TracingExporter(cfg.appSecret),
    jobs: new Jobs(cfg.redisUrl, async (state) => {
      const value = { ...state, last_error: state.last_error ? "Job failed; inspect private operator logs." : null };
      await handle.db.insert(kv).values({ key: `job-health:${state.name}`, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
    }, cfg.runtimeRole === "worker" ? cfg.workerJobs : undefined),
    rand: opts.rand,
    blind: cfg.blind.enabled ? new BlindIssuer(handle.db, cfg) : undefined,
    ohttp: cfg.ohttp.enabled ? new OhttpKeys(handle.db, cfg) : undefined,
    tlog: cfg.tlog.enabled ? new TransparencyLog(handle.db, cfg.tlog).start() : undefined,
  };
  if (ctx.blind) await ensurePool(ctx);

  const webDir = resolve(cfg.webDir ?? resolve(import.meta.dir, "../web/out"));
  const webBuilt = existsSync(resolve(webDir, "index.html"));
  const csp = webBuilt ? siteCsp(webDir) : "frame-ancestors 'none'; object-src 'none'; base-uri 'none'";
  const app = new Hono();
  // The OpenAI-style /v1/* aliases get the same CORS as /api/*, so a browser can read the receipt, lane and policy headers on either.
  const apiCors = cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-pay-with", "x-payment", "x-wallet-auth", "x-anyroute-cache", "x-anyroute-disclosure-max", "x-anyroute-lane", "x-anyroute-lane-downgrade", "http-referer", "x-title", "traceparent", "x-api-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access"], exposeHeaders: EXPOSED_RESPONSE_HEADERS });
  app.use("/api/*", apiCors);
  app.use("/v1/*", apiCors);
  app.use("/ollama/*", apiCors);
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    if (c.res.headers.get("content-type")?.includes("text/html")) {
      c.header("content-security-policy", csp);
      // Tell Tor Browser this page has an onion twin (only on the clearnet site; it does nothing without ONION_ADDRESS).
      if (cfg.onion.address && c.req.method === "GET" && !viaOnion(c, cfg)) {
        const url = new URL(c.req.url);
        c.header("onion-location", `http://${cfg.onion.address}${url.pathname}${url.search}`);
      }
    }
    if (cfg.production) c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  });

  app.use("*", onionIngress(cfg)); // onion requests: drop every client address header before any route reads one
  app.use("*", statusMiddleware(ctx)); // public-lane outcomes per API surface for /api/v1/status/slo; private lanes are not counted here
  chatRoutes(app, ctx);
  embeddingsRoutes(app, ctx);
  batchesRoutes(app, ctx);
  rerankRoutes(app, ctx);
  modelsRoutes(app, ctx);
  generationRoutes(app, ctx);
  keysRoutes(app, ctx);
  teamsRoutes(app, ctx);
  escrowRoutes(app, ctx);
  savedRoutesRoutes(app, ctx);
  presetsRoutes(app, ctx);
  characterRoutes(app, ctx);
  memoryRoutes(app, ctx);
  agentSessionsRoutes(app, ctx);
  spendRoutes(app, ctx);
  holdersRoutes(app, ctx);
  disclosureRoutes(app, ctx);
  ipxRoutes(app, ctx);
  attestationHistoryRoutes(app, ctx); // before attestationRoutes: /attestation/summary must not be read as a provider id
  attestationRoutes(app, ctx);
  measurementRoutes(app, ctx);
  badgeRoutes(app, ctx);
  laneRoutes(app, ctx);
  dayzeroRoutes(app, ctx);
  creatorClaimRoutes(app, ctx);
  if (ctx.blind) blindRoutes(app, ctx);
  if (ctx.ohttp) ohttpRoutes(app, ctx);
  if (ctx.cfg.hostAnchor.enabled) hostAnchorRoutes(app, ctx);
  if (ctx.tlog) tlogRoutes(app, ctx);
  statusRoutes(app, ctx);
  skillsRoutes(app, ctx);
  publicRoutes(app, ctx);
  mcpRoutes(app, ctx);
  anthropicRoutes(app, ctx);
  ollamaRoutes(app, ctx);
  responsesRoutes(app, ctx);
  ragRoutes(app, ctx);
  paymasterRoutes(app, ctx);
  adminRoutes(app, ctx);
  // The website (web/out, a static Next.js export) is served at / when it has been built; otherwise
  // a small built-in page lists models and rankings.

  if (webBuilt) {
    app.use("/_next/static/*", async (c, next) => {
      await next();
      c.header("cache-control", "public, max-age=31536000, immutable");
    });
    app.use("*", serveStatic({ root: webDir }));
    // /registry/<provider id>/ is one static page (exported as /registry/_/) that reads the id from the address.
    const registryShell = resolve(webDir, "registry/_/index.html");
    if (existsSync(registryShell)) {
      const html = readFileSync(registryShell, "utf8");
      app.get("/registry/:id/", (c) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(c.req.param("id")) ? c.html(html) : c.notFound()));
      app.get("/registry/:id", (c) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(c.req.param("id")) ? c.redirect(`/registry/${c.req.param("id")}/`, 308) : c.notFound()));
    }
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

  // Batch lines are dispatched in process with a marker in `env` that no network request can carry (router/batch-line.ts).
  registerJobs(ctx, (path, init) => app.request(path, init), (path, init, env) => app.request(path, init, env as never));
  if (opts.startJobs ?? cfg.workers.enabled) await ctx.jobs.start();

  // Passive health belongs to each API replica, not the shared registry worker's memory.
  const healthTimer = cfg.runtimeRole === "api" ? setInterval(() => void ctx.health.flush(ctx.db).catch(() => undefined), 5000) : null;
  healthTimer?.unref();
  const stopStatus = startStatusLoop(ctx);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (healthTimer) clearInterval(healthTimer);
    await stopStatus();
    await ctx.telegram?.stop();
    await ctx.jobs.stop();
    await ctx.tlog?.stop();
    await ctx.health.flush(ctx.db).catch(() => undefined);
    await ctx.telemetry.close();
    await ctx.tracing.close();
    await limiter.close();
    redis?.disconnect();
    await handle.close();
  };
  return { app, ctx, close, fetch: app.fetch };
}

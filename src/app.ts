import { browserSessionRoutes } from "./browser-sessions/routes.ts"; // E147
import { securityAlertsRoutes, securityAlertsMiddleware } from "./security-alerts/routes.ts"; // D138
import { newModelsFeedRoutes } from "./api/models-new-feed.ts"; // C131
import { projectCors } from "./projects/cors.ts"; // C134
import { quietAgentAlertRoutes } from "./api/quiet-agent-alerts.ts"; // D141
import { accountRunwayRoutes } from "./api/account-runway.ts"; // B119
import { agentSpendRoutes } from "./agents/spend-glance.ts"; // C132
import { hardeningMiddleware, originLockMiddleware } from "./hardening/middleware.ts"; // HD1
import { internalEnv } from "./hardening/client.ts"; // HD1
import { initializeUpstreamMonitor } from "./rush/monitor.ts"; // ON3
import { facilitatorRoutes } from "./facilitator/routes.ts"; // v6 F: hosted x402 facilitator
import { toolsRoutes } from "./tools/routes.ts"; // v6 T: paid tool market, off by default.
import { firstCallRoutes, firstCallCsp } from "./developers/first-call.ts"; // ON2
import { inferenceScopeMiddleware, keyDefaultsRoutes } from "./provisioning/scope.ts"; // ZK6
import { structuredOutputMiddleware } from "./structured-output/chat.ts"; // V83
import { paymentRecovery } from "./pay/recovery.ts";
import { statementRoutes } from "./api/statements.ts"; // V87
import { proofPackRoutes } from "./api/proof-pack.ts"; // U100
import { laneReportRoutes } from "./api/lane-report.ts"; // Lane report
import { insightsRoutes } from "./api/insights.ts"; // V88: spend insights.
import { webhookRoutes } from "./webhooks/routes.ts"; // V86: signed destinations.
import { makegoodRoutes } from "./services/makegood.ts"; // V6 R: make-good refunds.
import { scheduledPromptRoutes } from "./api/schedules.ts"; // D136
import { inboxRoutes } from "./api/inbox.ts"; // U78: account inbox.
import { projectBudgetRoutes } from "./api/project-budgets.ts"; // D139
import { activityRoutes } from "./api/activity.ts";
import { networkStatsRoutes } from "./network/stats.ts";
import { commerceStatsRoutes } from "./commerce/stats.ts"; // v6 L
import { agentProfilesRoutes } from "./api/agent-profiles.ts";
import { identityRoutes } from "./identity/routes.ts"; // v6 I: before the rulebook routes, which 404 without AGENT_POLICY_ENABLED.
import { agentSealedRoutes } from "./api/agent-sealed.ts";
import { telegramLinkingRoutes } from "./api/telegram-linking.ts";
import { weeklySummaryRoutes } from "./api/weekly-summary.ts"; // B120
import { guardAgreementSigners } from "./agreements/tally.ts";
import { agreementsRoutes } from "./agreements/routes.ts";
import { networkBurnRoutes } from "./network/burn-routes.ts";
import { agentLedgerMiddleware } from "./agents/ledger-context.ts";
import { agentLedgerRoutes } from "./api/agent-ledger.ts";
import { networkHostRoutes } from "./api/network-hosts.ts";
import { networkSanctionsRoutes } from "./api/network-sanctions.ts";
import { e2eeRoutes } from "./api/e2ee.ts";
import { hostBondRoutes } from "./network/bonds.ts";
import { guardHostSlasher } from "./network/bond-config.ts";
import { configureNetworkRouting } from "./network/routing.ts";
import { siteCsp } from "./lib/csp.ts";
import { zkapiHosting } from "./zkapi/hosting.ts"; // ZK10
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
import { openDatabase, type DbHandle } from "./db/client.ts";
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
import { depositRoutes } from "./api/deposits.ts"; // V97B
import { savedRoutesRoutes } from "./api/saved-routes.ts";
import { presetsRoutes } from "./api/presets.ts";
import { characterRoutes } from "./api/characters.ts";
import { memoryRoutes } from "./api/memory.ts";
import { agentCertificatesRoutes } from "./api/agent-certificates.ts";
import { guardRoutes } from "./api/guard.ts"; // V98
import { agentPayRoutes } from "./api/agent-pay.ts"; // Pay another agent
import { agentsRoutes } from "./api/agents.ts";
import { agentPolicyHistoryRoutes } from "./api/agent-policy-history.ts"; // D144
import { playbooksRoutes } from "./api/playbooks.ts"; // U115
import { agentApprovalMiddleware, agentApprovalsRoutes } from "./api/agent-approvals.ts";
import { agentSessionsRoutes } from "./api/agent-sessions.ts";
import { spendRoutes } from "./api/spend.ts";
import { holdersRoutes } from "./api/holders.ts";
import { disclosureRoutes } from "./api/disclosure.ts";
import { ipxRoutes } from "./api/ipx.ts";
import { dataToolsRoutes } from "./data-tools/routes.ts"; // B: per-call market-data tools.
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
import { hostRoutes } from "./api/hosts.ts";
import { TransparencyLog } from "./tlog/log.ts";
import { networkPolicyRoutes } from "./network/routes.ts";
import { tlogRoutes } from "./tlog/routes.ts";
import { statusRoutes } from "./api/status.ts";
import { networkRoutes } from "./network/waitlist.ts";
import { skillsRoutes } from "./api/skills.ts";
import { idempotencyCors, idempotencyMiddleware } from "./idempotency/middleware.ts"; // D145
import { startStatusLoop, statusMiddleware } from "./services/slo.ts";

export type AppOptions = {
  env?: Record<string, unknown>;
  rand?: () => number;
  chain?: ChainService;
  startJobs?: boolean;
  /** Already initialized, caller-owned database for embedding or sharing an in-memory test store. */
  database?: Pick<DbHandle, "db" | "kind">;
};

export async function createApp(opts: AppOptions = {}) {
  const cfg = loadConfig(opts.env ?? {});
  await guardHostSlasher(cfg);
  setLogLevel(cfg.logLevel);
  const ownedDatabase = opts.database ? undefined : await openDatabase(cfg.databaseUrl, { migrate: cfg.autoMigrate });
  const handle = opts.database ?? ownedDatabase!;
  const redis = cfg.redisUrl ? new (await import("ioredis")).Redis(cfg.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false }) : undefined;
  const limiter: RateLimiter = redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter();
  const signer = new ReceiptSigner(handle.db, cfg.appSecret, cfg.receipts.rotationDays, cfg.receipts.signingKey);
  await signer.init();
  const catalog = new Catalog(handle.db);
  catalog.trackArrivals = cfg.modelArrivalsEnabled; // C131
  await catalog.refresh();
  const health = new HealthTracker(cfg.routing.outageWindowMs);
  configureNetworkRouting(health, cfg.networkWeights);
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
  if (cfg.agreements.rulings) await guardAgreementSigners(ctx.chain.client, cfg.agreements.oracle!, cfg.agreements.signerKeys!, cfg.agreements.threshold);
  if (ctx.blind) await ensurePool(ctx);

  await initializeUpstreamMonitor(ctx); // ON3
  const webDir = resolve(cfg.webDir ?? resolve(import.meta.dir, "../web/out"));
  const webBuilt = existsSync(resolve(webDir, "index.html"));
  const csp = webBuilt ? siteCsp(webDir) : "frame-ancestors 'none'; object-src 'none'; base-uri 'none'";
  const app = new Hono();
  securityAlertsMiddleware(app, ctx); // D138
  app.use("*", originLockMiddleware(ctx)); // HD1: authenticate ingress before CORS, including preflights.
  // The OpenAI-style /v1/* aliases get the same CORS as /api/*, so a browser can read the receipt, lane and policy headers on either.
  const apiCors = cors({ origin: "*", allowHeaders: ["x-agent-approval", "authorization", "content-type", "x-e2ee-version", "x-client-pub-key", "x-model-pub-key", "x-e2ee-nonce", "x-e2ee-timestamp", "x-pay-with", "x-payment", "payment-signature", "payment-recovery", "x-wallet-auth", "x-anyroute-cache", "x-anyroute-disclosure-max", "x-anyroute-lane", "x-anyroute-lane-downgrade", "x-anyroute-decision-tag", "http-referer", "x-title", "traceparent", "x-api-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access"], exposeHeaders: [...EXPOSED_RESPONSE_HEADERS, ...(cfg.routeExplain ? ["x-anyroute-route"] : []), /* V84 */ ...(cfg.structuredOutputCheckEnabled ? ["x-anyroute-json-check"] : []), /* V83 */ "x-e2ee-applied", "x-e2ee-version", "x-e2ee-algo", "x-e2ee-receipt-id"] });
  app.use("*", projectCors); // C134: after origin lock, before existing CORS
  app.use("*", idempotencyCors); // D145
  app.use("/api/*", apiCors);
  app.use("/v1/*", apiCors);
  app.use("/ollama/*", apiCors);
  app.use("/facilitator/*", apiCors); // v6 F
  if (webBuilt && cfg.zkapiPageOrigins.length) app.use("*", zkapiHosting(csp, cfg.zkapiPageOrigins)); // ZK10: narrowly scoped static policies.
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    if (c.res.headers.get("content-type")?.includes("text/html")) {
      c.header("content-security-policy", firstCallCsp(c.req.method, c.req.path, cfg.developerFirstCallEnabled) ?? csp); // ON2: retain the script-free endpoint page policy.
      // Tell Tor Browser this page has an onion twin (only on the clearnet site; it does nothing without ONION_ADDRESS).
      if (cfg.onion.address && c.req.method === "GET" && !viaOnion(c, cfg)) {
        const url = new URL(c.req.url);
        c.header("onion-location", `http://${cfg.onion.address}${url.pathname}${url.search}`);
      }
    }
    if (cfg.production) c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  });

  app.use("*", hardeningMiddleware(ctx)); // HD1: after CORS/security headers, before every body reader.
  app.use("*", onionIngress(cfg)); // onion requests: drop every client address header before any route reads one
  app.use("*", statusMiddleware(ctx)); // public-lane outcomes per API surface for /api/v1/status/slo; private lanes are not counted here
  app.use("*", inferenceScopeMiddleware(ctx)); // ZK6: deny by default before account middleware.
  idempotencyMiddleware(app, ctx); // D145: authenticated replays precede approval consumption and billing.
  app.use("*", agentLedgerMiddleware(ctx));
  app.use("*", agentApprovalMiddleware(ctx));
  paymentRecovery(app, ctx); // a lost x402 answer is sent again, never paid twice; outside every other route middleware
  structuredOutputMiddleware(app, ctx); // V83: ordinary chat routes bill each call.
  firstCallRoutes(app, cfg.developerFirstCallEnabled, cfg.siteUrl); // ON2: the public site address, not the router host
  chatRoutes(app, ctx);
  e2eeRoutes(app, ctx);
  embeddingsRoutes(app, ctx);
  batchesRoutes(app, ctx);
  rerankRoutes(app, ctx);
  modelsRoutes(app, ctx);
  newModelsFeedRoutes(app, ctx); // C131
  generationRoutes(app, ctx);
  activityRoutes(app, ctx);
  statementRoutes(app, ctx); // V87
  proofPackRoutes(app, ctx); // U100
  laneReportRoutes(app, ctx); // Lane report: read-only, with statements
  insightsRoutes(app, ctx); // V88: read-only, off by default.
  accountRunwayRoutes(app, ctx); // B119
  scheduledPromptRoutes(app, ctx, (path, init, env) => app.request(path, init, internalEnv(env) as never)); // D136
  inboxRoutes(app, ctx); // U78: account inbox.
  securityAlertsRoutes(app, ctx); // D138
  projectBudgetRoutes(app, ctx); // D139
  keyDefaultsRoutes(app, ctx); // ZK6: before /keys/:hash.
  keysRoutes(app, ctx);
  browserSessionRoutes(app, ctx); // E147
  teamsRoutes(app, ctx);
  escrowRoutes(app, ctx);
  depositRoutes(app, ctx); // V97B: account-owned deposit progress, both lanes.
  savedRoutesRoutes(app, ctx);
  presetsRoutes(app, ctx);
  characterRoutes(app, ctx);
  memoryRoutes(app, ctx);
  agentProfilesRoutes(app, ctx);
  identityRoutes(app, ctx); // v6 I
  agentSealedRoutes(app, ctx);
  agentsRoutes(app, ctx);
  agentPolicyHistoryRoutes(app, ctx); // D144
  agentSpendRoutes(app, ctx); // C132
  quietAgentAlertRoutes(app, ctx); // D141
  playbooksRoutes(app, ctx); // U115: after agentsRoutes, whose /api/v1/agents/* switch also covers the follow route.
  guardRoutes(app, ctx); // V98
  agentPayRoutes(app, ctx); // Pay another agent (AGENT_PAY_ENABLED)
  agreementsRoutes(app, ctx);
  agentCertificatesRoutes(app, ctx);
  agentLedgerRoutes(app, ctx);
  agentApprovalsRoutes(app, ctx);
  telegramLinkingRoutes(app, ctx);
  weeklySummaryRoutes(app, ctx); // B120
  agentSessionsRoutes(app, ctx);
  spendRoutes(app, ctx);
  webhookRoutes(app, ctx); // V86.
  makegoodRoutes(app, ctx); // V6 R.
  holdersRoutes(app, ctx);
  disclosureRoutes(app, ctx);
  ipxRoutes(app, ctx);
  dataToolsRoutes(app, ctx); // B
  attestationHistoryRoutes(app, ctx); // before attestationRoutes: /attestation/summary must not be read as a provider id
  attestationRoutes(app, ctx);
  if (ctx.cfg.hostDashboard.enabled) hostRoutes(app, ctx);
  hostBondRoutes(app, ctx);
  measurementRoutes(app, ctx);
  badgeRoutes(app, ctx);
  laneRoutes(app, ctx);
  dayzeroRoutes(app, ctx);
  creatorClaimRoutes(app, ctx);
  if (ctx.blind) blindRoutes(app, ctx);
  if (ctx.ohttp) ohttpRoutes(app, ctx);
  if (ctx.cfg.hostAnchor.enabled) hostAnchorRoutes(app, ctx);
  if (ctx.tlog) tlogRoutes(app, ctx);
  networkPolicyRoutes(app, ctx);
  statusRoutes(app, ctx);
  skillsRoutes(app, ctx);
  toolsRoutes(app, ctx); // v6 T: registers nothing unless TOOLS_MARKET_ENABLED.
  networkRoutes(app, ctx);
  publicRoutes(app, ctx);
  networkSanctionsRoutes(app, ctx);
  networkBurnRoutes(app, ctx);
  networkHostRoutes(app, ctx);
  networkStatsRoutes(app, ctx);
  commerceStatsRoutes(app, ctx); // v6 L: off by default.
  mcpRoutes(app, ctx);
  anthropicRoutes(app, ctx);
  ollamaRoutes(app, ctx);
  responsesRoutes(app, ctx);
  ragRoutes(app, ctx);
  paymasterRoutes(app, ctx);
  facilitatorRoutes(app, ctx); // v6 F: answers 503 facilitator_disabled until FACILITATOR_ENABLED
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
  registerJobs(ctx, (path, init) => app.request(path, init, internalEnv()), (path, init, env) => app.request(path, init, internalEnv(env) as never));
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
    await ownedDatabase?.close();
  };
  return { app, ctx, close, fetch: app.fetch };
}

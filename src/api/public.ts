import type { Hono } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { encodeFunctionData, keccak256, toBytes, type Hex } from "viem";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { apps, generations, kv, models, offers, paywithSessions, providers } from "../db/schema.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import { providerApplication, submitProviderApplication } from "../providers/application.ts";
import { readiness } from "../services/readiness.ts";
import { readinessMetrics } from "../services/readiness-metrics.ts";
import { readJson } from "./common.ts";
import { requireKey } from "./auth.ts";
import { verifyReceipt, anchorProof } from "./generation.ts";
import { fairPrice, openDebt, rawToPico, statement } from "../pay/paywith.ts";
import { PayWithStockAbi, erc20Abi } from "../chain/abis.ts";

export { providerApplication } from "../providers/application.ts";

export function publicRoutes(app: Hono, ctx: Ctx) {
  const launchMetrics = async () => {
    const r = await ctx.db.execute(sql`
      SELECT
        coalesce(sum(tokens_in + tokens_out) FILTER (WHERE ts > now() - interval '24 hours'), 0) AS tokens_24h,
        coalesce(sum(tokens_in + tokens_out) FILTER (WHERE ts > now() - interval '7 days'), 0) / 7 AS tokens_per_day_7d,
        count(DISTINCT key_hash) FILTER (WHERE ts > now() - interval '24 hours') AS active_keys_24h,
        count(DISTINCT key_hash) FILTER (WHERE ts > now() - interval '30 days') AS active_keys_30d
      FROM generations WHERE provider_id <> 'cache'`);
    const row = (((r as { rows?: unknown[] }).rows ?? r) as Record<string, string | number>[])[0] ?? {};
    return {
      tokens_24h: Number(row.tokens_24h ?? 0),
      tokens_per_day_7d: Math.round(Number(row.tokens_per_day_7d ?? 0)),
      active_keys_24h: Number(row.active_keys_24h ?? 0),
      active_keys_30d: Number(row.active_keys_30d ?? 0),
    };
  };
  // ---- Receipts ----
  app.get("/api/v1/receipts/keys", async (c) => c.json(await ctx.signer.jwks()));
  app.get("/.well-known/anyroute-receipt-keys.json", async (c) => c.json(await ctx.signer.jwks()));
  app.post("/api/v1/receipts/verify", async (c) => {
    const b = z
      .object({ payload: z.record(z.string(), z.unknown()), sig: z.string(), key_id: z.string(), anchor: z.object({ root: z.string(), proof: z.array(z.string()), index: z.number().int().optional() }).optional() })
      .parse(await readJson(c));
    return c.json({ data: await verifyReceipt(ctx, b) });
  });
  app.get("/api/v1/receipts/:id", async (c) => {
    const [g] = await ctx.db.select().from(generations).where(eq(generations.id, c.req.param("id")));
    if (!g) fail(404, "Receipt not found.", "not_found");
    // Receipts carry only hashes and amounts, so they are public proofs by id.
    return c.json({ data: { id: g.id, payload: g.receipt, sig: g.receiptSig, key_id: g.receiptKeyId, leaf: g.receiptLeaf, anchor: await anchorProof(ctx, g) } });
  });

  // ---- Rankings: tokens per model/app, and what creators were paid ----
  app.get("/api/v1/rankings", async (c) => {
    const period = c.req.query("period") ?? "day";
    const hours = period === "week" ? 168 : period === "month" ? 720 : 24;
    const since = new Date(Date.now() - hours * 3_600_000);
    const byModel = await ctx.db
      .select({
        model: generations.modelId,
        tokens: sql<string>`sum(${generations.tokensIn} + ${generations.tokensOut})`,
        requests: sql<string>`count(*)`,
        royalty: sql<string>`coalesce(sum(${generations.royalty}), 0)`,
      })
      .from(generations)
      .where(and(gte(generations.ts, since), sql`${generations.providerId} <> 'cache'`))
      .groupBy(generations.modelId)
      .orderBy(desc(sql`sum(${generations.tokensIn} + ${generations.tokensOut})`))
      .limit(100);
    const byApp = await ctx.db
      .select({ app: generations.appId, tokens: sql<string>`sum(${generations.tokensIn} + ${generations.tokensOut})` })
      .from(generations)
      .where(and(gte(generations.ts, since), sql`${generations.appId} IS NOT NULL`))
      .groupBy(generations.appId)
      .orderBy(desc(sql`sum(${generations.tokensIn} + ${generations.tokensOut})`))
      .limit(50);
    const appRows = byApp.length ? await ctx.db.select().from(apps) : [];
    const appMap = new Map(appRows.map((a) => [a.id, a]));
    const modelRows = await ctx.db.select({ id: models.id, creator: models.creator, royaltyBps: models.royaltyBps }).from(models);
    const mm = new Map(modelRows.map((m) => [m.id, m]));
    return c.json({
      data: {
        period,
        since: since.toISOString(),
        models: byModel.map((r) => ({
          model: r.model,
          tokens: Number(r.tokens),
          requests: Number(r.requests),
          paid_to_creator_usd: picoToUsd(BigInt(r.royalty)),
          creator: mm.get(r.model)?.creator ?? null,
          royalty_bps: mm.get(r.model)?.royaltyBps ?? 0,
        })),
        apps: byApp.map((r) => ({ app: appMap.get(r.app!)?.title ?? appMap.get(r.app!)?.url ?? r.app, url: appMap.get(r.app!)?.url ?? null, tokens: Number(r.tokens) })),
      },
    });
  });

  // ---- Pay with Stock Tokens ----
  app.get("/api/v1/paywith/tokens", (c) =>
    c.json({
      data: {
        contract: ctx.cfg.chain.payWithStock ?? null,
        threshold_usd: ctx.cfg.paywith.thresholdUsd,
        max_age_hours: ctx.cfg.paywith.maxAgeH,
        max_debt_usd: ctx.cfg.paywith.maxDebtUsd,
        tokens: ctx.cfg.paywith.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals, feed: t.feed ?? null })),
      },
    }),
  );
  app.get("/api/v1/paywith/session", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const [s] = await ctx.db.select().from(paywithSessions).where(eq(paywithSessions.keyHash, k.chainKeyHash));
    if (!s) return c.json({ data: null });
    const tok = ctx.cfg.paywith.tokens.find((t) => t.address.toLowerCase() === s.token.toLowerCase());
    // Today's spend comes from the contract (UTC day window); the indexed row is the fallback.
    let spentToday = s.spentRawToday;
    try {
      const onchain = await ctx.chain.session(k.chainKeyHash as Hex);
      const today = BigInt(Math.floor(Date.now() / 86_400_000) * 86_400);
      spentToday = onchain.dayStart < today ? 0n : onchain.spentRawToday;
    } catch {
      /* chain unavailable: indexed value */
    }
    return c.json({
      data: {
        token: s.token,
        symbol: s.symbol,
        decimals: tok?.decimals ?? 18,
        wallet: s.wallet,
        cap_raw_per_day: s.capRawDay.toString(),
        spent_raw_today: spentToday.toString(),
        active: s.active,
        pay_with_default: k.payWithDefault ?? null,
        open_debt_usd: picoToUsd(await openDebt(ctx, k.chainKeyHash)),
        opened_tx: s.openedTx,
      },
    });
  });
  // Unsigned transactions the wallet signs to open/close a session (the router never holds user funds).
  app.post("/api/v1/paywith/open", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const v = z.object({ token: z.string(), cap_raw_per_day: z.string().regex(/^\d+$/), wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await readJson(c));
    const tok = ctx.cfg.paywith.tokens.find((t) => t.symbol.toLowerCase() === v.token.toLowerCase() || t.address.toLowerCase() === v.token.toLowerCase());
    if (!tok) fail(404, `${v.token} is not a registered Stock Token.`, "not_found");
    const pws = ctx.chain.require("payWithStock");
    // The router may spend up to the session's daily cap without a per-charge signature, so the API
    // only builds sessions worth at most PAYWITH_MAX_DAILY_CAP_USD a day (required in production).
    const maxCapUsd = ctx.cfg.paywith.maxDailyCapUsd;
    if (maxCapUsd !== null) {
      const fair = await fairPrice(ctx, tok.address);
      if (!fair) fail(503, `The ${tok.symbol} price is unavailable, so the session cap cannot be checked.`, "price_unavailable");
      if (rawToPico(BigInt(v.cap_raw_per_day), tok.decimals, fair) > usdToPico(maxCapUsd)) fail(400, `cap_raw_per_day is worth more than this router's $${maxCapUsd} daily session limit.`, "cap_too_high");
    }
    // Anyone can open a session on any key hash on-chain; the router only honours sessions whose
    // wallet the key holder registered here (authenticated by the key itself).
    const intent = { wallet: v.wallet.toLowerCase(), token: tok.address.toLowerCase(), at: new Date().toISOString() };
    await ctx.db.insert(kv).values({ key: `paywith-intent:${k.chainKeyHash}`, value: intent }).onConflictDoUpdate({ target: kv.key, set: { value: intent, updatedAt: new Date() } });
    return c.json({
      data: {
        chain: ctx.cfg.chain.id,
        wallet: intent.wallet,
        transactions: [
          { to: tok.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pws, BigInt(v.cap_raw_per_day) * 31n] }), description: `Approve ${tok.symbol} for PayWithStock (31 days of cap)` },
          { to: pws, data: encodeFunctionData({ abi: PayWithStockAbi, functionName: "openSession", args: [k.chainKeyHash as Hex, tok.address as Hex, BigInt(v.cap_raw_per_day)] }), description: `Open a ${tok.symbol} session for this key` },
        ],
      },
    });
  });
  app.post("/api/v1/paywith/close", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const pws = ctx.chain.require("payWithStock");
    return c.json({ data: { chain: ctx.cfg.chain.id, transactions: [{ to: pws, data: encodeFunctionData({ abi: PayWithStockAbi, functionName: "closeSession", args: [k.chainKeyHash as Hex] }), description: "Close the session (instant)" }] } });
  });
  app.get("/api/v1/paywith/statement", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) fail(400, "month must be YYYY-MM.", "invalid_request");
    return c.json({ data: await statement(ctx, k.chainKeyHash, month) });
  });

  // ---- Provider onboarding: apply -> schema check -> bond -> 7-day shadow (canaries) -> live ----
  app.post("/api/v1/providers/apply", async (c) => {
    const data = await submitProviderApplication(ctx, providerApplication.parse(await readJson(c)), c.req.header("x-application-token"));
    return c.json({ data }, 201);
  });

  // Creator royalties: prove you control the model's Hugging Face repo by committing
  // `anyroute.json` = {"creator": "0x…", "royalty_bps": 500} to its main branch, then claim.
  app.post("/api/v1/creators/claim", async (c) => {
    const v = z.object({ model: z.string(), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await readJson(c));
    const lim = await ctx.limiter.take(`claim:${v.model}`, 1, 10, 3_600_000);
    if (!lim.ok) fail(429, "Too many claim attempts for this model.", "rate_limited");
    const [m] = await ctx.db.select().from(models).where(eq(models.id, v.model));
    if (!m) fail(404, "Unknown model.", "not_found");
    if (!m.hfRepo || !/^[\w.-]+\/[\w.-]+$/.test(m.hfRepo)) fail(400, "This model has no Hugging Face repository on record to prove ownership against.", "no_hf_repo");
    let proof: { creator?: string; royalty_bps?: number };
    try {
      const res = await fetch(`${ctx.cfg.hfBaseUrl}/${m.hfRepo}/raw/main/anyroute.json`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      proof = (await res.json()) as typeof proof;
    } catch (e) {
      fail(400, `Could not read anyroute.json from ${m.hfRepo} (${(e as Error).message}). Commit {"creator": "${v.address}"} to the repo's main branch.`, "claim_unverified");
    }
    if (String(proof.creator ?? "").toLowerCase() !== v.address.toLowerCase()) fail(403, "anyroute.json names a different creator address.", "claim_mismatch");
    const bps = Math.min(2000, Math.max(0, Number.isInteger(proof.royalty_bps) ? proof.royalty_bps! : ctx.cfg.fees.defaultRoyaltyBps));
    await ctx.db.update(models).set({ creator: v.address.toLowerCase(), royaltyBps: bps }).where(eq(models.id, m.id));
    await ctx.catalog.refresh();
    let tx: string | null = null;
    if (ctx.chain.address("royalty") && ctx.chain.roleAddress("router"))
      tx = (await ctx.chain.registerRoyalty(keccak256(toBytes(m.id)), v.address as Hex, bps).catch((e) => {
        throw new ApiError(502, `Verified, but on-chain registration failed: ${(e as Error).message.slice(0, 150)}`, "chain_failed");
      })).hash;
    return c.json({ data: { model: m.id, creator: v.address.toLowerCase(), royalty_bps: bps, onchain_tx: tx } }, 201);
  });

  app.get("/api/v1/status", async (c) =>
    c.json({
      data: {
        launch: await launchMetrics(),
        router: ctx.cfg.publicUrl,
        env: ctx.cfg.env,
        // The running build (RELEASE_COMMIT; null when unset) and whether its contracts were verified.
        release: {
          commit: ctx.cfg.release.commit,
          deployment: {
            status: ctx.cfg.release.deployment.status,
            manifest_sha256: ctx.cfg.release.deployment.manifestSha256,
            manifest_block: ctx.cfg.release.deployment.manifestBlock,
            verified_at_block: ctx.cfg.release.deployment.verifiedAtBlock,
            verifier_revision: ctx.cfg.release.deployment.verifierRevision,
          },
        },
        database: ctx.dbKind,
        redis: !!ctx.cfg.redisUrl,
        chain: ctx.chain.status(),
        dev_faucet: ctx.chain.devFaucet,
        receipts: { key_id: ctx.signer.keyId, rotation_days: ctx.cfg.receipts.rotationDays, anchor_interval_ms: ctx.cfg.receipts.anchorIntervalMs },
        settlement: { spent_root_interval_ms: ctx.cfg.workers.settlementIntervalMs },
        fees: { prepaid_bps: 0, per_call_margin_bps: ctx.cfg.fees.perCallMarginBps, provider_fee_bps: ctx.cfg.fees.providerFeeBps, byok_fee_bps: ctx.cfg.fees.byokFeeBps },
        paywith: { tokens: ctx.cfg.paywith.tokens.map((t) => t.symbol), configured: !!ctx.cfg.chain.payWithStock },
        per_call: { configured: !!ctx.cfg.chain.callPay, max_usd: ctx.cfg.fees.perCallMaxUsd },
        telemetry: ctx.telemetry.enabled,
        jobs: ctx.jobs.status().map((job) => ({ ...job, last_error: job.last_error ? "Job failed" : null })),
        catalog: { models: ctx.catalog.models.size, providers: ctx.catalog.providers.size },
      },
    }),
  );
  app.get("/ready", async (c) => {
    const result = await readiness(ctx);
    return c.json(result, result.ok ? 200 : 503);
  });
  app.get("/ready/metrics", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(readinessMetrics(await readiness(ctx)));
  });
  app.get("/health", (c) => c.json({ ok: true }));
}

export { usdToPico };

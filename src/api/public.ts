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
import { verifyReceipt, verifyReceiptV2, anchorProof } from "./generation.ts";
import { COSE_CONTENT_TYPE } from "../receipts/v2.ts";
import { holdersStatus } from "../holders/tiers.ts";
import { laneSummary } from "./models.ts";
import { allowanceProposal, allowanceView, chargeProposals, fairPrice, forgetAllowance, openDebt, rawToPico, saveAllowance, signCharge, statement, typedDataJson } from "../pay/paywith.ts";
import { PayWithStockAbi, erc20Abi } from "../chain/abis.ts";
import { acceptedTokens, anyrSummary, escrowEnabled } from "../pay/escrow.ts";
import { x402Enabled } from "../pay/x402.ts";
import { PRIVATE_LANES, PUBLIC_LANE_ROWS, privateLaneStats } from "../services/private-stats.ts";
import { labelForReceipt } from "../privacy/resolve.ts";

export { providerApplication } from "../providers/application.ts";

export function publicRoutes(app: Hono, ctx: Ctx) {
  const launchMetrics = async () => {
    const r = await ctx.db.execute(sql`
      SELECT
        coalesce(sum(tokens_in + tokens_out) FILTER (WHERE ts > now() - interval '24 hours'), 0) AS tokens_24h,
        coalesce(sum(tokens_in + tokens_out) FILTER (WHERE ts > now() - interval '7 days'), 0) / 7 AS tokens_per_day_7d,
        count(DISTINCT key_hash) FILTER (WHERE ts > now() - interval '24 hours') AS active_keys_24h,
        count(DISTINCT key_hash) FILTER (WHERE ts > now() - interval '30 days') AS active_keys_30d
      FROM generations WHERE provider_id <> 'cache' AND ${PUBLIC_LANE_ROWS}`);
    const row = (((r as { rows?: unknown[] }).rows ?? r) as Record<string, string | number>[])[0] ?? {};
    return {
      tokens_24h: Number(row.tokens_24h ?? 0),
      tokens_per_day_7d: Math.round(Number(row.tokens_per_day_7d ?? 0)),
      active_keys_24h: Number(row.active_keys_24h ?? 0),
      active_keys_30d: Number(row.active_keys_30d ?? 0),
    };
  };
  // ---- Private-lane stats: noisy hourly counters only (services/private-stats.ts) ----
  app.get("/api/v1/stats", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ data: { lanes: PRIVATE_LANES, ...privateLaneStats(ctx).document() } });
  });

  // ---- Receipts ----
  app.get("/api/v1/receipts/keys", async (c) => c.json(await ctx.signer.jwks()));
  app.get("/.well-known/anyroute-receipt-keys.json", async (c) => c.json(await ctx.signer.jwks()));
  const anchorInput = z.object({ root: z.string(), proof: z.array(z.string()), index: z.number().int().optional() }).optional();
  app.post("/api/v1/receipts/verify", async (c) => {
    const raw = await readJson(c);
    // v2: a COSE_Sign1 (base64), optionally with the hashes, the streamed event data and an anchor proof to check.
    if (raw && typeof raw === "object" && typeof (raw as { cose?: unknown }).cose === "string") {
      const b = z
        .object({ cose: z.string().max(16_384), request_sha256: z.string().optional(), response_sha256: z.string().optional(), chunks: z.array(z.string()).max(100_000).optional(), anchor: anchorInput })
        .parse(raw);
      return c.json({ data: await verifyReceiptV2(ctx, b) });
    }
    const b = z.object({ payload: z.record(z.string(), z.unknown()), sig: z.string(), key_id: z.string(), anchor: anchorInput }).parse(raw);
    return c.json({ data: await verifyReceipt(ctx, b) });
  });
  // The anchor path for a receipt once its hour has been rooted. `anchored` is true only when the root was posted to
  // ReceiptAnchor on chain; without a configured chain the root is kept off chain (status "local") and says so.
  app.get("/api/v1/receipts/:id/proof", async (c) => {
    const [g] = await ctx.db.select().from(generations).where(eq(generations.id, c.req.param("id")));
    if (!g) fail(404, "Receipt not found.", "not_found");
    const version = g.receiptLeafV2 && c.req.query("v") !== "1" ? 2 : 1;
    const a = await anchorProof(ctx, g, version);
    const leaf = version === 2 ? g.receiptLeafV2 : g.receiptLeaf;
    if (!a) return c.json({ data: { rid: g.id, leaf, leaf_version: version, rooted: false, anchored: false, status: "pending", hint: "Receipts are rooted hourly. Ask again after the next root." } });
    const { index, leaf_index, from, to, ...rest } = a;
    return c.json({ data: { rid: g.id, leaf, leaf_version: version, rooted: true, anchored: a.status === "confirmed" && !!a.tx, anchor_index: index, leaf_index, window: { from, to }, ...rest } });
  });
  // "What we saw": the plain-English privacy label for one answer, computed from its signed receipt (privacy/label.ts).
  // Public by id, like the receipt itself.
  app.get("/api/v1/receipts/:id/privacy", async (c) => {
    const [g] = await ctx.db.select({ id: generations.id, receipt: generations.receipt }).from(generations).where(eq(generations.id, c.req.param("id")));
    if (!g) fail(404, "Receipt not found.", "not_found");
    return c.json({ data: await labelForReceipt(ctx, { id: g.id, payload: g.receipt }) });
  });
  app.get("/api/v1/receipts/:id", async (c) => {
    const [g] = await ctx.db.select().from(generations).where(eq(generations.id, c.req.param("id")));
    if (!g) fail(404, "Receipt not found.", "not_found");
    const format = c.req.query("format");
    if (format === "cose") {
      if (!g.receiptCose) fail(404, "This receipt has no v2 (COSE) encoding.", "not_found");
      if (c.req.query("encoding") === "base64") return c.text(g.receiptCose, 200, { "content-type": "text/plain; charset=utf-8" });
      return c.body(Buffer.from(g.receiptCose, "base64"), 200, { "content-type": COSE_CONTENT_TYPE });
    }
    // Receipts carry only hashes and amounts, so they are public proofs by id. The v1 fields stay as they were; v2,
    // when the receipt has one, is added beside them.
    const v2 = g.receiptCose ? { alg: "EdDSA", kid: g.receiptKeyId, content_type: COSE_CONTENT_TYPE, cose: g.receiptCose, claims: g.receiptV2, leaf: g.receiptLeafV2, anchor: await anchorProof(ctx, g, 2) } : null;
    // `privacy` is derived from the payload for readers; it is not part of what is signed.
    return c.json({ data: { id: g.id, version: v2 ? 2 : 1, payload: g.receipt, sig: g.receiptSig, key_id: g.receiptKeyId, leaf: g.receiptLeaf, anchor: await anchorProof(ctx, g), v2, privacy: await labelForReceipt(ctx, { id: g.id, payload: g.receipt }) } });
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
      .where(and(gte(generations.ts, since), sql`${generations.providerId} <> 'cache'`, PUBLIC_LANE_ROWS))
      .groupBy(generations.modelId)
      .orderBy(desc(sql`sum(${generations.tokensIn} + ${generations.tokensOut})`))
      .limit(100);
    const byApp = await ctx.db
      .select({ app: generations.appId, tokens: sql<string>`sum(${generations.tokensIn} + ${generations.tokensOut})` })
      .from(generations)
      .where(and(gte(generations.ts, since), sql`${generations.appId} IS NOT NULL`, PUBLIC_LANE_ROWS))
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
    // Today's spend, the authorization epoch and the allowance come from the contract (UTC day window);
    // the indexed row is the fallback.
    let spentToday = s.spentRawToday;
    let epoch: string | null = null;
    let allowance: Awaited<ReturnType<typeof allowanceView>> = null;
    try {
      const onchain = await ctx.chain.session(k.chainKeyHash as Hex);
      const today = BigInt(Math.floor(Date.now() / 86_400_000) * 86_400);
      spentToday = onchain.dayStart < today ? 0n : onchain.spentRawToday;
      epoch = onchain.epoch.toString();
      allowance = await allowanceView(ctx, k.chainKeyHash, onchain);
    } catch {
      /* chain unavailable: indexed value */
    }
    const charges = await chargeProposals(ctx, k.chainKeyHash);
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
        epoch,
        allowance,
        charges_awaiting_signature: charges.filter((x) => x.status === "awaiting_signature").length,
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
    // Every charge needs the wallet's own authorization; the daily cap stays an extra bound, and the API
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
        next: "Once the session is indexed, sign a bounded allowance (POST /api/v1/paywith/allowance/typed-data, then POST /api/v1/paywith/allowance), or sign each charge from GET /api/v1/paywith/charges.",
      },
    });
  });
  // EIP-712 AllowanceAuthorization for the session wallet to sign once: a total and a per-charge token limit,
  // at most 7 days, at most $5 per charge on-chain, every charge tied to the receipts it pays.
  app.post("/api/v1/paywith/allowance/typed-data", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const v = z
      .object({ max_raw_total: z.string().regex(/^\d{1,78}$/).optional(), max_raw_per_charge: z.string().regex(/^\d{1,78}$/).optional(), valid_seconds: z.number().int().positive().optional() })
      .parse(await readJson(c));
    const p = await allowanceProposal(ctx, k, { maxRawTotal: v.max_raw_total ? BigInt(v.max_raw_total) : undefined, maxRawPerCharge: v.max_raw_per_charge ? BigInt(v.max_raw_per_charge) : undefined, validSeconds: v.valid_seconds });
    return c.json({ data: { wallet: p.wallet, symbol: p.symbol, decimals: p.decimals, typed_data: typedDataJson(p.typedData) } });
  });
  app.post("/api/v1/paywith/allowance", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const v = z.object({ message: z.record(z.string(), z.unknown()), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await readJson(c));
    return c.json({ data: await saveAllowance(ctx, k, { message: v.message, signature: v.signature as Hex }) }, 201);
  });
  // Charges the router proposes (exact USDG, token maximum, usage commitment) for the wallet to sign.
  app.get("/api/v1/paywith/charges", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    return c.json({ data: await chargeProposals(ctx, k.chainKeyHash) });
  });
  app.post("/api/v1/paywith/charges/:id/signature", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const v = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await readJson(c));
    return c.json({ data: await signCharge(ctx, k, c.req.param("id"), v.signature as Hex) });
  });
  // One transaction voids every outstanding charge signature and the allowance (the session stays open).
  app.post("/api/v1/paywith/revoke", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const pws = ctx.chain.require("payWithStock");
    await forgetAllowance(ctx, k.chainKeyHash);
    return c.json({ data: { chain: ctx.cfg.chain.id, transactions: [{ to: pws, data: encodeFunctionData({ abi: PayWithStockAbi, functionName: "revokeAuthorizations", args: [k.chainKeyHash as Hex] }), description: "Revoke every charge authorization and the allowance (instant)" }] } });
  });
  app.post("/api/v1/paywith/close", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const pws = ctx.chain.require("payWithStock");
    await forgetAllowance(ctx, k.chainKeyHash);
    return c.json({ data: { chain: ctx.cfg.chain.id, transactions: [{ to: pws, data: encodeFunctionData({ abi: PayWithStockAbi, functionName: "closeSession", args: [k.chainKeyHash as Hex] }), description: "Close the session and revoke its authorizations (instant)" }] } });
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

  app.get("/api/v1/status", async (c) => {
    await ctx.catalog.ensureFresh();
    return c.json({
      data: {
        // Raw launch metrics count the public lane only. Attested and unlinkable traffic is published only as noisy
        // hourly counters, at /api/v1/stats.
        launch: await launchMetrics(),
        private_lanes: { lanes: PRIVATE_LANES, stats: "/api/v1/stats", epsilon_spent_today: privateLaneStats(ctx).budget().epsilon_spent_today },
        router: ctx.cfg.publicUrl,
        network: { hosts_open: ctx.cfg.networkHosts.enabled === true, payouts_open: ctx.cfg.networkPayouts.enabled === true, fee_bps: ctx.cfg.networkPayouts.feeBps },
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
        // Escrow payments: the tokens it credits, the Stock Token haircut, and $ANYR's own terms (null when not accepted).
        escrow: { enabled: escrowEnabled(ctx), tokens: escrowEnabled(ctx) ? acceptedTokens(ctx).map((t) => t.symbol) : [], haircut_bps: ctx.cfg.escrow.haircutBps, anyr: anyrSummary(ctx) },
        per_call: { configured: !!ctx.cfg.chain.callPay || x402Enabled(ctx), max_usd: ctx.cfg.fees.perCallMaxUsd, x402: { configured: x402Enabled(ctx), network: ctx.cfg.x402.network } },
        // $ANYR holder tiers: the token, the tier ladder, and whether tiers apply to requests.
        holders: holdersStatus(ctx),
        telemetry: ctx.telemetry.enabled,
        // The onion service that reaches this router over Tor (null when none is configured). Clients that reach it hide
        // their network address from the router; requests carry no address here, so limits for unkeyed calls are shared.
        onion: ctx.cfg.onion.address ? { address: ctx.cfg.onion.address, url: `http://${ctx.cfg.onion.address}` } : null,
        jobs: ctx.jobs.status().map((job) => ({ ...job, last_error: job.last_error ? "Job failed" : null })),
        catalog: { models: ctx.catalog.models.size, providers: ctx.catalog.providers.size },
        // Privacy lanes: how many models and live endpoints can serve each one right now, and the selection weight.
        lanes: laneSummary(ctx),
      },
    });
  });
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

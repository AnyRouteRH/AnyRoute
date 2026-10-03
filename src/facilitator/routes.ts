import type { Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { addressBucket } from "../api/common.ts";
import { anchorProof } from "../api/generation.ts";
import { fail } from "../lib/errors.ts";
import { inspectCose } from "../receipts/signer.ts";
import { COSE_CONTENT_TYPE } from "../receipts/v2.ts";
import { discoverResources, LISTING_TYPES, listingDomain, listingJson, parseListing, upsertListing } from "./discovery.ts";
import { facilitatorSellers, facilitatorSettlements, sellerGasFloats } from "./schema.ts";
import { lastRelayCheck, relayReady, settleExact, type SettleResult } from "./settle.ts";
import { caip2, FacilitatorInputError, parseFacilitatorRequest, parsePayload, payerOut, verifyExact, type ExactRequirements } from "./verify.ts";

// The hosted x402 facilitator for Robinhood Chain (v6 F), under /facilitator: the x402 facilitator interface (supported,
// verify, settle), a Bazaar-shaped discovery index of sellers who opted in, signed seller listings, seller gas floats and
// settlement receipts. Its rate limits are its own: per caller address, per payer and per seller (payTo).

const MAX_BODY = 64 * 1024;
const RECEIPT_ID = /^fst_[0-9a-f]{24}$/;
const SELLER_ID = /^fsl_[0-9a-f]{24}$/;

async function readBody(c: Context): Promise<unknown> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) fail(413, "Request body is too large (64 KB max).", "payload_too_large");
  const text = await c.req.text();
  if (text.length > MAX_BODY) fail(413, "Request body is too large (64 KB max).", "payload_too_large");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const retryAfter = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

/** What /api/v1/status says about the facilitator. The relay reading is the last one taken, never a fresh claim. */
export function facilitatorStatus(ctx: Ctx) {
  const f = ctx.cfg.facilitator;
  const relay = ctx.chain.roleAddress("facilitator");
  const last = lastRelayCheck(ctx);
  return {
    enabled: f.enabled,
    url: f.enabled ? `${ctx.cfg.publicUrl}/facilitator` : null,
    networks: f.enabled ? [caip2(ctx.cfg.chain.id)] : [],
    fee_bps: f.feeBps,
    min_settle_units: f.minSettle.toString(),
    gas_floats: !!f.gasFloat,
    relay: f.enabled ? { address: relay ? getAddress(relay) : null, balance_floor_wei: f.relayFloorWei.toString(), above_floor: last?.ok ?? null, checked_at: last?.at.toISOString() ?? null } : null,
    listings_screened: ctx.cfg.sanctions.enabled,
  };
}

export function facilitatorRoutes(app: Hono, ctx: Ctx) {
  const f = ctx.cfg.facilitator;
  const network = caip2(ctx.cfg.chain.id);
  const on = () => {
    if (!f.enabled) fail(503, "The facilitator is not switched on at this router.", "facilitator_disabled");
  };
  /** Per caller address: the facilitator's own bucket, apart from the API's. Over Tor the shared onion bucket. */
  const byAddress = async (c: Context) => {
    const from = addressBucket(c, ctx.cfg);
    const r = await ctx.limiter.take(`facilitator:${from.id}`, 1, from.scale(f.rpm), 60_000);
    if (!r.ok) c.header("retry-after", retryAfter(r.retryAfterMs));
    return r.ok;
  };
  /** Per payer and per seller: a payer cannot drain the relay with a stream of tiny payments, nor a seller with its buyers'. */
  const byParties = async (c: Context, payer: Hex, payTo: Hex) => {
    const p = await ctx.limiter.take(`facilitator-payer:${payer.toLowerCase()}`, 1, f.payerPerMin, 60_000);
    if (!p.ok) {
      c.header("retry-after", retryAfter(p.retryAfterMs));
      return false;
    }
    const s = await ctx.limiter.take(`facilitator-seller:${payTo.toLowerCase()}`, 1, f.sellerPerMin, 60_000);
    if (!s.ok) c.header("retry-after", retryAfter(s.retryAfterMs));
    return s.ok;
  };
  const settleJson = (c: Context, r: SettleResult) => {
    const { http, ...body } = r;
    if (http === 503) c.header("retry-after", "60");
    return c.json(body, http);
  };

  app.get("/facilitator/supported", async (c) => {
    on();
    if (!(await byAddress(c))) fail(429, "Too many facilitator requests from this address.", "rate_limited");
    const relay = ctx.chain.roleAddress("facilitator");
    const domain = await ctx.chain.usdgDomain();
    const kinds = [{ x402Version: 1, scheme: "exact", network }, ...(ctx.cfg.x402.network !== network ? [{ x402Version: 1, scheme: "exact", network: ctx.cfg.x402.network }] : []), { x402Version: 2, scheme: "exact", network }];
    return c.json({
      kinds,
      extensions: ["bazaar"],
      signers: { [network]: relay ? [getAddress(relay)] : [] },
      policy: {
        custody: "none",
        settlement: "transferWithAuthorization from the payer straight to payTo; the relay key only pays gas",
        asset: { address: getAddress(ctx.cfg.chain.usdg), name: domain.name, version: domain.version, decimals: 6 },
        minSettleUnits: f.minSettle.toString(),
        fee: { bps: f.feeBps, waived: f.feeBps === 0, treasury: f.treasury ? getAddress(f.treasury) : null, requirementField: "extra.facilitatorFee {amount, payTo}", payloadField: "payload.facilitatorFee {signature, authorization}" },
        gasFloats: f.gasFloat ? { enabled: true, bufferBps: f.gasFloat.bufferBps, treasury: getAddress(f.treasury!) } : { enabled: false },
        relay: { balanceFloorWei: f.relayFloorWei.toString(), belowFloor: "facilitator_unavailable" },
        screening: { listings: ctx.cfg.sanctions.enabled ? "ofac_sdn" : "off", payers: "not_screened", settlements: "not_screened", reason: "non-custodial: the facilitator never holds the funds it relays" },
        rateLimits: { perAddressPerMinute: f.rpm, perPayerPerMinute: f.payerPerMin, perSellerPerMinute: f.sellerPerMin, listingsPerHour: f.listingsPerHour },
        validBeforeMarginSeconds: 6,
        listing: { domain: listingDomain(ctx.cfg.chain.id), primaryType: "SellerListing", types: LISTING_TYPES },
        discovery: `${ctx.cfg.publicUrl}/facilitator/discovery/resources`,
      },
    });
  });

  app.get("/facilitator/discovery/resources", async (c) => {
    on();
    if (!(await byAddress(c))) fail(429, "Too many facilitator requests from this address.", "rate_limited");
    return c.json(await discoverResources(ctx, c.req.query()));
  });

  app.post("/facilitator/verify", async (c) => {
    on();
    if (!(await byAddress(c))) return c.json({ isValid: false, invalidReason: "rate_limited", payer: "" }, 429);
    let parsed;
    try {
      parsed = parseFacilitatorRequest(await readBody(c));
    } catch (e) {
      if (e instanceof FacilitatorInputError) return c.json({ isValid: false, invalidReason: e.reason, invalidMessage: e.message, payer: "" }, 400);
      throw e;
    }
    const { payload, requirements } = parsed;
    if (!(await byParties(c, payload.main.auth.from, requirements.payTo))) return c.json({ isValid: false, invalidReason: "rate_limited", payer: payerOut(payload.main.auth.from) }, 429);
    const v = await verifyExact(ctx, payload, requirements, { relayReady: () => relayReady(ctx) });
    if (!v.isValid) {
      if (v.invalidReason === "facilitator_unavailable") c.header("retry-after", "60");
      return c.json({ isValid: false, invalidReason: v.invalidReason, payer: payerOut(v.payer) }, v.invalidReason === "facilitator_unavailable" ? 503 : 200);
    }
    return c.json({ isValid: true, payer: payerOut(v.payer) });
  });

  app.post("/facilitator/settle", async (c) => {
    on();
    if (!(await byAddress(c))) return c.json({ success: false, errorReason: "rate_limited", transaction: "", network, payer: "" }, 429);
    let parsed;
    try {
      parsed = parseFacilitatorRequest(await readBody(c));
    } catch (e) {
      if (e instanceof FacilitatorInputError) return c.json({ success: false, errorReason: e.reason, errorMessage: e.message, transaction: "", network, payer: "" }, 400);
      throw e;
    }
    const { payload, requirements } = parsed;
    if (!(await byParties(c, payload.main.auth.from, requirements.payTo))) return c.json({ success: false, errorReason: "rate_limited", transaction: "", network: requirements.network, payer: payerOut(payload.main.auth.from) }, 429);
    return settleJson(c, await settleExact(ctx, payload, requirements));
  });

  // Opt-in listing, signed by the payTo key (EIP-712 SellerListing; see /facilitator/supported policy.listing).
  app.post("/facilitator/sellers", async (c) => {
    on();
    if (!(await byAddress(c))) fail(429, "Too many facilitator requests from this address.", "rate_limited");
    const raw = await readBody(c);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(400, "The body must be a signed listing.", "invalid_listing");
    const listing = parseListing(ctx, raw as Record<string, unknown>);
    const r = await ctx.limiter.take(`facilitator-listing:${listing.payTo}`, 1, f.listingsPerHour, 3_600_000);
    if (!r.ok) fail(429, "Too many listing updates for this payTo; retry later.", "rate_limited", undefined, { "retry-after": retryAfter(r.retryAfterMs) });
    const { row, created } = await upsertListing(ctx, listing);
    return c.json({ data: listingJson(row) }, created ? 201 : 200);
  });

  app.get("/facilitator/sellers/:id", async (c) => {
    on();
    if (!(await byAddress(c))) fail(429, "Too many facilitator requests from this address.", "rate_limited");
    const id = c.req.param("id");
    if (!SELLER_ID.test(id)) fail(404, "Seller not found.", "not_found");
    const [row] = await ctx.db.select().from(facilitatorSellers).where(eq(facilitatorSellers.id, id));
    if (!row) fail(404, "Seller not found.", "not_found");
    const [float] = await ctx.db.select().from(sellerGasFloats).where(eq(sellerGasFloats.sellerId, id));
    return c.json({ data: { ...listingJson(row), gasFloat: float ? { balance: float.balance.toString(), funded: float.funded.toString(), debited: float.debited.toString() } : null } });
  });

  // Top up a seller's gas float: an exact payment from any wallet to the treasury, relayed like any other.
  app.post("/facilitator/sellers/:id/gas-float", async (c) => {
    on();
    if (!f.gasFloat || !f.treasury) fail(503, "Gas floats are not switched on at this facilitator.", "gas_floats_unavailable");
    if (!(await byAddress(c))) return c.json({ success: false, errorReason: "rate_limited", transaction: "", network, payer: "" }, 429);
    const id = c.req.param("id");
    const [seller] = SELLER_ID.test(id) ? await ctx.db.select({ id: facilitatorSellers.id }).from(facilitatorSellers).where(eq(facilitatorSellers.id, id)) : [];
    if (!seller) fail(404, "Seller not found. Sign a listing first (it may say listed: false).", "not_found");
    const raw = await readBody(c);
    let payload;
    try {
      payload = parsePayload((raw as { paymentPayload?: unknown } | undefined)?.paymentPayload);
    } catch (e) {
      if (e instanceof FacilitatorInputError) return c.json({ success: false, errorReason: e.reason, errorMessage: e.message, transaction: "", network, payer: "" }, 400);
      throw e;
    }
    if (!(await byParties(c, payload.main.auth.from, f.treasury))) return c.json({ success: false, errorReason: "rate_limited", transaction: "", network, payer: payerOut(payload.main.auth.from) }, 429);
    const requirements: ExactRequirements = { x402Version: payload.x402Version as 1 | 2, scheme: "exact", network, amount: payload.main.auth.value, payTo: f.treasury, asset: ctx.cfg.chain.usdg.toLowerCase() as Hex, maxTimeoutSeconds: 300, resource: null, fee: null };
    const r = await settleExact(ctx, payload, requirements, { kind: "gas_float", floatSellerId: seller.id });
    return settleJson(c, r);
  });

  // A settlement's signed receipt (kind facilitator.settle) and, once its hour is rooted, the anchor proof.
  app.get("/facilitator/receipts/:id", async (c) => {
    on();
    if (!(await byAddress(c))) fail(429, "Too many facilitator requests from this address.", "rate_limited");
    const id = c.req.param("id");
    if (!RECEIPT_ID.test(id)) fail(404, "Receipt not found.", "not_found");
    const [s] = await ctx.db.select().from(facilitatorSettlements).where(eq(facilitatorSettlements.id, id));
    if (!s?.receiptCose) fail(404, "Receipt not found.", "not_found");
    if (c.req.query("format") === "cose") return c.body(Buffer.from(s.receiptCose, "base64"), 200, { "content-type": COSE_CONTENT_TYPE });
    return c.json({
      data: {
        id: s.id,
        kind: "facilitator.settle",
        status: s.status,
        transaction: s.txHash,
        alg: "EdDSA",
        kid: s.receiptKeyId,
        content_type: COSE_CONTENT_TYPE,
        cose: s.receiptCose,
        claims: inspectCose(Buffer.from(s.receiptCose, "base64")).claims,
        leaf: s.receiptLeaf,
        anchor: await anchorProof(ctx, { anchorIndex: s.anchorIndex, leafIndex: s.leafIndex }),
      },
    });
  });
}

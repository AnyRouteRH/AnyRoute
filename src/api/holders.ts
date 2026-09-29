import type { Hono } from "hono";
import { formatUnits, parseUnits } from "viem";
import type { Ctx } from "../context.ts";
import { holderCreditsFor } from "../holders/credits.ts";
import { discountedBps, lookupHolder, scaleLimit, tierJson, walletOfAccount } from "../holders/tiers.ts";
import { requireKey } from "./auth.ts";

// $ANYR holder status for the wallet behind this key: balance, live tier and perks, the tier ladder,
// and the free inference credits received (scripts/holder-credits.ts). Only wallet sign-in keys have a
// wallet; any other key gets the same shape with a hint.
export function holdersRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/holder", async (c) => {
    c.header("Cache-Control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const h = ctx.cfg.holders;
    const wallet = walletOfAccount(key.accountId);
    const credits = wallet ? await holderCreditsFor(ctx.db, key.accountId) : [];
    const data = {
      enabled: h.enabled,
      token: h.token ? { address: h.token.address, symbol: h.token.symbol } : null,
      wallet,
      balance: null as string | null,
      balance_error: false,
      tier: null as ReturnType<typeof tierJson> | null,
      next_tier: null as { name: string; min: string; remaining: string } | null,
      perks: null as Record<string, unknown> | null,
      tiers: h.tiers.map(tierJson),
      credits_received: credits,
      credits_total_usd: Number(credits.reduce((s, x) => s + x.usd, 0).toFixed(6)),
      ...(wallet ? {} : { hint: `Holder perks follow a wallet. Sign in with the wallet that holds $${h.token?.symbol ?? "ANYR"}.` }),
    };
    if (!wallet || !h.token) return c.json({ data });

    const look = await lookupHolder(ctx, wallet);
    if (look.error || look.balance == null || look.decimals == null) return c.json({ data: { ...data, balance_error: true } });
    const { balance, decimals, tier } = look;
    data.balance = formatUnits(balance, decimals);
    const next = h.enabled ? h.tiers.find((t) => parseUnits(t.min, decimals) > balance) : undefined;
    if (next) data.next_tier = { name: next.name, min: next.min, remaining: formatUnits(parseUnits(next.min, decimals) - balance, decimals) };
    if (tier) {
      data.tier = tierJson(tier);
      const fees = ctx.cfg.fees;
      data.perks = {
        rpm_multiplier: tier.rpmMultiplier,
        rpm: scaleLimit(key.rpm ?? ctx.cfg.limits.defaultRpm, tier), // this key's limit; 0 = unlimited
        tpm: scaleLimit(key.tpm ?? null, tier),
        discount_bps: tier.discountBps,
        // Anyroute's own fee rates for this wallet. Upstream cost and royalties are never discounted.
        fees: { prepaid_bps: 0, per_call_margin_bps: discountedBps(fees.perCallMarginBps, tier), byok_fee_bps: discountedBps(fees.byokFeeBps, tier) },
        ...(tier.discountBps ? { note: "Prepaid calls carry no Anyroute margin, so the discount applies to per-call payments and BYOK fees." } : {}),
      };
    }
    return c.json({ data });
  });
}

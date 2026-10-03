import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import { bearer, requireKey, requireRole } from "../api/auth.ts";
import { reserve, release, settle } from "../ledger/ledger.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsdString, usdToPico } from "../lib/money.ts";
import { sha256, uid } from "../lib/util.ts";
import { payPerCall } from "../pay/percall.ts";
import { x402ResponseHeaders } from "../pay/x402.ts";

// B: one data-tool call, charged once. Called only after the data was read and passed its checks, so a refusal is free.
//  - With an API key (inference-only keys included): the flat price comes out of the key's prepaid balance through the
//    ordinary reserve and settle, so key budgets, balances and agent rulebooks apply. A rulebook sees the call as the tool
//    `data_tool` (its tools list, schedule and kill switch apply); it is not a model call.
//  - Without a key: the router's per-call payment, the same as keyless chat. An x402 `exact` offer (402 with `accepts`) once
//    X402_PAY_TO is set, CallPay where that is deployed, otherwise 401. The payment is credited to the payer's wallet account
//    and the price is settled from it; anything paid above the price stays there as change.
// Ledger and hold kind: data_tool (statements list it under other movements, not model usage).

export const DATA_TOOL_KIND = "data_tool";

export type DataCharge = { json: { usd: string; paid_with: "key" | "per_call"; payment_tx: string | null }; headers: Record<string, string> };

export async function chargeDataCall(ctx: Ctx, c: Context, o: { tool: string; description: string }): Promise<DataCharge> {
  const price = usdToPico(ctx.cfg.dataTools.priceUsd);
  const id = uid("dt_");
  const authorization = c.req.header("authorization");
  if (bearer(authorization)) {
    const key = await requireKey(ctx, authorization);
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    const lim = await ctx.limiter.take(`k:${key.keyHash}`, 1, key.rpm ?? ctx.cfg.limits.defaultRpm, 60_000);
    if (!lim.ok) fail(429, "Rate limit exceeded.", "rate_limited", undefined, { "retry-after": String(Math.ceil(lim.retryAfterMs / 1000)) });
    await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: price, kind: DATA_TOOL_KIND, ttlMs: 60_000 });
    return { json: { usd: picoToUsdString(await settleOrRelease(ctx, id, price, o.description)), paid_with: "key", payment_tx: null }, headers: {} };
  }
  // The quote binds to the method and path, the only request content a GET has.
  const paid = await payPerCall(ctx, c, { pricePico: price, bodySha: sha256(`GET ${new URL(c.req.url).pathname}`), modelId: `data:${o.tool}`, description: o.description });
  await reserve(ctx.db, { id, accountId: paid.accountId, keyHash: null, amount: price, kind: DATA_TOOL_KIND, ttlMs: 60_000 });
  const charged = await settleOrRelease(ctx, id, price, o.description);
  return { json: { usd: picoToUsdString(charged), paid_with: "per_call", payment_tx: paid.txHash }, headers: paid.paymentResponse ? x402ResponseHeaders(paid.paymentResponse) : {} };
}

async function settleOrRelease(ctx: Ctx, id: string, price: bigint, description: string) {
  try {
    return (await settle(ctx.db, id, price, { description, kind: DATA_TOOL_KIND })).charged;
  } catch (e) {
    await release(ctx.db, id);
    throw e;
  }
}

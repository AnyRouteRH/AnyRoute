import { and, eq, inArray } from "drizzle-orm";
import { encodeFunctionData, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { quotes } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { type Pico, picoToUsdg, usdgToPico } from "../lib/money.ts";
import { ensureAccount, post } from "../ledger/ledger.ts";
import { sleep } from "../lib/util.ts";
import { CallPayAbi } from "../chain/abis.ts";
import { walletAccountId } from "../api/auth.ts";

// HTTP 402 per-call payments for callers without a key (agents):
//   request -> 402 {price_usdg, pay_to, nonce, expiry, chain: 4663}
//   -> CallPay.pay(nonce, amount, expiry) on RHC (4337 + Paymaster)
//   -> retry the identical request with `X-Payment: <txHash>` -> served; receipt links the tx.
// The quote is bound to the request body hash. Any unused part of the payment stays as change on
// the payer's wallet account, spendable later with X-Wallet-Auth.

const fmtUsdg = (units: bigint) => {
  const s = units.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "") || "0";
};

export async function paymentRequired(ctx: Ctx, opts: { pricePico: Pico; bodySha: string; modelId: string }): Promise<never> {
  const callPay = ctx.chain.address("callPay");
  if (!callPay) fail(401, "An API key is required: per-call payment is not configured on this router.", "missing_key");
  const priceUsdg = picoToUsdg(opts.pricePico, "ceil");
  if (priceUsdg > BigInt(Math.round(ctx.cfg.fees.perCallMaxUsd * 1e6)))
    fail(400, `This request could cost more than the per-call maximum of $${ctx.cfg.fees.perCallMaxUsd}. Lower max_tokens or use a prepaid key.`, "per_call_too_large");
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const expiry = Math.floor(Date.now() / 1000) + ctx.cfg.fees.quoteTtlS;
  await ctx.db.insert(quotes).values({
    nonce,
    priceUsdg,
    pricePico: usdgToPico(priceUsdg),
    requestSha256: opts.bodySha,
    modelId: opts.modelId,
    expiresAt: new Date(expiry * 1000),
  });
  const domain = ctx.cfg.chain.routerKey ? await ctx.chain.usdgDomain() : ctx.cfg.chain.usdgDomain;
  const calldata = encodeFunctionData({ abi: CallPayAbi, functionName: "pay", args: [nonce, priceUsdg, BigInt(expiry)] });
  fail(
    402,
    `Payment required: $${fmtUsdg(priceUsdg)} USDG. Pay with CallPay on chain ${ctx.cfg.chain.id}, then retry this exact request with X-Payment: <txHash>.`,
    "payment_required",
    {
      price_usdg: fmtUsdg(priceUsdg),
      price_usdg_units: priceUsdg.toString(),
      pay_to: callPay,
      token: ctx.cfg.chain.usdg,
      nonce,
      expiry,
      chain: ctx.cfg.chain.id,
      method: "pay(bytes32 nonce,uint256 amount,uint256 expiry)",
      calldata,
      paymaster: ctx.cfg.chain.paymaster ? { address: ctx.cfg.chain.paymaster, rpc: `${ctx.cfg.publicUrl}/api/v1/paymaster` } : null,
      // Gasless option: sign this EIP-712 message with the paying wallet and send it back as
      // X-Payment: base64(JSON {scheme: "eip3009", from, value, validAfter, validBefore, nonce, signature}).
      // The router relays CallPay.payWithAuthorization; the quote nonce doubles as the authorization nonce.
      eip3009: ctx.cfg.chain.routerKey
        ? {
            domain: { name: domain.name, version: domain.version, chainId: ctx.cfg.chain.id, verifyingContract: ctx.cfg.chain.usdg },
            primaryType: "ReceiveWithAuthorization",
            types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
            message: { to: callPay, value: priceUsdg.toString(), validAfter: "0", validBefore: String(expiry), nonce },
          }
        : null,
      retry_header: "X-Payment",
      margin_bps: ctx.cfg.fees.perCallMarginBps,
    },
    { "x-payment-required": "usdg", "www-authenticate": `Payment realm="anyroute", chain="${ctx.cfg.chain.id}", nonce="${nonce}"` },
  );
}

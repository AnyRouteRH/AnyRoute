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

export type Eip3009Auth = { from: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex; signature: Hex };
export type PaymentHeader = { kind: "tx"; hash: Hex } | { kind: "eip3009"; auth: Eip3009Auth };

export function parsePaymentHeader(v: string): PaymentHeader {
  const t = v.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return { kind: "tx", hash: t.toLowerCase() as Hex };
  try {
    const j = JSON.parse(t.startsWith("{") ? t : Buffer.from(t, "base64").toString("utf8"));
    if (typeof j?.tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(j.tx)) return { kind: "tx", hash: j.tx.toLowerCase() as Hex };
    if (j?.scheme === "eip3009") {
      const hex = (x: unknown, n?: number) => typeof x === "string" && (n ? new RegExp(`^0x[0-9a-fA-F]{${n}}$`) : /^0x[0-9a-fA-F]+$/).test(x);
      if (!hex(j.from, 40) || !hex(j.nonce, 64) || !hex(j.signature)) throw new Error("bad fields");
      return { kind: "eip3009", auth: { from: j.from, value: BigInt(j.value), validAfter: BigInt(j.validAfter ?? 0), validBefore: BigInt(j.validBefore), nonce: j.nonce, signature: j.signature } };
    }
  } catch {
    /* fallthrough */
  }
  fail(400, "X-Payment must be a transaction hash, JSON {\"tx\": \"0x...\"}, or base64 JSON {\"scheme\": \"eip3009\", ...}.", "invalid_payment");
}

/** Gasless path: relay the signed authorization on-chain, then redeem the resulting payment. */
export async function relayAuthorization(ctx: Ctx, auth: Eip3009Auth): Promise<Hex> {
  const [q] = await ctx.db.select().from(quotes).where(eq(quotes.nonce, auth.nonce));
  if (!q) fail(402, "This authorization's nonce is not a quote from this router.", "payment_unknown_quote");
  if (q.status !== "open") fail(409, "This quote was already paid or used.", "payment_used");
  if (auth.value < q.priceUsdg) fail(402, `Authorization is for ${auth.value} base units; the quote is ${q.priceUsdg}.`, "payment_insufficient");
  try {
    return (await ctx.chain.payWithAuthorization({ nonce: auth.nonce, amount: auth.value, expiry: BigInt(Math.floor(q.expiresAt.getTime() / 1000)), from: auth.from, validAfter: auth.validAfter, validBefore: auth.validBefore, signature: auth.signature })).toLowerCase() as Hex;
  } catch (e) {
    fail(402, `The payment authorization was rejected on-chain: ${(e as Error).message.split("\n")[0].slice(0, 200)}`, "payment_failed");
  }
}

/** Verify a CallPay transaction for this exact request and credit the payer's wallet account. */
export async function redeemPayment(ctx: Ctx, txHash: Hex, bodySha: string, waitMs = 8_000) {
  let payments = await ctx.chain.readCallPayments(txHash);
  const deadline = Date.now() + waitMs;
  while (!Array.isArray(payments) && Date.now() < deadline) {
    await sleep(750);
    payments = await ctx.chain.readCallPayments(txHash);
  }
  if (!Array.isArray(payments))
    fail(402, `Payment ${txHash} is not confirmed yet (${payments.confirmations}/${ctx.cfg.chain.confirmations}). Retry shortly.`, "payment_pending", { confirmations: payments.confirmations });
  // Credit every payment in the transaction to its own payer (a bundle may carry several); whatever
  // happens next, payers keep what they paid as change. Same ledger refs as the indexer.
  for (const p of payments) {
    const acct = walletAccountId(p.payer.toLowerCase());
    await ctx.db.transaction(async (tx) => {
      await ensureAccount(tx, acct, "wallet", p.payer.toLowerCase());
      await post(tx, { accountId: acct, amount: usdgToPico(p.amount), kind: "per_call_payment", ref: `callpay:${txHash}:${p.logIndex}`, description: `Per-call payment ${txHash}` });
    });
  }
  // Which of them pays for this request: the one whose quote was issued for this exact body.
  const quoteRows = await ctx.db.select().from(quotes).where(inArray(quotes.nonce, payments.map((p) => p.nonce)));
  const q = quoteRows.find((r) => r.requestSha256 === bodySha) ?? quoteRows[0];
  const paid = payments.find((p) => p.nonce === q?.nonce) ?? payments[0];
  const payer = paid.payer.toLowerCase();
  const accountId = walletAccountId(payer);
  if (!q) fail(402, "This payment does not match any quote from this router. It was kept as change on your wallet account.", "payment_unknown_quote");
  if (q.requestSha256 !== bodySha)
    fail(409, "This payment was quoted for a different request body. It was kept as change on your wallet account; spend it with X-Wallet-Auth.", "payment_request_mismatch");
  if (q.status === "used") fail(409, "This quote was already used.", "payment_used");
  if (paid.amount < q.priceUsdg)
    fail(402, `Underpaid: quote was ${q.priceUsdg} base units, paid ${paid.amount}. The payment was kept as change.`, "payment_insufficient");
  // Compare-and-set: of two concurrent redemptions of the same payment, exactly one wins.
  const updated = await ctx.db
    .update(quotes)
    .set({ status: "used", payer, txHash, accountId })
    .where(and(eq(quotes.nonce, q.nonce), inArray(quotes.status, ["open", "paid"])))
    .returning({ nonce: quotes.nonce });
  if (!updated.length) fail(409, "This quote was already used.", "payment_used");
  return { accountId, payer, txHash, quote: q };
}

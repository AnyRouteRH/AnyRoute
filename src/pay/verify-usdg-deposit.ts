import { TransactionReceiptNotFoundError } from "viem";
import type { Ctx } from "../context.ts";
import type { DecodedLog } from "../chain/service.ts";

/** Receipt status, configured Credits contract, exact log index/key/amount and canonical block hash. */
export async function verifyUsdgDeposit(ctx: Ctx, e: DecodedLog, hash?: string): Promise<{ ok: boolean; unknown?: boolean; hash?: string }> {
  let r;
  try { r = await ctx.chain.client.getTransactionReceipt({ hash: e.txHash }); }
  catch (err) { if (err instanceof TransactionReceiptNotFoundError) return { ok: false }; throw err; }
  const canonical = await ctx.chain.blockHashAt(e.blockNumber);
  if (!canonical) return { ok: false, unknown: true };
  if (hash && hash !== canonical.toLowerCase()) return { ok: false };
  if (r.blockHash.toLowerCase() !== canonical.toLowerCase()) return { ok: false, unknown: true };
  if (r.status !== "success" || r.blockNumber !== e.blockNumber) return { ok: false };
  const decoded = ctx.chain.decodeReceipt(r.logs);
  const found = decoded.some(l => l.contract === "credits" && l.event === "Deposited" && l.logIndex === e.logIndex && String(l.args.keyHash).toLowerCase() === String(e.args.keyHash).toLowerCase() && String(l.args.amount) === String(e.args.amount));
  return { ok: found, hash: canonical.toLowerCase() };
}

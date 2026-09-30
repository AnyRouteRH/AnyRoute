import type { Ctx } from "../context.ts";
import type { Candidate } from "../catalog/catalog.ts";
import { networkReceiptLinks } from "./payout-schema.ts";
const ids = new WeakMap<object, string>();
/** Only a response header identifier is read here; no response or request text is retained. */
export function captureNetworkReceipt<T extends object>(result: T, response: Response, candidate: Candidate): T {
  const id = response.headers.get("x-anyroute-receipt-id");
  if (candidate.provider.networkHost && id && /^rcpt_[0-9a-f]{24}$/.test(id)) ids.set(result, id);
  return result;
}
export async function linkNetworkReceipt(ctx: Ctx, generationId: string, providerId: string, upstream: object) {
  if (!ctx.cfg.networkPayouts.enabled) return;
  const receiptId = ids.get(upstream);
  if (receiptId) await ctx.db.insert(networkReceiptLinks).values({ generationId, providerId, receiptId }).onConflictDoNothing();
}
export function forwardNetworkReceipt<T extends object>(result: T, upstream: object): T {
  const id = ids.get(upstream);
  if (id) ids.set(result, id);
  return result;
}

// Decision tags. Send the SHA-256 of an order intent with the model call that informs it, as X-Anyroute-Decision-Tag,
// and the router signs that hash into the call's v1 receipt (payload.decision_tag) and v2 claims (claims.decision_tag).
// Later, anyone holding the order and the receipt can show this model call was made for this order; the router only ever
// sees the hash. The router records tags only while DECISION_TAGS_ENABLED is on (GET /api/v1/status: decision_tags.enabled);
// while it is off the header is ignored, so check the first receipt you store.
//
// The hash is the one integrations/robinhood-agents/decision-receipt.ts and the Python SDK compute: SHA-256 of the order's
// canonical JSON (keys sorted, no spaces). Write prices and quantities as strings so every language hashes the same bytes.

import { canonicalJson } from "./canonical.js";
import { sha256Hex } from "./hash.js";

export const DECISION_TAG_HEADER = "X-Anyroute-Decision-Tag";

/** `sha256:<hex>` of the order's canonical JSON: the value to send as the decision tag and to give Agent Guard as details_sha256. */
export async function decisionTag(order: Record<string, unknown>): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(order))}`;
}

/**
 * Request options that send this order's decision tag, merged into `options` (its own headers are kept). Pass the result as
 * the second argument of `client.chat.completions.create` here, or of the OpenAI SDK's `create`, which reads `headers` too.
 */
export async function withDecisionTag<T extends { headers?: Record<string, string> }>(order: Record<string, unknown>, options?: T): Promise<T & { headers: Record<string, string> }> {
  return { ...(options ?? ({} as T)), headers: { ...(options?.headers ?? {}), [DECISION_TAG_HEADER]: await decisionTag(order) } };
}

type TaggedReceipt = { payload?: Record<string, unknown> | null; v2?: { claims?: Record<string, unknown> | null } | null; claims?: Record<string, unknown> | null };

/** The decision tag a receipt carries (its v1 payload, else its v2 claims), or null when it carries none. */
export function receiptDecisionTag(receipt: TaggedReceipt | null | undefined): string | null {
  const tag = receipt?.payload?.decision_tag ?? receipt?.v2?.claims?.decision_tag ?? receipt?.claims?.decision_tag;
  return typeof tag === "string" ? tag : null;
}

/**
 * Whether a receipt's decision tag is this order's hash. It compares hashes only: check the receipt's signature with
 * verifyReceipt (or client.verifyReceipt) as well, since an unsigned copy can say anything.
 */
export async function checkDecisionTag(receipt: TaggedReceipt | null | undefined, order: Record<string, unknown>) {
  const expected = await decisionTag(order);
  const tag = receiptDecisionTag(receipt);
  return { matches: tag === expected, tag, expected };
}

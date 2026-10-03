import type { ExternalDoc } from "./types.ts";

// v6 L: the commerce ledger's public snapshot in router memory (src/commerce/stats.ts).
export const commerceStores: ExternalDoc["otherStores"] = [{
  id: "commerce-stats-cache", name: "Public commerce ledger in router memory",
  purpose: "When COMMERCE_STATS_ENABLED is on, cache the public commerce ledger and share one refresh among concurrent readers.",
  holds: "Only the public aggregate response: snapshot time, receipt kinds, filter settings and transfer-index position, and per window and kind the gross and filtered settlement, distinct payer and payee counts, USDG volume, median price, refund count and rate, and the count excluded by each rule. To build it, the router reads in memory the payer and payee wallet or account identifiers, amounts, times, transaction hashes, anchor status and refund flags of settled payments, and public USDG transfers; none of these enter the cache. Figures are never split by privacy lane, so a private-lane settlement cannot be told apart. No inference text or caller network address is read. No Redis keys. A failed refresh logs one warning with the first line of the error, cut to 200 characters; database errors put the query text on that line, not its parameters.",
  ttl: "Cache freshness ends 60 seconds after refresh begins, with no stale-on-error serving. The single expired snapshot may remain allocated until replaced or the router exits. Settlement rows read for a refresh are eligible for collection when it ends.",
  requestText: "none",
  evidence: [{ file: "src/commerce/stats.ts", contains: "export const COMMERCE_STATS_CACHE_MS = 60_000;" }, { file: "src/commerce/stats.ts", contains: "const get = statsCache(() => readCommerceStats(ctx), Date.now, COMMERCE_STATS_CACHE_MS);" }, { file: "src/commerce/ledger.ts", contains: "nothing it returns names a payer, a payee" }],
}];

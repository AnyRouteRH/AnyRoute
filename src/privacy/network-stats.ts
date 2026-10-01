import type { ExternalDoc } from "./types.ts";

export const networkStatsStores: ExternalDoc["otherStores"] = [{
  id: "network-stats-cache", name: "Public network statistics in router memory",
  purpose: "When NETWORK_STATS_ENABLED is on, cache read-only network statistics and share one refresh among concurrent readers.",
  holds: "Only the public aggregate response: snapshot time, host status counts, fresh admitted host count, distinct eligible model IDs, 100,000-token ranges from retained public-lane generation counts, indexer total/active USDG bonds with freshness and block, waitlist counts and published policy version. Private-lane generation rows are excluded; existing router-wide DP releases cannot identify network-host totals. Database query results and public admission evidence are read temporarily to form the snapshot. The host query selects no credentials, operator wallets or contact fields. The existing bond adapter reads public on-chain projection metadata, which can include operator addresses; only aggregate amounts, freshness and indexed block enter this cache. No inference text or caller address is read. No new database rows, Redis keys or log fields.",
  ttl: "Cache freshness ends 30 seconds after refresh begins, with no stale-on-error serving. The single expired snapshot may remain allocated until replaced or the router exits. Query results are eligible for collection after refresh; process exit releases all cache memory.",
  requestText: "none",
  evidence: [{ file: "src/network/stats.ts", contains: "NETWORK_STATS_CACHE_MS = 30_000" }, { file: "src/network/stats.ts", contains: "PUBLIC_LANE_ROWS" }, { file: "src/network/stats.ts", contains: "const get = statsCache" }],
}];

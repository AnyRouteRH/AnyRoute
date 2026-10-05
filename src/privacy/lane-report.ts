import type { Evidence, ExternalDoc, RedisFamily } from "./types.ts";

// Lane report (src/lane-report/read.ts). Read-only over existing call records; one new per-key rate-limit family.

const ev = (file: string, contains: string): Evidence => ({ file, contains });

export const laneReportLimit: RedisFamily = {
  key: "rl:lane-report:<key hash>:<window start>",
  purpose: "Lane reports, thirty per minute per API key. Contains only the key hash and a counter.",
  holds: "key-hash",
  limiterPrefix: "lane-report:",
  windowSeconds: 60,
  ttl: "61 seconds (the 60-second window plus one second)",
  evidence: [ev("src/api/lane-report.ts", "await ctx.limiter.take(`lane-report:${key.keyHash}`"), ev("src/lib/ratelimit.ts", "const k = `rl:${key}:${start}`;"), ev("src/lib/ratelimit.ts", "await this.redis.pexpire(k, windowMs + 1000);")],
};

export const laneReportStores: ExternalDoc["otherStores"] = [{
  id: "lane-report", name: "Lane report in memory",
  purpose: "With STATEMENTS_ENABLED (off by default), GET /api/v1/lane-report?from=&to= groups the calls Activity lists for the key's scope over at most 31 UTC days by the lane each receipt records, provider and model, and returns calls and charged spend per lane, the share on the attested and unlinkable lanes, and per provider and model rows for those lanes with links to the provider's public attestation record. Management and owner/admin keys read the account; ordinary and session keys read only their own key. The proof pack carries the same summary for the calls in each file.",
  holds: "Lane names read from receipt JSON, provider and model ids, call counts, exact charged amounts, the range and the key hash for key-scoped reports. No request or answer text, receipt hashes, key secrets or network addresses.",
  ttl: "Discarded after the response with cache-control no-store. No new tables, columns or log fields; one rate-limit counter per key.",
  requestText: "none", evidence: [ev("src/lane-report/read.ts", "export async function readLaneReport"), ev("src/api/lane-report.ts", 'c.header("cache-control", "no-store")')],
}];

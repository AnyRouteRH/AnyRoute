import type { Catalog } from "./catalog/catalog.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import type { RateLimiter } from "./lib/ratelimit.ts";
import type { ReceiptSigner } from "./receipts/signer.ts";
import type { HealthTracker } from "./services/health.ts";
import type { ChainService } from "./chain/service.ts";
import type { ResponseCache } from "./gateway/cache.ts";
import type { Telemetry } from "./gateway/otel.ts";
import type { Jobs } from "./services/jobs.ts";

export type Ctx = {
  cfg: Config;
  db: Db;
  dbKind: "pglite" | "postgres";
  catalog: Catalog;
  health: HealthTracker;
  signer: ReceiptSigner;
  limiter: RateLimiter;
  chain: ChainService;
  cache: ResponseCache;
  telemetry: Telemetry;
  jobs: Jobs;
  /** Set only when TELEGRAM_BOT_TOKEN is configured; stopped before the jobs on shutdown. */
  telegram?: { stop(): Promise<void> };
  /** Test hook: deterministic provider shuffle. */
  rand?: () => number;
};

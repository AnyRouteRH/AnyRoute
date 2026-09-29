import type { Ctx } from "../context.ts";
import { expireHolds } from "../ledger/ledger.ts";
import { pollChain } from "../chain/indexer.ts";
import { runPaywithAggregator } from "../pay/paywith.ts";
import { pollEscrow } from "../pay/escrow.ts";
import { retryAnchors, runAnchor, runKeyRotation } from "./anchor.ts";
import { runAttestor } from "./attestor.ts";
import { runCanaries } from "./canaries.ts";
import { runProbes } from "./probes.ts";
import { runRegistry } from "./registry.ts";
import { runSettlement } from "./settlement.ts";
import { runSlasher } from "./slasher.ts";
import { runBuyback } from "./buyback.ts";
import { ALERT_INTERVAL_MS, runAlertNotifier } from "./alerts.ts";

export function registerJobs(ctx: Ctx) {
  const { cfg, jobs } = ctx;
  const chainOn = () => ["credits", "callPay", "payWithStock", "providerBond", "receiptAnchor", "royalty", "staking"].some((n) => ctx.chain.address(n as never));
  jobs.register("health-flush", 5_000, () => ctx.health.flush(ctx.db));
  jobs.register("holds-expire", 60_000, () => expireHolds(ctx.db));
  jobs.register("catalog-refresh", 30_000, () => ctx.catalog.refresh(), { atStart: true });
  jobs.register("provider-registry", cfg.workers.registryIntervalMs, () => runRegistry(ctx), { atStart: true });
  if (cfg.routing.probes) jobs.register("health-probes", cfg.routing.probeIntervalMs, () => runProbes(ctx), { atStart: true });
  if (cfg.canaries.enabled) jobs.register("canaries", cfg.canaries.intervalMs, () => runCanaries(ctx));
  jobs.register("attestor", cfg.attestation.intervalMs, () => runAttestor(ctx), { atStart: true });
  jobs.register("receipts-anchor", cfg.receipts.anchorIntervalMs, async () => ({ anchor: await runAnchor(ctx), retry: await retryAnchors(ctx) }), { atStart: true });
  jobs.register("receipt-key-rotation", 3_600_000, () => runKeyRotation(ctx), { atStart: true });
  jobs.register("settlement", cfg.workers.settlementIntervalMs, () => runSettlement(ctx), { atStart: true });
  jobs.register("slasher", 3_600_000, () => runSlasher(ctx));
  jobs.register("buyback", 3_600_000, () => runBuyback(ctx));
  jobs.register("chain-indexer", 5_000, async () => (chainOn() ? pollChain(ctx) : { skipped: "no contracts" }), { atStart: true });
  jobs.register("escrow-indexer", 5_000, () => pollEscrow(ctx), { atStart: true });
  jobs.register("paywith-aggregator", 60_000, async () => (ctx.chain.address("payWithStock") ? runPaywithAggregator(ctx) : { skipped: "not configured" }));
  jobs.register("alert-notifier", ALERT_INTERVAL_MS, () => runAlertNotifier(ctx), { atStart: true });
}

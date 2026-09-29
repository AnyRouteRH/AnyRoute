import type { Ctx } from "../context.ts";
import { expireHolds } from "../ledger/ledger.ts";
import { pollChain } from "../chain/indexer.ts";
import { runPaywithAggregator } from "../pay/paywith.ts";
import { pollEscrow } from "../pay/escrow.ts";
import { runSpendWatch } from "./spend-watch.ts";
import { retryAnchors, runAnchor, runKeyRotation } from "./anchor.ts";
import { runAttestor } from "./attestor.ts";
import { runMeasurements } from "./measurements.ts";
import { runCanaries } from "./canaries.ts";
import { runProbes } from "./probes.ts";
import { runRegistry } from "./registry.ts";
import { runSettlement } from "./settlement.ts";
import { runSlasher } from "./slasher.ts";
import { runBuyback } from "./buyback.ts";
import { ALERT_INTERVAL_MS, runAlertNotifier } from "./alerts.ts";
import { TelegramBot, type RouterCall } from "./telegram.ts";

export function registerJobs(ctx: Ctx, router?: RouterCall) {
  const { cfg, jobs } = ctx;
  const chainOn = () => ["credits", "callPay", "payWithStock", "providerBond", "receiptAnchor", "royalty", "staking"].some((n) => ctx.chain.address(n as never));
  jobs.register("health-flush", 5_000, () => ctx.health.flush(ctx.db));
  jobs.register("holds-expire", 60_000, () => expireHolds(ctx.db));
  jobs.register("catalog-refresh", 30_000, () => ctx.catalog.refresh(), { atStart: true });
  jobs.register("provider-registry", cfg.workers.registryIntervalMs, () => runRegistry(ctx), { atStart: true });
  if (cfg.routing.probes) jobs.register("health-probes", cfg.routing.probeIntervalMs, () => runProbes(ctx), { atStart: true });
  if (cfg.canaries.enabled) jobs.register("canaries", cfg.canaries.intervalMs, () => runCanaries(ctx));
  jobs.register("attestor", cfg.attestation.intervalMs, () => runAttestor(ctx), { atStart: true });
  // Off unless MEASUREMENTS_ENABLED: Rekor lookups and register() calldata for attested measurements. Sends nothing.
  if (cfg.measurements.enabled) jobs.register("measurements", cfg.measurements.intervalMs, () => runMeasurements(ctx));
  jobs.register("receipts-anchor", cfg.receipts.anchorIntervalMs, async () => ({ anchor: await runAnchor(ctx), retry: await retryAnchors(ctx) }), { atStart: true });
  jobs.register("receipt-key-rotation", 3_600_000, () => runKeyRotation(ctx), { atStart: true });
  jobs.register("settlement", cfg.workers.settlementIntervalMs, () => runSettlement(ctx), { atStart: true });
  jobs.register("slasher", 3_600_000, () => runSlasher(ctx));
  jobs.register("buyback", 3_600_000, () => runBuyback(ctx));
  jobs.register("chain-indexer", 5_000, async () => (chainOn() ? pollChain(ctx) : { skipped: "no contracts" }), { atStart: true });
  jobs.register("spend-watch", 60_000, () => runSpendWatch(ctx));
  jobs.register("escrow-indexer", 5_000, () => pollEscrow(ctx), { atStart: true });
  jobs.register("paywith-aggregator", 60_000, async () => (ctx.chain.address("payWithStock") ? runPaywithAggregator(ctx) : { skipped: "not configured" }));
  // Weekly blind-token issuer key rotation: next epoch's keys are created ahead, ended epochs lose their private half.
  if (ctx.blind) jobs.register("blind-key-rotation", 3_600_000, () => ctx.blind!.rotate(), { atStart: true });
  jobs.register("alert-notifier", ALERT_INTERVAL_MS, () => runAlertNotifier(ctx), { atStart: true });
  // Long-polls Telegram: one getUpdates cycle per run, re-run every second (Jobs never overlaps a job with itself).
  if (cfg.telegram.botToken && router) {
    const bot = new TelegramBot(ctx, { token: cfg.telegram.botToken, router });
    ctx.telegram = bot;
    jobs.register("telegram-bot", 1_000, () => bot.poll());
  }
}

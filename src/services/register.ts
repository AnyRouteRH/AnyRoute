import { registerSecurityAlertsJob } from "../security-alerts/worker.ts"; // D138
import { runDepositPings } from "../pay/deposit-pings.ts"; // B123
import { registerLowBalanceJob } from "../account/low-balance.ts"; // B119
import { registerQuietAlertsJob } from "../agents/quiet-alerts.ts"; // D141
import { registerPriceNoticesJob } from "../catalog/price-notices.ts"; // C133
import { registerRushJobs } from "../rush/monitor.ts"; // ON3
import { registerWeeklySummaryJob } from "../telegram/weekly-summary.ts"; // B120
import { reconcileToolCalls } from "../tools/call.ts"; // v6 T
import { runToolCanaries } from "../tools/canary.ts"; // v6 T
import { runAgentLiveness } from "../identity/liveness.ts"; // v6 I
import { runAgentIdentity } from "../identity/identity.ts"; // v6 I
import { runWebhooks } from "../webhooks/worker.ts"; // V86: bounded event delivery.
import { runMakegoodPayouts } from "./makegood.ts"; // V6 R
import { pollCommerceTransfers } from "../commerce/funding.ts"; // v6 L
import { registerAgreementJobs } from "../agreements/jobs.ts";
import { runNetworkFeeBurn } from "../network/fee-burn.ts";
import { pollHostBonds } from "../network/bond-indexer.ts";
import { runHostSlasher } from "../network/slashing.ts";
import { pruneAgentLedgerLinks } from "../agents/ledger-context.ts";
import { runAgentAlerts } from "../agents/alert-delivery.ts";
import { refreshSanctions } from "../network/sanctions.ts";
import type { Ctx } from "../context.ts";
import { pruneAgentPolicyEvents } from "../agents/store.ts";
import { expireHolds } from "../ledger/ledger.ts";
import { pollChain } from "../chain/indexer.ts";
import { runPaywithAggregator } from "../pay/paywith.ts";
import { pollEscrow } from "../pay/escrow.ts";
import { runSpendWatch } from "./spend-watch.ts";
import { retryAnchors, runAnchor, runKeyRotation } from "./anchor.ts";
import { runAttestorWithSealed as runAttestor } from "../agents/sealed/attestor.ts";
import { runMeasurementJob } from "./measurement-bundles.ts";
import { runIpxOracle } from "./ipx-oracle.ts";
import { runDayzero } from "./dayzero.ts";
import { runHostAnchor } from "./host-anchor.ts";
import { runCanaries } from "./canaries.ts";
import { runProbes } from "./probes.ts";
import { runRegistry } from "./registry.ts";
import { runSettlement } from "./settlement.ts";
import { runSlasher } from "./slasher.ts";
import { ALERT_INTERVAL_MS, runAlertNotifier } from "./alerts.ts";
import { TelegramBot, type RouterCall } from "./telegram.ts";
import { runBatches, type Dispatch } from "./batches.ts";
import { runSkillsMirror } from "../skills/service.ts";
import { expirePaidResults } from "../pay/recovery.ts";
import { runAgentPayVerify } from "../agents/pay.ts"; // Pay another agent

export function registerJobs(ctx: Ctx, router?: RouterCall, dispatch?: Dispatch) {
  const { cfg, jobs } = ctx;
  registerSecurityAlertsJob(ctx); // D138
  if (cfg.depositPingsEnabled && cfg.runtimeRole !== "api") jobs.register("deposit-pings", 5_000, () => runDepositPings(ctx)); // B123
  registerLowBalanceJob(ctx); // B119
  registerPriceNoticesJob(ctx); // C133
  registerQuietAlertsJob(ctx); // D141
  registerAgreementJobs(ctx, router);
  registerRushJobs(ctx); // ON3
  registerWeeklySummaryJob(ctx); // B120
  // v6 T: close holds of failed paid tool calls once their authorization expires; probe listed tools with a known answer.
  if (cfg.tools.enabled) { jobs.register("tools-reconcile", 60_000, () => reconcileToolCalls(ctx)); jobs.register("tools-canary", 3_600_000, () => runToolCanaries(ctx)); }
  if (cfg.hostBonds.enabled) { jobs.register("host-bond-indexer", 5_000, () => pollHostBonds(ctx), { atStart: true }); jobs.register("host-slasher", 60_000, () => runHostSlasher(ctx)); }
  if (cfg.agentPolicyEnabled) jobs.register("agent-alerts", 60_000, () => runAgentAlerts(ctx));
  if (cfg.agentPayEnabled) jobs.register("agent-pay-verify", 60_000, () => runAgentPayVerify(ctx)); // Pay another agent: settle seen payments, re-check final ones.
  // v6 I: a signed probe of each listed agent endpoint (daily); the registrar sends queued ERC-8004 registrations.
  if (cfg.identity.enabled && cfg.agentProfilesEnabled) jobs.register("agent-liveness", cfg.identity.livenessIntervalMs, () => runAgentLiveness(ctx));
  if (cfg.identity.enabled && cfg.identity.mode === "registrar" && cfg.identity.registrarKey) jobs.register("agent-identity", 60_000, () => runAgentIdentity(ctx));
  if (cfg.sanctions.enabled) jobs.register("sanctions-refresh", 86_400_000, () => refreshSanctions(ctx), { atStart: true });
  const chainOn = () => ["credits", "callPay", "payWithStock", "providerBond", "receiptAnchor", "royalty"].some((n) => ctx.chain.address(n as never));
  jobs.register("health-flush", 5_000, () => ctx.health.flush(ctx.db));
  jobs.register("holds-expire", 60_000, () => expireHolds(ctx.db));
  // x402 payment recovery: rows and sealed answers past their 24 hours are deleted.
  jobs.register("x402-recovery-expire", 3_600_000, () => expirePaidResults(ctx));
  if (cfg.agentPolicyEnabled) jobs.register("agent-ledger-retention", 3_600_000, () => pruneAgentLedgerLinks(ctx.db));
  if (cfg.agentPolicyEnabled) jobs.register("agent-policy-retention", 3_600_000, () => pruneAgentPolicyEvents(ctx.db));
  jobs.register("catalog-refresh", 30_000, () => ctx.catalog.refresh(), { atStart: true });
  jobs.register("provider-registry", cfg.workers.registryIntervalMs, () => runRegistry(ctx), { atStart: true });
  if (cfg.routing.probes) jobs.register("health-probes", cfg.routing.probeIntervalMs, () => runProbes(ctx), { atStart: true });
  if (cfg.canaries.enabled) jobs.register("canaries", cfg.canaries.intervalMs, () => runCanaries(ctx));
  jobs.register("attestor", cfg.attestation.intervalMs, () => runAttestor(ctx), { atStart: true });
  // Off unless MEASUREMENTS_ENABLED: Rekor lookups, signed measurement bundles (with MEASUREMENT_PUBLIC_KEY) and
  // register() calldata for attested measurements. Sends nothing.
  if (cfg.measurements.enabled) jobs.register("measurements", cfg.measurements.intervalMs, () => runMeasurementJob(ctx));
  // Off unless IPX_ENABLED and IPX_ORACLE_ENABLED: signs IPX index price updates and hands them to the configured sinks.
  if (cfg.ipx.enabled && cfg.ipx.oracle.enabled) jobs.register("ipx-oracle", cfg.ipx.oracle.intervalS * 1000, () => runIpxOracle(ctx));
  // Off unless DAYZERO_ENABLED: watch Hugging Face for new fine-tunes of the configured permissive base models, and
  // evaluate and promote candidates an operator has linked and approved. Serving anything still needs an approval.
  if (cfg.lane.dayzero.enabled) jobs.register("dayzero", cfg.lane.dayzero.intervalMs, () => runDayzero(ctx));
  jobs.register("receipts-anchor", cfg.receipts.anchorIntervalMs, async () => ({ anchor: await runAnchor(ctx), retry: await retryAnchors(ctx) }), { atStart: true });
  jobs.register("receipt-key-rotation", 3_600_000, () => runKeyRotation(ctx), { atStart: true });
  // Off unless HOST_ANCHOR_ENABLED: per-host roots of attested sidecars' receipt leaves (ReceiptAnchor.anchorAttested).
  if (cfg.hostAnchor.enabled) jobs.register("host-anchor", cfg.hostAnchor.intervalMs, () => runHostAnchor(ctx));
  jobs.register("settlement", cfg.workers.settlementIntervalMs, () => runSettlement(ctx), { atStart: true });
  jobs.register("slasher", 3_600_000, () => runSlasher(ctx));
  if (cfg.networkPayouts.burnEnabled) jobs.register("network-fee-burn", 3_600_000, () => runNetworkFeeBurn(ctx));
  jobs.register("chain-indexer", 5_000, async () => (chainOn() ? pollChain(ctx) : { skipped: "no contracts" }), { atStart: true });
  if (cfg.webhookSigningEnabled) jobs.register("webhooks", 60_000, () => runWebhooks(ctx)); // V86.
  if (cfg.makegood.enabled) jobs.register("makegood-payouts", 3_600_000, () => runMakegoodPayouts(ctx)); // V6 R: refuses without its key.
  // v6 L: copy public USDG transfers for the commerce ledger's funding-source filter (COMMERCE_FUNDING_FROM_BLOCK).
  if (cfg.commerce.enabled && cfg.commerce.funding.fromBlock !== null) jobs.register("commerce-transfers", 60_000, () => pollCommerceTransfers(ctx));
  jobs.register("spend-watch", 60_000, () => runSpendWatch(ctx));
  jobs.register("escrow-indexer", 5_000, () => pollEscrow(ctx), { atStart: true });
  jobs.register("paywith-aggregator", 60_000, async () => (ctx.chain.address("payWithStock") ? runPaywithAggregator(ctx) : { skipped: "not configured" }));
  // Weekly blind-token issuer key rotation: next epoch's keys are created ahead, ended epochs lose their private half.
  if (ctx.blind) jobs.register("blind-key-rotation", 3_600_000, () => ctx.blind!.rotate(), { atStart: true });
  // Oblivious HTTP gateway key rotation (one key per epoch, a day by default): the next epoch's key is created ahead, expired keys lose their private half.
  if (ctx.ohttp) jobs.register("ohttp-key-rotation", 3_600_000, () => ctx.ohttp!.rotate(), { atStart: true });
  // Transparency log (TLOG_ENABLED): log keys published since the last run and sign a checkpoint for the newest tree.
  if (ctx.tlog) jobs.register("tlog", cfg.tlog.intervalMs, () => ctx.tlog!.run(), { atStart: true });
  jobs.register("alert-notifier", ALERT_INTERVAL_MS, () => runAlertNotifier(ctx), { atStart: true });
  // Batch API: runs queued batch lines in spare capacity, expires overdue batches and deletes results past BATCH_RESULTS_TTL.
  if (dispatch) jobs.register("batches", cfg.batch.intervalMs, () => runBatches(ctx, dispatch));
  // Skills Hub mirror (SKILLS_SOURCES): pulls skills from the listed repositories and registry indexes, scans and stores them.
  if (cfg.skills.sources.length) jobs.register("skills-mirror", cfg.skills.mirrorIntervalMs, () => runSkillsMirror(ctx));
  // Long-polls Telegram: one getUpdates cycle per run, re-run every second (Jobs never overlaps a job with itself).
  if (cfg.telegram.botToken && router) {
    const bot = new TelegramBot(ctx, { token: cfg.telegram.botToken, router });
    ctx.telegram = bot;
    jobs.register("telegram-bot", 1_000, () => bot.poll());
  }
}

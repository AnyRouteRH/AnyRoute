import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { providers } from "../db/schema.ts";
import type { Candidate, ProviderRow } from "../catalog/catalog.ts";
import { attestationFresh, type HealthView, type SelectInput } from "../router/select.ts";
import { networkWeight } from "./weight.ts";
import { NETWORK_WEIGHT_POLICY as POLICY, type NetworkWeightSettings } from "./weight-config.ts";

// The optional fields compile before the additive network_host column lands.
type NetworkProvider = ProviderRow & { networkHost?: unknown; probationUntil?: Date | null };
export type NetworkEvidence = {
  probationUntil: number | null;
  attestedSuccesses: number;
  recentSuccesses: number;
  recentFailures: number;
  probeSuccesses: number;
  probeFailures: number;
  probeLatencyMs?: number;
  failedAttestation: boolean;
  asOf: number;
};
type State = { settings: NetworkWeightSettings; evidence: Map<string, NetworkEvidence>; revision: number };
const states = new WeakMap<HealthView, State>();
const until = (p: NetworkProvider) => (p.probationUntil ?? p.shadowUntil)?.getTime() ?? null;

export const isNetworkHost = (p: ProviderRow): boolean => (p as NetworkProvider).networkHost === true;
export const networkProbeEligible = (p: ProviderRow, settings: NetworkWeightSettings): boolean => p.status === "live" || p.status === "shadow" || (settings.enabled && isNetworkHost(p) && p.status === "probation");
export const networkProbeOfferEligible = (p: ProviderRow, status: string, settings: NetworkWeightSettings): boolean => status === "live" || (settings.enabled && isNetworkHost(p) && status === "shadow");

/** Per router instance, rebuilt from existing records; nothing is persisted by this module. */
export function configureNetworkRouting(health: HealthView, settings: NetworkWeightSettings) {
  states.set(health, { settings, evidence: new Map(), revision: 0 });
}

/** Only successful signed, attested generation records count; probes and cache hits do not. */
export async function readNetworkEvidence(db: Db, p: NetworkProvider, settings: NetworkWeightSettings, now: number): Promise<NetworkEvidence> {
  const probationUntil = until(p);
  const start = new Date(probationUntil === null ? p.createdAt.getTime() : probationUntil - settings.probationDays * 86_400_000).toISOString();
  const end = new Date(now).toISOString();
  const recent = new Date(now - POLICY.recentWindowMs).toISOString();
  const results = await Promise.all([
    db.execute(sql`SELECT count(*) AS successes FROM generations
      WHERE provider_id = ${p.id} AND ts >= ${start} AND ts <= ${end}
        AND NOT cancelled AND mode <> 'cache' AND receipt_sig IS NOT NULL
        AND receipt->>'disclosure' = 'attested'
        AND (receipt->>'attestation_simulated') IS DISTINCT FROM 'true'`),
    db.execute(sql`SELECT
      count(*) FILTER (WHERE ts >= ${recent} AND ok) AS recent_successes,
      count(*) FILTER (WHERE ts >= ${recent} AND NOT ok) AS recent_failures,
      count(*) FILTER (WHERE source = 'probe' AND ok) AS probe_successes,
      count(*) FILTER (WHERE source = 'probe' AND NOT ok) AS probe_failures,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE source = 'probe' AND ok AND ts >= ${recent}) AS probe_latency
      FROM health WHERE provider_id = ${p.id} AND ts >= ${start} AND ts <= ${end}
        AND (ok OR (error_kind IS DISTINCT FROM 'rejected' AND error_kind IS DISTINCT FROM 'rate_limited'))`),
    db.execute(sql`SELECT ok, tee_kind FROM attestations WHERE provider_id = ${p.id} AND ts <= ${end} ORDER BY ts DESC, id DESC LIMIT 1`),
  ]);
  const first = (result: unknown) => (((result as { rows?: unknown[] }).rows ?? result) as Record<string, unknown>[])[0] ?? {};
  const gen = first(results[0]);
  const probe = first(results[1]);
  return {
    probationUntil, attestedSuccesses: Number(gen.successes),
    recentSuccesses: Number(probe.recent_successes), recentFailures: Number(probe.recent_failures),
    probeSuccesses: Number(probe.probe_successes), probeFailures: Number(probe.probe_failures),
    probeLatencyMs: probe.probe_latency == null ? undefined : Number(probe.probe_latency),
    failedAttestation: first(results[2]).ok === false || first(results[2]).tee_kind === "dev", asOf: now,
  };
}

/** Called by the existing health aggregate refresh. Failure invalidates evidence, rather than keeping a full weight. */
export async function refreshNetworkRouting(health: HealthView, db: Db) {
  const state = states.get(health);
  if (!state?.settings.enabled) return;
  const revision = ++state.revision;
  state.evidence = new Map();
  const rows = (await db.select().from(providers)) as NetworkProvider[];
  const next = new Map<string, NetworkEvidence>();
  const now = Date.now();
  for (const p of rows) if (p.networkHost === true) next.set(p.id, await readNetworkEvidence(db, p, state.settings, now));
  if (state.revision === revision) state.evidence = next;
}

/** One selector hook. Existing lane checks, sorting, pinning and fallback still run on every candidate. */
export function networkSelectionInput(input: SelectInput): SelectInput {
  const state = states.get(input.health);
  if (!state?.settings.enabled || !input.offers.some((c) => (c.provider as NetworkProvider).networkHost === true)) return input;
  const now = Date.now();
  const weights = new Map<string, number>();
  const offers = input.offers.map((c): Candidate => {
    const p = c.provider as NetworkProvider;
    if (p.networkHost !== true) return c;
    const evidence = state.evidence.get(p.id);
    const usable = evidence && evidence.probationUntil === until(p) && now >= evidence.asOf && now - evidence.asOf <= POLICY.evidenceMaxAgeMs;
    const weight = usable ? networkWeight({
      ...evidence, networkHost: true, attested: attestationFresh(c, input.attestationMaxAgeMs, true),
      unhealthy: input.health.outage(c.modelId, p.id), latencyMs: evidence.probeLatencyMs ?? input.health.stats(c.modelId, p.id)?.latency.p50, now,
    }, state.settings) : 0;
    weights.set(p.id, weight);
    // Admitted probation rows can receive traffic; rejected, pending and suspended rows remain excluded.
    const status = ["shadow", "probation"].includes(p.status) ? "live" : p.status;
    return { ...c, status: c.status === "shadow" && status === "live" ? "live" : c.status, provider: { ...p, status } };
  });
  const health: HealthView = {
    outage: (m, p) => weights.get(p) === 0 || input.health.outage(m, p),
    uptime30d: (m, p) => input.health.uptime30d(m, p),
    quality: (m, p) => input.health.quality(m, p) * (weights.get(p) ?? 1),
    stats: (m, p) => input.health.stats(m, p),
  };
  return { ...input, offers, health };
}

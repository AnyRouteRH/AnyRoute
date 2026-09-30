import { NETWORK_WEIGHT_POLICY as POLICY, type NetworkWeightSettings } from "./weight-config.ts";

export type NetworkWeightInput = {
  networkHost?: unknown;
  attested: boolean; // Fresh, router-verified hardware evidence, never a development quote.
  failedAttestation?: boolean;
  unhealthy: boolean;
  probationUntil: number | null;
  attestedSuccesses: number;
  recentSuccesses: number;
  recentFailures: number;
  probeSuccesses: number;
  probeFailures: number;
  latencyMs?: number;
  /** Reserved for verified bond evidence. Neutral until the bond policy is implemented. */
  bond?: bigint;
  now: number;
};

/** Pure multiplier; expiry alone never graduates a host. No status or lane is changed here. */
export function networkWeight(input: NetworkWeightInput, settings: NetworkWeightSettings): number {
  if (!settings.enabled || input.networkHost !== true) return 1;
  if (!input.attested || input.failedAttestation || input.unhealthy) return 0;
  const counts = [input.attestedSuccesses, input.recentSuccesses, input.recentFailures, input.probeSuccesses, input.probeFailures];
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 0) || !Number.isFinite(input.now)) return 0;
  const probes = input.probeSuccesses + input.probeFailures;
  const uptime = probes ? input.probeSuccesses / probes : null;
  if (uptime !== null && uptime < POLICY.minimumUptime) return 0;
  if (input.latencyMs != null && (!Number.isFinite(input.latencyMs) || input.latencyMs < 0 || input.latencyMs >= POLICY.maximumLatencyMs)) return 0;
  const graduated = input.probationUntil !== null && Number.isFinite(input.probationUntil) && input.now >= input.probationUntil &&
    input.attestedSuccesses >= settings.graduateRequests && uptime !== null && uptime >= settings.graduateUptime;
  const total = input.recentSuccesses + input.recentFailures;
  const errors = total > 0 && input.recentFailures / total > POLICY.errorThreshold ? POLICY.errorWeight : 1;
  const latency = input.latencyMs == null || input.latencyMs <= POLICY.latencyTargetMs ? 1 : POLICY.latencyTargetMs / input.latencyMs;
  return (graduated ? 1 : POLICY.probationWeight) * errors * latency;
}

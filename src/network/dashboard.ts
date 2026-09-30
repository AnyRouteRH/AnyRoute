import { and, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { offers, providerDisclosure, providers } from "../db/schema.ts";
import type { PublicAttestation } from "../api/provider-attestation.ts";
import { attestationFresh } from "../router/select.ts";
import { readNetworkEvidence } from "./routing.ts";
import { networkWeight } from "./weight.ts";

type AdmissionFacts = Pick<typeof providers.$inferSelect, "id" | "networkHost" | "networkReasons" | "status">;

/** Read the version actually checked at admission or renewal, never the newest published version. */
export async function hostAdmission(ctx: Ctx, p: AdmissionFacts, attestation: PublicAttestation) {
  if (!p.networkHost) return null;
  const [disclosure] = await ctx.db.select({ claims: providerDisclosure.claims, retention: providerDisclosure.retention }).from(providerDisclosure).where(eq(providerDisclosure.providerId, p.id));
  const claim = (disclosure?.claims as { retention?: { source?: unknown; as_of?: unknown } } | undefined)?.retention;
  const match = typeof claim?.source === "string" ? /^sidecar attestation checked against host policy v([1-9]\d*)$/.exec(claim.source) : null;
  const version = match ? Number(match[1]) : NaN;
  const policy_version = Number.isSafeInteger(version) ? version : null;
  const checked = typeof claim?.as_of === "string" ? Date.parse(claim.as_of) : NaN;
  const checked_at = Number.isFinite(checked) && checked <= Date.now() ? new Date(checked).toISOString() : null;
  const age = Date.now() - Date.parse(attestation.last_attempt_at ?? "");
  const approved = ["probation", "live"].includes(p.status) && p.networkReasons.length === 0 &&
    disclosure?.retention === "attested" && policy_version !== null && checked_at !== null &&
    attestation.status === "attested" && attestation.last_attempt_ok === true && age >= 0 && age <= ctx.cfg.attestation.intervalMs * 3;
  return { status: approved ? "approved" : "not_approved", policy_version, reasons: p.networkReasons, checked_at };
}

/** Host-wide view of the network multiplier: highest among its currently eligible model offers. */
export async function hostRoutingWeight(ctx: Ctx, p: typeof providers.$inferSelect) {
  if (!ctx.cfg.networkHosts.enabled || !ctx.cfg.networkWeights.enabled || !p.networkHost ||
    !["probation", "shadow", "live"].includes(p.status) || p.networkReasons.length) return 0;
  const attested = attestationFresh({ provider: p }, ctx.cfg.attestation.intervalMs * 3, true);
  if (!attested) return 0;
  const now = Date.now();
  const evidence = await readNetworkEvidence(ctx.db, p, ctx.cfg.networkWeights, now);
  const models = await ctx.db.select({ id: offers.modelId }).from(offers).where(and(eq(offers.providerId, p.id), inArray(offers.status, ["shadow", "live"])));
  const weights = models.map(({ id }) => networkWeight({ ...evidence, networkHost: true, attested,
    unhealthy: ctx.health.outage(id, p.id), latencyMs: evidence.probeLatencyMs ?? ctx.health.stats(id, p.id)?.latency.p50, now,
  }, ctx.cfg.networkWeights));
  return Number(Math.max(0, ...weights).toFixed(2));
}

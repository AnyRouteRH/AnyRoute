import type { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { attestations, providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { currentMeasurement } from "../services/measurements.ts";

// GET /api/v1/attestation/:providerId - what the router has actually checked about a provider's confidential
// endpoint, and what it has not. The default answer is "unverified": a provider is "attested" only while the router
// holds a fresh attestation it verified itself, and "simulated" only for development evidence outside production.
// Nothing here is the provider's own claim repeated back.

const NOT_CHECKED = [
  "The image and model digests are values the endpoint's software committed to inside the quote; the router does not derive them from the hardware registers. The compose hash is compared with the verified event log only when the dstack verifier is configured.",
  "Who signed the transparency-log entry: the router confirms an entry for the image digest exists and is included in the log, not that the entry came from the image's publisher.",
  "That the running software matches the image's source: reproducible-build provenance is not verified here.",
  "That prompts stay inside the enclave: attestation shows what is running, not what it does with data.",
];

export function attestationRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/attestation/:providerId", async (c) => {
    const id = c.req.param("providerId");
    const [p] = await ctx.db.select().from(providers).where(eq(providers.id, id));
    if (!p || p.status === "applied") fail(404, "Unknown provider.", "not_found");

    const [last] = await ctx.db.select().from(attestations).where(eq(attestations.providerId, p.id)).orderBy(desc(attestations.ts)).limit(1);
    const age = p.attestedAt ? Date.now() - p.attestedAt.getTime() : Number.NaN;
    const fresh = p.attested && !!p.attestationHash && !!p.teeKind && Number.isFinite(age) && age >= 0 && age <= ctx.cfg.attestation.intervalMs * 3;
    const okRow = last?.ok ? last : null;
    // Development evidence is marked as such when it is accepted, whatever TEE kind the provider declared.
    const simulatedEvidence = fresh && (p.teeKind === "dev" || (okRow?.detail as { simulated?: unknown } | null)?.simulated === true);
    const status = fresh && !simulatedEvidence ? "attested" : simulatedEvidence && !ctx.cfg.production ? "simulated" : "unverified";
    const unverifiedReason = !last ? "no_attestation" : !last.ok ? "last_attempt_failed" : simulatedEvidence ? "simulated_evidence_refused" : "attestation_stale";
    const verifiers = status === "attested" ? (((okRow?.detail as { verifiers?: unknown } | null)?.verifiers as string[] | undefined) ?? []) : [];
    const m = status === "attested" ? await currentMeasurement(ctx, p.id) : null;
    const registry = ctx.cfg.measurements.registry;

    const rekorFound = !!m && m.rekorInclusionVerified;
    const onchain = !m ? "not_recorded" : m.status === "registered" ? "registered" : m.status === "revoked" ? "revoked" : m.txHash ? "submitted_unconfirmed" : m.calldata ? "calldata_ready_not_submitted" : "not_submitted";
    c.header("Cache-Control", "public, max-age=30");
    return c.json({
      data: {
        provider: p.id,
        status,
        ...(status === "unverified" ? { reason: unverifiedReason } : {}),
        tee: simulatedEvidence ? "dev" : p.teeKind ?? null,
        attested_at: status === "attested" || status === "simulated" ? p.attestedAt?.toISOString() ?? null : null,
        attestation_hash: status === "attested" || status === "simulated" ? p.attestationHash ?? null : null,
        verifiers,
        measurement: m
          ? {
              image_digest: m.imageDigest,
              compose_hash: m.composeHash,
              model_digest: m.modelDigest,
              status: m.status,
              first_attested_at: m.attestedAt.toISOString(),
              last_seen_at: m.lastSeenAt.toISOString(),
              transparency_log: {
                found: rekorFound,
                entry: m.rekorEntry,
                uuid: m.rekorUuid,
                log_index: m.rekorLogIndex,
                kind: m.rekorKind,
                integrated_at: m.rekorIntegratedAt?.toISOString() ?? null,
                inclusion_verified: m.rekorInclusionVerified,
                checkpoint_signature_verified: m.rekorCheckpointVerified,
                checked_at: m.rekorCheckedAt?.toISOString() ?? null,
              },
              registry: { address: registry, state: onchain, tx_hash: m.txHash, registered_at: m.registeredAt?.toISOString() ?? null },
            }
          : null,
        checks: {
          quote_verified: status === "attested",
          digests_bound_to_quote: !!m,
          transparency_log_entry: rekorFound,
          transparency_log_checkpoint_signature: !!m?.rekorCheckpointVerified,
          registered_on_chain: m?.status === "registered",
        },
        not_checked: NOT_CHECKED,
      },
    });
  });
}

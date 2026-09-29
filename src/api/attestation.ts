import type { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { attestations, providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { currentMeasurement } from "../services/measurements.ts";
import { tdxRegisters } from "../services/measurement-bundle.ts";
import { entryUrl, verifiedBundleForEntry } from "../services/measurement-bundles.ts";
import { loadTlsPin } from "../providers/tls-pin.ts";
import { servedPolicyHash } from "./disclosure.ts";

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

// When the log entry is a signed measurement bundle, two of the statements above change: the router does check who signed the
// entry (the measurement key it is configured with), and the bundle's source pins are the publisher's statement.
const NOT_CHECKED_BUNDLE = [
  NOT_CHECKED[0],
  "Who holds the measurement key: the router confirms the log entry was signed with the measurement key it is configured with (published at /api/v1/measurements/key), not that the key belongs to the party you expect.",
  "That the source commit, source tarball hash and model weights hash in the bundle are what they say: the router compares only the compose hash, image and model digests (and the MRTD and RTMR3 allow-lists) with the quote. Anyone can reproduce the rest from the public repository (scripts/check-reproducible.ts).",
  NOT_CHECKED[3],
];
const GATEWAY_NOT_CHECKED =
  "The model servers behind an attested gateway: the router attests the gateway itself, and each response's receipt carries the gateway's signed record of whether the upstream that answered was verified (receipt.upstream_attestation), which the router checks before accepting it for an attested request.";

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
    // The last measurement recorded stays visible while the attestation is stale or failing (attested_now says which),
    // so an operator restarting an endpoint can still compare what it serves with what the router last verified.
    const m = simulatedEvidence ? null : await currentMeasurement(ctx, p.id);
    const registry = ctx.cfg.measurements.registry;
    // The certificate the router's connections to this provider are pinned to, when it attested through a
    // self-signed certificate (providers/tls-pin.ts).
    const pin = simulatedEvidence ? null : await loadTlsPin(ctx.db, p.id);

    // An aci/1 gateway (providers/aci.ts): what its verified report established.
    const aci = status === "attested" ? ((okRow?.detail as { aci?: Record<string, unknown> } | null)?.aci ?? null) : null;

    const rekorFound = !!m && m.rekorInclusionVerified;
    // Whether the recorded log entry is a signed measurement bundle (verified by the router) or an entry for the image digest.
    const bundle = m?.rekorUuid && rekorFound ? await verifiedBundleForEntry(ctx, p.id, m.composeHash, m.rekorUuid) : null;
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
        // The classifier policy hash this fresh attestation bound (sent as X-Anyroute-Policy-Hash), else null.
        policy_hash: status === "attested" && ctx.catalog.providers.get(p.id) ? servedPolicyHash(ctx, { provider: ctx.catalog.providers.get(p.id)! }) : null,
        tls_pin: pin ? { spki_sha256: pin.spkiSha256, attestation_ref: pin.attestationRef, pinned_at: pin.pinnedAt } : null,
        measurement: m
          ? {
              image_digest: m.imageDigest,
              compose_hash: m.composeHash,
              model_digest: m.modelDigest,
              registers: tdxRegisters(m.quote),
              status: m.status,
              attested_now: status === "attested",
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
                subject: !m.rekorUuid || !rekorFound ? null : bundle ? "measurement_bundle" : "image_digest",
                entry_url: m.rekorUuid ? entryUrl(ctx, m.rekorUuid) : null,
                bundle: bundle
                  ? { digest: bundle.bundleDigest, signer_key_id: bundle.signerKeyId, created_at: (bundle.bundle as { created_at?: string }).created_at ?? null, signature_verified: true, url: `/api/v1/measurements/bundles/${p.id}` }
                  : null,
              },
              registry: { address: registry, state: onchain, tx_hash: m.txHash, registered_at: m.registeredAt?.toISOString() ?? null },
            }
          : null,
        checks: {
          quote_verified: status === "attested",
          digests_bound_to_quote: !!m && status === "attested",
          transparency_log_entry: rekorFound,
          transparency_log_checkpoint_signature: !!m?.rekorCheckpointVerified,
          registered_on_chain: m?.status === "registered",
        },
        ...(aci
          ? {
              gateway: {
                protocol: "aci/1",
                keyset_digest: aci.keyset_digest ?? null,
                workload_id: aci.workload_id ?? null,
                compose_hash: aci.compose_hash ?? null,
                os_image_hash: aci.os_image_hash ?? null,
                source_provenance: aci.source_provenance ?? null,
                tls_spki_sha256: aci.tls_spki_sha256 ?? null,
                keyset_not_after: aci.not_after ?? null,
                keyset_endorsement: aci.keyset_endorsement ?? null,
              },
            }
          : {}),
        not_checked: [...(bundle ? NOT_CHECKED_BUNDLE : NOT_CHECKED), ...(aci ? [GATEWAY_NOT_CHECKED] : [])],
      },
    });
  });
}

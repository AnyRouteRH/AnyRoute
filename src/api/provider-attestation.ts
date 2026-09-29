import { desc, inArray } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { attestations, providers } from "../db/schema.ts";

// The attestation summary that GET /api/v1/providers puts on each provider. It answers with the same three-way status
// as GET /api/v1/attestation/:providerId ("attested" only while the router holds a fresh attestation it verified
// itself, "simulated" only for development evidence outside production, otherwise "unverified") and adds nothing the
// provider claimed about itself. The digests and the per-check detail stay on that endpoint; this is the short form a
// listing needs.

export type PublicAttestation = {
  status: "attested" | "simulated" | "unverified";
  /** Why a provider is unverified. Absent otherwise. */
  reason?: "no_attestation" | "last_attempt_failed" | "attestation_stale" | "simulated_evidence_refused";
  /** The TEE kind the router verified against ("dev" for simulated evidence), or the declared kind while unverified. */
  tee: string | null;
  /** The verifiers that accepted the quote, only while the provider is attested. */
  verifiers: string[];
  /** When the router last verified this provider successfully (null if it never has). */
  last_verified_at: string | null;
  /** When the router last tried, and whether that attempt passed. */
  last_attempt_at: string | null;
  last_attempt_ok: boolean | null;
};

type ProviderFacts = Pick<typeof providers.$inferSelect, "id" | "attested" | "attestationHash" | "attestedAt" | "teeKind">;
type Attempt = { ok: boolean; ts: Date; detail: unknown };

/** The newest attestation attempt of each listed provider, in one query. */
export async function latestAttempts(ctx: Ctx, ids: string[]): Promise<Map<string, Attempt>> {
  const out = new Map<string, Attempt>();
  if (!ids.length) return out;
  const rows = await ctx.db
    .selectDistinctOn([attestations.providerId], { providerId: attestations.providerId, ok: attestations.ok, ts: attestations.ts, detail: attestations.detail })
    .from(attestations)
    .where(inArray(attestations.providerId, ids))
    .orderBy(attestations.providerId, desc(attestations.ts), desc(attestations.id));
  for (const r of rows) out.set(r.providerId, { ok: r.ok, ts: r.ts, detail: r.detail });
  return out;
}

export function summarizeAttestation(ctx: Ctx, p: ProviderFacts, last: Attempt | undefined): PublicAttestation {
  const age = p.attestedAt ? Date.now() - p.attestedAt.getTime() : Number.NaN;
  const fresh = p.attested && !!p.attestationHash && !!p.teeKind && Number.isFinite(age) && age >= 0 && age <= ctx.cfg.attestation.intervalMs * 3;
  const okRow = last?.ok ? last : null;
  const simulatedEvidence = fresh && (p.teeKind === "dev" || (okRow?.detail as { simulated?: unknown } | null)?.simulated === true);
  const status = fresh && !simulatedEvidence ? "attested" : simulatedEvidence && !ctx.cfg.production ? "simulated" : "unverified";
  const reason = !last ? "no_attestation" : !last.ok ? "last_attempt_failed" : simulatedEvidence ? "simulated_evidence_refused" : "attestation_stale";
  const verifiers = status === "attested" ? (((okRow?.detail as { verifiers?: unknown } | null)?.verifiers as string[] | undefined) ?? []) : [];
  return {
    status,
    ...(status === "unverified" ? { reason } : {}),
    tee: simulatedEvidence ? "dev" : p.teeKind ?? null,
    verifiers,
    last_verified_at: p.attestedAt?.toISOString() ?? null,
    last_attempt_at: last?.ts.toISOString() ?? null,
    last_attempt_ok: last ? last.ok : null,
  };
}

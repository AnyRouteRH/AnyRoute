import { eq, like } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { kv } from "../db/schema.ts";

// The classifier policy hash a provider's last verified attestation bound (router/lane.ts policyHashFromReport).
// Written only by the attestor, cleared whenever an attestation fails or no longer binds one, so a stored value
// always comes from the provider's latest successful attestation. It is reported on responses as
// X-Anyroute-Policy-Hash and in GET /api/v1/models, and only while that attestation is fresh.

const KEY_PREFIX = "attest-policy:";

export type AttestedPolicy = { policyHash: string; reportHash: string; attestedAt: string };

function parse(v: unknown): AttestedPolicy | null {
  const o = v as Record<string, unknown> | null;
  return o && typeof o.policy_hash === "string" && typeof o.report_hash === "string" && typeof o.attested_at === "string"
    ? { policyHash: o.policy_hash, reportHash: o.report_hash, attestedAt: o.attested_at }
    : null;
}

export async function loadAttestedPolicies(db: Db | Tx): Promise<Map<string, AttestedPolicy>> {
  const rows = await db.select().from(kv).where(like(kv.key, `${KEY_PREFIX}%`));
  const out = new Map<string, AttestedPolicy>();
  for (const r of rows) {
    const p = parse(r.value);
    if (p) out.set(r.key.slice(KEY_PREFIX.length), p);
  }
  return out;
}

export async function loadAttestedPolicy(db: Db | Tx, providerId: string): Promise<AttestedPolicy | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, KEY_PREFIX + providerId));
  return row ? parse(row.value) : null;
}

/** Record the policy hash an attestation bound, or clear it when that attestation bound none. */
export async function saveAttestedPolicy(db: Db | Tx, providerId: string, policyHash: string | null, reportHash: string) {
  if (!policyHash) return clearAttestedPolicy(db, providerId);
  const value = { policy_hash: policyHash, report_hash: reportHash, attested_at: new Date().toISOString() };
  await db.insert(kv).values({ key: KEY_PREFIX + providerId, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}

export async function clearAttestedPolicy(db: Db | Tx, providerId: string) {
  await db.delete(kv).where(eq(kv.key, KEY_PREFIX + providerId));
}

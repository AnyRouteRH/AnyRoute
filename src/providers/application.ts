import { sealProviderHeaders } from "./headers.ts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { kv, providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { canonicalJson, encrypt, randomHex, safeEqual, sha256 } from "../lib/util.ts";

export const providerApplication = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(80),
  base_url: z.string().url().max(2048),
  api_key: z.string().min(1).max(500).optional(),
  contact: z.string().max(200).optional(),
  datacenters: z.array(z.string().max(40)).max(20).optional(),
  data_policy: z.object({ training: z.boolean(), retains_prompts: z.boolean(), retention_days: z.number().int().min(0).optional(), zdr: z.boolean().optional() }),
  tee: z.object({ kind: z.enum(["tdx", "snp", "nvidia-cc", "tinfoil", "dev"]), attestation_url: z.string().url().max(2048) }).optional(),
  payout_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,80}$/), z.string().max(2000).regex(/^[^\r\n]*$/)).refine((h) => Object.keys(h).length <= 20).optional(),
});

export function validateProviderUrl(value: string, production: boolean) {
  const u = new URL(value);
  if (!(["https:", ...(production ? [] : ["http:"])].includes(u.protocol)) || u.username || u.password || u.hash)
    fail(400, "Provider URLs require HTTPS in production and must not contain credentials or fragments.", "invalid_request");
}

/** Content hash of one application revision: every stored field that an applicant (or the seed
 * manifest) controls and that approval activates. Secrets are hashed as their stored ciphertext,
 * so any resubmission, even of the same key, is a new revision. Chain- and job-maintained fields
 * (bond, stake, attestation, timestamps) are excluded so they cannot invalidate a review. The
 * operator approves a revision by passing this hash; see `providers.approve`. */
export function applicationReviewHash(p: typeof providers.$inferSelect) {
  return sha256(canonicalJson({
    v: 1, id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, apiKeyEnc: p.apiKeyEnc, headers: p.headers,
    dataPolicy: p.dataPolicy, datacenter: p.datacenter, teeKind: p.teeKind, attestationUrl: p.attestationUrl,
    payoutMode: p.payoutMode, payoutAddress: p.payoutAddress, contact: p.contact, timeoutMs: p.timeoutMs, staticModels: p.staticModels,
  }));
}

/** Public applications are inert until an operator reviews both URLs and approves them.
 * Approval is a network trust grant; a bond alone must never authorize outbound traffic.
 * The token holder may revise a pending ("applied") application, but every revision changes its
 * review hash, so an approval issued for an earlier revision is refused. Once approved, edits stop. */
export async function submitProviderApplication(ctx: Ctx, v: z.infer<typeof providerApplication>, token?: string) {
  validateProviderUrl(v.base_url, ctx.cfg.production);
  if (v.tee) validateProviderUrl(v.tee.attestation_url, ctx.cfg.production);
  // Shared across REST/tRPC and replicas with Redis; cannot be evaded by spoofing IP headers.
  const limit = await ctx.limiter.take("provider-applications", 1, 30, 60_000);
  if (!limit.ok) fail(429, "Provider application limit reached. Retry later.", "rate_limit", undefined, { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) });
  return ctx.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(providers).where(eq(providers.id, v.id)).for("update");
    if (existing && existing.status !== "applied") fail(409, "That provider id is already registered.", "conflict");
    const applicationToken = existing ? null : randomHex(24);
    if (existing) {
      const [stored] = await tx.select().from(kv).where(eq(kv.key, `apply-token:${v.id}`));
      if (!stored || !token || !safeEqual(String(stored.value), sha256(token))) fail(409, "Application token required to update this application.", "conflict");
    }
    const row = {
      id: v.id, name: v.name, baseUrl: v.base_url,
      apiKeyEnc: v.api_key ? encrypt(ctx.cfg.appSecret, v.api_key) : null,
      contact: v.contact ?? null, datacenter: v.datacenters ?? [], dataPolicy: v.data_policy,
      teeKind: v.tee?.kind ?? null, attestationUrl: v.tee?.attestation_url ?? null,
      payoutAddress: v.payout_address?.toLowerCase() ?? null, payoutMode: v.payout_address ? "usdg" : "invoice",
      headers: sealProviderHeaders(ctx.cfg.appSecret, v.headers), status: "applied", updatedAt: new Date(),
    };
    if (existing) await tx.update(providers).set(row).where(eq(providers.id, v.id));
    else {
      const inserted = await tx.insert(providers).values(row).onConflictDoNothing().returning({ id: providers.id });
      if (!inserted.length) fail(409, "That provider id is already registered.", "conflict");
      await tx.insert(kv).values({ key: `apply-token:${v.id}`, value: sha256(applicationToken!) });
    }
    return { id: v.id, status: "applied", models_found: 0, ...(applicationToken ? { application_token: applicationToken } : {}), next: ["Keep your application token. An operator must review and approve the provider before discovery, attestation, or shadow traffic can begin."] };
  });
}

export function publicProvider(p: typeof providers.$inferSelect) {
  return { id: p.id, name: p.name, status: p.status, dataPolicy: p.dataPolicy, datacenter: p.datacenter, teeKind: p.teeKind, attested: p.attested, attestedAt: p.attestedAt };
}

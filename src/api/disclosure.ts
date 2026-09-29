import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Candidate, ProviderRow } from "../catalog/catalog.ts";
import { providerDisclosure, providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { safeEqual } from "../lib/util.ts";
import { CLAIMS, RETENTION_VALUES, TRAINING_VALUES, disclosureClass, profileOf, type Claim, type ClaimName, type DisclosureClass } from "../router/disclosure.ts";
import { attestationFresh, candidateDisclosure } from "../router/select.ts";
import { readJson } from "./common.ts";
import { bearer } from "./auth.ts";

// Disclosure profiles: what an operator has documented about how a provider handles a prompt.
//   GET /api/v1/disclosure/:providerId   public
//   PUT /api/v1/disclosure/:providerId   operator token; replaces the whole profile

/** The class a call to this offer is served under right now (and whether the attestation behind it is a dev report). */
export function servedDisclosure(ctx: Ctx, c: Candidate): { class: DisclosureClass; simulated: boolean } {
  const cls = candidateDisclosure(c, profileOf(ctx.catalog.disclosure.get(c.providerId)), ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production);
  return { class: cls, simulated: cls === "attested" && c.provider.teeKind === "dev" };
}

/**
 * The classifier policy hash this offer's endpoint reported in its attestation, or null. Only while that attestation
 * is fresh, and only when the stored hash came from that very attestation (same report hash): nothing else counts.
 */
export function servedPolicyHash(ctx: Ctx, c: Pick<Candidate, "provider">): string | null {
  const pol = c.provider.attestedPolicy;
  if (!pol || pol.reportHash !== c.provider.attestationHash) return null;
  return attestationFresh(c, ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production) ? pol.policyHash : null;
}

/** The public view of one provider's profile, plus what it is served under at this moment. */
export function disclosureView(ctx: Ctx, p: ProviderRow) {
  const profile = profileOf(ctx.catalog.disclosure.get(p.id));
  const fresh = attestationFresh({ provider: p }, ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production);
  const cls = disclosureClass(profile, fresh);
  return {
    provider: p.id,
    ...profile,
    current: { class: cls, attestation_fresh: fresh, tee: p.teeKind ?? null, simulated: cls === "attested" && p.teeKind === "dev" },
  };
}

const source = z.string().trim().min(3).max(500).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "must not contain control characters");
const asOf = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date, YYYY-MM-DD")
  .refine((v) => {
    const t = Date.parse(v + "T00:00:00Z");
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v && t <= Date.now() + 86_400_000;
  }, "must be a real date, not in the future");
const claim = { source, as_of: asOf };
const note = z.string().trim().max(500).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "must not contain control characters");

/** PUT body. Every claim is optional and carries its own source and date; an omitted claim reverts to the conservative default. */
export const disclosureInput = z
  .object({
    retention: z.object({ value: z.enum(RETENTION_VALUES), ...claim }).strict().optional(),
    jurisdiction: z.object({ value: z.string().trim().min(2).max(64).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "must not contain control characters"), ...claim }).strict().optional(),
    legal_hold: z.object({ active: z.boolean(), note: note.optional(), ...claim }).strict().optional(),
    training_use: z.object({ value: z.enum(TRAINING_VALUES), ...claim }).strict().optional(),
  })
  .strict();
export type DisclosureInput = z.infer<typeof disclosureInput>;

/** Validate against the provider, store, and refresh the catalog. Replaces the profile. */
export async function writeDisclosure(ctx: Ctx, providerId: string, input: DisclosureInput) {
  const [p] = await ctx.db.select().from(providers).where(eq(providers.id, providerId));
  if (!p) fail(404, "Provider not found.", "not_found");
  const retention = input.retention?.value ?? "logs";
  if (retention !== "logs" && !input.legal_hold)
    fail(400, `retention "${retention}" needs a legal_hold claim (active true or false, with a source and date): a no-retention claim is void under a legal hold, and an undeclared hold is not trusted.`, "invalid_request");
  if (retention === "attested") {
    if (!p.teeKind || !p.attestationUrl) fail(409, 'retention "attested" needs a provider with a TEE and an attestation endpoint; this provider has none.', "provider_not_attestable");
    if (ctx.cfg.production && p.teeKind === "dev") fail(409, 'retention "attested" cannot rest on a dev attestation in production.', "provider_not_attestable");
  }
  const claims: Partial<Record<ClaimName, Claim>> = {};
  for (const name of CLAIMS) {
    const c = input[name];
    if (c) claims[name] = { source: c.source, as_of: c.as_of };
  }
  const row = {
    providerId,
    retention,
    jurisdiction: input.jurisdiction?.value ?? "unknown",
    legalHold: input.legal_hold?.active ?? null,
    legalHoldNote: input.legal_hold?.note || null,
    trainingUse: input.training_use?.value ?? "unknown",
    claims,
    updatedAt: new Date(),
  };
  await ctx.db.insert(providerDisclosure).values(row).onConflictDoUpdate({ target: providerDisclosure.providerId, set: row });
  await ctx.catalog.refresh();
  return disclosureView(ctx, ctx.catalog.providers.get(providerId) ?? p);
}

export function disclosureRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/disclosure/:providerId", async (c) => {
    await ctx.catalog.ensureFresh();
    const p = ctx.catalog.providers.get(c.req.param("providerId"));
    // A pending application is not public yet (the provider list hides it as well).
    if (!p || p.status === "applied") fail(404, "Provider not found.", "not_found");
    return c.json({ data: disclosureView(ctx, p) });
  });

  app.put("/api/v1/disclosure/:providerId", async (c) => {
    const token = c.req.header("x-admin-token") ?? bearer(c.req.header("authorization"));
    if (!ctx.cfg.adminToken || !token || !safeEqual(token, ctx.cfg.adminToken)) fail(401, "Operator token required.", "unauthorized");
    const input = disclosureInput.parse(await readJson(c));
    return c.json({ data: await writeDisclosure(ctx, c.req.param("providerId"), input) });
  });
}

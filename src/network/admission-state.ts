import { desc, eq } from "drizzle-orm";
import { verify } from "node:crypto";
import type { Ctx } from "../context.ts";
import { offers, providerDisclosure, providers } from "../db/schema.ts";
import { UNDECLARED } from "../router/disclosure.ts";
import { parseVerifierKey } from "../tlog/note.ts";
import { checkHostAgainstPolicy, hostPolicySchema, policyHash, policyJson, type HostPolicyBindings } from "./policy.ts";
import { hostPolicies } from "./schema.ts";

export function admissionReasons(evidence: HostPolicyBindings, policy: Parameters<typeof checkHostAgainstPolicy>[1], models: string[]) {
  const result = checkHostAgainstPolicy(evidence, policy);
  if (!result.ok) return result.reasons;
  const bound = new Set([...(evidence.bindings?.models ?? []).map(m => m.id), evidence.bindings?.model_id]);
  return [...result.reasons, ...models.filter(id => !bound.has(id)).map(id => `Requested model ${id} is not bound to the verified hardware quote.`)];
}

/** Admission and scheduled renewal use the same current-policy signature and binding checks. */
export async function checkPublishedHostPolicy(ctx: Ctx, evidence: HostPolicyBindings, models: string[]) {
  const [published] = await ctx.db.select().from(hostPolicies).orderBy(desc(hostPolicies.version)).limit(1);
  if (!published) return { reasons: ["No published host admission policy is available."], policy: null };
  try {
    const policy = hostPolicySchema.parse(JSON.parse(published.canonical));
    if (policyJson(policy) !== published.canonical || policyHash(policy) !== published.sha256 || !ctx.tlog || published.verifierKey !== ctx.tlog.verifierKey || !verify(null, Buffer.from(published.canonical), parseVerifierKey(published.verifierKey).key, Buffer.from(published.signature, "base64"))) throw new Error("Invalid policy");
    return { reasons: admissionReasons(evidence, policy, models), policy };
  } catch { return { reasons: ["The published host admission policy could not be verified."], policy: null }; }
}

/** Only retention is established here. No operator declaration is inferred from hardware evidence. */
export async function saveHostDisclosure(ctx: Ctx, providerId: string, version: number) {
  const now = new Date();
  const row = { providerId, retention: "attested", jurisdiction: UNDECLARED.jurisdiction,
    legalHold: UNDECLARED.legal_hold.active, legalHoldNote: UNDECLARED.legal_hold.note,
    trainingUse: UNDECLARED.training_use, claims: { ...UNDECLARED.claims,
      retention: { source: `sidecar attestation checked against host policy v${version}`, as_of: now.toISOString() } }, updatedAt: now };
  await ctx.db.insert(providerDisclosure).values(row).onConflictDoUpdate({ target: providerDisclosure.providerId, set: row });
}

export async function rejectHost(ctx: Ctx, providerId: string, reasons: string[]) {
  await ctx.db.transaction(async tx => {
    await tx.update(providers).set({ status: "rejected", attested: false, staticModels: null, shadowUntil: null, networkReasons: [...new Set(reasons)], updatedAt: new Date() }).where(eq(providers.id, providerId));
    await tx.update(offers).set({ status: "disabled", updatedAt: new Date() }).where(eq(offers.providerId, providerId));
    await tx.delete(providerDisclosure).where(eq(providerDisclosure.providerId, providerId));
  });
}

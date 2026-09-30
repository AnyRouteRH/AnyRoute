import { desc, eq } from "drizzle-orm";
import { verify } from "node:crypto";
import type { Ctx } from "../context.ts";
import { offers, providers } from "../db/schema.ts";
import { attestProvider } from "../services/attestor.ts";
import { parseVerifierKey } from "../tlog/note.ts";
import { checkHostAgainstPolicy, hostPolicySchema, policyHash, policyJson, type HostPolicyBindings } from "./policy.ts";
import { hostPolicies } from "./schema.ts";
import { assertNotSanctioned } from "./sanctions.ts";
import { admittedModels } from "./offers.ts";
import { isApiError } from "../lib/errors.ts";

export function admissionReasons(evidence: HostPolicyBindings, policy: Parameters<typeof checkHostAgainstPolicy>[1], models: string[]) {
  const result = checkHostAgainstPolicy(evidence, policy);
  if (!result.ok) return result.reasons;
  const bound = new Set([...(evidence.bindings?.models ?? []).map(m => m.id), evidence.bindings?.model_id]);
  return [...result.reasons, ...models.filter(id => !bound.has(id)).map(id => `Requested model ${id} is not bound to the verified hardware quote.`)];
}

/** Pending rows never become routable during verification. The existing attestor receives an
 * approved-status copy only for this explicit admission run; its checks and writes are unchanged. */
export async function admitHost(ctx: Ctx, provider: typeof providers.$inferSelect, models: string[]) {
  const reasons: string[] = [];
  let hardware = false;
  let staticModels: ReturnType<typeof admittedModels> | null = null;
  if (new URL(provider.baseUrl).protocol !== "https:") reasons.push("The sidecar endpoint must use HTTPS.");
  else {
    const attestation = await attestProvider(ctx, { ...provider, status: "shadow" }, true);
    if (!attestation.ok) reasons.push("Attestation failed: " + ("reason" in attestation ? attestation.reason : "hardware evidence was not verified."));
    else if (!("host_policy_bindings" in attestation)) reasons.push("Verified quote-bound sidecar bindings are unavailable.");
    else {
      const evidence = attestation.host_policy_bindings;
      hardware = evidence.hardware_verified && !evidence.dev && !evidence.simulated;
      const [published] = await ctx.db.select().from(hostPolicies).orderBy(desc(hostPolicies.version)).limit(1);
      if (!published) reasons.push("No published host admission policy is available.");
      else {
        try {
          const policy = hostPolicySchema.parse(JSON.parse(published.canonical));
          if (policyJson(policy) !== published.canonical || policyHash(policy) !== published.sha256 || !ctx.tlog || published.verifierKey !== ctx.tlog.verifierKey || !verify(null, Buffer.from(published.canonical), parseVerifierKey(published.verifierKey).key, Buffer.from(published.signature, "base64"))) throw new Error("Invalid policy");
          reasons.push(...admissionReasons(evidence, policy, models));
          if (!reasons.length && ctx.cfg.networkHosts.enabled) staticModels = admittedModels(evidence, policy, models);
        } catch { reasons.push("The published host admission policy could not be verified."); }
      }
    }
  }
  if (ctx.cfg.sanctions.enabled) {
    for (const address of new Set([provider.operator!, provider.payoutAddress!])) {
      try { await assertNotSanctioned(ctx, address); }
      catch (error) { if (!isApiError(error)) throw error; reasons.push(`${address === provider.operator ? "Operator" : "Payout"} screening: ${error.message}`); }
    }
  }
  const status = reasons.length ? "rejected" : "probation";
  await ctx.db.update(providers).set({ status, staticModels: status === "probation" && staticModels?.length ? staticModels : null, networkReasons: [...new Set(reasons)], attested: hardware, shadowUntil: status === "probation" ? new Date(Date.now() + ctx.cfg.networkHosts.probationDays * 86_400_000) : null, updatedAt: new Date() }).where(eq(providers.id, provider.id));
  if (status === "rejected") await ctx.db.update(offers).set({ status: "disabled", updatedAt: new Date() }).where(eq(offers.providerId, provider.id));
  return { provider_id: provider.id, status, reasons: [...new Set(reasons)], dashboard: `/hosts/?id=${encodeURIComponent(provider.id)}` };
}

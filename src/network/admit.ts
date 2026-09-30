import { recordPolicyRejection } from "./slashing.ts";
import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { providers } from "../db/schema.ts";
import { attestProvider } from "../services/attestor.ts";
import { assertNotSanctioned } from "./sanctions.ts";
import { admittedModels } from "./offers.ts";
import { checkPublishedHostPolicy, rejectHost, saveHostDisclosure } from "./admission-state.ts";
import { isApiError } from "../lib/errors.ts";

export { admissionReasons } from "./admission-state.ts";

/** Pending rows never become routable during verification. The existing attestor receives an
 * approved-status copy only for this explicit admission run; its checks and writes are unchanged. */
export async function admitHost(ctx: Ctx, provider: typeof providers.$inferSelect, models: string[]) {
  const reasons: string[] = [];
  let hardware = false;
  let policyVersion: number | null = null;
  let staticModels: ReturnType<typeof admittedModels> | null = null;
  if (new URL(provider.baseUrl).protocol !== "https:") reasons.push("The sidecar endpoint must use HTTPS.");
  else {
    const attestation = await attestProvider(ctx, { ...provider, status: "shadow" }, true);
    if (!attestation.ok) reasons.push("Attestation failed: " + ("reason" in attestation ? attestation.reason : "hardware evidence was not verified."));
    else if (!("host_policy_bindings" in attestation)) reasons.push("Verified quote-bound sidecar bindings are unavailable.");
    else {
      const evidence = attestation.host_policy_bindings;
      hardware = evidence.hardware_verified && !evidence.dev && !evidence.simulated;
      const checked = await checkPublishedHostPolicy(ctx, evidence, models);
      reasons.push(...checked.reasons);
      await recordPolicyRejection(ctx, provider.id, evidence, checked);
      if (checked.policy && !reasons.length && ctx.cfg.networkHosts.enabled) {
        staticModels = admittedModels(evidence, checked.policy, models);
        policyVersion = checked.policy.version;
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
  if (status === "rejected") await rejectHost(ctx, provider.id, reasons);
  else if (policyVersion !== null) await saveHostDisclosure(ctx, provider.id, policyVersion);
  return { provider_id: provider.id, status, reasons: [...new Set(reasons)], dashboard: `/hosts/?id=${encodeURIComponent(provider.id)}` };
}

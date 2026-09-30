import { recordPolicyRejection } from "./slashing.ts";
import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { providers } from "../db/schema.ts";
import type { attestProvider } from "../services/attestor.ts";
import { checkPublishedHostPolicy, rejectHost, saveHostDisclosure } from "./admission-state.ts";

/** Runs after fresh quote verification; curated providers and disabled network hosting are unchanged. */
export async function renewHostAttestation(ctx: Ctx, p: typeof providers.$inferSelect, result: Awaited<ReturnType<typeof attestProvider>>) {
  if (!ctx.cfg.networkHosts.enabled || !p.networkHost) return result;
  if (!result.ok) {
    await ctx.db.update(providers).set({ networkReasons: ["Attestation failed: " + ("reason" in result ? result.reason : "hardware evidence was not verified.")] }).where(eq(providers.id, p.id));
    return result;
  }
  const checked = "host_policy_bindings" in result
    ? await checkPublishedHostPolicy(ctx, result.host_policy_bindings, p.networkModels ?? [])
    : { reasons: ["Verified quote-bound sidecar bindings are unavailable."], policy: null };
  if ("host_policy_bindings" in result) await recordPolicyRejection(ctx, p.id, result.host_policy_bindings, checked);
  if (checked.reasons.length) {
    await rejectHost(ctx, p.id, checked.reasons);
    return { provider: p.id, ok: false, reason: checked.reasons.join(" ") };
  }
  await saveHostDisclosure(ctx, p.id, checked.policy!.version);
  await ctx.db.update(providers).set({ networkReasons: [] }).where(eq(providers.id, p.id));
  return result;
}

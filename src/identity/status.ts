import type { Ctx } from "../context.ts";
import { receiptKinds } from "./receipt-sources.ts";

/** The GET /api/v1/status section: what is switched on here, read from configuration, never assumed. */
export function identityStatus(ctx: Ctx) {
  const i = ctx.cfg.identity;
  return {
    enabled: i.enabled,
    paid_feedback: i.paidFeedback,
    registration_mode: i.enabled ? i.mode : null,
    chain_id: ctx.cfg.chain.id,
    registries: { identity: i.registries.identity ?? null, reputation: i.registries.reputation ?? null, validation: i.registries.validation ?? null, canonical: i.registries.canonical },
    validator: i.validator ?? null,
    feedback_receipt_kinds: i.paidFeedback ? receiptKinds() : [],
    feedback_half_life_days: i.paidFeedback ? i.halfLifeDays : null,
    liveness_interval_ms: i.enabled ? i.livenessIntervalMs : null,
  };
}

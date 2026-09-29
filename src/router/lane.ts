import type { DisclosureClass } from "./disclosure.ts";

// Catalog variants and the rule that keeps low-refusal weights off public routes.
//
// A model is one of three variants:
//   mainstream          the publisher's own alignment; no extra rule
//   native_low_refusal  trained to refuse little; restricted
//   abliterated         refusal behaviour removed from the weights after training; restricted
//
// A restricted model is served only when ALL of these hold for the provider at the moment of the request:
//   1. the provider is served under the "attested" disclosure class (declared attested retention AND a fresh,
//      verified attestation; a development report never counts in production), and
//   2. the provider's attestation reported the in-enclave hard-block classifier as enabled
//      (providers.classifier_enabled, written only by the attestor; unknown is false), and
//   3. the model's status is "servable" (an operator approved it).
// Nothing here is a request option: a caller cannot relax it, and it applies whichever lane the request asked
// for. A restricted model is never sent to a public or vendor-forwarded provider.

export const VARIANTS = ["mainstream", "native_low_refusal", "abliterated"] as const;
export type Variant = (typeof VARIANTS)[number];
export const LANE_STATUSES = ["servable", "candidate"] as const;
export type LaneStatus = (typeof LANE_STATUSES)[number];

/** What the router needs to know about one model to route it. */
export type ModelLane = { variant: Variant; servable: boolean };

/** The stored row, kept structural so this module stays free of the database. */
export type ModelLaneRowLike = { variant: string; status: string };

export const MAINSTREAM: ModelLane = Object.freeze({ variant: "mainstream", servable: true }) as ModelLane;

export const isVariant = (v: unknown): v is Variant => (VARIANTS as readonly unknown[]).includes(v);
export const isRestricted = (v: Variant | null | undefined): boolean => v === "abliterated" || v === "native_low_refusal";

/**
 * Ids and names that say the weights were modified to remove refusals. A model nobody has classified yet, whose
 * name says this, is treated as abliterated rather than mainstream, so that a provider listing it first cannot
 * put it on a public route before the operator has looked at it. An explicit row always wins over this guess.
 */
const REFUSAL_REMOVED = /abliterat|uncensor|decensor|unfilter|lorablat|refusal[-_ ]?(?:free|removed|ablated)/i;

export function inferredVariant(model: { id: string; name?: string | null; hfRepo?: string | null }): Variant {
  return REFUSAL_REMOVED.test(`${model.id} ${model.name ?? ""} ${model.hfRepo ?? ""}`) ? "abliterated" : "mainstream";
}

/** A day-zero candidate, as far as routing is concerned. */
export type CandidateLike = { variant: string; status: string };

/**
 * The variant and status a model is routed under: its declared row; else, if its Hugging Face repository is a
 * day-zero candidate, the candidate's variant, not servable until the candidate is (a candidate the pipeline
 * rejected for its license or provenance says nothing about serving); else what its name says; else mainstream.
 * Unrecognised stored values read as the most restricted setting.
 */
export function laneOf(
  model: { id: string; name?: string | null; hfRepo?: string | null },
  row: ModelLaneRowLike | null | undefined,
  candidate?: CandidateLike | null,
): ModelLane & { source: "declared" | "candidate" | "inferred" | "default" } {
  if (row) {
    const variant: Variant = isVariant(row.variant) ? row.variant : "abliterated";
    return { variant, servable: row.status === "servable", source: "declared" };
  }
  if (candidate && candidate.status !== "rejected") {
    return { variant: isVariant(candidate.variant) ? candidate.variant : "abliterated", servable: candidate.status === "servable", source: "candidate" };
  }
  const variant = inferredVariant(model);
  return { variant, servable: true, source: variant === "mainstream" ? "default" : "inferred" };
}

/**
 * Why a provider serving this class, with this classifier state, may not serve a restricted model; null when it may.
 * `cls` must come from the router's own attestation checks (candidateDisclosure), never from the provider's claim.
 */
export function restrictedExclusion(cls: DisclosureClass, classifierEnabled: boolean | null | undefined): string | null {
  if (cls !== "attested") return `restricted variant is served only under attested retention with a fresh attestation (this provider is ${cls})`;
  if (classifierEnabled !== true) return "restricted variant is served only by providers whose attestation reports the in-enclave classifier as enabled";
  return null;
}

export const NOT_SERVABLE_REASON = "model is a candidate and has not been approved for serving";

// ---- The classifier flag, as the attestor reads it ------------------------------------------------------------

export type ClassifierEvidence = {
  /** A hardware quote a configured verifier accepted. */
  hardwareVerified: boolean;
  /** The sidecar bindings were committed in that quote's report_data. */
  bindingsCommitted: boolean;
  /** The evidence is a development report (never true in production: those attestations are refused). */
  simulated: boolean;
  /** ALLOW_DEV_ATTESTATION outside production. */
  allowDev: boolean;
};

/**
 * Whether an attestation report says the in-enclave hard-block classifier is enabled, and only when that can be
 * trusted:
 *   - with a hardware quote: only the value the sidecar committed in its bindings (`bindings.classifier_enabled`),
 *     which the quote's report_data covers. The unbound top-level `classifier` field of the document is a claim
 *     the quote does not cover and is ignored.
 *   - with a development report, outside production only: the document's own `classifier.enabled`. That report
 *     is simulated, and routing refuses it in production.
 * Anything else, including a missing or malformed field, is false.
 */
export function classifierFromReport(report: Record<string, any> | null | undefined, ev: ClassifierEvidence): boolean {
  if (!report || typeof report !== "object") return false;
  if (ev.simulated) return ev.allowDev && report.classifier?.enabled === true;
  if (!ev.hardwareVerified || !ev.bindingsCommitted) return false;
  return report.sidecar_bindings?.classifier_enabled === true;
}

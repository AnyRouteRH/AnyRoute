import type { DisclosureMax, Lane } from "@anyroute/client";
import type { Model } from "./types.js";

// Lanes, weakest to strongest. "public": any provider. "attested": only providers whose enclave the router verified,
// refused rather than downgraded. "unlinkable": served only through an Oblivious HTTP relay with a blind token.
export const LANES = ["public", "attested", "unlinkable"] as const satisfies readonly Lane[];
/** Disclosure ceilings, loosest to strictest. */
export const DISCLOSURES = ["any", "policy", "none"] as const satisfies readonly DisclosureMax[];

export const isLane = (v: unknown): v is Lane => typeof v === "string" && (LANES as readonly string[]).includes(v);
export const isDisclosure = (v: unknown): v is DisclosureMax => typeof v === "string" && (DISCLOSURES as readonly string[]).includes(v);

/** The stricter of two lanes (undefined counts as unset). */
export function stricterLane(a: Lane | undefined, b: Lane | undefined): Lane | undefined {
  if (!a) return b;
  if (!b) return a;
  return LANES.indexOf(a) >= LANES.indexOf(b) ? a : b;
}

/** Whether GET /api/v1/models says the model can be served on `lane` right now. */
export function supportsLane(model: Pick<Model, "lanes">, lane: Lane): boolean {
  return Array.isArray(model.lanes) && model.lanes.includes(lane);
}

export { routingHeaders, withRouting } from "@anyroute/client";
export type { DisclosureMax, Lane, RoutingOptions } from "@anyroute/client";

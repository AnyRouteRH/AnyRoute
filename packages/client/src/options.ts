// Disclosure ceiling and lane. These map onto the router's request options (see the docs, "Route by what a provider
// discloses"): `provider.disclosure` / `provider.lane` in the body and the X-Anyroute-Disclosure-Max / X-Anyroute-Lane
// headers. The router applies the stricter of body and header, and never sends a request to a provider that does not
// qualify. The "unlinkable" lane is not available and the router answers 501; the client passes it through unchanged.

export type DisclosureMax = "none" | "policy" | "any";
export type Lane = "public" | "attested" | "unlinkable";

export type RoutingOptions = { disclosure?: DisclosureMax; lane?: Lane };

export function routingHeaders(o: RoutingOptions): Record<string, string> {
  return {
    ...(o.disclosure ? { "x-anyroute-disclosure-max": o.disclosure } : {}),
    ...(o.lane ? { "x-anyroute-lane": o.lane } : {}),
  };
}

const DISCLOSURE_RANK: Record<DisclosureMax, number> = { any: 0, policy: 1, none: 2 };
const LANE_RANK: Record<Lane, number> = { public: 0, attested: 1, unlinkable: 2 };
const stricter = <T extends string>(rank: Record<T, number>, a: unknown, b: T | undefined): T | undefined => {
  const known = (v: unknown): v is T => typeof v === "string" && v in rank;
  if (!b) return known(a) ? a : undefined;
  return known(a) && rank[a] > rank[b] ? a : b;
};

/**
 * Merge routing options into a request body's `provider` object without dropping the caller's own preferences. A
 * disclosure or lane already in the body is kept when it is the stricter one: an option never loosens a request.
 */
export function withRouting<T extends Record<string, unknown>>(body: T, o: RoutingOptions & { only?: string[]; allowFallbacks?: boolean }): T {
  const provider = { ...((body.provider as Record<string, unknown> | undefined) ?? {}) };
  const disclosure = stricter(DISCLOSURE_RANK, provider.disclosure, o.disclosure);
  const lane = stricter(LANE_RANK, provider.lane, o.lane);
  if (disclosure) provider.disclosure = disclosure;
  if (lane) provider.lane = lane;
  if (o.only) provider.only = o.only;
  if (o.allowFallbacks !== undefined) provider.allow_fallbacks = o.allowFallbacks;
  return Object.keys(provider).length ? { ...body, provider } : body;
}

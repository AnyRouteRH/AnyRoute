import { ApiError, fail } from "../lib/errors.ts";

// Disclosure profiles and the request options that route on them.
//
// A provider's profile records what the operator has documented about how it handles a prompt:
// retention (attested | policy | logs), jurisdiction, legal hold and training use, each with a
// source and a date. The router never infers any of it. What a request is *served under* is a
// separate, per-call fact, the disclosure class, computed by `disclosureClass` from the profile plus
// whether the provider currently passes the existing attestation checks:
//
//   attested          retention is declared "attested" AND the provider's TEE attestation is fresh now
//   policy            a documented no-retention policy (or an attested provider whose attestation has
//                     lapsed) with no active or undeclared legal hold
//   vendor-forwarded  everything else: the prompt reaches a vendor that may log it
//
// The same function drives both routing filters and the label reported back, so they cannot disagree.

export const RETENTION_VALUES = ["attested", "policy", "logs"] as const;
export type Retention = (typeof RETENTION_VALUES)[number];
export const TRAINING_VALUES = ["none", "opt_in", "yes"] as const;
export type TrainingUse = (typeof TRAINING_VALUES)[number] | "unknown";
export const DISCLOSURE_MAX_VALUES = ["none", "policy", "any"] as const;
export type DisclosureMax = (typeof DISCLOSURE_MAX_VALUES)[number];
export const LANES = ["public", "attested", "unlinkable"] as const;
export type Lane = (typeof LANES)[number];
export type DisclosureClass = "attested" | "policy" | "vendor-forwarded";
export const CLAIMS = ["retention", "jurisdiction", "legal_hold", "training_use"] as const;
export type ClaimName = (typeof CLAIMS)[number];
export type Claim = { source: string; as_of: string };

export type DisclosureProfile = {
  /** False when the operator has recorded nothing: every value below is then the conservative default. */
  declared: boolean;
  retention: Retention;
  jurisdiction: string;
  legal_hold: { active: boolean | null; note: string | null };
  training_use: TrainingUse;
  claims: Record<ClaimName, Claim | null>;
  updated_at: string | null;
};

/** The stored row, as the schema types it (kept structural so this module stays free of the database). */
export type DisclosureRowLike = {
  retention: string;
  jurisdiction: string;
  legalHold: boolean | null;
  legalHoldNote: string | null;
  trainingUse: string;
  claims: unknown;
  updatedAt: Date;
};

const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T => ((values as readonly string[]).includes(v as string) ? (v as T) : fallback);

/** A provider with no recorded profile: retention "logs", jurisdiction "unknown", nothing else claimed. */
export const UNDECLARED: DisclosureProfile = Object.freeze({
  declared: false,
  retention: "logs",
  jurisdiction: "unknown",
  legal_hold: Object.freeze({ active: null, note: null }),
  training_use: "unknown",
  claims: Object.freeze({ retention: null, jurisdiction: null, legal_hold: null, training_use: null }),
  updated_at: null,
}) as DisclosureProfile;

/** Profile for a stored row; anything missing or unrecognised falls back to the conservative value. */
export function profileOf(row: DisclosureRowLike | null | undefined): DisclosureProfile {
  if (!row) return UNDECLARED;
  const stored = (row.claims && typeof row.claims === "object" ? row.claims : {}) as Record<string, Claim | undefined>;
  const claim = (name: ClaimName): Claim | null => {
    const c = stored[name];
    return c && typeof c.source === "string" && typeof c.as_of === "string" ? { source: c.source, as_of: c.as_of } : null;
  };
  return {
    declared: true,
    retention: oneOf(RETENTION_VALUES, row.retention, "logs"),
    jurisdiction: row.jurisdiction || "unknown",
    legal_hold: { active: row.legalHold ?? null, note: row.legalHoldNote ?? null },
    training_use: oneOf([...TRAINING_VALUES, "unknown"] as const, row.trainingUse, "unknown"),
    claims: { retention: claim("retention"), jurisdiction: claim("jurisdiction"), legal_hold: claim("legal_hold"), training_use: claim("training_use") },
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * What a request to this provider is served under right now. `attestationOk` must come from the
 * router's own attestation checks (a fresh, verified report; never a dev report in production).
 * A no-retention *policy* is void while a legal hold is active, and is not trusted while the hold
 * status is undeclared.
 */
export function disclosureClass(profile: DisclosureProfile, attestationOk: boolean): DisclosureClass {
  if (profile.retention === "attested" && attestationOk) return "attested";
  if ((profile.retention === "attested" || profile.retention === "policy") && profile.legal_hold.active === false) return "policy";
  return "vendor-forwarded";
}

/** Whether a provider served under `cls` satisfies a request's disclosure ceiling. */
export function classAllowed(cls: DisclosureClass, max: DisclosureMax): boolean {
  return max === "any" || (max === "policy" ? cls !== "vendor-forwarded" : cls === "attested");
}

/** Why a candidate is excluded under a strict request (used in the `excluded` list of an error). */
export function disclosureExclusion(max: DisclosureMax, lane: Lane, cls: DisclosureClass): string {
  const asked = lane !== "public" ? `lane "${lane}"` : `disclosure "${max}"`;
  return max === "none"
    ? `${asked} requires attested retention with a fresh attestation (this provider is ${cls})`
    : `${asked} requires a documented no-retention policy with no legal hold (this provider is ${cls})`;
}

// ---- Request options ---------------------------------------------------------------------------

const DISCLOSURE_RANK: Record<DisclosureMax, number> = { any: 0, policy: 1, none: 2 };
const LANE_RANK: Record<Lane, number> = { public: 0, attested: 1, unlinkable: 2 };

export type DisclosureRequest = {
  /** The effective ceiling: the strictest of `provider.disclosure`, the header, and what the lane implies. */
  max: DisclosureMax;
  /** The lane the request is served on (`public` when unset, or the request's default lane; see resolveDisclosureRequest). */
  lane: Lane;
  /** Set when lane "unlinkable" was asked for with an identity-bearing credential and the caller allowed a downgrade. */
  downgradedFrom?: Lane;
};

export const LANE_DOWNGRADE_VALUES = ["none", "attested"] as const;
export type LaneDowngrade = (typeof LANE_DOWNGRADE_VALUES)[number];

function parseOption<T extends string>(values: readonly T[], raw: unknown, name: string): T | null {
  if (raw == null || raw === "") return null;
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if ((values as readonly unknown[]).includes(v)) return v as T;
  return fail(400, `${name} must be one of: ${values.join(", ")}.`, "invalid_request");
}

/** `unlinkable` needs the blind-token payment and relay path, which a router only runs with OHTTP_ENABLED. */
export const unlinkableUnavailable = () =>
  new ApiError(
    501,
    'Lane "unlinkable" is not available yet. It needs a blind-token payment and relay path, which this router does not run. Nothing was sent to any provider. Use lane "attested" for attested providers, or "public".',
    "lane_not_available",
    { lane: "unlinkable", available_lanes: ["public", "attested"] },
  );

export type LaneOptions = {
  /** True when this router runs the Oblivious HTTP gateway and blind tokens (OHTTP_ENABLED). Otherwise `unlinkable` is a 501. */
  unlinkable?: boolean;
  /** The lane a request that names none is served on (ohttp/lane.ts: "unlinkable" for a relayed blind-token request). Default "public". */
  defaultLane?: Lane;
};

/** A lane from a body field, header or query string: null when unset, 400 when unrecognised, 501 for `unlinkable` unless it is served. */
export function parseLane(raw: unknown, name: string, opts: LaneOptions = {}): Lane | null {
  const lane = parseOption(LANES, raw, name);
  if (lane === "unlinkable" && !opts.unlinkable) throw unlinkableUnavailable();
  return lane;
}

/**
 * Resolve `provider.disclosure` / `provider.lane` and the `X-Anyroute-Disclosure-Max` / `X-Anyroute-Lane`
 * headers into one request. When both a body field and a header are given, the stricter one wins: a
 * restriction is never relaxed by a second setting. Lanes "attested" and "unlinkable" imply disclosure "none".
 * Lane "unlinkable" is refused (501) unless `opts.unlinkable`; when it is served, whether the request may use it
 * (relay, token) is decided by the caller (ohttp/lane.ts), not here.
 */
export function resolveDisclosureRequest(
  prefs: { disclosure?: unknown; lane?: unknown } | undefined,
  headers: { disclosureMax?: string | null; lane?: string | null },
  opts: LaneOptions = {},
): DisclosureRequest {
  const disclosures = [parseOption(DISCLOSURE_MAX_VALUES, prefs?.disclosure, "`provider.disclosure`"), parseOption(DISCLOSURE_MAX_VALUES, headers.disclosureMax, "X-Anyroute-Disclosure-Max")];
  const lanes = [parseLane(prefs?.lane, "`provider.lane`", opts), parseLane(headers.lane, "X-Anyroute-Lane", opts)];
  const strictest = <T extends string>(xs: (T | null)[], rank: Record<T, number>, base: T): T => xs.reduce<T>((a, x) => (x && rank[x] > rank[a] ? x : a), base);
  // A request that names no lane anywhere is served on the default lane; one that names any lane, even "public", is not.
  const named = lanes.some((l) => l !== null);
  const lane = named ? strictest(lanes, LANE_RANK, "public") : (opts.defaultLane ?? "public");
  const max = strictest(disclosures, DISCLOSURE_RANK, "any");
  return { max: lane !== "public" ? "none" : max, lane };
}

/** `provider.lane_downgrade` / `X-Anyroute-Lane-Downgrade`: "attested" allows it, anything unset is "none". 400 when unrecognised. */
export function parseLaneDowngrade(raw: unknown, header: string | null | undefined): LaneDowngrade {
  const vals = [parseOption(LANE_DOWNGRADE_VALUES, raw, "`provider.lane_downgrade`"), parseOption(LANE_DOWNGRADE_VALUES, header, "X-Anyroute-Lane-Downgrade")];
  // Either setting may refuse the downgrade; it is allowed only when one allows it and none refuses it.
  return vals.includes("none") ? "none" : vals.includes("attested") ? "attested" : "none";
}

/** The exclusion reason select.ts records for a provider that is in an outage (it is checked after the disclosure filter). */
export const OUTAGE_REASON = "outage in the last 30s";

/** The error code for a lane request (attested or unlinkable) that no attested endpoint can serve right now. */
export const NO_ATTESTED_ENDPOINT = "no_attested_endpoint";

/**
 * The refusal for a request that carries a disclosure ceiling or a lane and found no provider, or null when
 * the ceiling was not what blocked it. Never a downgrade: nothing was sent to any provider and nothing was charged.
 * On lanes "attested" and "unlinkable":
 *   503 no_attested_endpoint  no endpoint with a fresh, verified attestation can serve it now; `metadata.reason` is
 *                             "attested_endpoints_down" (some exist but are in an outage; Retry-After is set) or
 *                             "none_attested" (the model has endpoints, none of them attested)
 * With only `provider.disclosure`:
 *   503 disclosure_provider_unavailable  a provider meets the ceiling but every one of them is in an outage (retry later)
 *   409 disclosure_unavailable           no provider meets the ceiling, though the model has providers that would otherwise serve it
 * `otherwiseServable` answers whether the same request, without the ceiling, would have found a provider.
 */
export function disclosureRefusal(
  req: Pick<DisclosureRequest, "max" | "lane">,
  models: string[],
  excluded: { model?: string; provider: string; reason: string }[],
  otherwiseServable: () => boolean,
): ApiError | null {
  if (req.max === "any") return null;
  const wanted = req.lane !== "public" ? `lane "${req.lane}"` : `provider.disclosure "${req.max}"`;
  const requested = { disclosure: req.max, lane: req.lane };
  if (req.lane !== "public") {
    const down = excluded.some((e) => e.reason === OUTAGE_REASON);
    if (!down && !otherwiseServable()) return null;
    return new ApiError(
      503,
      down
        ? `Attested endpoints for ${models.join(", ")} are temporarily unavailable, so ${wanted} cannot be served right now. The request was not routed to any endpoint without a fresh, verified attestation, and nothing was charged. Retry shortly.`
        : `No endpoint for ${models.join(", ")} that fits this request has a fresh, verified attestation, so ${wanted} cannot be served. Nothing was sent to any provider and nothing was charged. See GET /api/v1/models?lane=attested for models that have one.`,
      NO_ATTESTED_ENDPOINT,
      { lane: req.lane, reason: down ? "attested_endpoints_down" : "none_attested", requested, excluded: excluded.slice(0, 50) },
      down ? { "retry-after": "30" } : undefined,
    );
  }
  if (excluded.some((e) => e.reason === OUTAGE_REASON))
    return new ApiError(
      503,
      `Providers for ${models.join(", ")} that meet ${wanted} are temporarily unavailable. The request was not routed to any provider that does not meet it, and nothing was charged. Retry shortly.`,
      "disclosure_provider_unavailable",
      { requested, excluded: excluded.slice(0, 50) },
      { "retry-after": "30" },
    );
  if (!otherwiseServable()) return null;
  const needs = req.max === "none" ? 'a provider whose retention is declared "attested" and whose TEE attestation is fresh' : "a provider with attested retention or a documented no-retention policy and no legal hold";
  return new ApiError(
    409,
    `No provider for ${models.join(", ")} meets ${wanted}: it needs ${needs}. Nothing was sent to any provider and nothing was charged. Relax the option, or see GET /api/v1/models?lane=attested and GET /api/v1/disclosure/{providerId}.`,
    "disclosure_unavailable",
    { requested, excluded: excluded.slice(0, 50) },
  );
}

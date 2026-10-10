import { assertKeyIpLane } from "../key-ip/allowlist.ts"; // E148
import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { parseLaneDowngrade, resolveDisclosureRequest, type DisclosureRequest, type Lane } from "../router/disclosure.ts";
import { onionUnlinkable, unlinkableServed } from "../onion/lane.ts";
import { gatewayOrigin } from "./origin.ts";

// The three privacy lanes, as a request is admitted to them:
//
//   public      any endpoint; key, credits, per-call payment or blind token
//   attested    only endpoints with a fresh, verified attestation; any credential
//   unlinkable  only endpoints with a fresh, verified attestation, reached through an independent Oblivious HTTP
//               relay (OHTTP_ENABLED) or through this router's Tor onion service (UNLINKABLE_VIA_ONION; see
//               onion/lane.ts), paid with a blind token and nothing that names the payer
//
// The endpoint part of "attested" and "unlinkable" is the disclosure filter in router/select.ts, which never falls back
// to an endpoint without a fresh attestation (router/disclosure.ts, 503 no_attested_endpoint). This module decides which
// lane a request is on and checks the transport and credential part of "unlinkable" before the request is priced or
// spends a token.

/** The credentials a request presented. A key or a wallet names the payer; a blind token does not. */
export type LaneAuth = { hasKey: boolean; hasWallet?: boolean; hasToken: boolean };

const identityBearing = (o: LaneAuth) => o.hasKey || !!o.hasWallet;

/**
 * The lane a request that names none is served on: "unlinkable" when the router serves that lane and the request
 * already qualifies for it (it came through the gateway from an independent relay and pays with a blind token and
 * nothing else), otherwise "public".
 */
export function defaultLane(ctx: Ctx, c: Context, o: LaneAuth): Lane {
  if (!ctx.cfg.ohttp.enabled || !o.hasToken || identityBearing(o)) return "public";
  return gatewayOrigin(c.req.raw)?.relay?.independent ? "unlinkable" : "public";
}

/**
 * Resolve the lane and disclosure ceiling of a request (`provider.lane`, `provider.disclosure`, the X-Anyroute-Lane and
 * X-Anyroute-Disclosure-Max headers, the stricter winning; else the default lane) and admit it to that lane:
 *   - lane "unlinkable" with an API key or a wallet is refused (403 lane_requires_anonymous_auth), unless the request
 *     allows a downgrade (`provider.lane_downgrade: "attested"` or X-Anyroute-Lane-Downgrade: attested), in which case
 *     it is served on lane "attested": still attested endpoints only, never public.
 *   - lane "unlinkable" otherwise must meet requireUnlinkable.
 */
export function requestLane(ctx: Ctx, c: Context, provider: Record<string, unknown> | undefined, o: LaneAuth): DisclosureRequest {
  assertKeyIpLane(c, String(provider?.lane)); // E148: refuse even when unlinkable is not served
  const disc = resolveDisclosureRequest(
    provider,
    { disclosureMax: c.req.header("x-anyroute-disclosure-max"), lane: c.req.header("x-anyroute-lane") },
    { unlinkable: unlinkableServed(ctx.cfg), defaultLane: defaultLane(ctx, c, o) },
  );
  const downgrade = parseLaneDowngrade(provider?.lane_downgrade, c.req.header("x-anyroute-lane-downgrade"));
  assertKeyIpLane(c, disc.lane); // E148: even with a requested downgrade
  if (disc.lane !== "unlinkable") return disc;
  if (identityBearing(o) && downgrade === "attested") return { ...disc, lane: "attested", downgradedFrom: "unlinkable" };
  requireUnlinkable(ctx, c, o);
  return disc;
}

/**
 * Refuse a request for lane "unlinkable" that names its payer, did not arrive through an independent relay or (with
 * UNLINKABLE_VIA_ONION) through the onion service, or has no blind token.
 */
export function requireUnlinkable(ctx: Ctx, c: Context, o: LaneAuth): void {
  const origin = gatewayOrigin(c.req.raw);
  const ohttp = ctx.cfg.ohttp.enabled;
  const onion = ctx.cfg.unlinkable.viaOnion;
  const onionUrl = onion && ctx.cfg.onion.address ? `http://${ctx.cfg.onion.address}` : null;
  // Where the lane is also served over Tor, the refusals say so; with Oblivious HTTP alone they read as they always have.
  const links = { ...(ohttp ? { relays_url: "/api/v1/relays", gateway_url: "/api/v1/ohttp/gateway" } : {}), ...(onion ? { status_url: "/api/v1/status", onion_url: onionUrl } : {}) };
  const through = !onion ? "through an Oblivious HTTP relay" : ohttp ? "through an Oblivious HTTP relay or over Tor to this router's onion service" : "over Tor to this router's onion service";
  if (identityBearing(o))
    throw new ApiError(
      403,
      `Lane "unlinkable" is paid with a blind token only (Authorization: PrivateToken token=...), never with an API key or a wallet, because those name the payer. Buy tokens with POST /api/v1/blind/purchase and send the request ${through}, or set provider.lane_downgrade to "attested" to be served on lane "attested" instead.`,
      "lane_requires_anonymous_auth",
      { ...links, lane: "unlinkable", downgrade: "attested" },
    );
  // Over Tor: the onion proxy's secret is the whole of the network check (onion/lane.ts); only the payment is left.
  if (!onionUnlinkable(c, ctx.cfg)) {
    if (!origin?.relay)
      throw new ApiError(
        403,
        !onion
          ? 'Lane "unlinkable" is only served for requests that arrive through an Oblivious HTTP relay. This request came directly, so the router would see your network address. Pick a relay from GET /api/v1/relays, send the request through it to the gateway, and pay with a blind token (Authorization: PrivateToken).'
          : `Lane "unlinkable" is only served for requests that arrive ${through}. This request came directly, so the router would see your network address. ${ohttp ? "Pick a relay from GET /api/v1/relays and send the request through it to the gateway, or send it" : "Send it"} over Tor to the onion address in GET /api/v1/status (onion.url${onionUrl ? `, ${onionUrl}` : ""}), and pay with a blind token (Authorization: PrivateToken).`,
        "unlinkable_requires_relay",
        links,
      );
    if (!origin.relay.independent)
      throw new ApiError(
        403,
        `Lane "unlinkable" is not served through a relay run by the gateway's own operator (${origin.relay.operator}): it would hide nothing from the router. Use a relay from another operator (GET /api/v1/relays).`,
        "unlinkable_requires_independent_relay",
        links,
      );
  }
  if (!o.hasToken)
    throw new ApiError(
      401,
      'Lane "unlinkable" is paid with a blind token only (Authorization: PrivateToken token=...). Buy tokens with POST /api/v1/blind/purchase and see GET /api/v1/blind/keys.',
      "unlinkable_requires_token",
      undefined,
      ctx.blind?.challengeHeader,
    );
}

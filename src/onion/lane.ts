import type { Context } from "hono";
import { viaOnion } from "../api/common.ts";
import type { Config } from "../config.ts";

// Lane "unlinkable" over Tor (UNLINKABLE_VIA_ONION).
//
// The lane keeps the router from tying together who pays, where a request came from and what it asks. Payment is a
// blind token (src/blind), which its purchase cannot be linked to. The network address is hidden by the transport:
//
//   ohttp  an Oblivious HTTP relay run by another operator (OHTTP_ENABLED; src/ohttp/lane.ts), or
//   onion  Tor. The client reaches this router's onion service (deploy/onion) through a Tor circuit, and the onion
//          service connects to the router over a private network. Tor never gives the onion service the client's
//          address, the proxy strips every header that could carry one, and the router ignores such headers on
//          onion requests anyway (./ingress.ts). What hides the address is the Tor network, not an operator the
//          router trusts, so the onion service being AnyRoute's own does not undo it.
//
// Whether a request came through the onion service is decided only by the secret the onion proxy writes into
// X-Anyroute-Onion (ONION_PROXY_SECRET, compared in constant time; src/lib/onion.ts). The proxy deletes any copy a
// client sends, and a clearnet client that sends the header without the secret is an ordinary client, so the onion
// path cannot be claimed from the public hostname.
//
// Everything else about the lane is the same on both transports: blind token only (an API key, a wallet or a per-call
// payment is refused with lane_requires_anonymous_auth), attested endpoints only, no fallback. Neither transport hides
// the prompt from the router: it terminates TLS on this lane today, on either path.

export type UnlinkableTransport = "ohttp" | "onion";

/** The transports that carry lane "unlinkable" on this router, in a fixed order; empty when the lane is not served. */
export function unlinkableTransports(cfg: Pick<Config, "ohttp" | "unlinkable">): UnlinkableTransport[] {
  const via: UnlinkableTransport[] = [];
  if (cfg.ohttp.enabled) via.push("ohttp");
  if (cfg.unlinkable.viaOnion) via.push("onion");
  return via;
}

/** True when this router serves lane "unlinkable" at all (otherwise asking for it is 501 lane_not_available). */
export const unlinkableServed = (cfg: Pick<Config, "ohttp" | "unlinkable">): boolean => cfg.ohttp.enabled || cfg.unlinkable.viaOnion;

/**
 * True when this request's network path qualifies for lane "unlinkable" over Tor: UNLINKABLE_VIA_ONION is on and the
 * onion proxy forwarded it (it carries the proxy's secret). The payment part (a blind token, and nothing that names the
 * payer) is checked with the rest of the lane in src/ohttp/lane.ts.
 */
export const onionUnlinkable = (c: Context, cfg: Pick<Config, "onion" | "unlinkable">): boolean => cfg.unlinkable.viaOnion && viaOnion(c, cfg);

import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { gatewayOrigin } from "./origin.ts";

// The "unlinkable" lane: attested providers only, reached through an Oblivious HTTP relay, paid with a blind token.
// The router serves it only when all three hold, and says which one is missing when it does not. The attested
// providers part is the same disclosure filter lane "attested" uses (see router/disclosure.ts); this checks the other
// two before the request is authenticated further, priced, or spends a token.

/** Refuse a request for lane "unlinkable" that did not arrive through a relay with a blind token and no API key. */
export function requireUnlinkable(ctx: Ctx, c: Context, o: { hasKey: boolean; hasWallet?: boolean; hasToken: boolean }): void {
  const origin = gatewayOrigin(c.req.raw);
  const links = { relays_url: "/api/v1/relays", gateway_url: "/api/v1/ohttp/gateway" };
  if (!origin?.relay)
    throw new ApiError(
      403,
      'Lane "unlinkable" is only served for requests that arrive through an Oblivious HTTP relay. This request came directly, so the router would see your network address. Pick a relay from GET /api/v1/relays, send the request through it to the gateway, and pay with a blind token (Authorization: PrivateToken).',
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
  if (o.hasKey || o.hasWallet || !o.hasToken)
    throw new ApiError(
      o.hasKey || o.hasWallet ? 403 : 401,
      'Lane "unlinkable" is paid with a blind token only (Authorization: PrivateToken token=...), never with an API key or a wallet, because those name the payer. Buy tokens with POST /api/v1/blind/purchase and see GET /api/v1/blind/keys.',
      "unlinkable_requires_token",
      undefined,
      ctx.blind?.challengeHeader,
    );
}

import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { ONION_HEADER } from "../lib/onion.ts";
import { onionUnlinkable } from "../onion/lane.ts";

const privateAuth = (c: Context) => /^\s*PrivateToken(?:\s|$)/i.test(c.req.header("authorization") ?? "");
const identity = (c: Context) => !!(c.req.header("x-api-key") || c.req.header("x-wallet-auth") || c.req.header("x-pay-with"));

/** Only the authenticated onion ingress may forward its marker; token calls always ask for unlinkable. */
export function onionMessagesHeaders(c: Context, ctx: Ctx): Record<string, string> | null {
  if (!privateAuth(c)) return null;
  if (!ctx.blind || !onionUnlinkable(c, ctx.cfg)) throw new ApiError(403, "Messages with blind tokens require this router's unlinkable onion path.", "unlinkable_requires_onion");
  if (identity(c)) throw new ApiError(403, "Messages on the unlinkable lane accept blind tokens only, without an API key or wallet.", "lane_requires_anonymous_auth");
  return { authorization: c.req.header("authorization")!, [ONION_HEADER]: c.req.header(ONION_HEADER)!, "x-anyroute-lane": "unlinkable" };
}

/** Counting on the onion path is free, requires no token and never verifies or redeems one. */
export function onionCountAllowed(c: Context, ctx: Ctx) {
  return !!ctx.blind && onionUnlinkable(c, ctx.cfg) && !identity(c) && (!c.req.header("authorization") || privateAuth(c));
}

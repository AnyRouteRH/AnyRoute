import type { MiddlewareHandler } from "hono";
import { viaOnion } from "../api/common.ts";
import type { Config } from "../config.ts";

// Requests that arrive through the onion service carry no client address, and nothing on them may be taken for one.
// The onion proxy (deploy/onion/haproxy.cfg) already deletes these headers before it forwards a request; the router
// deletes them again here, before any route runs, so a proxy configuration that drifted still cannot hand a
// client-written address to a rate limit, a log or an in-process adapter. On onion requests the router reads no
// address at all: per-address limits use one shared "onion" bucket (addressBucket in src/api/common.ts).

/** Headers that name, or claim to name, a client's network address. */
export const ADDRESS_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ipcountry",
  "fastly-client-ip",
  "x-appengine-user-ip",
  "via",
] as const;

/** Strip address headers from every request the onion proxy forwarded; other requests pass untouched. */
export function onionIngress(cfg: Pick<Config, "onion">): MiddlewareHandler {
  return async (c, next) => {
    if (cfg.onion.secrets.length && viaOnion(c, cfg)) {
      const headers = c.req.raw.headers;
      for (const name of ADDRESS_HEADERS) {
        try {
          headers.delete(name);
        } catch {
          /* immutable headers: nothing downstream reads them on an onion request (addressBucket short-circuits) */
        }
      }
    }
    await next();
  };
}

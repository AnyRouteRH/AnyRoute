import type { Context } from "hono";
import type { Config } from "../config.ts";
import { fail } from "../lib/errors.ts";
import { matchesOnionSecret, ONION_HEADER } from "../lib/onion.ts";

export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) fail(413, "Request body is too large (16 MB max).", "payload_too_large");
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) fail(413, "Request body is too large (16 MB max).", "payload_too_large");
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail(400, "Request body must be valid JSON.", "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Request body must be a JSON object.", "invalid_json");
  return body as Record<string, unknown>;
}

/** Client address for rate limits. X-Forwarded-For is spoofable, so it is only read behind a trusted
 *  proxy (TRUST_PROXY=true), and then only its right-most entry — the hop the proxy itself saw. */
export function clientIp(c: Context, trustProxy = false) {
  if (trustProxy) {
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  const env = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
  try {
    return env?.requestIP?.(c.req.raw)?.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** True when the onion proxy forwarded this request: it carries the secret the proxy shares with the router. A request that
 *  sends the header without the secret is an ordinary client and is treated as one. */
export const viaOnion = (c: Context, cfg: Pick<Config, "onion">) => matchesOnionSecret(cfg.onion.secrets, c.req.header(ONION_HEADER));

/** Who a per-address rate limit counts a request against. */
export type AddressBucket = {
  /** The client address, or "onion" for every request that arrived over Tor. */
  id: string;
  onion: boolean;
  /** The limit this bucket gets where one address would get `limit`. */
  scale: (limit: number) => number;
};

/**
 * The bucket for per-address rate limits (unauthenticated calls, new keys, sign-in challenges and the like). Requests
 * that came over Tor have no client address: the onion proxy's is the same for all of them and X-Forwarded-For is
 * whatever the client wrote. Keying by either would make every onion client one client, or let a client pick its own
 * bucket. They share one "onion" bucket per limit instead, sized ONION_POOL_MULTIPLIER times a single address's limit and
 * kept apart from every real address. Calls that carry an API key are limited per key, not by this bucket.
 */
export function addressBucket(c: Context, cfg: Pick<Config, "onion" | "trustProxy">): AddressBucket {
  if (viaOnion(c, cfg)) {
    const multiplier = cfg.onion.poolMultiplier;
    return { id: "onion", onion: true, scale: (limit) => limit * multiplier };
  }
  return { id: clientIp(c, cfg.trustProxy), onion: false, scale: (limit) => limit };
}

export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

import { derivedClientIp } from "../hardening/client.ts";
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
 *  proxy (TRUST_PROXY=true), counting TRUST_PROXY_HOPS from the right. A valid enabled origin lock permits CF-Connecting-IP. */
export function clientIp(c: Context, trustProxy = false) {
  if (c.get("onionIngress")) return "onion";
  return derivedClientIp(c, trustProxy, c.get("hardening"));
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

/**
 * Headers every chat, completion and embeddings response carries once a generation id exists:
 *   X-Generation-Id / X-Receipt-Id  the generation id, which is also the id of its signed receipt (GET /api/v1/receipts/{id})
 *   Inference-Id                     the same id, under the name Hugging Face inference clients read
 *   X-Anyroute-Lane                  the lane the request was served under: public, attested or unlinkable
 *   X-Anyroute-Policy-Hash           only when the serving endpoint's fresh attestation bound a classifier policy hash
 * Browsers can read all of them (CORS Access-Control-Expose-Headers, see app.ts).
 */
export function generationHeaders(id: string, lane: string, policyHash?: string | null): Record<string, string> {
  return { "x-generation-id": id, "x-receipt-id": id, "inference-id": id, "x-anyroute-lane": lane, ...(policyHash ? { "x-anyroute-policy-hash": policyHash } : {}) };
}

/** The response headers listed above plus the others a browser client may read. */
export const EXPOSED_RESPONSE_HEADERS = ["x-generation-id", "x-receipt-id", "inference-id", "x-anyroute-lane", "x-anyroute-policy-hash", "x-payment-required", "x-payment-response", "payment-required", "payment-response", "x-anyroute-disclosure", "x-anyroute-cache", "x-anyroute-character", "x-anyroute-character-lane", "x-anyroute-character-note", "x-anyroute-character-session", "retry-after"];

/** The policy hash a header may state for a response that stands for several calls: only one they all share. */
export const sharedPolicyHash = (hashes: (string | null | undefined)[]): string | null => (hashes.length && hashes.every((h) => h && h === hashes[0]) ? hashes[0]! : null);

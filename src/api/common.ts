import type { Context } from "hono";
import { fail } from "../lib/errors.ts";

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

export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

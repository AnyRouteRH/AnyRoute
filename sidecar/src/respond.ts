import type { Runtime } from "./boot.ts";

/** Headers on every response the sidecar itself produces. Dev mode is stated on all of them. */
export function baseHeaders(rt: Runtime): Headers {
  const h = new Headers();
  h.set("x-anyroute-attestation-ref", rt.attestationRef);
  if (rt.dev) h.set("x-anyroute-attestation", "dev-simulated");
  h.set("cache-control", "no-store");
  h.set("x-content-type-options", "nosniff");
  return h;
}

export function jsonResponse(rt: Runtime, status: number, body: unknown, extra?: Record<string, string>): Response {
  const h = baseHeaders(rt);
  h.set("content-type", "application/json");
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  return new Response(JSON.stringify(body), { status, headers: h });
}

/** OpenAI-style error body so SDKs surface the message. */
export function errorResponse(rt: Runtime, status: number, code: string, message: string, extra?: Record<string, string>): Response {
  const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return jsonResponse(rt, status, { error: { message, type, code } }, extra);
}

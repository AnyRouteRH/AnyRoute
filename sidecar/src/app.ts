import { attestationDocument, discoveryDocument } from "./attest.ts";
import type { Runtime } from "./boot.ts";
import { buildUpstreamHeaders } from "./headers.ts";
import { handleInference, type Caller } from "./proxy.ts";
import { parseNonce } from "./reportdata.ts";
import { errorResponse, jsonResponse } from "./respond.ts";
import { SidecarError, safeEqual, sha256Hex } from "./util.ts";
import { SIDECAR_VERSION } from "./version.ts";

// Request routing. The handler takes a plain Request: it never sees, and cannot log, the peer address.

/** Match a presented API key against the configured SHA-256 digests without an early exit. */
export function authenticate(rt: Runtime, req: Request): Caller | null {
  if (rt.cfg.auth.keys.length === 0) return { keyId: "anonymous" }; // parseConfig requires allow_anonymous for this
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const presented = sha256Hex(m[1]);
  let hit: string | null = null;
  for (const k of rt.cfg.auth.keys) if (safeEqual(presented, k.sha256) && hit === null) hit = k.id;
  return hit === null ? null : { keyId: hit };
}

function unauthorized(rt: Runtime) {
  return errorResponse(rt, 401, "invalid_api_key", "a valid API key is required", { "www-authenticate": 'Bearer realm="anyroute-sidecar"' });
}

export function createHandler(rt: Runtime): (req: Request) => Promise<Response> {
  let health: { at: number; ok: boolean } | null = null;
  const upstreamHealthy = async (): Promise<boolean> => {
    if (health && Date.now() - health.at < 5000) return health.ok;
    let ok = false;
    try {
      const res = await rt.fetchImpl(`${rt.cfg.upstream.baseUrl}/v1/models`, {
        headers: buildUpstreamHeaders(new Headers(), { forwardHeaders: [], upstreamApiKey: rt.upstreamApiKey }),
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      await res.arrayBuffer().catch(() => {});
      ok = res.ok;
    } catch {
      ok = false;
    }
    health = { at: Date.now(), ok };
    return ok;
  };

  const route = async (req: Request, url: URL): Promise<{ name: string; res: Response }> => {
    const p = url.pathname;
    const m = req.method;

    if (p === "/healthz") {
      if (m !== "GET" && m !== "HEAD") return { name: "healthz", res: errorResponse(rt, 405, "method_not_allowed", "use GET", { allow: "GET, HEAD" }) };
      const upstream = await upstreamHealthy();
      const ok = upstream;
      const body = {
        status: ok ? "ok" : "degraded",
        version: SIDECAR_VERSION,
        dev: rt.dev,
        attestation: { kind: rt.bootEvidence.kind, ref: rt.attestationRef },
        model_digest: rt.model.digest,
        upstream: upstream ? "ok" : "unreachable",
        uptime_s: Math.floor((Date.now() - rt.startedAt) / 1000),
        receipts: { pending: rt.queue.pending, dropped: rt.queue.dropped },
        tls_not_after: rt.tls?.notAfter.toISOString() ?? null,
      };
      return { name: "healthz", res: jsonResponse(rt, ok ? 200 : 503, body) };
    }

    if (p === "/attest") {
      if (m !== "GET") return { name: "attest", res: errorResponse(rt, 405, "method_not_allowed", "use GET", { allow: "GET" }) };
      const nonceParam = url.searchParams.get("nonce");
      if (nonceParam === null) return { name: "attest", res: jsonResponse(rt, 200, attestationDocument(rt, rt.bootEvidence, null)) };
      const nonce = parseNonce(nonceParam);
      if (!nonce) return { name: "attest", res: errorResponse(rt, 400, "invalid_nonce", "nonce must be 64 hex characters (32 bytes)") };
      try {
        const fresh = await rt.freshQuote(nonce);
        return { name: "attest", res: jsonResponse(rt, 200, attestationDocument(rt, fresh, nonceParam.replace(/^0x/, "").toLowerCase())) };
      } catch (e) {
        if (e instanceof SidecarError && e.code === "QUOTE_RATE_LIMITED") return { name: "attest", res: errorResponse(rt, 429, "rate_limited", e.message, { "retry-after": "5" }) };
        rt.logger("error", "fresh quote failed", { code: e instanceof SidecarError ? e.code : "UNKNOWN" });
        return { name: "attest", res: errorResponse(rt, 502, "attestation_unavailable", "the platform could not produce a quote") };
      }
    }

    if (p === "/.well-known/anyroute-sidecar.json") {
      if (m !== "GET") return { name: "discovery", res: errorResponse(rt, 405, "method_not_allowed", "use GET", { allow: "GET" }) };
      return { name: "discovery", res: jsonResponse(rt, 200, discoveryDocument(rt)) };
    }

    if (p === "/v1/chat/completions" || p === "/v1/embeddings") {
      const caller = authenticate(rt, req);
      if (!caller) return { name: p, res: unauthorized(rt) };
      return { name: p, res: await handleInference(rt, req, p, caller) };
    }

    const rid = /^\/v1\/receipts\/(rcpt_[0-9a-f]{24})$/.exec(p);
    if (rid) {
      const caller = authenticate(rt, req);
      if (!caller) return { name: "receipt", res: unauthorized(rt) };
      const env = rt.receiptIndex.get(rid[1], caller.keyId);
      return { name: "receipt", res: env ? jsonResponse(rt, 200, env) : errorResponse(rt, 404, "receipt_not_found", "no such receipt for this key") };
    }

    if (p === "/anchor/leaves" || p === "/anchor/ack") {
      // The router's anchor pulls leaves here. Off unless an anchor token is configured.
      if (!rt.anchorToken) return { name: "anchor", res: errorResponse(rt, 404, "not_found", "not found") };
      const m2 = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
      if (!m2 || !safeEqual(sha256Hex(m2[1]), sha256Hex(rt.anchorToken))) return { name: "anchor", res: unauthorized(rt) };
      if (p === "/anchor/leaves") {
        if (m !== "GET") return { name: "anchor", res: errorResponse(rt, 405, "method_not_allowed", "use GET", { allow: "GET" }) };
        const after = Math.max(0, Math.floor(Number(url.searchParams.get("after") ?? "0")) || 0);
        const limit = Math.min(1000, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? "100")) || 100));
        return { name: "anchor", res: jsonResponse(rt, 200, rt.queue.pull(after, limit)) };
      }
      if (m !== "POST") return { name: "anchor", res: errorResponse(rt, 405, "method_not_allowed", "use POST", { allow: "POST" }) };
      let through = NaN;
      try {
        through = Number(((await req.json()) as { through_seq?: unknown }).through_seq);
      } catch {
        /* falls through to the 400 below */
      }
      if (!Number.isInteger(through) || through < 0) return { name: "anchor", res: errorResponse(rt, 400, "invalid_request", "through_seq must be a non-negative integer") };
      return { name: "anchor", res: jsonResponse(rt, 200, rt.queue.ack(through)) };
    }

    return { name: "unknown", res: errorResponse(rt, 404, "not_found", "not found") };
  };

  return async (req) => {
    const started = Date.now();
    let name = "unknown";
    let res: Response;
    try {
      const out = await route(req, new URL(req.url));
      name = out.name;
      res = out.res;
    } catch (e) {
      rt.logger("error", "unhandled error", { error: e instanceof Error ? e.message : "unknown" });
      res = errorResponse(rt, 500, "internal_error", "internal error");
    }
    if (name !== "healthz") rt.logger("info", "request", { route: name, status: res.status, ms: Date.now() - started });
    return res;
  };
}

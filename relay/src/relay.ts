import { isOnionHost, type Gateway, type RelayConfig } from "./config.ts";
import { SocksError, createSocksFetch } from "./socks.ts";
import { RELAY_VERSION } from "./version.ts";

// The relay: it receives an encapsulated request from a client and forwards exactly those bytes to a gateway it was
// configured with, then returns the encapsulated response. It cannot read either. What it must not do is pass on
// anything that identifies the client, so the forwarded request is built from scratch (never from the incoming
// headers), and it keeps no per-client state and writes no log lines while handling requests: only counters.

/** How much larger than a request a response may be: the gateway adds padding, a nonce and a tag. */
const RESPONSE_SLACK = 64 * 1024;
const REQ = "message/ohttp-req";
const RES = "message/ohttp-res";

/** Reasons a request is refused before it is forwarded. A fixed list, so a counter never carries anything a client chose. */
export const REJECT_REASONS = ["method", "media_type", "gateway_unknown", "gateway_ambiguous", "empty_body", "body_too_large", "busy"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export class Counters {
  requests = 0;
  forwarded = 0;
  rejected: Record<RejectReason, number> = { method: 0, media_type: 0, gateway_unknown: 0, gateway_ambiguous: 0, empty_body: 0, body_too_large: 0, busy: 0 };
  /** Answers from the gateway by class. */
  gateway = { ok: 0, refused: 0, error: 0 };
  /** The gateway did not answer: timeouts, connection failures, and (for an onion gateway) the SOCKS5 proxy failing to reach it. */
  unreachable = { timeout: 0, network: 0, proxy: 0 };
  /** The gateway rejected the credential this relay presents. An operator problem; the client sees a 502. */
  credentialRejected = 0;
  bytesIn = 0;
  bytesOut = 0;
  inflight = 0;

  render(): string {
    const lines = [
      "# HELP relay_requests_total Requests received on the relay path.",
      "# TYPE relay_requests_total counter",
      `relay_requests_total ${this.requests}`,
      "# HELP relay_forwarded_total Requests accepted for forwarding to a gateway (whatever the gateway then answered).",
      "# TYPE relay_forwarded_total counter",
      `relay_forwarded_total ${this.forwarded}`,
      "# HELP relay_rejected_total Requests refused before forwarding, by reason.",
      "# TYPE relay_rejected_total counter",
      ...REJECT_REASONS.map((r) => `relay_rejected_total{reason="${r}"} ${this.rejected[r]}`),
      "# HELP relay_gateway_responses_total Answers from a gateway: ok (message/ohttp-res), refused (a status passed on) or error.",
      "# TYPE relay_gateway_responses_total counter",
      `relay_gateway_responses_total{class="ok"} ${this.gateway.ok}`,
      `relay_gateway_responses_total{class="refused"} ${this.gateway.refused}`,
      `relay_gateway_responses_total{class="error"} ${this.gateway.error}`,
      "# TYPE relay_gateway_unreachable_total counter",
      `relay_gateway_unreachable_total{kind="timeout"} ${this.unreachable.timeout}`,
      `relay_gateway_unreachable_total{kind="network"} ${this.unreachable.network}`,
      `relay_gateway_unreachable_total{kind="proxy"} ${this.unreachable.proxy}`,
      "# TYPE relay_gateway_credential_rejected_total counter",
      `relay_gateway_credential_rejected_total ${this.credentialRejected}`,
      "# TYPE relay_bytes_in_total counter",
      `relay_bytes_in_total ${this.bytesIn}`,
      "# TYPE relay_bytes_out_total counter",
      `relay_bytes_out_total ${this.bytesOut}`,
      "# TYPE relay_inflight gauge",
      `relay_inflight ${this.inflight}`,
    ];
    return lines.join("\n") + "\n";
  }
}

const mediaType = (v: string | null) => (v ?? "").split(";")[0].trim().toLowerCase();

/** At most `max` bytes of a body, or null when it is longer. Counts as it reads, so a lying length header does not help. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };

function reply(status: number, type: string, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code: status, type, message } }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra } });
}

/** The gateway a request names: its configured name or its exact URL. With one gateway configured, none needs naming. */
function chooseGateway(cfg: RelayConfig, wanted: string | null): Gateway | "unknown" | "ambiguous" {
  if (wanted === null || wanted === "") return cfg.gateways.length === 1 ? cfg.gateways[0] : "ambiguous";
  return cfg.gateways.find((g) => g.name === wanted || g.url === wanted) ?? "unknown";
}

export function createRelay(cfg: RelayConfig, fetchImpl: typeof fetch = fetch) {
  const counters = new Counters();
  // A gateway that is an onion service is reached through the SOCKS5 proxy (config.ts refuses one without a proxy).
  const socksFetch = cfg.socks5 ? createSocksFetch(cfg.socks5, { maxResponseBytes: cfg.maxBodyBytes + RESPONSE_SLACK }) : undefined;
  const onionGateways = new Set(cfg.gateways.filter((g) => isOnionHost(new URL(g.url).hostname)).map((g) => g.name));

  const reject = (reason: RejectReason, status: number, type: string, message: string) => {
    counters.rejected[reason]++;
    return reply(status, type, message);
  };

  async function relay(req: Request, url: URL): Promise<Response> {
    counters.requests++;
    if (mediaType(req.headers.get("content-type")) !== REQ) return reject("media_type", 415, "unsupported_media_type", `Expected content-type ${REQ}.`);
    const gateway = chooseGateway(cfg, url.searchParams.get("gateway"));
    // Only a gateway in the allow-list is ever contacted. The check happens before the body is read.
    if (gateway === "unknown") return reject("gateway_unknown", 403, "gateway_not_allowed", "This relay does not forward to that gateway.");
    if (gateway === "ambiguous") return reject("gateway_ambiguous", 400, "gateway_required", `This relay serves several gateways; name one with ?gateway=<name>: ${cfg.gateways.map((g) => g.name).join(", ")}.`);
    if (Number(req.headers.get("content-length") ?? 0) > cfg.maxBodyBytes) return reject("body_too_large", 413, "payload_too_large", "Request body is too large.");
    if (counters.inflight >= cfg.maxInflight) return reject("busy", 503, "busy", "The relay is at capacity. Try again shortly.");
    counters.inflight++;
    try {
      const body = await readCapped(req.body, cfg.maxBodyBytes);
      if (!body) return reject("body_too_large", 413, "payload_too_large", "Request body is too large.");
      if (!body.length) return reject("empty_body", 400, "empty_body", "An encapsulated request is required.");
      counters.bytesIn += body.length;
      counters.forwarded++;

      // The forwarded request is built from nothing but the configured pieces and the body: no header, address, cookie
      // or query string from the client's request is copied into it.
      const headers: Record<string, string> = { "content-type": REQ, accept: RES, "user-agent": `anyroute-ohttp-relay/${RELAY_VERSION}` };
      if (gateway.credential) headers.authorization = `Bearer ${gateway.credential}`;
      let res: Response;
      try {
        const signal = AbortSignal.any([req.signal, AbortSignal.timeout(cfg.timeoutMs)]);
        if (onionGateways.has(gateway.name) && socksFetch) res = await socksFetch(gateway.url, { method: "POST", headers, body, signal });
        else res = await fetchImpl(gateway.url, { method: "POST", headers, body, redirect: "manual", signal });
      } catch (e) {
        if ((e as Error)?.name === "TimeoutError") {
          counters.unreachable.timeout++;
          return reply(504, "gateway_timeout", "The gateway did not answer in time.");
        }
        if (req.signal.aborted) return new Response(null, { status: 499 });
        if (e instanceof SocksError) counters.unreachable.proxy++;
        else counters.unreachable.network++;
        return reply(502, "gateway_unreachable", "The gateway could not be reached.");
      }

      if (res.status === 200 && mediaType(res.headers.get("content-type")) === RES) {
        // A little more than the request limit: the gateway pads and wraps what it sends back.
        const out = await readCapped(res.body, cfg.maxBodyBytes + RESPONSE_SLACK).catch(() => null);
        if (!out) {
          counters.gateway.error++;
          return reply(502, "bad_gateway_response", "The gateway's response was too large or incomplete.");
        }
        counters.gateway.ok++;
        counters.bytesOut += out.length;
        return new Response(out as never, { status: 200, headers: { "content-type": RES, "cache-control": "no-store", ...CORS } });
      }
      await res.body?.cancel().catch(() => undefined);
      // The gateway refused before unwrapping the request (RFC 9458 section 5.2): stale key, size, rate limit. Pass the
      // status on so the client can react; never pass a body or header through.
      if (res.status === 401) {
        counters.credentialRejected++;
        counters.gateway.error++;
        return reply(502, "bad_gateway_response", "The gateway did not accept this relay.");
      }
      if ([400, 413, 415, 422, 429].includes(res.status)) {
        counters.gateway.refused++;
        const retry = res.status === 429 ? res.headers.get("retry-after") : null;
        return reply(res.status, "gateway_refused", "The gateway refused the request.", retry && /^\d{1,6}$/.test(retry) ? { "retry-after": retry } : {});
      }
      counters.gateway.error++;
      return reply(502, "bad_gateway_response", "The gateway returned an unexpected response.");
    } finally {
      counters.inflight--;
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === cfg.path) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method !== "POST") {
        counters.requests++;
        return reject("method", 405, "method_not_allowed", "Use POST.");
      }
      return relay(req, url);
    }
    if (url.pathname === "/healthz" && req.method === "GET") return new Response("ok\n", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    if (cfg.metrics && url.pathname === "/metrics" && req.method === "GET") return new Response(counters.render(), { headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } });
    return reply(404, "not_found", "Not found.");
  }

  return { handle, counters };
}

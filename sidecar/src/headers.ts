// What crosses the gateway. Requests are forwarded by allow-list, not by deny-list: only the headers named here
// (plus any the operator lists in upstream.forward_headers) reach the model server, so a proxy header nobody
// thought of cannot leak a client address. isNetworkIdentifierHeader is the second line: it is used to refuse
// such names in the configuration and by the tests.

export const SIDECAR_USER_AGENT = "anyroute-sidecar";

const EXACT = new Set([
  "forwarded",
  "forwarded-for",
  "via",
  "client-ip",
  "true-client-ip",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "x-originating-ip",
  "x-remote-ip",
  "x-remote-addr",
  "x-proxyuser-ip",
  "x-real-client-ip",
  "x-appengine-user-ip",
  "fastly-client-ip",
  "proxy-client-ip",
  "wl-proxy-client-ip",
  "do-connecting-ip",
  "x-forwarded",
]);
const PREFIXES = ["x-forwarded-", "cf-", "x-vercel-", "x-envoy-", "x-azure-", "fly-", "x-amzn-", "x-goog-", "x-cloud-trace", "x-ms-", "x-arr-", "x-geo-", "x-country", "x-city"];
const IP_TOKENS = new Set(["ip", "ipv4", "ipv6", "addr", "address", "ips", "geo", "country", "city"]);

/** True for headers that carry, or commonly carry, a client's network address or location. */
export function isNetworkIdentifierHeader(name: string): boolean {
  const n = name.toLowerCase().trim();
  if (EXACT.has(n)) return true;
  if (PREFIXES.some((p) => n.startsWith(p))) return true;
  return n.split("-").some((t) => IP_TOKENS.has(t));
}

/** Headers that are never forwarded whatever the configuration says. */
const NEVER = new Set(["host", "authorization", "proxy-authorization", "content-length", "connection", "transfer-encoding", "cookie", "set-cookie", "upgrade", "te", "trailer", "keep-alive"]);
export const isForbiddenForwardHeader = (name: string) => NEVER.has(name.toLowerCase()) || isNetworkIdentifierHeader(name);

export type UpstreamHeaderOptions = { forwardHeaders: string[]; upstreamApiKey?: string };

/** The complete header set sent to the model server. */
export function buildUpstreamHeaders(client: Headers, opts: UpstreamHeaderOptions): Headers {
  const out = new Headers();
  out.set("content-type", "application/json");
  out.set("accept-encoding", "identity");
  out.set("user-agent", SIDECAR_USER_AGENT);
  const accept = client.get("accept");
  if (accept && accept.length <= 200 && /^[\w*+.\-/;=,\s]+$/.test(accept)) out.set("accept", accept);
  if (opts.upstreamApiKey) out.set("authorization", `Bearer ${opts.upstreamApiKey}`);
  for (const name of opts.forwardHeaders) {
    if (isForbiddenForwardHeader(name)) continue;
    const v = client.get(name);
    if (v !== null) out.set(name, v);
  }
  return out;
}

/** Response headers copied from the model server. Everything else (server, date, cookies, ...) is dropped. */
const RESPONSE_ALLOW = ["content-type", "retry-after"];
export function pickResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const name of RESPONSE_ALLOW) {
    const v = upstream.get(name);
    if (v !== null) out.set(name, v);
  }
  return out;
}

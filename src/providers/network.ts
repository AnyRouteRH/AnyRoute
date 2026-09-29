import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { Readable } from "node:stream";
import { pinnedTlsOptions, type TlsPin } from "./tls-pin.ts";

/** Bound untrusted discovery/attestation JSON, including chunked responses. */
export async function boundedJson(response: Response, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Provider response exceeds the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider response is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Provider response exceeds the size limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Address = { address: string; family: number };
type NetworkPolicy = {
  production: boolean;
  allowDevelopmentMockLoopback?: boolean;
  allowDevelopmentLoopbackHostnames?: string[];
  resolve?: (hostname: string) => Promise<Address[]>;
  /** An attested provider's pinned certificate (providers/tls-pin.ts): the only certificate its connections accept. */
  tlsPin?: Pick<TlsPin, "certPem" | "spkiSha256"> | null;
};

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

function v4In(address: number, base: number, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

function isPublicIpv4(address: string) {
  const n = ipv4Number(address);
  if (n === null) return false;
  const blocked: [string, number][] = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, prefix]) => v4In(n, ipv4Number(base)!, prefix));
}

function ipv6Words(address: string): number[] | null {
  if (isIP(address) !== 6 || address.includes("%")) return null;
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const i = value.lastIndexOf(":");
    const v4 = ipv4Number(value.slice(i + 1));
    if (i < 0 || v4 === null) return null;
    value = `${value.slice(0, i)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").map((x) => Number.parseInt(x, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map((x) => Number.parseInt(x, 16)) : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (zeros < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const words = [...left, ...Array(zeros).fill(0), ...right];
  return words.length === 8 && words.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? words : null;
}

function ipv6Prefix(words: number[], prefix: number, expected: number[]) {
  const fullWords = Math.floor(prefix / 16);
  for (let i = 0; i < fullWords; i++) if (words[i] !== expected[i]) return false;
  const tail = prefix % 16;
  if (tail) {
    const mask = (0xffff << (16 - tail)) & 0xffff;
    return (words[fullWords] & mask) === (expected[fullWords] & mask);
  }
  return true;
}

function isPublicIpv6(address: string) {
  const words = ipv6Words(address);
  if (!words) return false;
  // Only global-unicast space is eligible. Reject special-use, documentation, and transition
  // ranges even though some of them sit inside 2000::/3.
  if (!ipv6Prefix(words, 3, [0x2000])) return false;
  return ![
    [32, [0x2001, 0x0db8]], // documentation
    [23, [0x2001]], // IETF special-purpose assignments
    [16, [0x2002]], // 6to4 embeds arbitrary IPv4 destinations
    [20, [0x3fff]], // documentation
  ].some(([prefix, base]) => ipv6Prefix(words, prefix as number, base as number[]));
}

export function isPublicAddress(address: string) {
  return isIP(address) === 4 ? isPublicIpv4(address) : isIP(address) === 6 ? isPublicIpv6(address) : false;
}

function resolveWithSignal(resolve: Promise<Address[]>, signal?: AbortSignal | null): Promise<Address[]> {
  if (!signal) return resolve;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  return new Promise((accept, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    resolve.then((value) => { cleanup(); accept(value); }, (error) => { cleanup(); reject(error); });
  });
}

function isLoopbackAddress(address: string) {
  return ipv4Number(address) !== null ? v4In(ipv4Number(address)!, ipv4Number("127.0.0.0")!, 8) : address.toLowerCase() === "::1";
}

function hostnameFrom(url: URL) {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}

/** Check a provider URL and resolve it to one reviewed address (public, or loopback for development mocks). */
async function resolveDestination(url: URL, policy: NetworkPolicy, signal?: AbortSignal | null) {
  const host = hostnameFrom(url);
  if (!(url.protocol === "https:" || (!policy.production && url.protocol === "http:")) || url.username || url.password || url.hash)
    throw new Error("Provider URL must use HTTPS in production and cannot contain credentials or a fragment.");
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  const literalFamily = isIP(host);
  const resolved = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await resolveWithSignal((policy.resolve ?? ((h) => lookup(h, { all: true, verbatim: true })))(host), signal);
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  if (!resolved.length) throw new Error("Provider hostname did not resolve.");
  const devLoopback = !policy.production && policy.allowDevelopmentMockLoopback === true &&
    (host === "localhost" || host === "localhost.localdomain" || policy.allowDevelopmentLoopbackHostnames?.includes(host) || (literalFamily > 0 && isLoopbackAddress(host)));
  if (devLoopback ? !resolved.every((x) => isLoopbackAddress(x.address)) : !resolved.every((x) => isPublicAddress(x.address)))
    throw new Error("Provider destination resolves to a non-public address.");
  return { host, literalFamily, pinned: resolved[0] };
}

/**
 * Read the certificate an https provider presents, without sending it anything: a TLS handshake to the same
 * reviewed address providerFetch would use, then close. The certificate is not trusted by this call; the attestor
 * decides whether to pin it (providers/tls-pin.ts).
 */
export async function peekProviderCertificate(input: string | URL, policy: NetworkPolicy, signal?: AbortSignal): Promise<Buffer> {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("Only https providers present a certificate.");
  const { host, literalFamily, pinned } = await resolveDestination(url, policy, signal);
  return await new Promise<Buffer>((resolve, reject) => {
    const socket = tlsConnect({
      host: pinned.address,
      port: Number(url.port || 443),
      ...(literalFamily === 0 ? { servername: host } : {}),
      // Nothing is sent over this connection; the certificate is only read.
      rejectUnauthorized: false,
    });
    const done = (err: Error | null, der?: Buffer) => {
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (err) reject(err);
      else resolve(der!);
    };
    const abort = () => done(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      done(raw && raw.length ? null : new Error("Provider presented no certificate."), raw ? Buffer.from(raw) : undefined);
    });
    socket.once("error", (e: Error) => done(e));
  });
}

/** Resolve and pin the actual socket to a reviewed public address. */
export async function providerFetch(input: string | URL, init: RequestInit = {}, policy: NetworkPolicy): Promise<Response> {
  const url = new URL(input);
  if (init.redirect && init.redirect !== "error") throw new Error("Provider redirects are disabled.");
  const { host, literalFamily, pinned } = await resolveDestination(url, policy, init.signal);
  if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  // Selecting one already-vetted answer and returning it from the request's lookup callback pins
  // the connection. The HTTP client cannot perform a second DNS lookup after the security check.
  const lookupPinned = (_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    if (options?.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  // Node's HTTP client does not transparently decode compressed responses like fetch does.
  // Request identity and fail closed if an upstream ignores it, so callers never parse raw bytes.
  headers["accept-encoding"] = "identity";
  const requestOptions = {
    method: init.method ?? "GET",
    headers,
    signal: init.signal ?? undefined,
    lookup: lookupPinned,
    ...(url.protocol === "https:" && literalFamily === 0 ? { servername: host } : {}),
    // An attested provider's connections accept exactly its pinned certificate (see providers/tls-pin.ts).
    ...(url.protocol === "https:" && policy.tlsPin ? { ...pinnedTlsOptions(policy.tlsPin), agent: false } : {}),
  };
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && !(body instanceof URLSearchParams))
    throw new Error("Provider request body type is not supported.");

  return await new Promise<Response>((resolve, reject) => {
    const req = request(url, requestOptions, (res) => {
      // Readable.toWeb forwards cancellation to the IncomingMessage, which destroys its socket;
      // errors discovered after headers must also tear down the request side immediately.
      res.once("error", () => req.destroy());
      const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
      if (encoding && encoding !== "identity") {
        const error = new Error(`Provider sent ${encoding} despite Accept-Encoding: identity.`);
        res.destroy(error);
        req.destroy(error);
        reject(error);
        return;
      }
      const status = res.statusCode ?? 502;
      const responseBody = status === 204 || status === 304 ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>;
      resolve(new Response(responseBody, { status, statusText: res.statusMessage, headers: new Headers(res.headers as unknown as ConstructorParameters<typeof Headers>[0]) }));
    });
    req.once("error", reject);
    if (body instanceof ArrayBuffer) req.end(Buffer.from(body));
    else if (body instanceof Uint8Array) req.end(Buffer.from(body));
    else req.end(body == null ? undefined : body.toString());
  });
}

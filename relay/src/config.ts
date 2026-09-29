import { readFileSync } from "node:fs";
import type { SocksProxy } from "./socks.ts";

// Relay configuration comes from the environment. The one thing that matters for privacy is the gateway allow-list:
// the relay forwards to these URLs and to nothing else, whatever a client asks for.

export type Gateway = {
  /** Short name a client can pass as ?gateway=<name>. */
  name: string;
  /** The gateway resource URL requests are forwarded to. */
  url: string;
  /** `<key_id>:<secret>`, sent to the gateway as `Authorization: Bearer <credential>` so it can tell relay traffic from direct traffic. Never logged. */
  credential?: string;
};

export type RelayConfig = {
  /** A SOCKS5 proxy (a local Tor client) that gateways which are onion services are reached through. */
  socks5?: SocksProxy;
  host: string;
  port: number;
  /** The one path that accepts message/ohttp-req. */
  path: string;
  gateways: Gateway[];
  /** Largest encapsulated request, and largest response, the relay will carry. */
  maxBodyBytes: number;
  /** Time allowed for the gateway to answer (LLM responses are slow). */
  timeoutMs: number;
  /** Requests being forwarded at once; beyond this the relay answers 503 instead of queueing. */
  maxInflight: number;
  metrics: boolean;
  /** Also carry chunked Oblivious HTTP (message/ohttp-chunked-req and -res), passing the response on as it arrives. Off by default. */
  chunked: boolean;
  tls?: { certFile: string; keyFile: string };
};

export class ConfigError extends Error {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A version 3 onion service name: 56 base32 characters. (A gateway is never a subdomain of one.) */
export const isOnionHost = (hostname: string) => /^[a-z2-7]{56}\.onion$/.test(hostname);

function flag(env: Record<string, string | undefined>, name: string): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new ConfigError(`${name} must be true or false.`);
}

function int(env: Record<string, string | undefined>, name: string, dflt: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

/** RELAY_SOCKS5_PROXY: socks5h://[user:password@]host:port. The name of a target is always sent to the proxy, never resolved here, so socks5:// means the same. */
function parseSocks(raw: string): SocksProxy {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError("RELAY_SOCKS5_PROXY must look like socks5h://127.0.0.1:9050.");
  }
  if (u.protocol !== "socks5h:" && u.protocol !== "socks5:") throw new ConfigError("RELAY_SOCKS5_PROXY must be a socks5h:// (or socks5://) URL.");
  if (!u.hostname || !u.port || (u.pathname !== "" && u.pathname !== "/") || u.search || u.hash) throw new ConfigError("RELAY_SOCKS5_PROXY must be socks5h://[user:password@]host:port, with a port and nothing after it.");
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("RELAY_SOCKS5_PROXY has an invalid port.");
  // The URL parser keeps brackets on an IPv6 host; a socket wants it bare.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const username = u.username ? decodeURIComponent(u.username) : undefined;
  const password = u.password ? decodeURIComponent(u.password) : undefined;
  if (password !== undefined && username === undefined) throw new ConfigError("RELAY_SOCKS5_PROXY has a password without a user name.");
  if ((username && Buffer.byteLength(username) > 255) || (password && Buffer.byteLength(password) > 255)) throw new ConfigError("RELAY_SOCKS5_PROXY credentials are longer than SOCKS5 allows (255 bytes each).");
  return { host, port, ...(username !== undefined ? { username, ...(password !== undefined ? { password } : {}) } : {}) };
}

function parseGateways(raw: string, source: string, socks: SocksProxy | undefined): Gateway[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${source} must be a JSON array of {name, url, credential?}.`);
  }
  if (!Array.isArray(json) || json.length < 1 || json.length > 20) throw new ConfigError(`${source} must list 1 to 20 gateways.`);
  const out: Gateway[] = [];
  for (const [i, g] of json.entries()) {
    if (!g || typeof g !== "object") throw new ConfigError(`${source}[${i}] must be an object.`);
    const { name, url, credential, ...rest } = g as Record<string, unknown>;
    if (Object.keys(rest).length) throw new ConfigError(`${source}[${i}] has unknown fields: ${Object.keys(rest).join(", ")}.`);
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new ConfigError(`${source}[${i}].name must be 1 to 64 letters, digits, dots, dashes or underscores.`);
    if (typeof url !== "string") throw new ConfigError(`${source}[${i}].url is required.`);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ConfigError(`${source}[${i}].url is not a URL.`);
    }
    if (u.hostname.endsWith(".onion")) {
      // An onion service authenticates and encrypts the connection itself, so it is reached over plain http, through the proxy.
      if (!isOnionHost(u.hostname)) throw new ConfigError(`${source}[${i}].url is not a version 3 onion address.`);
      if (u.protocol !== "http:") throw new ConfigError(`${source}[${i}].url must be http:// for an onion service (the onion connection is already encrypted end to end).`);
      if (!socks) throw new ConfigError(`${source}[${i}].url is an onion service: set RELAY_SOCKS5_PROXY to a Tor client, for example socks5h://127.0.0.1:9050.`);
    } else if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
      // A relay carries traffic between strangers and a gateway: plain HTTP is only for a gateway on this machine.
      throw new ConfigError(`${source}[${i}].url must be https (http is only accepted for localhost and onion services).`);
    }
    if (u.username || u.password || u.hash || u.search) throw new ConfigError(`${source}[${i}].url must not carry credentials, a query or a fragment.`);
    if (credential !== undefined && (typeof credential !== "string" || !/^[A-Za-z0-9._-]{1,64}:[\x21-\x7e]{1,256}$/.test(credential))) throw new ConfigError(`${source}[${i}].credential must be <key_id>:<secret>, the key_id from the gateway operator's relay list and a secret of printable characters without spaces.`);
    out.push({ name, url: u.toString(), ...(credential ? { credential } : {}) });
  }
  if (new Set(out.map((g) => g.name)).size !== out.length) throw new ConfigError(`${source}: gateway names must be unique.`);
  if (new Set(out.map((g) => g.url)).size !== out.length) throw new ConfigError(`${source}: gateway URLs must be unique.`);
  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const inline = env.RELAY_GATEWAYS;
  const file = env.RELAY_GATEWAYS_FILE;
  if (inline && file) throw new ConfigError("Set RELAY_GATEWAYS or RELAY_GATEWAYS_FILE, not both.");
  if (!inline && !file) throw new ConfigError("RELAY_GATEWAYS (or RELAY_GATEWAYS_FILE) is required: the relay forwards only to gateways you list.");
  const socks5 = env.RELAY_SOCKS5_PROXY ? parseSocks(env.RELAY_SOCKS5_PROXY) : undefined;
  const gateways = inline ? parseGateways(inline, "RELAY_GATEWAYS", socks5) : parseGateways(readFileSync(file!, "utf8"), "RELAY_GATEWAYS_FILE", socks5);
  const path = env.RELAY_PATH ?? "/relay";
  if (!/^\/[A-Za-z0-9._~/-]{1,200}$/.test(path) || path.includes("//") || path === "/healthz" || path === "/metrics") throw new ConfigError("RELAY_PATH must be a plain path such as /relay.");
  const certFile = env.RELAY_TLS_CERT_FILE;
  const keyFile = env.RELAY_TLS_KEY_FILE;
  if (!!certFile !== !!keyFile) throw new ConfigError("RELAY_TLS_CERT_FILE and RELAY_TLS_KEY_FILE go together.");
  return {
    ...(socks5 ? { socks5 } : {}),
    host: env.RELAY_HOST || "127.0.0.1",
    port: int(env, "RELAY_PORT", 8080, 0, 65535),
    path,
    gateways,
    maxBodyBytes: int(env, "RELAY_MAX_BODY_BYTES", 8 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    timeoutMs: int(env, "RELAY_TIMEOUT_MS", 120_000, 1000, 250_000),
    maxInflight: int(env, "RELAY_MAX_INFLIGHT", 256, 1, 100_000),
    metrics: (env.RELAY_METRICS ?? "true").toLowerCase() !== "false",
    chunked: flag(env, "RELAY_CHUNKED_ENABLED"),
    ...(certFile && keyFile ? { tls: { certFile, keyFile } } : {}),
  };
}

import { readFileSync } from "node:fs";

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
  tls?: { certFile: string; keyFile: string };
};

export class ConfigError extends Error {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function int(env: Record<string, string | undefined>, name: string, dflt: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

function parseGateways(raw: string, source: string): Gateway[] {
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
    // A relay carries traffic between strangers and a gateway: plain HTTP is only for a gateway on this machine.
    if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new ConfigError(`${source}[${i}].url must be https (http is only accepted for localhost).`);
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
  const gateways = inline ? parseGateways(inline, "RELAY_GATEWAYS") : parseGateways(readFileSync(file!, "utf8"), "RELAY_GATEWAYS_FILE");
  const path = env.RELAY_PATH ?? "/relay";
  if (!/^\/[A-Za-z0-9._~/-]{1,200}$/.test(path) || path.includes("//") || path === "/healthz" || path === "/metrics") throw new ConfigError("RELAY_PATH must be a plain path such as /relay.");
  const certFile = env.RELAY_TLS_CERT_FILE;
  const keyFile = env.RELAY_TLS_KEY_FILE;
  if (!!certFile !== !!keyFile) throw new ConfigError("RELAY_TLS_CERT_FILE and RELAY_TLS_KEY_FILE go together.");
  return {
    host: env.RELAY_HOST || "127.0.0.1",
    port: int(env, "RELAY_PORT", 8080, 0, 65535),
    path,
    gateways,
    maxBodyBytes: int(env, "RELAY_MAX_BODY_BYTES", 8 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    timeoutMs: int(env, "RELAY_TIMEOUT_MS", 120_000, 1000, 250_000),
    maxInflight: int(env, "RELAY_MAX_INFLIGHT", 256, 1, 100_000),
    metrics: (env.RELAY_METRICS ?? "true").toLowerCase() !== "false",
    ...(certFile && keyFile ? { tls: { certFile, keyFile } } : {}),
  };
}

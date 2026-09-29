import { existsSync, readFileSync } from "node:fs";
import type { AttestationKind } from "./attestation/types.ts";
import type { BucketConfig } from "./quota.ts";
import { isForbiddenForwardHeader } from "./headers.ts";
import { SidecarError } from "./util.ts";

// sidecar.yaml loader. Unknown keys are rejected so a typo in a security setting cannot silently do nothing.
// A handful of environment variables override the file (listed in README.md) so a container can start from
// environment alone.

export type KeyPolicy = { id: string; sha256: string; quota?: BucketConfig };

export type SidecarConfig = {
  server: { host: string; port: number; hostnames: string[]; tls: "self_signed" | "off"; certValidityDays: number };
  upstream: {
    baseUrl: string;
    /** Name of the environment variable that holds the upstream's own API key, if it needs one. */
    apiKeyEnv: string;
    timeoutMs: number;
    streamIdleTimeoutMs: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
    /** Extra request headers to forward. Network identifiers are refused here. */
    forwardHeaders: string[];
  };
  model: { path?: string; digest?: string; exclude: string[]; servedName?: string };
  allowlist: { modelDigests: string[]; modelDigestsFile?: string; composeHashes: string[]; composeHashesFile?: string };
  image: { digest?: string };
  compose: { file?: string; hash?: string };
  attestation: { provider: AttestationKind; dstackEndpoint?: string; tdxTsmPath?: string; freshQuotesPerMinute: number };
  router: { url?: string; providerId?: string; apiKeyEnv: string; failClosed: boolean };
  auth: { keys: KeyPolicy[]; allowAnonymous: boolean };
  quota: { default: BucketConfig; global: BucketConfig };
  classifier: { enabled: boolean };
  royalty: { recipient?: string };
  receipts: { queueCapacity: number };
  anchor: { tokenEnv: string };
};

type Obj = Record<string, unknown>;
const bad = (path: string, msg: string): never => {
  throw new SidecarError("BAD_CONFIG", `sidecar.yaml: ${path}: ${msg}`);
};

function obj(v: unknown, path: string): Obj {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return bad(path, "expected a mapping");
  return v as Obj;
}
function known(o: Obj, keys: string[], path: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${path}.${k}`, `unknown setting (expected one of: ${keys.join(", ")})`);
}
function str(o: Obj, k: string, path: string): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) return bad(`${path}.${k}`, "expected a non-empty string");
  return v.trim();
}
function num(o: Obj, k: string, path: string, min: number, max: number): number | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return bad(`${path}.${k}`, `expected a number between ${min} and ${max}`);
  return v;
}
function int(o: Obj, k: string, path: string, min: number, max: number): number | undefined {
  const v = num(o, k, path, min, max);
  if (v !== undefined && !Number.isInteger(v)) bad(`${path}.${k}`, "expected an integer");
  return v;
}
function bool(o: Obj, k: string, path: string): boolean | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") return bad(`${path}.${k}`, "expected true or false");
  return v;
}
function strList(o: Obj, k: string, path: string): string[] {
  const v = o[k];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) return bad(`${path}.${k}`, "expected a list of strings");
  return (v as string[]).map((x) => x.trim());
}

function bucket(raw: unknown, path: string): BucketConfig {
  const o = obj(raw, path);
  known(o, ["requests_per_minute", "burst", "tokens_per_minute", "token_burst"], path);
  return {
    requestsPerMinute: num(o, "requests_per_minute", path, 0.001, 1e9),
    burst: num(o, "burst", path, 1, 1e9),
    tokensPerMinute: num(o, "tokens_per_minute", path, 1, 1e12),
    tokenBurst: num(o, "token_burst", path, 1, 1e12),
  };
}

const PROVIDERS: AttestationKind[] = ["dstack", "tdx", "dev"];

export function parseConfig(raw: unknown, env: Record<string, string | undefined> = {}): SidecarConfig {
  const root = obj(raw, "(root)");
  known(root, ["server", "upstream", "model", "allowlist", "image_digest", "compose", "attestation", "router", "auth", "quota", "classifier", "royalty", "receipts", "anchor"], "");

  const server = obj(root.server, "server");
  known(server, ["host", "port", "hostnames", "tls", "cert_validity_days"], "server");
  const up = obj(root.upstream, "upstream");
  known(up, ["base_url", "api_key_env", "timeout_ms", "stream_idle_timeout_ms", "max_request_bytes", "max_response_bytes", "forward_headers"], "upstream");
  const model = obj(root.model, "model");
  known(model, ["path", "digest", "exclude", "served_name"], "model");
  const allow = obj(root.allowlist, "allowlist");
  known(allow, ["model_digests", "model_digests_file", "compose_hashes", "compose_hashes_file"], "allowlist");
  const compose = obj(root.compose, "compose");
  known(compose, ["file", "hash"], "compose");
  const att = obj(root.attestation, "attestation");
  known(att, ["provider", "dstack", "tdx", "fresh_quotes_per_minute"], "attestation");
  const dstack = obj(att.dstack, "attestation.dstack");
  known(dstack, ["endpoint"], "attestation.dstack");
  const tdx = obj(att.tdx, "attestation.tdx");
  known(tdx, ["tsm_path"], "attestation.tdx");
  const router = obj(root.router, "router");
  known(router, ["url", "provider_id", "api_key_env", "fail_closed"], "router");
  const auth = obj(root.auth, "auth");
  known(auth, ["keys", "allow_anonymous"], "auth");
  const quota = obj(root.quota, "quota");
  known(quota, ["default", "global"], "quota");
  const classifier = obj(root.classifier, "classifier");
  known(classifier, ["enabled"], "classifier");
  const royalty = obj(root.royalty, "royalty");
  known(royalty, ["recipient"], "royalty");
  const receipts = obj(root.receipts, "receipts");
  known(receipts, ["queue_capacity"], "receipts");
  const anchor = obj(root.anchor, "anchor");
  known(anchor, ["token_env"], "anchor");

  const provider = (env.SIDECAR_ATTESTATION ?? str(att, "provider", "attestation") ?? "dstack") as AttestationKind;
  if (!PROVIDERS.includes(provider)) bad("attestation.provider", `expected one of ${PROVIDERS.join(", ")}`);

  const keysRaw = auth.keys;
  if (keysRaw !== undefined && keysRaw !== null && !Array.isArray(keysRaw)) bad("auth.keys", "expected a list");
  const keys: KeyPolicy[] = ((keysRaw as unknown[]) ?? []).map((k, i) => {
    const p = `auth.keys[${i}]`;
    const o = obj(k, p);
    known(o, ["id", "sha256", "quota"], p);
    const id = str(o, "id", p) ?? bad(p, "id is required");
    const sha = (str(o, "sha256", p) ?? bad(p, "sha256 is required (the hex SHA-256 of the API key)")).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) bad(`${p}.sha256`, "expected 64 hex characters");
    return { id, sha256: sha, quota: o.quota === undefined ? undefined : bucket(o.quota, `${p}.quota`) };
  });
  const ids = new Set<string>();
  for (const k of keys) {
    if (ids.has(k.id)) bad("auth.keys", `duplicate id "${k.id}"`);
    ids.add(k.id);
  }

  const forwardHeaders = strList(up, "forward_headers", "upstream").map((h) => h.toLowerCase());
  for (const h of forwardHeaders) {
    if (isForbiddenForwardHeader(h)) bad("upstream.forward_headers", `"${h}" can never be forwarded`);
  }

  const tlsMode = str(server, "tls", "server") ?? "self_signed";
  if (tlsMode !== "self_signed" && tlsMode !== "off") bad("server.tls", 'expected "self_signed" or "off"');

  const recipient = str(royalty, "recipient", "royalty");
  if (recipient && !/^0x[0-9a-fA-F]{40}$/.test(recipient)) bad("royalty.recipient", "expected a 0x-prefixed 20-byte address");

  const routerUrl = str(router, "url", "router");
  const routerProvider = str(router, "provider_id", "router");
  if (Boolean(routerUrl) !== Boolean(routerProvider)) bad("router", "url and provider_id must be set together");

  const envPort = env.SIDECAR_PORT ? Number(env.SIDECAR_PORT) : undefined;
  if (envPort !== undefined && (!Number.isInteger(envPort) || envPort < 0 || envPort > 65535)) bad("SIDECAR_PORT", "expected a port number");

  const baseUrl = (env.SIDECAR_UPSTREAM_URL ?? str(up, "base_url", "upstream") ?? "http://127.0.0.1:8000").replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    if (u.username || u.password || u.search || u.hash) throw new Error("parts");
  } catch {
    bad("upstream.base_url", "expected an http(s) URL without credentials, query or fragment");
  }
  if (keys.length === 0 && !(bool(auth, "allow_anonymous", "auth") ?? false)) {
    bad("auth.keys", "no API keys are configured; list keys (with the SHA-256 of each) or set auth.allow_anonymous: true to serve without authentication");
  }

  const cfg: SidecarConfig = {
    server: {
      host: env.SIDECAR_HOST ?? str(server, "host", "server") ?? "0.0.0.0",
      port: envPort ?? int(server, "port", "server", 0, 65535) ?? 8443,
      hostnames: strList(server, "hostnames", "server"),
      tls: tlsMode as "self_signed" | "off",
      certValidityDays: int(server, "cert_validity_days", "server", 1, 800) ?? 90,
    },
    upstream: {
      baseUrl,
      apiKeyEnv: str(up, "api_key_env", "upstream") ?? "SIDECAR_UPSTREAM_API_KEY",
      timeoutMs: int(up, "timeout_ms", "upstream", 1000, 3_600_000) ?? 600_000,
      streamIdleTimeoutMs: int(up, "stream_idle_timeout_ms", "upstream", 1000, 3_600_000) ?? 120_000,
      maxRequestBytes: int(up, "max_request_bytes", "upstream", 1024, 1 << 30) ?? 8 * 1024 * 1024,
      maxResponseBytes: int(up, "max_response_bytes", "upstream", 1024, 1 << 30) ?? 64 * 1024 * 1024,
      forwardHeaders,
    },
    model: {
      path: env.SIDECAR_MODEL_PATH ?? str(model, "path", "model"),
      digest: env.SIDECAR_MODEL_DIGEST ?? str(model, "digest", "model"),
      exclude: strList(model, "exclude", "model"),
      servedName: str(model, "served_name", "model"),
    },
    allowlist: {
      modelDigests: strList(allow, "model_digests", "allowlist"),
      modelDigestsFile: str(allow, "model_digests_file", "allowlist"),
      composeHashes: strList(allow, "compose_hashes", "allowlist"),
      composeHashesFile: str(allow, "compose_hashes_file", "allowlist"),
    },
    image: { digest: env.SIDECAR_IMAGE_DIGEST ?? str(root, "image_digest", "") },
    compose: { file: env.SIDECAR_COMPOSE_FILE ?? str(compose, "file", "compose"), hash: env.SIDECAR_COMPOSE_HASH ?? str(compose, "hash", "compose") },
    attestation: {
      provider,
      dstackEndpoint: env.SIDECAR_DSTACK_ENDPOINT ?? str(dstack, "endpoint", "attestation.dstack"),
      tdxTsmPath: str(tdx, "tsm_path", "attestation.tdx"),
      freshQuotesPerMinute: int(att, "fresh_quotes_per_minute", "attestation", 1, 600) ?? 30,
    },
    router: { url: routerUrl, providerId: routerProvider, apiKeyEnv: str(router, "api_key_env", "router") ?? "SIDECAR_ROUTER_API_KEY", failClosed: bool(router, "fail_closed", "router") ?? true },
    auth: { keys, allowAnonymous: bool(auth, "allow_anonymous", "auth") ?? false },
    quota: { default: bucket(quota.default, "quota.default"), global: bucket(quota.global, "quota.global") },
    classifier: { enabled: bool(classifier, "enabled", "classifier") ?? false },
    royalty: { recipient },
    receipts: { queueCapacity: int(receipts, "queue_capacity", "receipts", 1, 10_000_000) ?? 100_000 },
    anchor: { tokenEnv: str(anchor, "token_env", "anchor") ?? "SIDECAR_ANCHOR_TOKEN" },
  };
  if (!cfg.model.path && !cfg.model.digest) bad("model", "set model.path (the weights directory to hash) or model.digest (a precomputed digest)");
  return cfg;
}

/** Read sidecar.yaml. A missing default file is fine (environment only); a missing explicit file is an error. */
export function loadConfig(env: Record<string, string | undefined> = process.env, explicitPath?: string): SidecarConfig {
  const path = explicitPath ?? env.SIDECAR_CONFIG;
  const file = path ?? "sidecar.yaml";
  let raw: unknown = {};
  if (existsSync(file)) {
    try {
      raw = Bun.YAML.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new SidecarError("BAD_CONFIG", `cannot parse ${file}: ${(e as Error).message}`);
    }
  } else if (path) {
    throw new SidecarError("BAD_CONFIG", `config file ${path} does not exist`);
  }
  return parseConfig(raw, env);
}

// What the generated deployments pin, taken from sidecar/examples/phala. A test keeps these equal to that example, so
// the wizard and the example cannot drift apart.

/** The image the sidecar process runs in. Also the value declared as `image_digest`. */
export const BUN_IMAGE = "oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
export const BUN_IMAGE_DIGEST = "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";

/** llama.cpp's OpenAI-compatible server (CPU). */
export const LLAMACPP_IMAGE = "ghcr.io/ggml-org/llama.cpp:server-b11243@sha256:f9115c95639e60abc09d4ea83b26fd4d56c66aa1174594393335a514da00c283";

/** The public repository the sidecar source is fetched from, and the commit the Phala example runs. */
export const DEFAULT_SIDECAR_REPO = "AnyRouteRH/AnyRoute";
export const DEFAULT_SIDECAR_COMMIT = "dcfc2deeacd8f3d89ea61d7e7045259e173e8050";
export const DEFAULT_SIDECAR_TARBALL_SHA256 = "5b297e38e0cbea6e7784e496458ca5b4b930cf2421094b282feeb3947f979027";

/**
 * The sidecar.yaml keys the default commit's loader accepts (its `known(...)` lists). The generated file uses only these,
 * so it loads on that commit as well as on the current source. Chosen newer commits accept a superset.
 */
export const DEFAULT_COMMIT_CONFIG_KEYS: Record<string, string[]> = {
  "": ["server", "upstream", "model", "allowlist", "image_digest", "compose", "attestation", "router", "auth", "quota", "classifier", "royalty", "receipts", "anchor"],
  server: ["host", "port", "hostnames", "tls", "cert_validity_days"],
  upstream: ["base_url", "api_key_env", "timeout_ms", "stream_idle_timeout_ms", "max_request_bytes", "max_response_bytes", "forward_headers"],
  model: ["path", "digest", "exclude", "served_name"],
  allowlist: ["model_digests", "model_digests_file", "compose_hashes", "compose_hashes_file"],
  compose: ["file", "hash"],
  attestation: ["provider", "dstack", "tdx", "fresh_quotes_per_minute"],
  auth: ["keys", "allow_anonymous"],
  quota: ["default", "global"],
  royalty: ["recipient"],
  receipts: ["queue_capacity"],
};

export const SIDECAR_PORT = 8443;
export const GATEWAY_HOSTNAME = "${DSTACK_APP_ID}-8443s.${DSTACK_GATEWAY_DOMAIN}";

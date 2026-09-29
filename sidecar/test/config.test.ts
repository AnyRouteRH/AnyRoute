import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../src/config.ts";
import { sha256Hex } from "../src/util.ts";
import { cleanup, tmpDir, writeFiles } from "./helpers.ts";

afterEach(cleanup);

const minimal = { model: { digest: `sha256:${"aa".repeat(32)}` }, auth: { allow_anonymous: true } };
const codeAndMsg = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return `${(e as { code: string }).code}: ${(e as Error).message}`;
  }
  return "";
};

describe("sidecar.yaml", () => {
  test("defaults are safe", () => {
    const c = parseConfig(minimal);
    expect(c.server.tls).toBe("self_signed");
    expect(c.server.port).toBe(8443);
    expect(c.attestation.provider).toBe("dstack");
    expect(c.classifier.enabled).toBe(false);
    expect(c.upstream.baseUrl).toBe("http://127.0.0.1:8000");
    expect(c.router.failClosed).toBe(true);
    expect(c.upstream.forwardHeaders).toEqual([]);
  });

  test("unknown keys are rejected at every level", () => {
    expect(codeAndMsg(() => parseConfig({ ...minimal, srver: {} }))).toContain("BAD_CONFIG");
    expect(codeAndMsg(() => parseConfig({ ...minimal, server: { prot: 1 } }))).toContain("server.prot");
    expect(codeAndMsg(() => parseConfig({ ...minimal, quota: { default: { requests_per_min: 1 } } }))).toContain("quota.default.requests_per_min");
  });

  test("a model is required, and either a path or a digest is enough", () => {
    expect(codeAndMsg(() => parseConfig({ auth: { allow_anonymous: true } }))).toContain("model");
    expect(parseConfig({ model: { path: "/models/x" }, auth: { allow_anonymous: true } }).model.path).toBe("/models/x");
  });

  test("serving without keys needs an explicit opt-in", () => {
    expect(codeAndMsg(() => parseConfig({ model: { digest: `sha256:${"aa".repeat(32)}` } }))).toContain("allow_anonymous");
    const keyed = parseConfig({ model: { digest: `sha256:${"aa".repeat(32)}` }, auth: { keys: [{ id: "a", sha256: sha256Hex("k"), quota: { requests_per_minute: 5, burst: 2 } }] } });
    expect(keyed.auth.keys[0].quota?.requestsPerMinute).toBe(5);
    expect(keyed.auth.allowAnonymous).toBe(false);
  });

  test("keys must be well formed and unique", () => {
    const m = { digest: `sha256:${"aa".repeat(32)}` };
    expect(codeAndMsg(() => parseConfig({ model: m, auth: { keys: [{ id: "a", sha256: "abc" }] } }))).toContain("64 hex");
    expect(codeAndMsg(() => parseConfig({ model: m, auth: { keys: [{ sha256: sha256Hex("k") }] } }))).toContain("id is required");
    const k = { id: "a", sha256: sha256Hex("k") };
    expect(codeAndMsg(() => parseConfig({ model: m, auth: { keys: [k, k] } }))).toContain("duplicate");
  });

  test("network identifiers and credentials can never be forwarded", () => {
    for (const h of ["x-forwarded-for", "X-Real-IP", "cf-connecting-ip", "forwarded", "via", "authorization", "cookie", "host", "x-client-ip"]) {
      expect(codeAndMsg(() => parseConfig({ ...minimal, upstream: { forward_headers: [h] } }))).toContain("can never be forwarded");
    }
    expect(parseConfig({ ...minimal, upstream: { forward_headers: ["X-Request-Tag"] } }).upstream.forwardHeaders).toEqual(["x-request-tag"]);
  });

  test("the upstream URL is validated and a trailing /v1 is dropped", () => {
    expect(parseConfig({ ...minimal, upstream: { base_url: "http://vllm:8000/v1/" } }).upstream.baseUrl).toBe("http://vllm:8000");
    expect(codeAndMsg(() => parseConfig({ ...minimal, upstream: { base_url: "ftp://x" } }))).toContain("upstream.base_url");
    expect(codeAndMsg(() => parseConfig({ ...minimal, upstream: { base_url: "http://u:p@x" } }))).toContain("upstream.base_url");
  });

  test("environment variables override the file", () => {
    const c = parseConfig(minimal, { SIDECAR_PORT: "9000", SIDECAR_UPSTREAM_URL: "http://vllm:8000", SIDECAR_ATTESTATION: "tdx", SIDECAR_MODEL_DIGEST: `sha256:${"bb".repeat(32)}` });
    expect(c.server.port).toBe(9000);
    expect(c.upstream.baseUrl).toBe("http://vllm:8000");
    expect(c.attestation.provider).toBe("tdx");
    expect(c.model.digest).toBe(`sha256:${"bb".repeat(32)}`);
    expect(codeAndMsg(() => parseConfig(minimal, { SIDECAR_ATTESTATION: "sgx" }))).toContain("attestation.provider");
    expect(codeAndMsg(() => parseConfig(minimal, { SIDECAR_PORT: "70000" }))).toContain("SIDECAR_PORT");
  });

  test("royalty recipient must be an address; router url and provider go together", () => {
    expect(codeAndMsg(() => parseConfig({ ...minimal, royalty: { recipient: "0x1234" } }))).toContain("royalty.recipient");
    expect(codeAndMsg(() => parseConfig({ ...minimal, router: { url: "https://r.example" } }))).toContain("provider_id");
  });

  test("loads YAML from disk; a missing explicit file is an error", () => {
    const dir = tmpDir();
    writeFiles(dir, {
      "sidecar.yaml": `
server:
  port: 9443
  tls: "off"
model:
  path: /models/tiny
allowlist:
  model_digests:
    - sha256:${"aa".repeat(32)}
auth:
  allow_anonymous: true
quota:
  default:
    requests_per_minute: 60
    burst: 10
`,
    });
    const c = loadConfig({}, join(dir, "sidecar.yaml"));
    expect(c.server.port).toBe(9443);
    expect(c.server.tls).toBe("off");
    expect(c.quota.default.burst).toBe(10);
    expect(c.allowlist.modelDigests).toHaveLength(1);
    expect(codeAndMsg(() => loadConfig({}, join(dir, "missing.yaml")))).toContain("does not exist");
    writeFiles(dir, { "bad.yaml": "server: [unclosed" });
    expect(codeAndMsg(() => loadConfig({}, join(dir, "bad.yaml")))).toContain("BAD_CONFIG");
  });
});

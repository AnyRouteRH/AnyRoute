import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { siteCsp, zkapiCsp } from "../src/lib/csp.ts";
import { startRouter } from "./helpers.ts";

const origins = ["https://operator.example", "https://gateway.example:8443"];
const root = mkdtempSync(join(tmpdir(), "anyroute-zkapi-hosting-"));
mkdirSync(join(root, "zkapi"));
const html = '<html><body><script>self.site=1</script></body></html>';
for (const path of ["index.html", "other.html", "zkapi.html", "zkapi/index.html", "zkapi/other.html"]) writeFileSync(join(root, path), html);
writeFileSync(join(root, "zkapi/prover-worker.js"), "export {};");
writeFileSync(join(root, "zkapi/zkapi_browser.js"), "export {};");
writeFileSync(join(root, "zkapi/zkapi_browser_bg.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
afterAll(() => rmSync(root, { recursive: true }));
const base = siteCsp(root);
const pagePaths = ["/zkapi", "/zkapi/", "/zkapi/index.html", "/zkapi.html"];
const workerPolicy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' " + origins.join(" ");

test("ZKAPI_PAGE_ORIGINS defaults empty and accepts exact HTTPS origins", () => {
  expect(loadConfig({ ZKAPI_PAGE_ORIGINS: undefined }).zkapiPageOrigins).toEqual([]);
  expect(loadConfig({ ZKAPI_PAGE_ORIGINS: "" }).zkapiPageOrigins).toEqual([]);
  expect(loadConfig({ ZKAPI_PAGE_ORIGINS: "https://operator.example, https://gateway.example:8443,https://operator.example" }).zkapiPageOrigins).toEqual(origins);
  expect(loadConfig({ ZKAPI_PAGE_ORIGINS: "https://[2001:db8::1]:8443,https://operator.example:443" }).zkapiPageOrigins).toEqual(["https://[2001:db8::1]:8443", "https://operator.example:443"]);
});

test("ZKAPI_PAGE_ORIGINS rejects non-origins and CSP injection with a named config error", () => {
  for (const value of ["http://operator.example", "wss://operator.example", "https://operator.example/", "https://operator.example/config.json", "https://operator.example?x=1", "https://operator.example#x", "https://user:password@operator.example", "https://@operator.example", "https://*.example", "https:", "*", "https://operator.example:65536", "https://operator.example:", "https://operator.example;script-src", "https://operator.example'", "https://operator.example\\path", "https://operator.example\nscript-src", "https://operator.example,", ",https://operator.example", " ", "https://operator..example", "https://%6fperator.example"]) {
    expect(() => loadConfig({ ZKAPI_PAGE_ORIGINS: value })).toThrow(/Invalid configuration: ZKAPI_PAGE_ORIGINS:.*exact https origins/);
  }
});

test("the real config loader accepts enabled hosting under production guards", () => {
  const address = "0x" + "1".repeat(40);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), ZKAPI_PAGE_ORIGINS: origins.join(",") });
  expect(cfg.production).toBe(true);
  expect(cfg.zkapiPageOrigins).toEqual(origins);
});

test("pure CSP selection changes only exact page and worker paths when configured", () => {
  const page = base.replace("connect-src 'self'", "connect-src 'self' " + origins.join(" ")) + "; worker-src 'self'";
  for (const path of pagePaths) expect(zkapiCsp(path, base, origins)).toBe(page);
  expect(zkapiCsp("/zkapi/prover-worker.js", base, origins)).toBe(workerPolicy);
  for (const path of ["/", "/other.html", "/zkapi/other.html", "/zkapi/zkapi_browser.js", "/zkapi/prover-worker.js/", "/zkapi/index.html/", "/zkapi/other/index.html"]) expect(zkapiCsp(path, base, origins)).toBeUndefined();
  for (const path of [...pagePaths, "/zkapi/prover-worker.js", "/"]) expect(zkapiCsp(path, base, []) ?? base).toBe(base);
  for (const policy of [page, workerPolicy]) {
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/blob:|data:|\*/);
  }
});

for (const enabled of [false, true]) test(`router static headers and MIME with ZKAPI hosting ${enabled ? "enabled" : "unset"}`, async () => {
  const router = await startRouter({ providers: [], env: { WEB_DIR: root, ZKAPI_PAGE_ORIGINS: enabled ? origins.join(",") : "" } });
  try {
    for (const path of pagePaths) {
      const response = await router.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(zkapiCsp(path, base, enabled ? origins : []) ?? base);
    }
    for (const path of ["/", "/other.html", "/zkapi/other.html"]) {
      const response = await router.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(base);
    }
    for (const path of ["/zkapi/prover-worker.js", "/zkapi/zkapi_browser.js"]) {
      const response = await router.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")?.split(";")[0]).toBe("text/javascript");
      expect(response.headers.get("content-security-policy")).toBe(enabled && path.endsWith("prover-worker.js") ? workerPolicy : null);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const wasm = await router.request("/zkapi/zkapi_browser_bg.wasm");
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(wasm.headers.get("content-security-policy")).toBeNull();
  } finally {
    await router.close();
  }
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { providers } from "../src/db/schema.ts";
import { providerApplication } from "../src/providers/application.ts";
import { buildApplication, submitApplication } from "../sidecar/src/onboard/apply.ts";
import type { Manifest } from "../sidecar/src/onboard/state.ts";

// The application the onboarding CLI (sidecar/src/onboard) builds is checked against the router's own schema and filed
// with a real router, so the two cannot drift apart without a failing test.

const manifest = (over: Partial<Manifest["provider"]> = {}): Manifest => ({
  v: 1,
  type: "anyroute.provider.onboarding",
  sidecar_cli_version: "0.1.0",
  target: "phala-gpu",
  server: "vllm",
  provider: { id: "onboard-demo", name: "Onboard Demo", datacenters: ["US"], data_policy: { training: false, retains_prompts: false, retention_days: 0 }, ...over },
  model: { served_name: "demo", digest: "sha256:" + "11".repeat(32), files: 1, bytes: 1, weights_path: "/w", exclude: [] },
  sidecar: { repo: "Org/Repo", commit: "a".repeat(40), tarball_sha256: "b".repeat(64), runtime_image_digest: "sha256:" + "c".repeat(64) },
  model_image: "x@sha256:" + "d".repeat(64),
  compose_sha256: "e".repeat(64),
  router_key_sha256: "f".repeat(64),
});

describe("the provider application from the onboarding CLI", () => {
  let h: Harness;
  let dir: string;
  let keyPath: string;
  beforeAll(async () => {
    h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama] }] });
    dir = mkdtempSync(join(tmpdir(), "onboard-"));
    keyPath = join(dir, "router-api-key");
    writeFileSync(keyPath, "9a".repeat(32) + "\n");
  });
  afterAll(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The CLI talks to a router through fetch; this one goes straight into the test router.
  const viaRouter = (async (url: string, init: RequestInit) => h.request(new URL(String(url)).pathname, { method: init.method, headers: init.headers, body: init.body as string })) as unknown as typeof fetch;

  test("passes the router's schema, with and without the key, with and without the optional fields", () => {
    for (const includeKey of [false, true]) {
      const a = buildApplication(manifest(), { url: "https://abc-8443s.gw.example", includeKey, keyPath });
      expect(providerApplication.parse(a)).toMatchObject({ id: "onboard-demo", tee: { kind: "tdx" } });
      expect(a.api_key !== undefined).toBe(includeKey);
    }
    const full = buildApplication(manifest({ contact: "ops@example.org", payout_address: "0x" + "12".repeat(20), data_policy: { training: false, retains_prompts: true, retention_days: 30 } }), { url: "https://host.example/v1" });
    expect(providerApplication.parse(full)).toMatchObject({ contact: "ops@example.org", payout_address: "0x" + "12".repeat(20) });
    expect(full.base_url).toBe("https://host.example/v1");
    expect(full.tee.attestation_url).toBe("https://host.example/attest");
  });

  test("the router files it as a pending application and the key stays out unless it was included", async () => {
    const res = await submitApplication("http://localhost:1", buildApplication(manifest(), { url: "https://abc-8443s.gw.example" }), viaRouter);
    expect(res).toMatchObject({ id: "onboard-demo", status: "applied" });
    expect(res.application_token).toBeTruthy();
    const [row] = await h.ctx.db.select().from(providers).where(eq(providers.id, "onboard-demo"));
    expect(row).toMatchObject({ status: "applied", teeKind: "tdx", attestationUrl: "https://abc-8443s.gw.example/attest", baseUrl: "https://abc-8443s.gw.example/v1", apiKeyEnc: null });
    // pending applications are not public
    const listed = ((await (await h.request("/api/v1/providers")).json()) as { data: { slug: string }[] }).data;
    expect(listed.map((p) => p.slug)).not.toContain("onboard-demo");
  });

  test("with the key included it is stored encrypted, never in the clear", async () => {
    await submitApplication("http://localhost:1", buildApplication(manifest({ id: "onboard-keyed" }), { url: "https://k-8443s.gw.example", includeKey: true, keyPath }), viaRouter);
    const [row] = await h.ctx.db.select().from(providers).where(eq(providers.id, "onboard-keyed"));
    expect(row.apiKeyEnc).toBeTruthy();
    expect(row.apiKeyEnc).not.toContain("9a9a");
  });

  test("filing the same id twice is refused by the router and the reason comes back", async () => {
    await expect(submitApplication("http://localhost:1", buildApplication(manifest(), { url: "https://abc-8443s.gw.example" }), viaRouter)).rejects.toThrow(/409.*Application token required|409.*already registered/);
  });

  test("things the router would refuse are refused before anything is sent", () => {
    expect(() => buildApplication(manifest({ id: "Bad_ID" }), { url: "https://a.example" })).toThrow(/providerId|use 2 to 41/);
    expect(() => buildApplication(manifest(), { url: "http://a.example" })).toThrow(/https/);
    expect(() => buildApplication(manifest({ payout_address: "0x12" }), { url: "https://a.example" })).toThrow(/address/);
  });
});

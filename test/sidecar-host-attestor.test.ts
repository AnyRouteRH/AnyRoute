import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { attestProvider } from "../src/services/attestor.ts";
import { providers } from "../src/db/schema.ts";
import { checkHostAgainstPolicy, type HostPolicy } from "../src/network/policy.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { bindingsFor, DIGESTS, sidecarDocument } from "./measurement-fixtures.ts";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const v2 = () => ({ ...bindingsFor(), v: 2, source_hash: d("4"),
  engine: { name: "llama.cpp", image_digest: d("5") }, model: { id: "cpu", digest: DIGESTS.model } });
const policy: HostPolicy = { version: 1, issued_at: new Date().toISOString(), tee_kinds: ["tdx"],
  sidecar: { image_digests: [DIGESTS.image], source_hashes: [d("4")] },
  engines: [{ name: "llama.cpp", image_digest: d("5") }], models: [{ id: "cpu", model_digest: DIGESTS.model, min_gpu_cc: false }],
  rules: { require_gpu_cc_for: [], allow_dev: false } };

describe("fresh attestor outcome exposes policy bindings", () => {
  let h: Harness;
  let sidecar: ReturnType<typeof Bun.serve>;
  let dcap: ReturnType<typeof Bun.serve>;
  let selected: Record<string, unknown> = v2();
  let tamper = false;
  let verified = true;
  beforeAll(async () => {
    sidecar = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const report = sidecarDocument(new URL(req.url).searchParams.get("nonce") ?? "", { bindings: selected });
      if (tamper) report.bindings = { ...report.bindings, source_hash: d("6") };
      return Response.json(report);
    } });
    dcap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ verified }) });
    h = await startRouter({ providers: [{ id: "host", name: "Host", models: [MODELS.llama] }],
      env: { TDX_VERIFIER_URL: `http://127.0.0.1:${dcap.port}/verify` } });
    await h.ctx.db.update(providers).set({ teeKind: "tdx", attestationUrl: `http://127.0.0.1:${sidecar.port}/attest` }).where(eq(providers.id, "host"));
  });
  afterAll(async () => { sidecar?.stop(true); dcap?.stop(true); await h?.close(); });
  const run = async () => {
    const [p] = await h.ctx.db.select().from(providers).where(eq(providers.id, "host"));
    return attestProvider(h.ctx, p);
  };
  test("v1 hardware path continues verifying, without filling unsupported policy fields", async () => {
    selected = bindingsFor();
    const result = await run();
    expect(result.ok).toBe(true);
    expect("host_policy_bindings" in result).toBe(true);
    if ("host_policy_bindings" in result) expect(checkHostAgainstPolicy(result.host_policy_bindings, policy).reasons).toContain("No quote-bound engine image is available.");
  });
  test("v2 fresh verified quote passes the published policy", async () => {
    selected = v2();
    const result = await run();
    expect(result.ok).toBe(true);
    if (!("host_policy_bindings" in result)) throw new Error("missing adapter outcome");
    expect(checkHostAgainstPolicy(result.host_policy_bindings, policy)).toEqual({ ok: true, reasons: [] });
  });
  test("a tampered source binding fails before admission", async () => {
    selected = v2(); tamper = true;
    try { expect(await run()).toMatchObject({ ok: false, reason: "sidecar bindings are not committed in report_data" }); }
    finally { tamper = false; }
  });
  test("a valid commitment cannot smuggle unknown versions or inconsistent model digests", async () => {
    for (const bindings of [{ ...v2(), v: 3 }, { ...v2(), model: { id: "cpu", digest: d("7") } }]) {
      selected = bindings;
      expect(await run()).toMatchObject({ ok: false, reason: "sidecar bindings are not committed in report_data" });
    }
  });
  test("a rejected hardware signature never returns admission bindings", async () => {
    selected = v2(); verified = false;
    try { const result = await run(); expect(result.ok).toBe(false); expect(result).not.toHaveProperty("host_policy_bindings"); }
    finally { verified = true; }
  });
});

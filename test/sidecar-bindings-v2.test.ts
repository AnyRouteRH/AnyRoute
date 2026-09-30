import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { boot, type Runtime } from "../sidecar/src/boot.ts";
import { parseConfig } from "../sidecar/src/config.ts";
import { attestationDocument } from "../sidecar/src/attest.ts";
import { bindingsObject, reportDataHex } from "../sidecar/src/reportdata.ts";
import { sourceArchiveHash } from "../sidecar/src/source-bindings.ts";
import { cleanup, dstackProvider, tmpDir } from "../sidecar/test/helpers.ts";
import { silentLogger, canonicalJson, sha256Hex } from "../sidecar/src/util.ts";
import { evaluateAttestation, type AttestDocument, type RouterAttestation } from "../packages/client/src/attestation.ts";
import { validSidecarBindingVersion } from "../packages/client/src/sidecar-bindings.ts";
import { bindingsCommittedIn } from "../src/services/measurements.ts";
import { sidecarHostPolicyBindings } from "../src/network/sidecar-bindings.ts";
import { checkHostAgainstPolicy, type HostPolicy } from "../src/network/policy.ts";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const nonce = "ef".repeat(32);
const trusted = { teeKind: "tdx", hardwareVerified: true, bindingsCommitted: true, simulated: false };
let archive: string;
let sourceHash: string;
let legacy: Runtime;
let current: Runtime;
const config = (extensions?: unknown) => ({
  server: { tls: "self_signed" }, model: { digest: d("1"), served_name: "cpu" },
  allowlist: { model_digests: [d("1")] }, image_digest: d("2"), compose: { hash: d("3") },
  auth: { keys: [{ id: "router", sha256: "a".repeat(64) }] },
  ...(extensions ? { bindings: extensions } : {}),
});
const extensions = () => ({ version: 2, source_archive: archive, source_hash: sourceHash,
  engine: { name: "llama.cpp", image_digest: d("4") }, model_id: "cpu" });
const doc = (rt: Runtime) => attestationDocument(rt, rt.bootEvidence, null) as AttestDocument;
const router = (): RouterAttestation => ({ provider: "host", status: "attested", tee: "tdx", attested_at: new Date().toISOString(),
  attestation_hash: null, verifiers: ["dcap"], measurement: null, not_checked: [],
  checks: { quote_verified: true, digests_bound_to_quote: true, transparency_log_entry: false, transparency_log_checkpoint_signature: false, registered_on_chain: false } });
const policy = (): HostPolicy => ({ version: 1, issued_at: new Date().toISOString(), tee_kinds: ["tdx"],
  sidecar: { image_digests: [d("2")], source_hashes: [sourceHash] },
  engines: [{ name: "llama.cpp", image_digest: d("4") }], models: [{ id: "cpu", model_digest: d("1"), min_gpu_cc: false }],
  rules: { require_gpu_cc_for: [], allow_dev: false } });

beforeAll(async () => {
  archive = join(tmpDir(), "source.tar.gz");
  writeFileSync(archive, "pinned archive bytes\n");
  sourceHash = `sha256:${sha256Hex("pinned archive bytes\n")}`;
  const deps = { env: { NODE_ENV: "production" }, logger: silentLogger, provider: dstackProvider() };
  legacy = await boot(parseConfig(config(), deps.env), deps);
  current = await boot(parseConfig(config(extensions()), deps.env), deps);
});
afterAll(cleanup);

describe("SHA-256 sidecar bindings v2", () => {
  test("v1 report data is byte-for-byte unchanged and v1 still verifies", async () => {
    const b = bindingsObject(legacy.bindings);
    expect(Object.keys(b).sort()).toEqual(["compose_hash", "image_digest", "model_digest", "receipt_pubkey", "tls_pubkey"]);
    expect(reportDataHex(legacy.bindings)).toBe(sha256Hex(canonicalJson(b)) + "0".repeat(64));
    expect(bindingsCommittedIn(legacy.bootEvidence.reportData, b)).toBe(true);
    const result = await evaluateAttestation({ providerId: "host", router: router(), boot: doc(legacy), certificate: legacy.tls!.certPem });
    expect(result.failures).toEqual([]);
    expect(result.bound).toMatchObject({ bindingsVersion: 1, sourceHash: null, engine: null, modelId: null });
  });
  test("production sidecar config loads v2; boot hashes exact archive bytes", async () => {
    expect(parseConfig(config(extensions()), { NODE_ENV: "production" }).bindings?.version).toBe(2);
    expect(await sourceArchiveHash(archive)).toBe(sourceHash);
    expect(doc(current).bindings).toMatchObject({ v: 2, source_hash: sourceHash, engine: extensions().engine, model: { id: "cpu", digest: d("1") } });
  });
  test("v2 verifies in router and SDK, including a fresh quote and bound TLS key", async () => {
    const fresh = attestationDocument(current, await current.freshQuote(Buffer.from(nonce, "hex")), nonce) as AttestDocument;
    expect(bindingsCommittedIn(fresh.evidence.report_data, fresh.bindings)).toBe(true);
    const result = await evaluateAttestation({ providerId: "host", router: router(), boot: doc(current), fresh: { doc: fresh, nonceHex: nonce }, certificate: current.tls!.certPem });
    expect(result.failures).toEqual([]);
    expect(result.bound).toMatchObject({ bindingsVersion: 2, sourceHash, engine: extensions().engine, modelId: "cpu", modelDigest: d("1") });
    expect(result.notChecked.join(" ")).toContain("review the measured deployment");
  });
  const edits: [string, (b: any) => void][] = [
    ["source hash", b => b.source_hash = d("5")], ["engine name", b => b.engine.name = "other"],
    ["engine image", b => b.engine.image_digest = d("5")], ["model ID", b => b.model.id = "other"],
    ["model digest", b => { b.model.digest = d("5"); b.model_digest = d("5"); }],
    ["version", b => b.v = 3],
  ];
  for (const [name, mutate] of edits) test(`tampered v2 ${name} fails commitment and SDK verification`, async () => {
    const b = doc(current); mutate(b.bindings);
    expect(bindingsCommittedIn(b.evidence.report_data, b.bindings)).toBe(false);
    expect((await evaluateAttestation({ providerId: "host", router: router(), boot: b })).ok).toBe(false);
  });
  test("incomplete, unversioned and inconsistent v2 are rejected even when rehashed", () => {
    for (const mutate of [(b: any) => delete b.source_hash, (b: any) => delete b.v,
      (b: any) => b.model.digest = d("6"), (b: any) => b.engine.image_digest = "tag", (b: any) => b.model.id = ""]) {
      const b = doc(current).bindings; mutate(b);
      expect(validSidecarBindingVersion(b)).toBe(false);
      expect(bindingsCommittedIn(sha256Hex(canonicalJson(b)) + nonce, b)).toBe(false);
    }
  });
  test("archive mismatch or unreadable archive stops boot", async () => {
    for (const override of [{ source_hash: d("5") }, { source_archive: join(tmpDir(), "missing") }]) {
      await expect(boot(parseConfig(config({ ...extensions(), ...override })), { env: { NODE_ENV: "production" }, provider: dstackProvider(), logger: silentLogger })).rejects.toMatchObject({ code: override.source_hash ? "SOURCE_HASH_MISMATCH" : "SOURCE_UNREADABLE" });
    }
  });
  test("incomplete config, unknown keys and alias mismatch fail closed", () => {
    for (const extra of [{ ...extensions(), source_hash: undefined }, { ...extensions(), version: 3 },
      { ...extensions(), extra: true }, { ...extensions(), model_id: "other" }]) expect(() => parseConfig(config(extra))).toThrow();
  });
});

describe("v2 policy adapter", () => {
  test("approved v2 passes, v1 still verifies but lacks required policy pins", () => {
    expect(checkHostAgainstPolicy(sidecarHostPolicyBindings(doc(current).bindings, trusted), policy())).toEqual({ ok: true, reasons: [] });
    const v1 = checkHostAgainstPolicy(sidecarHostPolicyBindings(doc(legacy).bindings, trusted), policy());
    expect(v1.reasons).toContain("The quote-bound sidecar source hash is missing or off-policy.");
    expect(v1.reasons).toContain("No quote-bound engine image is available.");
    expect(v1.reasons).toContain("Model (unnamed) has an unknown model ID or digest.");
  });
  test("off-policy source, engine, model, TEE and GPU give precise reasons", () => {
    const b = sidecarHostPolicyBindings(doc(current).bindings, trusted);
    const p = policy();
    p.sidecar.source_hashes = [d("6")]; p.engines[0].image_digest = d("6"); p.models[0].id = "other";
    expect(checkHostAgainstPolicy(b, p).reasons).toEqual([
      "The quote-bound sidecar source hash is missing or off-policy.", "Engine llama.cpp has an unapproved name or image digest.", "Model cpu has an unknown model ID or digest.",
    ]);
    expect(checkHostAgainstPolicy({ ...b, tee_kind: "snp" }, policy()).reasons).toEqual(["The host's TEE kind is not approved by this policy."]);
    const gpu = policy(); gpu.models[0].min_gpu_cc = true;
    expect(checkHostAgainstPolicy(b, gpu).reasons).toEqual(["Model cpu requires verified GPU confidential-computing evidence."]);
  });
  test("unverified, uncommitted and development flags cannot expose trusted extensions", () => {
    for (const flags of [{ hardwareVerified: false }, { bindingsCommitted: false }, { simulated: true }]) {
      const b = sidecarHostPolicyBindings(doc(current).bindings, { ...trusted, ...flags });
      expect(b.bindings.source_hash).toBeUndefined(); expect(b.bindings.engines).toBeUndefined();
      expect(checkHostAgainstPolicy(b, policy()).ok).toBe(false);
    }
  });
});

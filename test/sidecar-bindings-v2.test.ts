import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseConfig } from "../sidecar/src/config.ts";
import { bindingsObject, reportDataHex, type Bindings } from "../sidecar/src/reportdata.ts";
import { sourceArchiveHash } from "../sidecar/src/source-bindings.ts";
import { canonicalJson, sha256Hex } from "../sidecar/src/util.ts";
import { validSidecarBindingVersion } from "../packages/client/src/sidecar-bindings.ts";
import { bindingsCommittedIn } from "../src/services/measurements.ts";
import { sidecarHostPolicyBindings } from "../src/network/sidecar-bindings.ts";
import { checkHostAgainstPolicy, type HostPolicy } from "../src/network/policy.ts";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const nonce = "ef".repeat(32);
const trusted = { teeKind: "tdx", hardwareVerified: true, bindingsCommitted: true, simulated: false };
let archive: string;
let sourceHash: string;
const legacy: Bindings = { tlsPubkey: "ab".repeat(32), receiptPubkey: "cd".repeat(32), imageDigest: d("2"), composeHash: d("3"), modelDigest: d("1") };
let current: Bindings;
let directory: string;
const config = (extensions?: unknown) => ({
  server: { tls: "self_signed" }, model: { digest: d("1"), served_name: "cpu" },
  allowlist: { model_digests: [d("1")] }, image_digest: d("2"), compose: { hash: d("3") },
  auth: { keys: [{ id: "router", sha256: "a".repeat(64) }] },
  ...(extensions ? { bindings: extensions } : {}),
});
const extensions = () => ({ version: 2, source_archive: archive, source_hash: sourceHash,
  engine: { name: "llama.cpp", image_digest: d("4") }, model_id: "cpu" });
const policy = (): HostPolicy => ({ version: 1, issued_at: new Date().toISOString(), tee_kinds: ["tdx"],
  sidecar: { image_digests: [d("2")], source_hashes: [sourceHash] },
  engines: [{ name: "llama.cpp", image_digest: d("4") }], models: [{ id: "cpu", model_digest: d("1"), min_gpu_cc: false }],
  rules: { require_gpu_cc_for: [], allow_dev: false } });

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "sidecar-bindings-v2-"));
  archive = join(directory, "source.tar.gz");
  writeFileSync(archive, "pinned archive bytes\n");
  sourceHash = `sha256:${sha256Hex("pinned archive bytes\n")}`;
  current = { ...legacy, v2: { v: 2, source_hash: sourceHash, engine: extensions().engine, model: { id: "cpu", digest: d("1") } } };
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("SHA-256 sidecar bindings v2", () => {
  test("v1 report data is byte-for-byte unchanged and committed", async () => {
    const b = bindingsObject(legacy);
    expect(Object.keys(b).sort()).toEqual(["compose_hash", "image_digest", "model_digest", "receipt_pubkey", "tls_pubkey"]);
    expect(reportDataHex(legacy)).toBe(sha256Hex(canonicalJson(b)) + "0".repeat(64));
    expect(bindingsCommittedIn(reportDataHex(legacy), b)).toBe(true);
  });
  test("source archive hashes exact bytes", async () => {
    expect(await sourceArchiveHash(archive)).toBe(sourceHash);
  });
  const edits: [string, (b: any) => void][] = [
    ["source hash", b => b.source_hash = d("5")], ["engine name", b => b.engine.name = "other"],
    ["engine image", b => b.engine.image_digest = d("5")], ["model ID", b => b.model.id = "other"],
    ["model digest", b => { b.model.digest = d("5"); b.model_digest = d("5"); }],
    ["version", b => b.v = 3],
  ];
  for (const [name, mutate] of edits) test(`tampered v2 ${name} fails commitment`, async () => {
    const b = bindingsObject(current); mutate(b);
    expect(bindingsCommittedIn(reportDataHex(current), b)).toBe(false);
  });
  test("incomplete, unversioned and inconsistent v2 are rejected even when rehashed", () => {
    for (const mutate of [(b: any) => delete b.source_hash, (b: any) => delete b.v,
      (b: any) => b.model.digest = d("6"), (b: any) => b.engine.image_digest = "tag", (b: any) => b.model.id = ""]) {
      const b = bindingsObject(current); mutate(b);
      expect(validSidecarBindingVersion(b)).toBe(false);
      expect(bindingsCommittedIn(sha256Hex(canonicalJson(b)) + nonce, b)).toBe(false);
    }
  });
  test("incomplete config, unknown keys and alias mismatch fail closed", () => {
    for (const extra of [{ ...extensions(), source_hash: undefined }, { ...extensions(), version: 3 },
      { ...extensions(), extra: true }, { ...extensions(), model_id: "other" }]) expect(() => parseConfig(config(extra))).toThrow();
  });
});

describe("v2 policy adapter", () => {
  test("approved v2 passes, v1 still verifies but lacks required policy pins", () => {
    expect(checkHostAgainstPolicy(sidecarHostPolicyBindings(bindingsObject(current), trusted), policy())).toEqual({ ok: true, reasons: [] });
    const v1 = checkHostAgainstPolicy(sidecarHostPolicyBindings(bindingsObject(legacy), trusted), policy());
    expect(v1.reasons).toContain("The quote-bound sidecar source hash is missing or off-policy.");
    expect(v1.reasons).toContain("No quote-bound engine image is available.");
    expect(v1.reasons).toContain("Model (unnamed) has an unknown model ID or digest.");
  });
  test("off-policy source, engine, model, TEE and GPU give precise reasons", () => {
    const b = sidecarHostPolicyBindings(bindingsObject(current), trusted);
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
      const b = sidecarHostPolicyBindings(bindingsObject(current), { ...trusted, ...flags });
      expect(b.bindings.source_hash).toBeUndefined(); expect(b.bindings.engines).toBeUndefined();
      expect(checkHostAgainstPolicy(b, policy()).ok).toBe(false);
    }
  });
});

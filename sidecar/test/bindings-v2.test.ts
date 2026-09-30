import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { boot, type Runtime } from "../src/boot.ts";
import { parseConfig } from "../src/config.ts";
import { attestationDocument } from "../src/attest.ts";
import { cleanup, dstackProvider, tmpDir } from "./helpers.ts";
import { silentLogger, sha256Hex } from "../src/util.ts";
import { evaluateAttestation, type AttestDocument, type RouterAttestation } from "../../packages/client/src/attestation.ts";
import { bindingsCommittedIn } from "../../src/services/measurements.ts";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const nonce = "ef".repeat(32);
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
    const result = await evaluateAttestation({ providerId: "host", router: router(), boot: doc(legacy), certificate: legacy.tls!.certPem });
    expect(result.failures).toEqual([]);
    expect(result.bound).toMatchObject({ bindingsVersion: 1, sourceHash: null, engine: null, modelId: null });
  });
  test("production sidecar config loads v2; boot hashes exact archive bytes", async () => {
    expect(parseConfig(config(extensions()), { NODE_ENV: "production" }).bindings?.version).toBe(2);
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
  for (const [name, mutate] of edits) test(`tampered v2 ${name} fails SDK verification`, async () => {
    const b = doc(current); mutate(b.bindings);
    expect((await evaluateAttestation({ providerId: "host", router: router(), boot: b })).ok).toBe(false);
  });
  test("archive mismatch or unreadable archive stops boot", async () => {
    for (const override of [{ source_hash: d("5") }, { source_archive: join(tmpDir(), "missing") }]) {
      await expect(boot(parseConfig(config({ ...extensions(), ...override })), { env: { NODE_ENV: "production" }, provider: dstackProvider(), logger: silentLogger })).rejects.toMatchObject({ code: override.source_hash ? "SOURCE_HASH_MISMATCH" : "SOURCE_UNREADABLE" });
    }
  });
});

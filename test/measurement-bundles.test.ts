import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { decodeFunctionData, type Hex } from "viem";
import { MeasurementRegistryAbi } from "../src/chain/abis.ts";
import { loadConfig } from "../src/config.ts";
import { measurementBundles, measurements, providers } from "../src/db/schema.ts";
import { asBytes32, bundleBytes, digestHex, keyId, parseBundle } from "../src/services/measurement-bundle.ts";
import { applyVerifiedBundles, runMeasurementJob, submitBundle, watchBundles } from "../src/services/measurement-bundles.ts";
import { recordMeasurement, runMeasurements, type FetchFn } from "../src/services/measurements.ts";
import { main as publishScript } from "../scripts/publish-measurement.ts";
import { parsePins } from "../scripts/lib/compose-pins.ts";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { COMPOSE_TEXT, LLAMA_IMAGE, newSigner, signedBundle } from "./bundle-fixtures.ts";
import { DIGESTS, REGS, tdxQuote } from "./measurement-fixtures.ts";
import { MockRekor } from "./rekor-mock.ts";

const REGISTRY = "0x00000000000000000000000000000000000d0001";
const signer = newSigner();
let log = new MockRekor();
const admin = { authorization: `Bearer ${ADMIN}` };
const realFetch = globalThis.fetch;

let h: Harness;
const rows = () => h.ctx.db.select().from(measurements);
const bundles = () => h.ctx.db.select().from(measurementBundles);
const record = (over: Partial<Parameters<typeof recordMeasurement>[1]> = {}) =>
  recordMeasurement(h.ctx, {
    providerId: "alpha",
    digests: { imageDigest: asBytes32(DIGESTS.image), composeHash: asBytes32(DIGESTS.compose), modelDigest: asBytes32(DIGESTS.model) },
    verifiers: ["dcap"],
    teeKind: "tdx",
    quoteHex: tdxQuote("00".repeat(64)),
    reportHash: "0x" + "0".repeat(64),
    ...over,
  });
/** What an operator does before handing the bundle over: submit its entry to the log. Returns the entry's uuid. */
async function publish(s: ReturnType<typeof signedBundle>, into: MockRekor = log): Promise<string> {
  const res = await into.fetch(`${into.baseUrl}/api/v1/log/entries`, { method: "POST", body: JSON.stringify(s.entry) });
  // The log answers 409 with the existing entry's location when the same entry is submitted again.
  if (res.status === 409) return res.headers.get("location")!.split("/").pop()!;
  expect(res.status).toBe(201);
  return Object.keys(await res.json())[0]!;
}
const submitRpc = (s: ReturnType<typeof signedBundle>, uuid?: string, headers: Record<string, string> = admin) =>
  h.request("/trpc/measurements.submitBundle", { method: "POST", headers, json: { bundle: s.bundle, signature: s.signature, ...(uuid ? { rekor_uuid: uuid } : {}) } });
const rpcData = async (res: Response) => (await res.json() as { result: { data: any } }).result.data;
const view = async (id = "alpha") => (await (await h.request(`/api/v1/attestation/${id}`)).json()).data;

beforeAll(async () => {
  // The router's own calls to the log (a submit over tRPC checks the entry at once) go to the in-memory log.
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => (String(url).startsWith(log.baseUrl) ? log.fetch(url, init) : realFetch(url, init))) as typeof fetch;
  h = await startRouter({
    providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama] }, { id: "pending", name: "Pending", models: [MODELS.qwen], live: false }],
    env: { MEASUREMENTS_ENABLED: "true", MEASUREMENT_PUBLIC_KEY: signer.publicPem, REKOR_URL: log.baseUrl, MEASUREMENT_REGISTRY_ADDRESS: REGISTRY },
  });
  await h.ctx.db.update(providers).set({ teeKind: "tdx", attested: true, attestedAt: new Date(), attestationHash: "0x" + "ab".repeat(32) }).where(eq(providers.id, "alpha"));
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await h.close();
});
beforeEach(async () => {
  log = new MockRekor();
  await h.ctx.db.delete(measurementBundles);
  await h.ctx.db.delete(measurements);
  h.ctx.cfg.measurements.publicKey = signer.publicPem;
  h.ctx.cfg.measurements.rekorPublicKey = log.publicKeyPem;
});

describe("configuration and the key endpoint", () => {
  test("the public key is published, and only when it is configured", async () => {
    const res = await h.request("/api/v1/measurements/key");
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ algorithm: "ecdsa-p256-sha256", key_id: keyId(signer.publicKey), public_key_pem: signer.publicPem, transparency_log: log.baseUrl });
    h.ctx.cfg.measurements.publicKey = null;
    expect((await h.request("/api/v1/measurements/key")).status).toBe(404);
    expect((await h.request("/api/v1/measurements/bundles/alpha")).status).toBe(404);
  });
  test("a private key, a non-P-256 key or garbage is refused at startup; an unset key leaves the feature off", () => {
    const env = { ANYROUTE_ENV: "test", APP_SECRET: "x".repeat(40) };
    expect(loadConfig({ ...env }).measurements.publicKey).toBeNull();
    expect(loadConfig({ ...env, MEASUREMENT_PUBLIC_KEY: signer.publicPem }).measurements.publicKey).toBe(signer.publicPem);
    expect(loadConfig({ ...env, MEASUREMENT_PUBLIC_KEY: signer.publicPem.trim().replace(/\n/g, "\\n") }).measurements.publicKey).toBe(signer.publicPem);
    expect(() => loadConfig({ ...env, MEASUREMENT_PUBLIC_KEY: signer.privatePem })).toThrow("public key");
    expect(() => loadConfig({ ...env, MEASUREMENT_PUBLIC_KEY: "nonsense" })).toThrow("P-256");
  });
});

describe("handing a bundle over", () => {
  test("only an operator can, and only for the trusted key, a good signature and a known provider", async () => {
    const s = signedBundle(signer);
    expect((await submitRpc(s, undefined, {})).status).toBe(401);
    expect((await submitRpc(s, undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    expect(await bundles()).toHaveLength(0);

    const other = signedBundle(newSigner());
    const wrongKey = await submitRpc(other);
    expect(wrongKey.status).toBe(400);
    expect(JSON.stringify(await wrongKey.json())).toContain("different signing key");

    const forged = await h.request("/trpc/measurements.submitBundle", { method: "POST", headers: admin, json: { bundle: s.bundle, signature: signedBundle(signer, { createdAt: "2026-10-01T00:00:00.000Z" }).signature } });
    expect(forged.status).toBe(400);
    expect(JSON.stringify(await forged.json())).toContain("signature does not verify");

    const unknown = signedBundle(signer, { provider: "nobody" });
    expect((await submitRpc(unknown)).status).toBe(404);
    const malformed = await h.request("/trpc/measurements.submitBundle", { method: "POST", headers: admin, json: { bundle: { type: "x" }, signature: "AAAA" } });
    expect(malformed.status).toBe(400);
    expect(await bundles()).toHaveLength(0);

    h.ctx.cfg.measurements.publicKey = null;
    expect((await submitRpc(s)).status).toBe(501);
  });
  test("a bundle whose entry is in the log is verified on the spot, and handing it over again changes nothing", async () => {
    const s = signedBundle(signer);
    const uuid = await publish(s);
    const first = await rpcData(await submitRpc(s, uuid));
    expect(first).toMatchObject({ status: "verified", bundle_digest: "0x" + s.digest, provider: "alpha", error: null, transparency_log: { uuid, inclusion_verified: true, checkpoint_signature_verified: true, signed_entry_timestamp_verified: true, entry_url: `${log.baseUrl}/api/v1/log/entries/${uuid}` } });
    const again = await rpcData(await submitRpc(s, uuid));
    expect(again.status).toBe("verified");
    expect(await bundles()).toHaveLength(1);
    const [row] = await bundles();
    expect(row).toMatchObject({ providerId: "alpha", composeHash: "0x" + "22".repeat(32), signerKeyId: keyId(signer.publicKey), rekorUuid: uuid, rekorLogIndex: expect.any(Number) });
    expect(digestHex(bundleBytes(parseBundle(row.bundle)))).toBe(s.digest);
    expect(row.rekorEntryJson).toMatchObject({ body: expect.any(String), verification: { signedEntryTimestamp: expect.any(String), inclusionProof: { checkpoint: expect.any(String) } } });
  });
  test("without the uuid, the router finds the entry by the bundle digest", async () => {
    const s = signedBundle(signer);
    const uuid = await publish(s);
    const out = await rpcData(await submitRpc(s));
    expect(out).toMatchObject({ status: "verified", transparency_log: { uuid } });
    expect(log.calls.some((c) => c.url.endsWith("/api/v1/index/retrieve") && c.body?.hash === `sha256:${s.digest}`)).toBe(true);
  });
});

describe("what makes a bundle count", () => {
  test("an entry the operator names that is not this bundle's is a rejection; a rejected bundle can be handed over again", async () => {
    const s = signedBundle(signer);
    const stranger = signedBundle(newSigner()); // someone else's bundle, logged with their key
    const strangerUuid = await publish(stranger);
    const out = await rpcData(await submitRpc(s, strangerUuid));
    expect(out).toMatchObject({ status: "rejected", error: "the entry's artifact hash is not the bundle digest" });
    // the same bytes logged under another key: the hash matches, the key does not
    const impostor = newSigner();
    const s2 = signedBundle(signer, { createdAt: "2026-09-29T11:00:00.000Z" });
    const impostorEntry = await log.fetch(`${log.baseUrl}/api/v1/log/entries`, { method: "POST", body: JSON.stringify({ ...s2.entry, spec: { ...s2.entry.spec, signature: { ...s2.entry.spec.signature, publicKey: { content: Buffer.from(impostor.publicPem).toString("base64") } } } }) });
    const impostorUuid = Object.keys(await impostorEntry.json())[0]!;
    expect(await rpcData(await submitRpc(s2, impostorUuid))).toMatchObject({ status: "rejected", error: "the entry was not signed with the measurement key" });
    // handing it over again with the right entry works
    const good = await publish(s);
    expect(await rpcData(await submitRpc(s, good))).toMatchObject({ status: "verified", error: null });
  });
  test("entries found only by searching never reject a bundle: anyone can log the same hash under their own key", async () => {
    const s = signedBundle(signer);
    // an attacker logs our digest under their key before we do
    const attacker = newSigner();
    const res = await log.fetch(`${log.baseUrl}/api/v1/log/entries`, { method: "POST", body: JSON.stringify({ ...s.entry, spec: { ...s.entry.spec, signature: { ...s.entry.spec.signature, publicKey: { content: Buffer.from(attacker.publicPem).toString("base64") } } } }) });
    expect(res.status).toBe(201);
    const out = await rpcData(await submitRpc(s));
    expect(out).toMatchObject({ status: "pending", error: "the entry was not signed with the measurement key" });
    // our own entry appears; the next pass finds it among the results
    const uuid = await publish(s);
    expect(await watchBundles(h.ctx, { fetchImpl: log.fetch })).toMatchObject({ checked: 1, verified: 1 });
    expect((await bundles())[0]).toMatchObject({ status: "verified", rekorUuid: uuid });
  });
  test("an entry that is not in the log yet, an outage and a missing inclusion proof leave the bundle pending, and the watcher settles it", async () => {
    const s = signedBundle(signer);
    const uuid = "24296fb24b8ad77a" + "9".repeat(64);
    expect(await rpcData(await submitRpc(s, uuid))).toMatchObject({ status: "pending", error: `the log has no entry ${uuid}` });
    log.outage = 503;
    expect(await watchBundles(h.ctx, { fetchImpl: log.fetch })).toMatchObject({ checked: 1, failed: 1, verified: 0 });
    expect((await bundles())[0]).toMatchObject({ status: "pending", error: "Rekor HTTP 503" });
    log.outage = null;
    const real = await publish(s);
    await h.ctx.db.update(measurementBundles).set({ rekorUuid: real });
    log.withholdProofs = true;
    expect(await watchBundles(h.ctx, { fetchImpl: log.fetch })).toMatchObject({ checked: 1, pending: 1 });
    expect((await bundles())[0]).toMatchObject({ status: "pending", error: "the log returned no inclusion proof for the entry" });
    log.withholdProofs = false;
    expect(await watchBundles(h.ctx, { fetchImpl: log.fetch })).toMatchObject({ checked: 1, verified: 1 });
    expect((await bundles())[0]).toMatchObject({ status: "verified", error: null });
    // a verified bundle is not looked up again
    log.calls.length = 0;
    expect(await watchBundles(h.ctx, { fetchImpl: log.fetch })).toMatchObject({ checked: 0 });
    expect(log.calls).toHaveLength(0);
  });
  test("a log that rewrites an entry's body, or a proof that does not verify, is never accepted", async () => {
    const s = signedBundle(signer);
    const uuid = await publish(s);
    log.replaceBody(uuid, { ...log.bodyOf(uuid), kind: "intoto" });
    expect(await rpcData(await submitRpc(s, uuid))).toMatchObject({ status: "rejected", error: "the entry's uuid does not name its body" });
  });
  test("a change of the trusted key rejects bundles signed with the old one at the next check", async () => {
    const s = signedBundle(signer);
    await submitBundle(h.ctx, { bundle: s.bundle, signature: s.signature, rekorUuid: "24296fb24b8ad77a" + "8".repeat(64) }, { fetchImpl: log.fetch });
    expect((await bundles())[0]!.status).toBe("pending");
    h.ctx.cfg.measurements.publicKey = newSigner().publicPem;
    expect(await watchBundles(h.ctx, { fetchImpl: log.fetch })).toMatchObject({ rejected: 1 });
    expect((await bundles())[0]).toMatchObject({ status: "rejected", error: "the bundle's signature does not verify against the trusted measurement key" });
  });
});

describe("the transparency-log entry of a measurement", () => {
  test("a verified bundle for the compose hash the quote committed to becomes the measurement's entry, and the record says so", async () => {
    await record();
    const before = await view();
    expect(before.checks).toMatchObject({ transparency_log_entry: false, transparency_log_checkpoint_signature: false });
    expect(before.measurement.transparency_log).toMatchObject({ found: false, subject: null, entry_url: null, bundle: null });
    expect(before.measurement.registers).toEqual({ mrtd: REGS.mrtd, rtmr3: REGS.rtmr3 });

    const s = signedBundle(signer);
    const uuid = await publish(s);
    await submitRpc(s, uuid);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "ready", rekorUuid: uuid, rekorEntry: "0x" + uuid.slice(-64), rekorKind: "hashedrekord", rekorInclusionVerified: true, rekorCheckpointVerified: true, rekorError: null });
    expect(row.rekorIntegratedAt).not.toBeNull();

    const d = await view();
    expect(d.checks).toMatchObject({ transparency_log_entry: true, transparency_log_checkpoint_signature: true });
    expect(d.measurement.transparency_log).toMatchObject({
      found: true,
      kind: "hashedrekord",
      uuid,
      inclusion_verified: true,
      checkpoint_signature_verified: true,
      subject: "measurement_bundle",
      entry_url: `${log.baseUrl}/api/v1/log/entries/${uuid}`,
      bundle: { digest: "0x" + s.digest, signer_key_id: keyId(signer.publicKey), signature_verified: true, url: "/api/v1/measurements/bundles/alpha" },
    });
    // the record states what it now does check about the entry, and no longer claims it does not check who signed
    expect(d.not_checked.join("\n")).toContain("measurement key it is configured with");
    expect(d.not_checked.join("\n")).not.toContain("not that the entry came from the image's publisher");
    expect(d.not_checked.join("\n")).toContain("scripts/check-reproducible.ts");
  });
  test("without the log's key the entry is found and its inclusion verified, but the checkpoint is reported unverified", async () => {
    h.ctx.cfg.measurements.rekorPublicKey = undefined;
    await record();
    const s = signedBundle(signer);
    await submitRpc(s, await publish(s));
    const d = await view();
    expect(d.checks).toMatchObject({ transparency_log_entry: true, transparency_log_checkpoint_signature: false });
    expect(d.measurement.transparency_log).toMatchObject({ found: true, inclusion_verified: true, checkpoint_signature_verified: false, subject: "measurement_bundle" });
  });
  test("a bundle handed over before the provider was measured is applied once the measurement is recorded", async () => {
    const s = signedBundle(signer);
    await submitRpc(s, await publish(s));
    expect(await rows()).toHaveLength(0);
    await record();
    expect((await rows())[0]).toMatchObject({ status: "observed", rekorUuid: null });
    expect(await watchBundles(h.ctx, { fetchImpl: log.fetch })).toMatchObject({ checked: 0, applied: 1 });
    expect((await rows())[0]).toMatchObject({ status: "ready", rekorKind: "hashedrekord", rekorInclusionVerified: true });
    // idempotent
    expect(await applyVerifiedBundles(h.ctx)).toEqual({ applied: 0, mismatched: 0 });
  });
  test("a bundle that does not describe what the quote committed to is verified as a document but applied to nothing", async () => {
    await record();
    const cases: [string, Parameters<typeof signedBundle>[1], string][] = [
      ["a different compose hash", { composeHash: "sha256:" + "23".repeat(32) }, ""],
      ["an image the quote did not commit to", { images: [{ service: "sidecar", reference: "x/y:1", digest: LLAMA_IMAGE }] }, "image digest"],
      ["a different model", { model: { digest: "sha256:" + "88".repeat(32), weights: [] } }, "model digest"],
      ["another MRTD", { tdx: { mrtd: ["cc".repeat(48)], rtmr3: [] } }, "MRTD"],
      ["another RTMR3", { tdx: { mrtd: [], rtmr3: ["cc".repeat(48)] } }, "RTMR3"],
    ];
    for (const [name, over, why] of cases) {
      const s = signedBundle(signer, { createdAt: `2026-09-29T1${cases.findIndex((c) => c[0] === name)}:00:00.000Z`, ...over });
      const out = await rpcData(await submitRpc(s, await publish(s)));
      expect(out.status, name).toBe("verified");
      const [row] = await rows();
      expect(row, name).toMatchObject({ status: "observed", rekorUuid: null, rekorInclusionVerified: false });
      if (why) expect(row.rekorError, name).toContain(why);
      await h.ctx.db.delete(measurementBundles);
    }
    const d = await view();
    expect(d.checks.transparency_log_entry).toBe(false);
  });
  test("after a compose change each bundle belongs to the row for its own compose hash, and only the current one is reported", async () => {
    const first = await record();
    const a = signedBundle(signer, { createdAt: "2026-09-29T10:00:00.000Z" });
    const ua = await publish(a);
    await submitRpc(a, ua);
    expect((await view()).checks.transparency_log_entry).toBe(true);

    // a redeploy with another compose file under the same image
    const composeB = asBytes32("sha256:" + "44".repeat(32));
    const second = await record({ digests: { imageDigest: asBytes32(DIGESTS.image), composeHash: composeB, modelDigest: asBytes32(DIGESTS.model) } });
    expect(second).toMatchObject({ status: "created", superseded: [first.id] });
    let d = await view();
    expect(d.measurement).toMatchObject({ compose_hash: composeB, transparency_log: { found: false, uuid: null, bundle: null } });
    expect(d.checks).toMatchObject({ transparency_log_entry: false, transparency_log_checkpoint_signature: false });
    expect(d.measurement_history).toMatchObject([{ compose_hash: asBytes32(DIGESTS.compose), transparency_log: { uuid: ua, subject: "measurement_bundle", bundle_digest: "0x" + a.digest } }]);
    // the earlier bundle, checked again, still applies only to the earlier compose hash
    expect(await applyVerifiedBundles(h.ctx)).toEqual({ applied: 0, mismatched: 0 });

    const b = signedBundle(signer, { createdAt: "2026-09-29T12:00:00.000Z", composeHash: "sha256:" + "44".repeat(32) });
    const ub = await publish(b);
    await submitRpc(b, ub);
    const byId = new Map((await rows()).map((r) => [r.id, r]));
    expect(byId.get(second.id)).toMatchObject({ status: "ready", rekorUuid: ub, supersededAt: null });
    expect(byId.get(first.id)).toMatchObject({ status: "ready", rekorUuid: ua, supersededBy: second.id });
    d = await view();
    expect(d.measurement.transparency_log).toMatchObject({ found: true, uuid: ub, subject: "measurement_bundle", bundle: { digest: "0x" + b.digest } });
    expect(d.checks).toMatchObject({ transparency_log_entry: true, transparency_log_checkpoint_signature: true });
    expect(d.measurement_history).toMatchObject([{ compose_hash: asBytes32(DIGESTS.compose), transparency_log: { uuid: ua, bundle_digest: "0x" + a.digest } }]);
  });
  test("a bundle for another provider's compose hash never touches this provider's measurement", async () => {
    await record();
    await h.ctx.db.update(providers).set({ status: "live" }).where(eq(providers.id, "pending"));
    const s = signedBundle(signer, { provider: "pending" });
    await submitRpc(s, await publish(s));
    expect((await rows())[0]).toMatchObject({ providerId: "alpha", status: "observed", rekorUuid: null });
    await h.ctx.db.update(providers).set({ status: "applied" }).where(eq(providers.id, "pending"));
  });
  test("the newest verified bundle wins; calldata built for an older entry is rebuilt, and a row whose calldata was sent is left alone", async () => {
    await record();
    const a = signedBundle(signer, { createdAt: "2026-09-29T10:00:00.000Z" });
    const ua = await publish(a);
    await submitRpc(a, ua);
    expect(await runMeasurementJob(h.ctx, { fetchImpl: log.fetch, read: async () => false })).toMatchObject({ keeper: { built: 1, target: REGISTRY } });
    expect((await rows())[0]!.calldata).not.toBeNull();

    const b = signedBundle(signer, { createdAt: "2026-09-29T12:00:00.000Z", tdx: { mrtd: [REGS.mrtd, "dd".repeat(48)], rtmr3: [] } });
    const ub = await publish(b);
    await submitRpc(b, ub);
    let [row] = await rows();
    expect(row).toMatchObject({ rekorUuid: ub, rekorEntry: "0x" + ub.slice(-64), calldata: null, calldataTarget: null, calldataBuiltAt: null });
    await runMeasurementJob(h.ctx, { fetchImpl: log.fetch, read: async () => false });
    [row] = await rows();
    const decoded = decodeFunctionData({ abi: MeasurementRegistryAbi, data: row.calldata as Hex });
    expect((decoded.args as [Hex, Record<string, unknown>, Hex])[1]).toMatchObject({ rekorEntry: "0x" + ub.slice(-64), composeHash: row.composeHash });

    // a transaction was sent with this calldata: the row keeps the entry it was sent with
    await h.ctx.db.update(measurements).set({ txHash: "0x" + "ee".repeat(32) });
    const c = signedBundle(signer, { createdAt: "2026-09-29T14:00:00.000Z" });
    await submitRpc(c, await publish(c));
    expect((await rows())[0]).toMatchObject({ rekorUuid: ub, txHash: "0x" + "ee".repeat(32) });
  });
  test("a measurement that already has an entry for its image digest gets the bundle's entry, which is the stronger record", async () => {
    await record();
    // the image-digest lookup found an entry (kind intoto) and calldata was built for it
    await h.ctx.db.update(measurements).set({ status: "ready", rekorUuid: "24296fb24b8ad77a" + "ab".repeat(32), rekorEntry: "0x" + "ab".repeat(32), rekorKind: "intoto", rekorInclusionVerified: true, calldata: "0x1234", calldataTarget: REGISTRY });
    expect((await view()).measurement.transparency_log).toMatchObject({ found: true, kind: "intoto", subject: "image_digest" });
    const s = signedBundle(signer);
    await submitRpc(s, await publish(s));
    expect((await view()).measurement.transparency_log).toMatchObject({ found: true, kind: "hashedrekord", subject: "measurement_bundle" });
    expect((await rows())[0]!.calldata).toBeNull();
  });
  test("registered measurements are not rewritten", async () => {
    await record();
    await h.ctx.db.update(measurements).set({ status: "registered", rekorUuid: "24296fb24b8ad77a" + "ab".repeat(32), rekorEntry: "0x" + "ab".repeat(32), rekorInclusionVerified: true });
    const s = signedBundle(signer);
    await submitRpc(s, await publish(s));
    expect((await rows())[0]).toMatchObject({ status: "registered", rekorUuid: "24296fb24b8ad77a" + "ab".repeat(32) });
    expect((await bundles())[0]!.status).toBe("verified");
  });
});

describe("the job", () => {
  test("bundles are checked before the keeper runs, so calldata already carries the bundle's entry", async () => {
    await record();
    const s = signedBundle(signer);
    const uuid = await publish(s);
    await h.ctx.db.insert(measurementBundles).values({ providerId: "alpha", composeHash: asBytes32(s.bundle.compose_hash), bundleDigest: "0x" + s.digest, bundle: s.bundle, signature: s.signature, signerKeyId: keyId(signer.publicKey), rekorUuid: uuid });
    const out = (await runMeasurementJob(h.ctx, { fetchImpl: log.fetch, read: async () => false })) as Record<string, any>;
    expect(out.bundles).toMatchObject({ checked: 1, verified: 1, applied: 1 });
    expect(out.keeper).toMatchObject({ built: 1 });
    expect(out.rekor).toMatchObject({ checked: 0 }); // the row was already ready: no image-digest lookup
    const [row] = await rows();
    const decoded = decodeFunctionData({ abi: MeasurementRegistryAbi, data: row.calldata as Hex });
    expect((decoded.args as [Hex, Record<string, unknown>, Hex])[1]).toMatchObject({ rekorEntry: "0x" + uuid.slice(-64) });
  });
  test("without a measurement key the job is the plain measurements job, and it does nothing when measurements are off", async () => {
    await record();
    h.ctx.cfg.measurements.publicKey = null;
    const f: FetchFn = (async () => new Response("[]")) as unknown as FetchFn;
    const out = (await runMeasurementJob(h.ctx, { fetchImpl: f, read: async () => false })) as Record<string, unknown>;
    expect(out).toEqual(await runMeasurements(h.ctx, { fetchImpl: f, read: async () => false }));
    expect(out).not.toHaveProperty("bundles");
    expect(await watchBundles(h.ctx, { fetchImpl: f })).toEqual({ skipped: "no MEASUREMENT_PUBLIC_KEY" });
    h.ctx.cfg.measurements.enabled = false;
    expect(await runMeasurementJob(h.ctx, { fetchImpl: f })).toEqual({ skipped: "MEASUREMENTS_ENABLED is false" });
    h.ctx.cfg.measurements.enabled = true;
  });
});

describe("the public list of bundles", () => {
  test("shows each bundle with its status, the entry the router verified and the log's own copy of it", async () => {
    const s = signedBundle(signer);
    const uuid = await publish(s);
    await submitRpc(s, uuid);
    const bad = signedBundle(signer, { createdAt: "2026-09-30T00:00:00.000Z" });
    await submitRpc(bad, await publish(s));
    const res = await h.request("/api/v1/measurements/bundles/alpha");
    expect(res.status).toBe(200);
    const list = (await res.json()).data as any[];
    expect(list.map((b) => b.status)).toEqual(["rejected", "verified"]);
    expect(list[0].error).toContain("artifact hash");
    expect(list[1]).toMatchObject({ bundle_digest: "0x" + s.digest, signature: s.signature, bundle: { provider: "alpha" }, transparency_log: { uuid, entry_url: `${log.baseUrl}/api/v1/log/entries/${uuid}` }, entry_record: { body: expect.any(String) } });
    expect((await h.request("/api/v1/measurements/bundles/nobody")).status).toBe(404);
    expect((await h.request("/api/v1/measurements/bundles/pending")).status).toBe(404);
  });
});

describe("the publishing script against a running router", () => {
  test("publish with --handover: the router's record turns from no to yes with the entry, key and bundle it can be checked against", async () => {
    // A measurement the router recorded from a verified quote of the public compose file's deployment.
    const pins = parsePins(COMPOSE_TEXT);
    const composeHash = "sha256:" + "5e".repeat(32);
    await record({ digests: { imageDigest: asBytes32(pins.images.find((i) => i.service === "sidecar")!.digest), composeHash: asBytes32(composeHash), modelDigest: asBytes32(pins.sidecar!.modelDigests[0]!) } });
    expect((await view()).checks.transparency_log_entry).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "publish-e2e-"));
    try {
      const router = "https://router.example.test";
      const viaRouter = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith(router)) return h.request(u.slice(router.length), init);
        return log.fetch(url, init);
      }) as unknown as typeof fetch;
      const out: string[] = [];
      const err: string[] = [];
      const file = join(dir, "record.json");
      const code = await publishScript(["--provider", "alpha", "--router-url", router, "--compose", new URL("../sidecar/examples/phala/docker-compose.yml", import.meta.url).pathname, "--out", file, "--handover"], {
        env: { MEASUREMENT_SIGNING_KEY: signer.privatePem, REKOR_URL: log.baseUrl, REKOR_PUBLIC_KEY: log.publicKeyPem, ADMIN_TOKEN: ADMIN },
        fetch: viaRouter,
        out: (x) => out.push(x),
        err: (x) => err.push(x),
        now: () => new Date("2026-09-29T12:00:00.000Z"),
        wait: async () => {},
      });
      expect(err.join("\n")).toBe("");
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("is verified");

      const rec = JSON.parse(readFileSync(file, "utf8"));
      const d = await view();
      expect(d.checks).toMatchObject({ quote_verified: true, transparency_log_entry: true, transparency_log_checkpoint_signature: true });
      expect(d.measurement.transparency_log).toMatchObject({ found: true, subject: "measurement_bundle", uuid: rec.rekor.uuid, log_index: rec.rekor.log_index, entry_url: rec.rekor.entry_url, bundle: { digest: "0x" + rec.bundle_digest.slice(7) } });
      expect(rec.rekor.entry_url).toBe(`${log.baseUrl}/api/v1/log/entries/${rec.rekor.uuid}`);

      // the record the script wrote checks out against the router's published key, and a second publication is refused
      out.length = 0;
      expect(await publishScript(["--verify", file, "--router-url", router], { env: { REKOR_URL: log.baseUrl }, fetch: viaRouter, out: (x) => out.push(x), err: (x) => err.push(x), now: () => new Date() })).toBe(0);
      expect(out.join("\n")).toContain("the key the router publishes");
      err.length = 0;
      expect(await publishScript(["--provider", "alpha", "--router-url", router, "--out", join(dir, "again.json"), "--dry-run"], { env: { MEASUREMENT_SIGNING_KEY: signer.privatePem }, fetch: viaRouter, out: () => {}, err: (x) => err.push(x), now: () => new Date() })).toBe(0);
      expect(await publishScript(["--provider", "alpha", "--router-url", router, "--out", join(dir, "again.json")], { env: { MEASUREMENT_SIGNING_KEY: signer.privatePem, REKOR_URL: log.baseUrl }, fetch: viaRouter, out: () => {}, err: (x) => err.push(x), now: () => new Date() })).toBe(1);
      expect(err.join("\n")).toContain("already holds a verified bundle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

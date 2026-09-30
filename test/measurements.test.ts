import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { decodeFunctionData, keccak256, type Hex } from "viem";
import { MeasurementRegistryAbi } from "../src/chain/abis.ts";
import { attestationEvents, attestations, measurements, providers } from "../src/db/schema.ts";
import { runAttestor } from "../src/services/attestor.ts";
import {
  bindingsCommittedIn,
  buildRegisterCalldata,
  checkpointSigned,
  currentMeasurement,
  digestsFromBindings,
  entryIncluded,
  measurementHistory,
  normalizeDigest,
  providerIdHash,
  reconcileRegistry,
  recordMeasurement,
  recordSubmission,
  rekorEntry,
  rekorSearch,
  runKeeper,
  runMeasurements,
  verifyInclusionProof,
  watchRekor,
  type RekorEntry,
} from "../src/services/measurements.ts";
import { verifyAgainstRouter } from "../sidecar/src/router-check.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { DIGESTS, REGS, bindingsFor, auditPath, mth, rekorEntryFor, sha, sidecarDocument } from "./measurement-fixtures.ts";

const REGISTRY = "0x00000000000000000000000000000000000d0001";
const REKOR = "https://rekor.example.test";
const UUID_A = "24296fb24b8ad77a" + "ab".repeat(32);
const UUID_B = "24296fb24b8ad77a" + "cd".repeat(32);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function rekorFetch(search: string[] | Response, entries: Record<string, Record<string, unknown> | Response> = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ method: init.method ?? "GET", url: u, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (u === `${REKOR}/api/v1/index/retrieve`) return search instanceof Response ? search.clone() : json(search);
    const m = /\/api\/v1\/log\/entries\/([0-9a-f]+)$/.exec(u);
    const e = m ? entries[m[1]] : undefined;
    return e instanceof Response ? e.clone() : e ? json(e) : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

// ---- pure helpers ---------------------------------------------------------------------------------------

describe("digests and bindings", () => {
  test("normalizeDigest accepts sha256:, 0x and bare hex and nothing else", () => {
    const h = "ab".repeat(32);
    expect(normalizeDigest(`sha256:${h}`)).toBe(`0x${h}`);
    expect(normalizeDigest(`0x${h.toUpperCase()}`)).toBe(`0x${h}`);
    expect(normalizeDigest(h)).toBe(`0x${h}`);
    for (const bad of [undefined, null, 5, "", "sha256:abc", `sha512:${h}`, `${h}00`, `0x${h.slice(2)}`, `sha256:${"zz".repeat(32)}`]) expect(normalizeDigest(bad)).toBeNull();
  });
  test("digestsFromBindings needs all three digests", () => {
    expect(digestsFromBindings(bindingsFor())).toEqual({ imageDigest: "0x" + "11".repeat(32), composeHash: "0x" + "22".repeat(32), modelDigest: "0x" + "33".repeat(32) });
    expect(digestsFromBindings({ ...bindingsFor(), model_digest: "" })).toBeNull();
    expect(digestsFromBindings({ image_digest: DIGESTS.image })).toBeNull();
    expect(digestsFromBindings(null)).toBeNull();
    expect(digestsFromBindings("x")).toBeNull();
  });
  test("bindingsCommittedIn checks the first 32 bytes of report_data against the bindings", () => {
    const doc = sidecarDocument("ee".repeat(32));
    expect(bindingsCommittedIn(doc.evidence.report_data, doc.bindings)).toBe(true);
    expect(bindingsCommittedIn(doc.evidence.report_data.toUpperCase(), doc.bindings)).toBe(true);
    expect(bindingsCommittedIn(doc.evidence.report_data, { ...doc.bindings, model_digest: "sha256:" + "44".repeat(32) })).toBe(false);
    expect(bindingsCommittedIn(sidecarDocument("ee".repeat(32), { tamperReportData: true }).evidence.report_data, doc.bindings)).toBe(false);
    expect(bindingsCommittedIn(doc.evidence.report_data, null)).toBe(false);
    expect(bindingsCommittedIn(doc.evidence.report_data, [])).toBe(false);
  });
});

describe("merkle inclusion (RFC 6962)", () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => Buffer.from(`leaf-${i}`));
  const leafHash = (d: Buffer) => sha(Buffer.concat([Buffer.from([0]), d]));

  test("every leaf of trees of every size up to 33 verifies against the recursively built root", () => {
    for (let n = 1; n <= 33; n++) {
      const data = leaves(n);
      const root = mth(data);
      for (let i = 0; i < n; i++) expect(verifyInclusionProof(leafHash(data[i]), BigInt(i), BigInt(n), auditPath(i, data), root)).toBe(true);
    }
  });
  test("wrong index, size, leaf, root or path length all fail", () => {
    const data = leaves(13);
    const root = mth(data);
    const path = auditPath(5, data);
    const ok = (idx: number, size: number, leaf: Buffer, p: Buffer[], r: Buffer) => verifyInclusionProof(leafHash(leaf), BigInt(idx), BigInt(size), p, r);
    expect(ok(5, 13, data[5], path, root)).toBe(true);
    expect(ok(4, 13, data[5], path, root)).toBe(false);
    // a size that changes the shape of the path fails (13 and 14 leaves share it, so the size alone cannot tell them apart)
    expect(ok(5, 8, data[5], path, root)).toBe(false);
    expect(ok(5, 17, data[5], path, root)).toBe(false);
    expect(ok(5, 13, data[6], path, root)).toBe(false);
    expect(ok(5, 13, data[5], path, sha("x"))).toBe(false);
    expect(ok(5, 13, data[5], path.slice(1), root)).toBe(false);
    expect(ok(5, 13, data[5], [...path, sha("extra")], root)).toBe(false);
    expect(ok(13, 13, data[5], path, root)).toBe(false);
    expect(verifyInclusionProof(leafHash(data[0]), -1n, 13n, path, root)).toBe(false);
  });
  test("entryIncluded hashes the decoded body as a leaf and rejects malformed proofs", async () => {
    const good = (await rekorEntry(rekorFetch([], { [UUID_A]: rekorEntryFor({ uuid: UUID_A, body: { kind: "intoto" }, size: 9, index: 4 }) }).f, REKOR, UUID_A))!;
    expect(entryIncluded(good)).toBe(true);
    expect(entryIncluded({ ...good, body: Buffer.from("something else").toString("base64") })).toBe(false);
    expect(entryIncluded({ ...good, inclusionProof: null })).toBe(false);
    expect(entryIncluded({ ...good, inclusionProof: { ...good.inclusionProof!, rootHash: "zz" } })).toBe(false);
    expect(entryIncluded({ ...good, inclusionProof: { ...good.inclusionProof!, hashes: ["nothex"] } })).toBe(false);
    expect(entryIncluded({ ...good, inclusionProof: { ...good.inclusionProof!, logIndex: 99 } })).toBe(false);
  });
});

describe("rekor client and checkpoint", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = ec.publicKey.export({ type: "spki", format: "pem" }).toString();
  const entryOf = async (over: Parameters<typeof rekorEntryFor>[0]) => (await rekorEntry(rekorFetch([], { [over.uuid]: rekorEntryFor(over) }).f, REKOR, over.uuid))!;

  test("rekorSearch posts the sha256: form of the digest and keeps only well-formed uuids", async () => {
    const { f, calls } = rekorFetch([UUID_A, "not-a-uuid", 5 as never, UUID_B]);
    expect(await rekorSearch(f, REKOR, ("0x" + "11".repeat(32)) as Hex)).toEqual([UUID_A, UUID_B]);
    expect(calls[0]).toEqual({ method: "POST", url: `${REKOR}/api/v1/index/retrieve`, body: { hash: "sha256:" + "11".repeat(32) } });
    expect(await rekorSearch(rekorFetch({ nope: 1 } as never).f, REKOR, ("0x" + "11".repeat(32)) as Hex)).toEqual([]);
    await expect(rekorSearch(rekorFetch(new Response("", { status: 500 })).f, REKOR, ("0x" + "11".repeat(32)) as Hex)).rejects.toThrow("Rekor HTTP 500");
  });
  test("rekorEntry maps the v1 entry shape and reads the entry kind from the body", async () => {
    const e = await entryOf({ uuid: UUID_A, body: { apiVersion: "0.0.2", kind: "intoto", spec: {} }, size: 8, index: 3, integratedTime: 1_790_000_123 });
    expect(e).toMatchObject({ uuid: UUID_A, kind: "intoto", logIndex: 1003, integratedTime: 1_790_000_123 });
    expect(e.inclusionProof).toMatchObject({ logIndex: 3, treeSize: 8 });
    expect((await entryOf({ uuid: UUID_A, body: "not json at all", size: 2, index: 1 })).kind).toBeNull();
    expect(await rekorEntry(rekorFetch([]).f, REKOR, UUID_A)).toBeNull();
  });
  test("checkpointSigned needs the log's key, matching size and root, and a valid signature", async () => {
    const e = await entryOf({ uuid: UUID_A, body: { kind: "x" }, size: 6, index: 2, checkpointKey: ec.privateKey });
    expect(checkpointSigned(e, pem)).toBe(true);
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(checkpointSigned(e, other)).toBe(false);
    expect(checkpointSigned(e, "not a key")).toBe(false);
    expect(checkpointSigned({ ...e, inclusionProof: { ...e.inclusionProof!, treeSize: 7 } }, pem)).toBe(false);
    expect(checkpointSigned({ ...e, inclusionProof: { ...e.inclusionProof!, rootHash: "11".repeat(32) } }, pem)).toBe(false);
    expect(checkpointSigned({ ...e, inclusionProof: { ...e.inclusionProof!, checkpoint: e.inclusionProof!.checkpoint!.replace("\n6\n", "\n6\n0\n") } }, pem)).toBe(false);
    expect(checkpointSigned({ ...e, inclusionProof: { ...e.inclusionProof!, checkpoint: undefined } }, pem)).toBe(false);
    expect(checkpointSigned({ ...e, inclusionProof: null } as RekorEntry, pem)).toBe(false);
  });
});

// ---- the whole path, against a real router database -----------------------------------------------------

describe("attestation to registry calldata", () => {
  let h: Harness;
  let sidecar: ReturnType<typeof Bun.serve>;
  let dcap: ReturnType<typeof Bun.serve>;
  let dstack: ReturnType<typeof Bun.serve>;
  const state = { doc: {} as Parameters<typeof sidecarDocument>[1], dcapVerified: true, dstackCompose: "22".repeat(32), dcapBodies: [] as unknown[] };

  beforeAll(async () => {
    sidecar = Bun.serve({ port: 0, fetch: (req) => Response.json(sidecarDocument(new URL(req.url).searchParams.get("nonce") ?? "", state.doc)) });
    dcap = Bun.serve({
      port: 0,
      fetch: async (req) => {
        state.dcapBodies.push(await req.json());
        return Response.json(state.dcapVerified ? { verified: true } : { verified: false, tcb_status: "Revoked" });
      },
    });
    dstack = Bun.serve({ port: 0, fetch: () => Response.json({ is_valid: true, details: { quote_verified: true, event_log_verified: true, tcb_info: { mrtd: REGS.mrtd, compose_hash: state.dstackCompose } } }) });
    h = await startRouter({
      providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama] }, { id: "pending", name: "Pending", models: [MODELS.qwen], live: false }],
      env: { MEASUREMENTS_ENABLED: "true", TDX_VERIFIER_URL: `http://127.0.0.1:${dcap.port}/verify`, MEASUREMENT_REGISTRY_ADDRESS: REGISTRY, REKOR_URL: REKOR, DSTACK_VERIFIER_URL: `http://127.0.0.1:${dstack.port}/verify` },
    });
    await h.ctx.db.update(providers).set({ teeKind: "tdx", attestationUrl: `http://127.0.0.1:${sidecar.port}/attest` }).where(eq(providers.id, "alpha"));
  });
  afterAll(async () => {
    sidecar.stop(true);
    dcap.stop(true);
    dstack.stop(true);
    await h.close();
  });
  beforeEach(async () => {
    state.doc = {};
    state.dcapVerified = true;
    state.dstackCompose = "22".repeat(32);
    state.dcapBodies = [];
    h.ctx.cfg.measurements.enabled = true;
    h.ctx.cfg.measurements.rekorPublicKey = undefined;
    h.ctx.cfg.attestation.verifiers = ["dcap"];
    await h.ctx.db.delete(measurements);
    await h.ctx.db.delete(attestations);
    await h.ctx.db.update(providers).set({ attested: false, attestationHash: null, attestedAt: null }).where(eq(providers.id, "alpha"));
  });

  const rows = () => h.ctx.db.select().from(measurements);
  const attest = async () => ((await runAttestor(h.ctx)).results[0] as { ok: boolean; reason?: string });
  const publicView = async (id = "alpha") => h.request(`/api/v1/attestation/${id}`);
  const readyRow = async (over: Partial<typeof measurements.$inferInsert> = {}) => {
    await attest();
    await h.ctx.db.update(measurements).set({ status: "ready", rekorUuid: UUID_A, rekorEntry: "0x" + "ab".repeat(32), rekorLogIndex: 1004, rekorKind: "intoto", rekorInclusionVerified: true, rekorCheckedAt: new Date(), ...over });
    return (await rows())[0];
  };

  test("a verified sidecar quote records the bound digests as an observed measurement", async () => {
    expect(await attest()).toMatchObject({ ok: true });
    const [row] = await rows();
    expect(row).toMatchObject({ providerId: "alpha", status: "observed", verifier: "dcap", teeKind: "tdx", imageDigest: "0x" + "11".repeat(32), composeHash: "0x" + "22".repeat(32), modelDigest: "0x" + "33".repeat(32), rekorUuid: null });
    expect(row.quote).toMatch(/^[0-9a-f]+$/);
    expect(row.quoteProofHash).toBe(keccak256(`0x${row.quote}`));
    const [att] = await h.ctx.db.select().from(attestations).where(eq(attestations.ok, true));
    expect(att.detail).toMatchObject({ verifiers: ["dcap"] });
    expect(row.reportHash).toBe(att.reportHash);
    expect(state.dcapBodies).toHaveLength(1);
  });
  test("re-attesting the same digests only refreshes last-seen; another model digest under the same image and compose hash conflicts", async () => {
    await attest();
    const [first] = await rows();
    await new Promise((r) => setTimeout(r, 15));
    await attest();
    const [second] = await rows();
    expect(await rows()).toHaveLength(1);
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
    expect(second.quote).toBe(first.quote);
    expect(second.supersededAt).toBeNull();
    // Nothing is recorded or rewritten, and since no recorded row describes that quote, none is current until one does.
    expect(await recordMeasurement(h.ctx, { providerId: "alpha", digests: { imageDigest: first.imageDigest as Hex, composeHash: first.composeHash as Hex, modelDigest: ("0x" + "99".repeat(32)) as Hex }, verifiers: ["dcap"], teeKind: "tdx", quoteHex: "00", reportHash: "0x0" })).toEqual({ status: "conflict", id: first.id, superseded: [first.id] });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ modelDigest: first.modelDigest, supersededBy: null });
    expect(await currentMeasurement(h.ctx, "alpha")).toBeNull();
    await attest();
    expect(await currentMeasurement(h.ctx, "alpha")).toMatchObject({ id: first.id, supersededAt: null });
    // a new image is a new row too, and it supersedes the previous one
    state.doc = { digests: { ...DIGESTS, image: "sha256:" + "55".repeat(32) } };
    await attest();
    expect(await rows()).toHaveLength(2);
    const current = (await currentMeasurement(h.ctx, "alpha"))!;
    expect(current.imageDigest).toBe("0x" + "55".repeat(32));
    expect(await measurementHistory(h.ctx, "alpha")).toMatchObject([{ id: first.id, supersededBy: current.id }]);
  });
  test("a new compose hash under the same image, in a verified quote, is a new row that supersedes the previous one", async () => {
    const old = await readyRow();
    await runKeeper(h.ctx);
    state.doc = { digests: { ...DIGESTS, compose: "sha256:" + "44".repeat(32) } };
    expect(await attest()).toMatchObject({ ok: true });
    const [prev, next] = await h.ctx.db.select().from(measurements).orderBy(measurements.id);
    expect(await rows()).toHaveLength(2);
    expect(next).toMatchObject({ imageDigest: old.imageDigest, composeHash: "0x" + "44".repeat(32), modelDigest: old.modelDigest, status: "observed", rekorUuid: null, supersededAt: null, supersededBy: null });
    // the previous row is kept as it was, with its log entry and calldata, and marked superseded by the new one
    expect(prev).toMatchObject({ id: old.id, composeHash: old.composeHash, status: "ready", rekorUuid: UUID_A, rekorInclusionVerified: true, supersededBy: next.id });
    expect(prev.supersededAt).not.toBeNull();
    expect(prev.calldata).not.toBeNull();
    expect((await currentMeasurement(h.ctx, "alpha"))!.id).toBe(next.id);

    // a quote that does not verify records nothing, whatever it commits to
    state.dcapVerified = false;
    state.doc = { digests: { ...DIGESTS, compose: "sha256:" + "66".repeat(32) } };
    expect(await attest()).toMatchObject({ ok: false });
    expect(await rows()).toHaveLength(2);
    expect((await currentMeasurement(h.ctx, "alpha"))!.id).toBe(next.id);

    // going back to the earlier compose file makes its row current again, with its own entry
    state.dcapVerified = true;
    state.doc = {};
    expect(await attest()).toMatchObject({ ok: true });
    expect(await rows()).toHaveLength(2);
    expect(await currentMeasurement(h.ctx, "alpha")).toMatchObject({ id: old.id, supersededAt: null, supersededBy: null, rekorUuid: UUID_A });
    expect(await measurementHistory(h.ctx, "alpha")).toMatchObject([{ id: next.id, supersededBy: old.id }]);
  });
  test("superseded rows are history: the log is not searched for them and the keeper builds no calldata for them", async () => {
    await attest();
    state.doc = { digests: { ...DIGESTS, compose: "sha256:" + "44".repeat(32) } };
    await attest();
    const { f, calls } = rekorFetch([]);
    expect(await watchRekor(h.ctx, { fetchImpl: f })).toMatchObject({ checked: 1, missing: 1 });
    expect(calls).toHaveLength(1);
    await h.ctx.db.update(measurements).set({ status: "ready", rekorUuid: UUID_A, rekorEntry: "0x" + "ab".repeat(32), rekorInclusionVerified: true });
    expect(await runKeeper(h.ctx)).toMatchObject({ built: 1 });
    const [prev, next] = await h.ctx.db.select().from(measurements).orderBy(measurements.id);
    expect(prev.calldata).toBeNull();
    expect(next.calldata).not.toBeNull();
  });
  test("a compose change stays visible as a measurement change in the attestation history", async () => {
    await h.ctx.db.delete(attestationEvents);
    await attest();
    state.doc = { digests: { ...DIGESTS, compose: "sha256:" + "44".repeat(32) } };
    await attest();
    const events = await h.ctx.db.select().from(attestationEvents).where(eq(attestationEvents.providerId, "alpha")).orderBy(attestationEvents.id);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "attestation", ok: true, measurementChanged: false });
    expect(events[1]).toMatchObject({ kind: "attestation", ok: true, measurementChanged: true, measurements: { compose_hash: "0x" + "44".repeat(32) } });
    expect(events[1].detail).toMatchObject({ changed: ["compose_hash"], previous: { compose_hash: "0x" + "22".repeat(32) } });
  });
  test("nothing is recorded when measurements are off, and the quote still has to pass", async () => {
    h.ctx.cfg.measurements.enabled = false;
    expect(await attest()).toMatchObject({ ok: true });
    expect(await rows()).toHaveLength(0);
    h.ctx.cfg.measurements.enabled = true;
    state.dcapVerified = false;
    expect(await attest()).toMatchObject({ ok: false });
    expect(await rows()).toHaveLength(0);
  });
  test("bindings the quote does not commit to fail the attestation and record nothing", async () => {
    state.doc = { tamperReportData: true };
    expect(await attest()).toMatchObject({ ok: false, reason: "sidecar bindings are not committed in report_data" });
    state.doc = { bindings: { ...bindingsFor(), model_digest: "" } };
    expect(await attest()).toMatchObject({ ok: false, reason: expect.stringContaining("valid image, compose and model digests") });
    expect(await rows()).toHaveLength(0);
    expect(state.dcapBodies).toHaveLength(0); // rejected before any verifier is asked
  });
  test("simulated evidence attests only where dev attestation is allowed and never records a measurement", async () => {
    state.doc = { dev: true };
    expect(await attest()).toMatchObject({ ok: true });
    expect(await rows()).toHaveLength(0);
    expect(state.dcapBodies).toHaveLength(0);
    h.ctx.cfg.attestation.allowDev = false;
    try {
      expect(await attest()).toMatchObject({ ok: false, reason: "dev attestation is disabled" });
    } finally {
      h.ctx.cfg.attestation.allowDev = true;
    }
    expect(await rows()).toHaveLength(0);
  });
  test("with dstack listed, the compose hash in the verified event log must equal the one in the bindings", async () => {
    h.ctx.cfg.attestation.verifiers = ["dcap", "dstack"];
    state.doc = { eventLog: "[]" };
    state.dstackCompose = "77".repeat(32);
    expect(await attest()).toMatchObject({ ok: false, reason: "compose hash in the bindings does not match the verified event log" });
    expect(await rows()).toHaveLength(0);
    state.dstackCompose = "22".repeat(32);
    expect(await attest()).toMatchObject({ ok: true });
    expect((await rows())[0].verifier).toBe("dcap,dstack");
  });

  test("the Rekor watcher makes an attested row ready with the earliest entry whose proof verifies", async () => {
    await attest();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    h.ctx.cfg.measurements.rekorPublicKey = ec.publicKey.export({ type: "spki", format: "pem" }).toString();
    const { f, calls } = rekorFetch([UUID_A, UUID_B], {
      [UUID_A]: rekorEntryFor({ uuid: UUID_A, body: { kind: "hashedrekord" }, size: 20, index: 7, integratedTime: 1_790_000_500, tamper: "proof" }),
      [UUID_B]: rekorEntryFor({ uuid: UUID_B, body: { kind: "intoto" }, size: 20, index: 9, integratedTime: 1_790_000_700, checkpointKey: ec.privateKey }),
    });
    expect(await watchRekor(h.ctx, { fetchImpl: f })).toEqual({ checked: 1, ready: 1, missing: 0, failed: 0 });
    const [row] = await rows();
    expect(row).toMatchObject({ status: "ready", rekorUuid: UUID_B, rekorEntry: "0x" + "cd".repeat(32), rekorKind: "intoto", rekorLogIndex: 1009, rekorInclusionVerified: true, rekorCheckpointVerified: true, rekorError: null });
    expect(row.rekorIntegratedAt!.getTime()).toBe(1_790_000_700_000);
    expect(calls[0]).toMatchObject({ method: "POST", body: { hash: "sha256:" + "11".repeat(32) } });
    // a ready row is not looked up again
    expect(await watchRekor(h.ctx, { fetchImpl: f })).toMatchObject({ checked: 0 });
  });
  test("without the log key the checkpoint is reported unverified; a tampered root or proof is never accepted", async () => {
    await attest();
    const bad = rekorFetch([UUID_A, UUID_B], {
      [UUID_A]: rekorEntryFor({ uuid: UUID_A, body: { kind: "x" }, size: 5, index: 1, tamper: "root" }),
      [UUID_B]: rekorEntryFor({ uuid: UUID_B, body: { kind: "x" }, size: 5, index: 1, tamper: "proof" }),
    });
    expect(await watchRekor(h.ctx, { fetchImpl: bad.f })).toMatchObject({ ready: 0, missing: 1 });
    let [row] = await rows();
    expect(row.status).toBe("observed");
    expect(row.rekorError).toContain("2 unverifiable");
    expect(row.rekorCheckedAt).not.toBeNull();
    const good = rekorFetch([UUID_A], { [UUID_A]: rekorEntryFor({ uuid: UUID_A, body: { kind: "x" }, size: 5, index: 1 }) });
    expect(await watchRekor(h.ctx, { fetchImpl: good.f })).toMatchObject({ ready: 1 });
    [row] = await rows();
    expect(row).toMatchObject({ status: "ready", rekorCheckpointVerified: false, rekorError: null });
  });
  test("no entries leaves the row observed; a Rekor outage is recorded and does not move it", async () => {
    await attest();
    expect(await watchRekor(h.ctx, { fetchImpl: rekorFetch([]).f })).toEqual({ checked: 1, ready: 0, missing: 1, failed: 0 });
    let [row] = await rows();
    expect(row).toMatchObject({ status: "observed", rekorError: null });
    expect(row.rekorCheckedAt).not.toBeNull();
    expect(await watchRekor(h.ctx, { fetchImpl: rekorFetch(new Response("", { status: 503 })).f })).toEqual({ checked: 1, ready: 0, missing: 0, failed: 1 });
    [row] = await rows();
    expect(row).toMatchObject({ status: "observed", rekorError: "Rekor HTTP 503" });
  });

  test("the keeper builds register() calldata for ready rows and sends nothing", async () => {
    const row = await readyRow();
    expect(await runKeeper(h.ctx)).toEqual({ built: 1, skippedStale: 0, target: REGISTRY });
    const [built] = await rows();
    expect(built).toMatchObject({ status: "ready", calldataTarget: REGISTRY, txHash: null });
    const decoded = decodeFunctionData({ abi: MeasurementRegistryAbi, data: built.calldata as Hex });
    expect(decoded.functionName).toBe("register");
    const [pid, m, proof] = decoded.args as [Hex, Record<string, unknown>, Hex];
    expect(pid).toBe(providerIdHash("alpha"));
    expect(m).toEqual({ imageDigest: row.imageDigest, composeHash: row.composeHash, modelDigest: row.modelDigest, rekorEntry: "0x" + "ab".repeat(32), attestedAt: 0n, revoked: false });
    expect(proof).toBe(`0x${row.quote}`);
    expect(keccak256(proof)).toBe(row.quoteProofHash);
    expect(built.calldata).toBe(buildRegisterCalldata(row));
    // idempotent
    expect(await runKeeper(h.ctx)).toMatchObject({ built: 0 });
  });
  test("the keeper skips observed rows, rows no longer being attested and rows without a log entry", async () => {
    await attest();
    expect(await runKeeper(h.ctx)).toMatchObject({ built: 0 });
    await readyRow({ lastSeenAt: new Date(Date.now() - 24 * 3_600_000) });
    expect(await runKeeper(h.ctx)).toMatchObject({ built: 0, skippedStale: 1 });
    expect((await rows())[0].calldata).toBeNull();
    const [stored] = await rows();
    expect(() => buildRegisterCalldata({ ...stored, rekorEntry: null })).toThrow("no transparency-log entry");
  });
  test("the registry read-back is the only way a measurement becomes registered or revoked", async () => {
    await readyRow();
    await runKeeper(h.ctx);
    const [row] = await rows();
    await recordSubmission(h.ctx, row.id, "0x" + "ee".repeat(32));
    expect((await rows())[0]).toMatchObject({ status: "ready", txHash: "0x" + "ee".repeat(32) });
    await expect(recordSubmission(h.ctx, row.id, "nope")).rejects.toThrow("0x-prefixed");
    await expect(recordSubmission(h.ctx, 9999, "0x" + "ee".repeat(32))).rejects.toThrow("only a ready measurement");

    const asked: unknown[][] = [];
    expect(await reconcileRegistry(h.ctx, async (...a) => (asked.push(a), false))).toEqual({ registered: 0, revoked: 0 });
    expect(asked[0]).toEqual([providerIdHash("alpha"), row.imageDigest, row.modelDigest, row.composeHash]);
    expect((await rows())[0].status).toBe("ready");
    expect(await reconcileRegistry(h.ctx, async () => true)).toEqual({ registered: 1, revoked: 0 });
    expect((await rows())[0]).toMatchObject({ status: "registered" });
    expect((await rows())[0].registeredAt).not.toBeNull();
    expect(await reconcileRegistry(h.ctx, async () => false)).toEqual({ registered: 0, revoked: 1 });
    expect((await rows())[0]).toMatchObject({ status: "revoked" });
    expect((await rows())[0].revokedAt).not.toBeNull();
    expect(await currentMeasurement(h.ctx, "alpha")).toBeNull();
    // a failing read leaves the row alone
    await h.ctx.db.update(measurements).set({ status: "registered", revokedAt: null });
    expect(await reconcileRegistry(h.ctx, async () => { throw new Error("rpc down"); })).toEqual({ registered: 0, revoked: 0 });
    expect((await rows())[0].status).toBe("registered");
    h.ctx.cfg.measurements.registry = null;
    expect(await reconcileRegistry(h.ctx, async () => true)).toEqual({ skipped: "no MEASUREMENT_REGISTRY_ADDRESS" });
    h.ctx.cfg.measurements.registry = REGISTRY;
  });
  test("the registry holds one measurement per image: its record for an earlier compose hash does not register the current row", async () => {
    const old = await readyRow();
    state.doc = { digests: { ...DIGESTS, compose: "sha256:" + "44".repeat(32) } };
    await attest();
    await h.ctx.db.update(measurements).set({ status: "ready", rekorUuid: UUID_B, rekorEntry: "0x" + "cd".repeat(32), rekorInclusionVerified: true }).where(eq(measurements.composeHash, "0x" + "44".repeat(32)));
    // the registry reports the image and model attested, but what it holds is the earlier compose hash
    expect(await reconcileRegistry(h.ctx, async (_p, _i, _m, compose) => compose === old.composeHash)).toEqual({ registered: 1, revoked: 0 });
    const [prev, next] = await h.ctx.db.select().from(measurements).orderBy(measurements.id);
    expect(prev).toMatchObject({ id: old.id, status: "registered" });
    expect(next).toMatchObject({ status: "ready", registeredAt: null });
    const d = (await (await publicView()).json()).data;
    expect(d.measurement).toMatchObject({ compose_hash: "0x" + "44".repeat(32), registry: { state: "not_submitted" } });
    expect(d.checks.registered_on_chain).toBe(false);
    expect(d.measurement_history).toMatchObject([{ compose_hash: old.composeHash, status: "registered" }]);
  });
  test("the job does nothing unless enabled, and otherwise runs lookup, keeper and read-back in order", async () => {
    await attest();
    h.ctx.cfg.measurements.enabled = false;
    expect(await runMeasurements(h.ctx, { fetchImpl: rekorFetch([]).f })).toEqual({ skipped: "MEASUREMENTS_ENABLED is false" });
    h.ctx.cfg.measurements.enabled = true;
    const { f } = rekorFetch([UUID_A], { [UUID_A]: rekorEntryFor({ uuid: UUID_A, body: { kind: "intoto" }, size: 4, index: 2 }) });
    const r = (await runMeasurements(h.ctx, { fetchImpl: f, read: async () => false })) as Record<string, any>;
    expect(r.rekor).toMatchObject({ ready: 1 });
    expect(r.keeper).toMatchObject({ built: 1, target: REGISTRY });
    expect(r.registry).toEqual({ registered: 0, revoked: 0 });
  });

  test("the public endpoint says unverified for unknown, unreviewed and never-attested providers", async () => {
    expect((await publicView("nobody")).status).toBe(404);
    expect((await publicView("pending")).status).toBe(404);
    const res = await publicView();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ provider: "alpha", status: "unverified", reason: "no_attestation", attested_at: null, attestation_hash: null, verifiers: [], measurement: null });
    expect(data.checks).toEqual({ quote_verified: false, digests_bound_to_quote: false, transparency_log_entry: false, transparency_log_checkpoint_signature: false, registered_on_chain: false });
    expect(data.not_checked.length).toBeGreaterThan(0);
  });
  test("a failed attempt and a stale attestation are unverified, with the reason", async () => {
    state.dcapVerified = false;
    await attest();
    expect((await (await publicView()).json()).data).toMatchObject({ status: "unverified", reason: "last_attempt_failed" });
    state.dcapVerified = true;
    await attest();
    expect((await (await publicView()).json()).data.status).toBe("attested");
    await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 10) }).where(eq(providers.id, "alpha"));
    // the last recorded measurement stays visible, marked as not currently attested
    const stale = (await (await publicView()).json()).data;
    expect(stale).toMatchObject({ status: "unverified", reason: "attestation_stale", attested_at: null, verifiers: [], measurement: { image_digest: "0x" + "11".repeat(32), attested_now: false } });
    expect(stale.checks).toMatchObject({ quote_verified: false, digests_bound_to_quote: false });
  });
  test("an attested provider reports what was verified and what is still missing, at each stage", async () => {
    await attest();
    let d = (await (await publicView()).json()).data;
    expect(d).toMatchObject({ status: "attested", tee: "tdx", verifiers: ["dcap"] });
    expect(d.attestation_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.measurement).toMatchObject({ status: "observed", image_digest: "0x" + "11".repeat(32), transparency_log: { found: false, inclusion_verified: false }, registry: { address: REGISTRY, state: "not_submitted", tx_hash: null } });
    expect(d.checks).toMatchObject({ quote_verified: true, digests_bound_to_quote: true, transparency_log_entry: false, registered_on_chain: false });
    expect(d.measurement).not.toHaveProperty("quote"); // the proof is stored and registered, not served

    const { f } = rekorFetch([UUID_A], { [UUID_A]: rekorEntryFor({ uuid: UUID_A, body: { kind: "intoto" }, size: 4, index: 2 }) });
    await runMeasurements(h.ctx, { fetchImpl: f, read: async () => false });
    d = (await (await publicView()).json()).data;
    expect(d.measurement).toMatchObject({ status: "ready", transparency_log: { found: true, entry: "0x" + "ab".repeat(32), inclusion_verified: true, checkpoint_signature_verified: false, kind: "intoto" }, registry: { state: "calldata_ready_not_submitted" } });
    expect(d.checks).toMatchObject({ transparency_log_entry: true, transparency_log_checkpoint_signature: false, registered_on_chain: false });

    await runMeasurements(h.ctx, { fetchImpl: f, read: async () => true });
    d = (await (await publicView()).json()).data;
    expect(d.measurement.registry.state).toBe("registered");
    expect(d.checks.registered_on_chain).toBe(true);
  });
  test("after a compose change the record describes only the current measurement; the earlier one is history with its own entry", async () => {
    await readyRow();
    await h.ctx.catalog.refresh();
    expect(h.ctx.catalog.manifests.get("alpha")).toEqual({ rekor_entry: UUID_A, registry_tx: null });
    let d = (await (await publicView()).json()).data;
    expect(d.measurement).toMatchObject({ compose_hash: "0x" + "22".repeat(32), transparency_log: { found: true, uuid: UUID_A } });
    expect(d.measurement_history).toEqual([]);

    state.doc = { digests: { ...DIGESTS, compose: "sha256:" + "44".repeat(32) } };
    await attest();
    d = (await (await publicView()).json()).data;
    expect(d).toMatchObject({ status: "attested" });
    expect(d.measurement).toMatchObject({ compose_hash: "0x" + "44".repeat(32), status: "observed", attested_now: true, transparency_log: { found: false, uuid: null, entry: null, subject: null, bundle: null } });
    // the entry that belongs to the earlier compose hash is not given to the new one
    expect(d.checks).toMatchObject({ quote_verified: true, digests_bound_to_quote: true, transparency_log_entry: false, transparency_log_checkpoint_signature: false });
    expect(d.measurement_history).toEqual([
      {
        image_digest: "0x" + "11".repeat(32),
        compose_hash: "0x" + "22".repeat(32),
        model_digest: "0x" + "33".repeat(32),
        status: "ready",
        first_attested_at: expect.any(String),
        last_seen_at: expect.any(String),
        superseded_at: expect.any(String),
        transparency_log: { uuid: UUID_A, log_index: 1004, entry_url: `${REKOR}/api/v1/log/entries/${UUID_A}`, subject: "image_digest", bundle_digest: null },
      },
    ]);
    // the models output carries no log entry for the provider until its current measurement has one
    await h.ctx.catalog.refresh();
    expect(h.ctx.catalog.manifests.get("alpha")).toEqual({ rekor_entry: null, registry_tx: null });
  });
  test("the sidecar's router cross-check reads this endpoint's response", async () => {
    // the sidecar calls GET <router>/api/v1/attestation/<provider> and looks for the served model digest in it
    const viaRouter = (async (url: URL | string) => h.request(new URL(String(url)).pathname)) as unknown as typeof fetch;
    const cfg = { url: "https://router.example", providerId: "alpha", failClosed: true };
    const served = "sha256:" + "33".repeat(32);
    await expect(verifyAgainstRouter(cfg, { modelDigest: served }, viaRouter)).rejects.toMatchObject({ code: "ROUTER_RECORD_UNRECOGNISED" }); // nothing recorded yet
    await attest();
    expect(await verifyAgainstRouter(cfg, { modelDigest: served }, viaRouter)).toEqual({ checked: true, registeredDigests: [served] });
    await expect(verifyAgainstRouter(cfg, { modelDigest: "sha256:" + "44".repeat(32) }, viaRouter)).rejects.toMatchObject({ code: "ROUTER_DIGEST_MISMATCH" });
    // a restart after the attestation went stale can still be checked against the last record
    await h.ctx.db.update(providers).set({ attested: false }).where(eq(providers.id, "alpha"));
    expect(await verifyAgainstRouter(cfg, { modelDigest: served }, viaRouter)).toMatchObject({ checked: true });
    await expect(verifyAgainstRouter({ ...cfg, providerId: "nobody" }, { modelDigest: served }, viaRouter)).rejects.toMatchObject({ code: "ROUTER_UNREACHABLE" });
  });
  test("simulated attestation shows as simulated outside production and as unverified in production", async () => {
    state.doc = { dev: true };
    await attest();
    expect((await (await publicView()).json()).data).toMatchObject({ status: "simulated", tee: "dev", verifiers: [], measurement: null });
    h.ctx.cfg.production = true;
    try {
      expect((await (await publicView()).json()).data).toMatchObject({ status: "unverified", reason: "simulated_evidence_refused" });
    } finally {
      h.ctx.cfg.production = false;
    }
  });
});

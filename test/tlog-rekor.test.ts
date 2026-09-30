import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { receiptKeys, tlogEntries, tlogRekorAnchors } from "../src/db/schema.ts";
import { log, sha256 } from "../src/lib/util.ts";
import { hashedrekordEntry, signBytes } from "../src/services/measurement-bundle.ts";
import { attestationBindingEntry } from "../src/tlog/entries.ts";
import { leafHash, MerkleTree } from "../src/tlog/merkle.ts";
import { formatCheckpoint, formatSignerKey, noteSigner, parseCheckpoint, parseNote, SIG_COSIGNATURE_V1, signatureLine } from "../src/tlog/note.ts";
import { anchorArtifact, anchorView, type AnchorRow } from "../src/tlog/rekor.ts";
import { SplitViewDetected, TransparencyError, TransparencyLog as ClientLog, verifyRekorInclusion } from "../packages/client/src/index.ts";
import { spkiFromText } from "../packages/client/src/ecdsa.ts";
import { startRouter, type Harness } from "./helpers.ts";
import { MockRekor } from "./rekor-mock.ts";

// Public-log anchoring of the transparency log's checkpoints in Rekor: submission when the checkpoint changes, the minimum
// interval, backoff and pending entries, the verification of what Rekor returns, the endpoints, the production guard that
// accepts anchoring in place of witnesses, and the client's Rekor mode against a split view.

setDefaultTimeout(60_000);

const ORIGIN = "router.test/tlog";
const BASE = "http://router.test";
const MIN = 60_000;
const anchorKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ANCHOR_PRIVATE = anchorKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ANCHOR_PUBLIC = anchorKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

const appFetch = (h: Harness, override?: (u: URL) => Response | Promise<Response> | null) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const o = override ? await override(u) : null;
    return o ?? h.app.request(u.pathname + u.search, init);
  }) as typeof fetch;

/** A Rekor record in the shape the router serves, from the raw entry a Rekor log returns. */
function recordOf(json: Record<string, any>) {
  const [uuid, raw] = Object.entries(json)[0]!;
  const ip = raw.verification.inclusionProof;
  return {
    uuid,
    body: raw.body,
    log_index: raw.logIndex,
    integrated_time: raw.integratedTime,
    log_id: raw.logID,
    signed_entry_timestamp: raw.verification.signedEntryTimestamp,
    inclusion_proof: { log_index: ip.logIndex, tree_size: ip.treeSize, root_hash: ip.rootHash, hashes: ip.hashes, checkpoint: ip.checkpoint },
  };
}

describe("Rekor anchoring of checkpoints", () => {
  let h: Harness;
  const rekor = new MockRekor();
  let clock = 1_800_000_000_000;
  let logKey: string;
  let initial = 0;
  const posts = () => rekor.calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v1/log/entries")).length;
  const tlog = () => h.ctx.tlog!;
  const anchor = () => h.ctx.tlog!.rekor!;
  const grow = async (n = 1) => {
    await tlog().append(Array.from({ length: n }, () => attestationBindingEntry(`p-${randomBytes(4).toString("hex")}`, { tls_pubkey: randomBytes(8).toString("hex") }, null)));
    return tlog().size();
  };
  const rows = () => h.ctx.db.select().from(tlogRekorAnchors).orderBy(asc(tlogRekorAnchors.id));
  const receiptDigest = async () => {
    const [k] = await h.ctx.db.select().from(receiptKeys).where(eq(receiptKeys.id, h.ctx.signer.keyId));
    return sha256(Buffer.from(k.publicKey, "hex"));
  };

  beforeAll(async () => {
    h = await startRouter({ env: { TLOG_ENABLED: "true", TLOG_ORIGIN: ORIGIN, TLOG_REKOR_ENABLED: "true", TLOG_REKOR_SIGNING_KEY: ANCHOR_PRIVATE, REKOR_URL: rekor.baseUrl, REKOR_PUBLIC_KEY: rekor.publicKeyPem } });
    await tlog().idle();
    anchor().fetch = rekor.fetch;
    anchor().wait = async () => undefined;
    anchor().now = () => clock;
    logKey = tlog().verifierKey;
  });
  afterAll(async () => {
    await h.close();
  });

  test("the newest checkpoint is submitted once, as a hashedrekord over the signed note, and its entry is verified and stored", async () => {
    const size = await tlog().size();
    expect(size).toBeGreaterThan(0);
    initial = size;
    const r = await tlog().run();
    expect(r.rekor).toMatchObject({ status: "anchored", size });
    expect(posts()).toBe(1);

    // What was submitted: the checkpoint as the log signed it (no cosignatures), hashed, signed with the anchoring key.
    const cp = (await tlog().checkpointAt(size))!;
    const artifact = anchorArtifact(cp);
    expect(artifact.toString()).toBe(await (await h.request("/tlog/checkpoint")).text());
    const sent = rekor.calls.find((c) => c.method === "POST")!.body;
    expect(sent.kind).toBe("hashedrekord");
    expect(sent.spec.data.hash.value).toBe(createHash("sha256").update(artifact).digest("hex"));
    expect(Buffer.from(sent.spec.signature.publicKey.content, "base64").toString()).toBe(ANCHOR_PUBLIC);

    const [row] = await rows();
    expect(row).toMatchObject({ size, status: "verified", rekorUrl: rekor.baseUrl, checkpointVerified: true, setVerified: true, artifactSha256: sent.spec.data.hash.value });
    expect(row.uuid).toMatch(/^[0-9a-f]{80}$/);
    expect(row.logIndex).toBeGreaterThanOrEqual(1000);
    expect(row.integratedTime).toBeGreaterThan(0);
    expect(row.inclusionProof).toMatchObject({ treeSize: rekor.size });
    expect(row.inclusionProof!.checkpoint).toContain("\n\n— rekor.test ");
    expect(row.signedEntryTimestamp).toBeTruthy();

    // The same checkpoint is never submitted again, however much time passes.
    clock += 60 * MIN;
    expect((await tlog().run()).rekor).toMatchObject({ status: "unchanged", size });
    expect(posts()).toBe(1);
  });

  test("a changed checkpoint is submitted at most once per TLOG_REKOR_MIN_INTERVAL_MS", async () => {
    expect(anchor().minIntervalMs).toBe(10 * MIN);
    const first = await grow();
    clock += 10 * MIN;
    expect((await tlog().run()).rekor).toMatchObject({ status: "anchored", size: first });
    const second = await grow();
    clock += 3 * MIN;
    expect((await tlog().run()).rekor).toMatchObject({ status: "throttled", size: second });
    const third = await grow(2);
    clock += 6 * MIN;
    expect((await tlog().run()).rekor).toMatchObject({ status: "throttled", size: third });
    expect(posts()).toBe(2);
    clock += 1 * MIN;
    expect((await tlog().run()).rekor).toMatchObject({ status: "anchored", size: third });
    expect(posts()).toBe(3);
    // Only the newest checkpoint is anchored; the ones in between are covered by consistency with it.
    expect((await rows()).map((r) => r.size)).toEqual([initial, first, third]);
    expect(await anchor().at(second)).toBeNull();
    expect((await anchor().at(third))?.status).toBe("verified");
  });

  test("Rekor failures back off and are logged as codes only; the key log keeps appending", async () => {
    const seen: { message: string; fields?: Record<string, unknown> }[] = [];
    const warn = log.warn;
    log.warn = (message, fields) => void seen.push({ message, fields });
    try {
      rekor.outage = 503;
      const size = await grow();
      clock += 10 * MIN;
      expect((await tlog().run()).rekor).toMatchObject({ status: "failed", size, code: "rekor_http_503" });
      // The first retry waits the minimum interval, the next one twice that.
      clock += 10 * MIN;
      expect((await tlog().run()).rekor).toMatchObject({ status: "failed", code: "rekor_http_503" });
      clock += 15 * MIN;
      expect((await tlog().run()).rekor).toMatchObject({ status: "backoff" });
      // Appending does not wait for Rekor.
      expect(await grow()).toBe(size + 1);
      rekor.outage = null;
      clock += 5 * MIN;
      expect((await tlog().run()).rekor).toMatchObject({ status: "anchored", size: size + 1 });
    } finally {
      log.warn = warn;
      rekor.outage = null;
    }
    const failures = seen.filter((s) => s.message === "tlog rekor anchor failed");
    expect(failures.length).toBe(2);
    for (const f of failures) expect(Object.keys(f.fields ?? {}).sort()).toEqual(["code", "failures"]);
    expect(JSON.stringify(seen)).not.toContain("unavailable"); // Rekor's own message text is never logged
  });

  test("an entry that comes back without an inclusion proof is kept pending and finished later, not submitted twice", async () => {
    rekor.withholdProofs = true;
    const size = await grow();
    clock += 10 * MIN;
    const before = posts();
    try {
      expect((await tlog().run()).rekor).toMatchObject({ status: "pending", size });
    } finally {
      rekor.withholdProofs = false;
    }
    expect(posts()).toBe(before + 1);
    const pending = (await rows()).find((r) => r.size === size)!;
    expect(pending).toMatchObject({ status: "pending", logIndex: null, inclusionProof: null });
    expect(await anchor().at(size)).toBeNull(); // not served while pending
    // The next run reads it back, verifies it and does not submit again (the checkpoint is unchanged).
    clock += 1 * MIN;
    expect((await tlog().run()).rekor).toMatchObject({ status: "unchanged", size });
    expect(posts()).toBe(before + 1);
    expect(await anchor().at(size)).toMatchObject({ status: "verified", uuid: pending.uuid, checkpointVerified: true });
  });

  test("what Rekor returns is verified: another artifact or a broken inclusion proof is refused and nothing is stored", async () => {
    const real = rekor.fetch;
    const count = (await rows()).length;
    try {
      // A log that records a different hash than the one submitted.
      anchor().fetch = (async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          body.spec.data.hash.value = randomBytes(32).toString("hex");
          return real(url, { ...init, body: JSON.stringify(body) });
        }
        return real(url, init);
      }) as typeof fetch;
      const size = await grow();
      clock += 10 * MIN;
      expect((await tlog().run()).rekor).toMatchObject({ status: "failed", size, code: "entry_mismatch" });

      // A log whose inclusion proof does not lead to its root.
      anchor().fetch = (async (url: string, init?: RequestInit) => {
        const res = await real(url, init);
        const json = (await res.json()) as Record<string, any>;
        for (const e of Object.values(json)) if (e?.verification?.inclusionProof?.hashes?.length) e.verification.inclusionProof.hashes[0] = "00".repeat(32);
        return new Response(JSON.stringify(json), { status: res.status, headers: res.headers });
      }) as typeof fetch;
      clock += 20 * MIN;
      expect((await tlog().run()).rekor).toMatchObject({ status: "failed", size, code: "entry_mismatch" });
      expect((await rows()).length).toBe(count);
    } finally {
      anchor().fetch = real;
    }
    clock += 60 * MIN;
    expect((await tlog().run()).rekor).toMatchObject({ status: "anchored" });
  });

  test("the endpoints: the summary names the newest anchor, the list pages, the key and one checkpoint's entry", async () => {
    const latest = (await anchor().latest())!;
    const info = (await (await h.request("/api/v1/tlog")).json()).data;
    expect(info.rekor).toMatchObject({ rekor_url: rekor.baseUrl, entry_type: "hashedrekord", algorithm: "ecdsa-p256-sha256", key_id: anchor().keyId, public_key_pem: ANCHOR_PUBLIC, min_interval_ms: 10 * MIN });
    expect(info.rekor.latest).toMatchObject({
      size: latest.size,
      uuid: latest.uuid,
      log_index: latest.logIndex,
      integrated_time: latest.integratedTime,
      artifact_sha256: latest.artifactSha256,
      entry_url: `${rekor.baseUrl}/api/v1/log/entries/${latest.uuid}`,
      search_url: null,
      verified: { inclusion: true, checkpoint_signature: true, signed_entry_timestamp: true },
    });
    expect(info.rekor.latest.inclusion_proof).toMatchObject({ tree_size: expect.any(Number), root_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(Object.keys(info.checkpoint)).toContain("rekor");

    const one = await h.request(`/api/v1/tlog/rekor/${latest.size}`);
    expect(one.status).toBe(200);
    expect((await one.json()).data).toEqual(info.rekor.latest);
    const none = await h.request(`/api/v1/tlog/rekor/${latest.size + 1000}`);
    expect([none.status, (await none.json()).error.type]).toEqual([404, "not_anchored"]);
    expect((await h.request("/api/v1/tlog/rekor/x")).status).toBe(400);

    const key = await h.request("/api/v1/tlog/rekor/key");
    expect(key.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await key.json()).data).toEqual({ algorithm: "ecdsa-p256-sha256", key_id: anchor().keyId, public_key_pem: ANCHOR_PUBLIC });

    const all = (await (await h.request("/api/v1/tlog/rekor")).json()).data;
    const sizes = (await rows()).filter((r) => r.status === "verified").map((r) => r.size).sort((a, b) => b - a);
    expect(all.anchors.map((a: { size: number }) => a.size)).toEqual(sizes);
    expect(all.latest.size).toBe(sizes[0]);
    expect(all.next_before).toBeNull();
    const page = (await (await h.request("/api/v1/tlog/rekor?limit=2")).json()).data;
    expect(page.anchors.map((a: { size: number }) => a.size)).toEqual(sizes.slice(0, 2));
    expect(page.next_before).toBe(sizes[1]);
    const next = (await (await h.request(`/api/v1/tlog/rekor?limit=2&before=${page.next_before}`)).json()).data;
    expect(next.anchors.map((a: { size: number }) => a.size)).toEqual(sizes.slice(2, 4));
    expect((await h.request("/api/v1/tlog/rekor?limit=0")).status).toBe(400);

    // Every served anchor checks out against Rekor's key with the client's own code.
    for (const a of all.anchors) {
      const leaf = new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.concat([Buffer.from([0]), Buffer.from(a.body, "base64")])));
      expect(await verifyRekorInclusion(a, leaf, spkiFromText(rekor.publicKeyPem))).toMatchObject({ included: true, checkpointSigned: true, setSigned: true });
    }
    // On the public Sigstore instance the record links to its search page.
    const view = anchorView({ ...(latest as AnchorRow), rekorUrl: "https://rekor.sigstore.dev" });
    expect(view.search_url).toBe(`https://search.sigstore.dev/?logIndex=${latest.logIndex}`);
  });

  test("the client accepts a key under a Rekor-anchored checkpoint, and refuses one that is not anchored yet", async () => {
    const rekorOpts = { anchorKey: ANCHOR_PUBLIC, rekorKey: rekor.publicKeyPem };
    const client = new ClientLog({ logUrl: BASE, logKey, rekor: rekorOpts, fetch: appFetch(h) });
    const digest = await receiptDigest();
    const ok = await client.requireLogged("receipt_key", digest);
    const latest = (await anchor().latest())!;
    expect(ok).toMatchObject({ kind: "receipt_key", sha256: digest, cosignedBy: [], rekor: { uuid: latest.uuid, logIndex: latest.logIndex, signedEntryTimestamp: true } });
    expect(ok.checkpoint.size).toBe(latest.size);

    // A new key: logged, but no checkpoint that includes it is anchored yet.
    await h.ctx.signer.rotateIfDue(true);
    await tlog().idle();
    const fresh = await receiptDigest();
    expect(((await client.requireLogged("receipt_key", fresh).catch((e) => e)) as TransparencyError).code).toBe("not_anchored");
    clock += 10 * MIN;
    expect((await tlog().run()).rekor).toMatchObject({ status: "anchored" });
    const before = (await client.remembered())!.size;
    const again = await client.requireLogged("receipt_key", fresh);
    expect(again.checkpoint.size).toBeGreaterThan(before);
    expect((await client.remembered())!.size).toBe(again.checkpoint.size);

    // Still refuses keys that are not logged, and anchors under keys it did not pin.
    expect(((await client.requireLogged("receipt_key", randomBytes(32)).catch((e) => e)) as TransparencyError).code).toBe("not_logged");
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    const wrongAnchor = new ClientLog({ logUrl: BASE, logKey, rekor: { ...rekorOpts, anchorKey: other }, fetch: appFetch(h) });
    const e1 = (await wrongAnchor.requireLogged("receipt_key", fresh).catch((e) => e)) as TransparencyError;
    expect([e1.code, e1.message]).toEqual(["bad_anchor", expect.stringContaining("pinned anchoring key")]);
    const wrongRekor = new ClientLog({ logUrl: BASE, logKey, rekor: { ...rekorOpts, rekorKey: other }, fetch: appFetch(h) });
    const e2 = (await wrongRekor.requireLogged("receipt_key", fresh).catch((e) => e)) as TransparencyError;
    expect([e2.code, e2.message]).toEqual(["bad_anchor", expect.stringContaining("pinned Rekor key")]);

    // Options: Rekor mode needs both keys; without it, witnesses are still required.
    expect(() => new ClientLog({ logUrl: BASE, logKey })).toThrow("witness");
    expect(() => new ClientLog({ logUrl: BASE, logKey, rekor: { anchorKey: ANCHOR_PUBLIC, rekorKey: "" } })).toThrow("rekorKey");
    expect(() => new ClientLog({ logUrl: BASE, logKey, rekor: { anchorKey: ANCHOR_PRIVATE, rekorKey: rekor.publicKeyPem } })).toThrow("private key");
    // With witnesses listed as well, both must hold: this log has no witnesses, so nothing is accepted.
    const w = noteSigner("witness.test/w", SIG_COSIGNATURE_V1, randomBytes(32));
    const both = new ClientLog({ logUrl: BASE, logKey, witnesses: [w.verifierKey], rekor: rekorOpts, fetch: appFetch(h) });
    expect(((await both.requireLogged("receipt_key", fresh).catch((e) => e)) as TransparencyError).code).toBe("not_witnessed");
  });

  test("a split view is refused: two checkpoints of one size with different roots, only one of them in Rekor", async () => {
    const rekorOpts = { anchorKey: ANCHOR_PUBLIC, rekorKey: rekor.publicKeyPem };
    const digest = await receiptDigest();
    const a = (await anchor().latest())!;
    const aNote = anchorArtifact((await tlog().checkpointAt(a.size))!).toString();
    const real = (await (await h.request(`/api/v1/tlog/proof?kind=receipt_key&sha256=${digest}`)).json()).data;
    expect(real.checkpoint.size).toBe(a.size);

    // A second tree of the same size that also contains the key (one other leaf differs), signed with the log's own key.
    const leaves = (await h.ctx.db.select({ leafHash: tlogEntries.leafHash }).from(tlogEntries).orderBy(asc(tlogEntries.idx))).slice(0, a.size).map((r) => Buffer.from(r.leafHash, "hex"));
    leaves[real.index === 0 ? 1 : 0] = leafHash(randomBytes(16));
    const forged = new MerkleTree(leaves);
    const signer = tlog().signer;
    const text = formatCheckpoint(ORIGIN, a.size, forged.root());
    const bNote = `${text}\n${signatureLine(signer.name, signer.keyId, signer.sign(Buffer.from(text)))}`;
    expect(parseCheckpoint(parseNote(bNote).text).size).toBe(parseCheckpoint(parseNote(aNote).text).size);
    const forgedProof = (rekorRecord: unknown) => ({
      data: { ...real, checkpoint: { size: a.size, root_hash: forged.root().toString("base64"), note: bNote, cosigned_by: [], witnessed: false, rekor: rekorRecord }, inclusion: forged.inclusionProof(real.index, a.size).map((p) => p.toString("base64")), consistency: null },
    });
    const serving = (rekorRecord: unknown) => (u: URL) => (u.pathname === "/api/v1/tlog/proof" ? Response.json(forgedProof(rekorRecord)) : null);

    // A client that never saw A, shown B with no Rekor entry, or with A's entry: refused.
    const fresh = new ClientLog({ logUrl: BASE, logKey, rekor: rekorOpts, fetch: appFetch(h, serving(null)) });
    expect(((await fresh.requireLogged("receipt_key", digest).catch((e) => e)) as TransparencyError).code).toBe("not_anchored");
    const borrowed = new ClientLog({ logUrl: BASE, logKey, rekor: rekorOpts, fetch: appFetch(h, serving(real.checkpoint.rekor)) });
    expect(((await borrowed.requireLogged("receipt_key", digest).catch((e) => e)) as TransparencyError).code).toBe("anchor_mismatch");

    // A client that accepted A, then shown B: refused, and A stays remembered.
    const remembered = new Map<string, string>();
    const store = { get: (o: string) => remembered.get(o) ?? null, set: (o: string, n: string) => void remembered.set(o, n) };
    const seenA = new ClientLog({ logUrl: BASE, logKey, rekor: rekorOpts, fetch: appFetch(h), store });
    await seenA.requireLogged("receipt_key", digest);
    expect(parseCheckpoint(parseNote(remembered.get(ORIGIN)!).text).size).toBe(a.size);
    const shownB = new ClientLog({ logUrl: BASE, logKey, rekor: rekorOpts, fetch: appFetch(h, serving(null)), store });
    expect(((await shownB.requireLogged("receipt_key", digest).catch((e) => e)) as TransparencyError).code).toBe("not_anchored");

    // If the log anchors B in Rekor too, B's entry is public next to A's, and a client that saw A reports the split view.
    const bArtifact = Buffer.from(bNote);
    const posted = await rekor.fetch(`${rekor.baseUrl}/api/v1/log/entries`, { method: "POST", body: JSON.stringify(hashedrekordEntry(bArtifact, signBytes(bArtifact, anchorKeys.privateKey), anchorKeys.publicKey)) });
    const bRecord = recordOf((await posted.json()) as Record<string, any>);
    const anchoredB = new ClientLog({ logUrl: BASE, logKey, rekor: rekorOpts, fetch: appFetch(h, serving(bRecord)), store });
    const split = (await anchoredB.requireLogged("receipt_key", digest).catch((e) => e)) as SplitViewDetected;
    expect(split).toBeInstanceOf(SplitViewDetected);
    expect(split.code).toBe("split_view");
    expect(split.evidence.first).toBe(remembered.get(ORIGIN)!);
    expect(split.evidence.second).toBe(bNote);
    // Anyone following the anchoring key's entries in Rekor finds one the log's own list does not explain.
    const key = Buffer.from(ANCHOR_PUBLIC).toString("base64");
    const bodyOf = (u: string) => {
      try {
        return rekor.bodyOf(u);
      } catch {
        return null; // not a JSON entry
      }
    };
    const inRekor = rekor.uuids().filter((u) => bodyOf(u)?.spec?.signature?.publicKey?.content === key).map((u) => bodyOf(u).spec.data.hash.value);
    const listed = new Set(((await (await h.request("/api/v1/tlog/rekor?limit=100")).json()).data.anchors as { artifact_sha256: string }[]).map((x) => x.artifact_sha256));
    const unexplained = inRekor.filter((hash) => !listed.has(hash));
    expect(unexplained).toContain(createHash("sha256").update(bArtifact).digest("hex"));
  });
});

describe("with anchoring off", () => {
  let h: Harness;
  beforeAll(async () => {
    const w1 = noteSigner("w1.test/w", SIG_COSIGNATURE_V1, randomBytes(32));
    const w2 = noteSigner("w2.test/w", SIG_COSIGNATURE_V1, randomBytes(32));
    h = await startRouter({ env: { TLOG_ENABLED: "true", TLOG_ORIGIN: ORIGIN, TLOG_WITNESSES: `${w1.verifierKey},${w2.verifierKey}` } });
    await h.ctx.tlog!.idle();
  });
  afterAll(async () => {
    await h.close();
  });

  test("no anchor, no Rekor endpoints and no submissions; the log itself is unchanged", async () => {
    expect(h.ctx.tlog!.rekor).toBeNull();
    const info = (await (await h.request("/api/v1/tlog")).json()).data;
    expect(info.rekor).toBeNull();
    expect(Object.keys(info.checkpoint)).not.toContain("rekor");
    for (const p of ["/api/v1/tlog/rekor", "/api/v1/tlog/rekor/key", "/api/v1/tlog/rekor/1"]) {
      const r = await h.request(p);
      expect([r.status, (await r.json()).error.type]).toEqual([404, "rekor_not_enabled"]);
    }
    const r = await h.ctx.tlog!.run();
    expect(r).not.toHaveProperty("rekor");
    expect(await h.ctx.db.select().from(tlogRekorAnchors)).toHaveLength(0);
  });
});

describe("configuration", () => {
  const seed = randomBytes(32);
  const production = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: "0x" + "1".repeat(40), CALLPAY_ADDRESS: "0x" + "1".repeat(40), PROVIDER_BOND_ADDRESS: "0x" + "1".repeat(40), RECEIPT_ANCHOR_ADDRESS: "0x" + "1".repeat(40), ROUTER_PRIVATE_KEY: "0x" + "2".repeat(64) };
  const tlog = { TLOG_ENABLED: "true", TLOG_SIGNING_KEY: formatSignerKey("router.example/tlog", seed) };
  const rekorOn = { TLOG_REKOR_ENABLED: "true", TLOG_REKOR_SIGNING_KEY: ANCHOR_PRIVATE };

  test("production accepts Rekor anchoring in place of witnesses, and refuses a log with neither", () => {
    const c = loadConfig({ ...production, ...tlog, ...rekorOn }).tlog;
    expect(c).toMatchObject({ enabled: true, origin: "router.example/tlog", witnesses: [] });
    expect(c.rekor).toMatchObject({ enabled: true, url: "https://rekor.sigstore.dev", minIntervalMs: 600_000, rekorPublicKey: null });
    expect(c.rekor.signingKey?.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    // The worker that runs the job starts with the same variables.
    const { ROUTER_PRIVATE_KEY: _r, ...worker } = production;
    expect(loadConfig({ ...worker, RUNTIME_ROLE: "worker", WORKER_JOBS: "tlog", ...tlog, ...rekorOn }).tlog.rekor.enabled).toBe(true);
    // The key may also arrive as base64 PKCS#8 or with escaped newlines.
    const der = anchorKeys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    expect(loadConfig({ ...production, ...tlog, ...rekorOn, TLOG_REKOR_SIGNING_KEY: der }).tlog.rekor.enabled).toBe(true);
    expect(loadConfig({ ...production, ...tlog, ...rekorOn, TLOG_REKOR_SIGNING_KEY: ANCHOR_PRIVATE.replace(/\n/g, "\\n") }).tlog.rekor.enabled).toBe(true);

    // Neither witnesses nor anchoring: refused, and the message names both ways to fix it.
    expect(() => loadConfig({ ...production, ...tlog })).toThrow(/TLOG_WITNESS_QUORUM.*TLOG_REKOR_ENABLED/);
    expect(() => loadConfig({ ...production, ...tlog, TLOG_REKOR_SIGNING_KEY: ANCHOR_PRIVATE })).toThrow("TLOG_REKOR_ENABLED");
    // Witnesses alone still satisfy it, as before.
    const w = [1, 2].map((i) => noteSigner(`w${i}.test/w`, SIG_COSIGNATURE_V1, randomBytes(32)).verifierKey).join(",");
    expect(loadConfig({ ...production, ...tlog, TLOG_WITNESSES: w }).tlog.rekor.enabled).toBe(false);
  });

  test("anchoring settings are validated", () => {
    expect(loadConfig({}).tlog.rekor.enabled).toBe(false);
    expect(() => loadConfig({ ...rekorOn })).toThrow("TLOG_REKOR_ENABLED needs TLOG_ENABLED");
    expect(() => loadConfig({ ...tlog, TLOG_REKOR_ENABLED: "true" })).toThrow("TLOG_REKOR_SIGNING_KEY");
    expect(() => loadConfig({ ...tlog, ...rekorOn, TLOG_REKOR_SIGNING_KEY: "bm90IGEga2V5" })).toThrow("ECDSA P-256");
    const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => loadConfig({ ...tlog, ...rekorOn, TLOG_REKOR_SIGNING_KEY: ed })).toThrow("ECDSA P-256");
    expect(() => loadConfig({ ...tlog, ...rekorOn, MEASUREMENT_PUBLIC_KEY: ANCHOR_PUBLIC })).toThrow("not the measurement key");
    expect(() => loadConfig({ ...tlog, ...rekorOn, TLOG_REKOR_MIN_INTERVAL_MS: "1000" })).toThrow("TLOG_REKOR_MIN_INTERVAL_MS");
    expect(() => loadConfig({ ...tlog, ...rekorOn, REKOR_PUBLIC_KEY: "nope" })).toThrow("REKOR_PUBLIC_KEY");
    expect(() => loadConfig({ ...production, ...tlog, ...rekorOn, REKOR_URL: "http://rekor.example" })).toThrow("https");
    expect(loadConfig({ ...tlog, ...rekorOn, REKOR_URL: "https://rekor.example/", TLOG_REKOR_MIN_INTERVAL_MS: "120000" }).tlog.rekor).toMatchObject({ url: "https://rekor.example", minIntervalMs: 120_000 });
  });
});

describe("the client's Rekor check on a real entry", () => {
  test("an entry of the public Sigstore log: inclusion, Rekor's checkpoint and its signed entry timestamp verify", async () => {
    const raw = JSON.parse(readFileSync(new URL("./fixtures/rekor/entry-200000000.json", import.meta.url), "utf8")) as Record<string, any>;
    const [uuid, e] = Object.entries(raw)[0]!;
    const rec = recordOf({ [uuid]: e });
    const key = spkiFromText(readFileSync(new URL("./fixtures/rekor/rekor-log-public-key.txt", import.meta.url), "utf8"));
    const leaf = leafHash(Buffer.from(rec.body, "base64"));
    expect(uuid.endsWith(leaf.toString("hex"))).toBe(true);
    expect(await verifyRekorInclusion(rec, leaf, key)).toMatchObject({ included: true, checkpointSigned: true, setSigned: true, treeSize: rec.inclusion_proof.tree_size });
    // Another key, a changed proof, or a checkpoint for another root: not verified.
    const other = spkiFromText(ANCHOR_PUBLIC);
    expect(await verifyRekorInclusion(rec, leaf, other)).toMatchObject({ included: true, checkpointSigned: false, setSigned: false });
    const broken = { ...rec, inclusion_proof: { ...rec.inclusion_proof, hashes: [...rec.inclusion_proof.hashes].reverse() } };
    expect(await verifyRekorInclusion(broken, leaf, key)).toMatchObject({ included: false, checkpointSigned: false });
    const moved = { ...rec, integrated_time: rec.integrated_time + 1 };
    expect((await verifyRekorInclusion(moved, leaf, key)).setSigned).toBe(false);
  });
});

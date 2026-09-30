import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { providers, receiptKeys, tlogEntries } from "../src/db/schema.ts";
import { canonicalJson, sha256 } from "../src/lib/util.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { submitBundle } from "../src/services/measurement-bundles.ts";
import { OhttpKeys } from "../src/ohttp/keys.ts";
import { attestationBindingEntry } from "../src/tlog/entries.ts";
import { decodeEntryBundle, leafHash, MerkleTree } from "../src/tlog/merkle.ts";
import { cosign, formatCheckpoint, formatSignerKey, noteSigner, parseCheckpoint, parseNote, parseVerifierKey, SIG_COSIGNATURE_V1, signatureLine, verifyNoteSignature, type NoteSigner } from "../src/tlog/note.ts";
import { witnessFromKeys, witnessRound } from "../scripts/tlog-witness.ts";
import type { WitnessState } from "../src/tlog/witness.ts";
import { AnyRoute, SplitViewDetected, TransparencyError, TransparencyLog as ClientLog, ohttpKeyConfigDigest } from "../packages/client/src/index.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { bindingsFor, sidecarDocument } from "./measurement-fixtures.ts";
import { newSigner, signedBundle } from "./bundle-fixtures.ts";
import { MockRekor } from "./rekor-mock.ts";

// The transparency log running inside the router: appends when keys are published or rotated, the tlog-tiles endpoints,
// witnesses handing in cosignatures, and the client's split-view checks against it.

setDefaultTimeout(60_000);

const ORIGIN = "router.test/tlog";
const BASE = "http://router.test";
const seeds = { w1: randomBytes(32), w2: randomBytes(32), w3: randomBytes(32) };
const W1 = noteSigner("witness-one.test/w", SIG_COSIGNATURE_V1, seeds.w1);
const W2 = noteSigner("witness-two.test/w", SIG_COSIGNATURE_V1, seeds.w2);
const W3 = noteSigner("witness-three.test/w", SIG_COSIGNATURE_V1, seeds.w3); // not configured in the router
const TLOG_ENV = { TLOG_ENABLED: "true", TLOG_ORIGIN: ORIGIN, TLOG_WITNESSES: `${W1.verifierKey},${W2.verifierKey}`, TLOG_WITNESS_QUORUM: "2", TLOG_COSIGN_RPM: "1000" };

/** A fetch that answers from the router's app, as a client or witness on the network would see it. */
const appFetch = (h: Harness, overrides: Record<string, () => Response> = {}) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (overrides[u.href]) return overrides[u.href]();
    return h.app.request(u.pathname + u.search, init);
  }) as typeof fetch;

const memoryStore = () => {
  const m = new Map<string, WitnessState>();
  return { load: (o: string) => m.get(o) ?? null, save: (o: string, s: WitnessState) => void m.set(o, s) };
};

/** A checkpoint of this size and root, signed with the log's own key and optionally cosigned: a forged second view. */
function forgedNote(h: Harness, size: number, root: Uint8Array, cosigners: NoteSigner[] = []) {
  const signer = h.ctx.tlog!.signer;
  const text = formatCheckpoint(ORIGIN, size, root);
  return `${text}\n${signatureLine(signer.name, signer.keyId, signer.sign(Buffer.from(text)))}${cosigners.map((w) => cosign(w, text, Math.floor(Date.now() / 1000))).join("")}`;
}

describe("transparency log in the router", () => {
  let h: Harness;
  let logKey: string;
  const witnesses = () => ({ w1: witnessFromKeys(logKey, formatSignerKey(W1.name, seeds.w1), memoryStore()), w2: witnessFromKeys(logKey, formatSignerKey(W2.name, seeds.w2), memoryStore()) });
  let wit: ReturnType<typeof witnesses>;
  const cosignAll = async () => {
    for (const w of [wit.w1, wit.w2]) expect(await witnessRound(BASE, w, appFetch(h))).toMatchObject({ ok: true, submitted: { status: 200 } });
  };
  const lookup = (kind: string, digest: string) => h.request(`/api/v1/tlog/lookup?kind=${kind}&sha256=${digest}`);
  const receiptDigest = async () => {
    const [k] = await h.ctx.db.select().from(receiptKeys).where(eq(receiptKeys.id, h.ctx.signer.keyId));
    return sha256(Buffer.from(k.publicKey, "hex"));
  };

  beforeAll(async () => {
    h = await startRouter({ env: { ...TLOG_ENV, ANYROUTE_FEATURE_BLIND: "true", OHTTP_ENABLED: "true" } });
    await h.ctx.tlog!.idle();
    logKey = (await (await h.request("/api/v1/tlog")).json()).data.verifier_key;
    wit = witnesses();
  });
  afterAll(async () => {
    await h.close();
  });

  test("the log describes itself: origin, pinned-key format, witnesses and quorum", async () => {
    const d = (await (await h.request("/api/v1/tlog")).json()).data;
    expect(d).toMatchObject({ origin: ORIGIN, quorum: 2, witnesses: [{ name: W1.name, verifier_key: W1.verifierKey }, { name: W2.name, verifier_key: W2.verifierKey }], kinds: ["receipt_key", "ohttp_key_config", "blind_issuer_key", "measurement_bundle", "attestation_binding", "data_inventory", "host_policy"] });
    expect(logKey).toBe(h.ctx.tlog!.verifierKey);
    expect(parseVerifierKey(logKey)).toMatchObject({ name: ORIGIN, type: 1 });
  });

  test("keys that exist at start are logged, and rotating or publishing a key appends it", async () => {
    // At start: the receipt key. Blind issuer keys are created the first time they are published.
    expect((await lookup("receipt_key", await receiptDigest())).status).toBe(200);
    expect(await h.ctx.db.select().from(tlogEntries).where(eq(tlogEntries.kind, "blind_issuer_key"))).toHaveLength(0);
    expect((await h.request("/api/v1/blind/keys")).status).toBe(200);
    await h.ctx.tlog!.idle();
    const blindBefore = await h.ctx.db.select().from(tlogEntries).where(eq(tlogEntries.kind, "blind_issuer_key"));
    expect(blindBefore.length).toBeGreaterThan(0);

    // Receipt key rotation.
    const before = await receiptDigest();
    await h.ctx.signer.rotateIfDue(true);
    await h.ctx.tlog!.idle();
    const after = await receiptDigest();
    expect(after).not.toBe(before);
    const hit = await (await lookup("receipt_key", after)).json();
    expect(hit.data).toMatchObject({ kind: "receipt_key", sha256: after, subject: h.ctx.signer.keyId });
    expect(JSON.parse(hit.data.entry).key.key_id).toBe(h.ctx.signer.keyId);

    // Oblivious HTTP: the served key and, after a rotation into a later epoch, the new keys.
    const served = await h.request("/api/v1/ohttp/keys");
    expect(served.status).toBe(200);
    await h.ctx.tlog!.idle();
    const list = new Uint8Array(await served.arrayBuffer());
    const config = list.subarray(2, 2 + ((list[0] << 8) | list[1]));
    expect((await lookup("ohttp_key_config", await ohttpKeyConfigDigest(config))).status).toBe(200);
    const ohttp = h.ctx.ohttp as OhttpKeys;
    const later = Date.now() + 3 * h.ctx.cfg.ohttp.keyEpochSeconds * 1000;
    ohttp.now = () => later;
    try {
      expect((await ohttp.rotate()).created).toBe(2);
    } finally {
      ohttp.now = () => Date.now();
    }
    await h.ctx.tlog!.idle();
    for (const k of await ohttp.history()) expect((await lookup("ohttp_key_config", k.configSha256)).status).toBe(200);

    // Blind issuer keys for a later epoch.
    const blind = h.ctx.blind!;
    const t = Date.now() + 3 * h.ctx.cfg.blind.epochSeconds * 1000;
    blind.now = () => t;
    try {
      expect((await blind.rotate()).created).toBeGreaterThan(0);
    } finally {
      blind.now = () => Date.now();
    }
    await h.ctx.tlog!.idle();
    const blindAfter = await h.ctx.db.select().from(tlogEntries).where(eq(tlogEntries.kind, "blind_issuer_key"));
    expect(blindAfter.length).toBeGreaterThan(blindBefore.length);
    for (const k of await blind.publicKeys()) expect((await lookup("blind_issuer_key", k.keyId)).status).toBe(200);

    // Nothing is logged twice, and the job only signs a checkpoint for the tree it finds.
    const size = await h.ctx.tlog!.size();
    expect(await h.ctx.tlog!.run()).toMatchObject({ added: 0, size });
    expect((await lookup("receipt_key", "ab".repeat(32))).status).toBe(404);
    expect((await lookup("nonsense", "ab".repeat(32))).status).toBe(400);
  });

  test("tiles, entry bundles and the checkpoint agree with each other", async () => {
    // Grow the tree past one full tile so a full tile and a level-1 tile exist.
    await h.ctx.tlog!.append(Array.from({ length: 300 }, (_, i) => attestationBindingEntry(`bulk-${i}`, { tls_pubkey: randomBytes(8).toString("hex"), n: i }, null)));
    const res = await h.request("/tlog/checkpoint");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const note = parseNote(await res.text());
    expect(verifyNoteSignature(note, parseVerifierKey(logKey))).toBe(true);
    const cp = parseCheckpoint(note.text);
    expect(cp.size).toBe(await h.ctx.tlog!.size());
    expect(cp.size).toBeGreaterThan(256);

    const full = await h.request("/tlog/tile/0/000");
    expect(full.status).toBe(200);
    expect(full.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(full.headers.get("content-type")).toBe("application/octet-stream");
    const tile0 = Buffer.from(await full.arrayBuffer());
    expect(tile0.length).toBe(256 * 32);
    const w = cp.size - 256;
    const partial = Buffer.from(await (await h.request(`/tlog/tile/0/001.p/${w}`)).arrayBuffer());
    expect(partial.length).toBe(w * 32);
    const top = Buffer.from(await (await h.request("/tlog/tile/1/000.p/1")).arrayBuffer());

    // Rebuild the tree from level-0 tiles and check it against the level-1 tile and the signed root.
    const hashes = [...tile0, ...partial].length / 32;
    const all = Buffer.concat([tile0, partial]);
    const tree = new MerkleTree(Array.from({ length: hashes }, (_, i) => all.subarray(i * 32, i * 32 + 32)));
    expect(tree.root().equals(cp.root)).toBe(true);
    expect(top.equals(tree.rangeHash(0, 256))).toBe(true);

    // Entry bundles hash to the leaves.
    const bundle = decodeEntryBundle(Buffer.from(await (await h.request(`/tlog/tile/entries/001.p/${w}`)).arrayBuffer()));
    expect(bundle.length).toBe(w);
    bundle.forEach((e, i) => expect(leafHash(e).equals(partial.subarray(i * 32, i * 32 + 32))).toBe(true));
    const first = decodeEntryBundle(Buffer.from(await (await h.request("/tlog/tile/entries/000")).arrayBuffer()));
    expect(JSON.parse(first[0].toString())).toMatchObject({ v: 1, type: "anyroute.tlog.entry" });

    // Tiles that do not exist (yet), and paths that are not canonical.
    for (const p of [`/tlog/tile/0/001.p/${w + 1}`, "/tlog/tile/0/001", "/tlog/tile/1/000", "/tlog/tile/0/1", "/tlog/tile/0/000.p/0", "/tlog/tile/entries/002"]) {
      const r = await h.request(p);
      expect(r.status).toBe(404);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("witnesses cosign through the log; the log keeps only valid cosignatures from configured witnesses", async () => {
    expect((await h.request("/api/v1/tlog/witnessed")).status).toBe(404);
    const one = await witnessRound(BASE, wit.w1, appFetch(h));
    expect(one).toMatchObject({ ok: true, submitted: { status: 200, body: { data: { accepted: [W1.name], cosignatures: 1, witnessed: false } } } });
    expect((await h.request("/api/v1/tlog/witnessed")).status).toBe(404);
    const two = await witnessRound(BASE, wit.w2, appFetch(h));
    expect(two).toMatchObject({ ok: true, submitted: { status: 200, body: { data: { cosignatures: 2, witnessed: true } } } });
    const served = await (await h.request("/tlog/checkpoint")).text();
    expect(parseNote(served).signatures.map((s) => s.name)).toEqual([ORIGIN, W1.name, W2.name]);
    expect(await (await h.request("/api/v1/tlog/witnessed")).text()).toBe(served);
    const size = parseCheckpoint(parseNote(served).text).size;
    expect(await (await h.request(`/api/v1/tlog/checkpoints/${size}`)).text()).toBe(served);

    const text = parseNote(served).text;
    const post = (body: string) => h.request("/api/v1/tlog/cosignatures", { method: "POST", headers: { "content-type": "text/plain" }, body });
    const logLine = parseNote(served).signatures[0].line;
    const errorType = async (r: Response) => (await r.json()).error.type;
    let r = await post(`${text}\n${logLine}${cosign(W3, text, Math.floor(Date.now() / 1000))}`);
    expect([r.status, await errorType(r)]).toEqual([403, "unknown_witness"]);
    const good = cosign(W1, text, Math.floor(Date.now() / 1000));
    const raw = Buffer.from(good.trimEnd().split(" ")[2], "base64");
    raw[raw.length - 1] ^= 1; // one bit of the Ed25519 signature
    const bad = `\u2014 ${W1.name} ${raw.toString("base64")}\n`;
    r = await post(`${text}\n${logLine}${bad}`);
    expect([r.status, await errorType(r)]).toEqual([403, "invalid_cosignature"]);
    r = await post(`${text}\n${logLine}${cosign(W1, text, Math.floor(Date.now() / 1000) + 3600)}`);
    expect([r.status, await errorType(r)]).toEqual([403, "invalid_cosignature"]); // dated an hour ahead
    const forged = formatCheckpoint(ORIGIN, size, randomBytes(32));
    r = await post(`${forged}\n${cosign(W1, forged, Math.floor(Date.now() / 1000))}`);
    expect([r.status, await errorType(r)]).toEqual([409, "checkpoint_mismatch"]);
    const future = formatCheckpoint(ORIGIN, size + 100, randomBytes(32));
    r = await post(`${future}\n${cosign(W1, future, Math.floor(Date.now() / 1000))}`);
    expect([r.status, await errorType(r)]).toEqual([404, "unknown_checkpoint"]);
    const elsewhere = formatCheckpoint("other.test/tlog", size, randomBytes(32));
    r = await post(`${elsewhere}\n${cosign(W1, elsewhere, 1)}`);
    expect([r.status, await errorType(r)]).toEqual([400, "unknown_log"]);
    r = await post("not a note");
    expect([r.status, await errorType(r)]).toEqual([400, "invalid_checkpoint"]);
    r = await post("x".repeat(20_000));
    expect(r.status).toBe(413);
    // A valid resubmission is fine and still one cosignature per witness.
    r = await post(`${text}\n${logLine}${good}`);
    expect((await r.json()).data).toMatchObject({ accepted: [W1.name], cosignatures: 2 });
  });

  test("a witness refuses a log that shows it a fork, and submits nothing", async () => {
    const served = parseNote(await (await h.request("/tlog/checkpoint")).text());
    const cp = parseCheckpoint(served.text);
    const fork = forgedNote(h, cp.size, randomBytes(32));
    let posted = 0;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.pathname === "/tlog/checkpoint") return new Response(fork);
      if (init?.method === "POST") posted++;
      return h.app.request(u.pathname + u.search, init);
    }) as typeof fetch;
    expect(await witnessRound(BASE, wit.w1, f)).toMatchObject({ ok: false, code: "fork" });
    const bigger = forgedNote(h, cp.size + 1, randomBytes(32));
    const g = (async (input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).pathname === "/tlog/checkpoint" ? new Response(bigger) : f(input, init))) as typeof fetch;
    expect(await witnessRound(BASE, wit.w1, g)).toMatchObject({ ok: false, code: "inconsistent" });
    expect(posted).toBe(0);
  });

  test("the client accepts a logged key only under a witnessed checkpoint, and refuses keys that are not logged", async () => {
    const client = new ClientLog({ logUrl: BASE, logKey, witnesses: [W1.verifierKey, W2.verifierKey], fetch: appFetch(h) });
    const digest = await receiptDigest();
    const ok = await client.requireLogged("receipt_key", digest);
    expect(ok).toMatchObject({ kind: "receipt_key", sha256: digest, cosignedBy: [W1.name, W2.name] });
    expect(ok.entry).toMatchObject({ kind: "receipt_key", key: { key_id: h.ctx.signer.keyId } });

    const missing = await client.requireLogged("receipt_key", randomBytes(32)).catch((e) => e);
    expect(missing).toBeInstanceOf(TransparencyError);
    expect(missing.code).toBe("not_logged");

    // A new key is appended, but no witness has cosigned the new tree yet: refused until they do.
    await h.ctx.signer.rotateIfDue(true);
    await h.ctx.tlog!.idle();
    const fresh = await receiptDigest();
    expect(((await client.requireLogged("receipt_key", fresh).catch((e) => e)) as TransparencyError).code).toBe("not_witnessed");
    await cosignAll();
    // Accepted now, with a consistency proof from the smaller checkpoint the client remembered.
    const before = (await client.remembered())!.size;
    const again = await client.requireLogged("receipt_key", fresh);
    expect(again.checkpoint.size).toBeGreaterThan(before);
    expect((await client.remembered())!.size).toBe(again.checkpoint.size);

    // One witness short of the quorum, or a log key that is not the pinned one.
    const short = new ClientLog({ logUrl: BASE, logKey, witnesses: [W1.verifierKey, W3.verifierKey], quorum: 2, fetch: appFetch(h) });
    expect(((await short.requireLogged("receipt_key", fresh).catch((e) => e)) as TransparencyError).code).toBe("not_witnessed");
    const otherLog = noteSigner(ORIGIN, 1, randomBytes(32));
    const wrong = new ClientLog({ logUrl: BASE, logKey: otherLog.verifierKey, witnesses: [W1.verifierKey, W2.verifierKey], fetch: appFetch(h) });
    expect(((await wrong.requireLogged("receipt_key", fresh).catch((e) => e)) as TransparencyError).code).toBe("bad_log_signature");
    expect(() => new ClientLog({ logUrl: BASE, logKey, witnesses: [] })).toThrow();
  });

  test("the client detects a split view: two checkpoints of one size, a tree that does not extend, or a disagreeing mirror", async () => {
    const digest = await receiptDigest();
    const current = parseCheckpoint(parseNote(await (await h.request("/api/v1/tlog/witnessed")).text()).text);

    // This client was shown another checkpoint of the same size earlier, signed by the log and cosigned by both witnesses.
    const other = forgedNote(h, current.size, randomBytes(32), [W1, W2]);
    const remembered = new Map([[ORIGIN, other]]);
    const store = { get: (o: string) => remembered.get(o) ?? null, set: (o: string, n: string) => void remembered.set(o, n) };
    const split = new ClientLog({ logUrl: BASE, logKey, witnesses: [W1.verifierKey, W2.verifierKey], fetch: appFetch(h), store });
    const e = (await split.requireLogged("receipt_key", digest).catch((x) => x)) as SplitViewDetected;
    expect(e).toBeInstanceOf(SplitViewDetected);
    expect(e.code).toBe("split_view");
    expect(e.evidence.first).toBe(other);
    expect(parseCheckpoint(parseNote(e.evidence.second).text).size).toBe(current.size);
    expect(remembered.get(ORIGIN)).toBe(other); // nothing was overwritten

    // A smaller checkpoint the current tree does not extend.
    remembered.set(ORIGIN, forgedNote(h, current.size - 5, randomBytes(32), [W1, W2]));
    const e2 = (await split.requireLogged("receipt_key", digest).catch((x) => x)) as SplitViewDetected;
    expect(e2).toBeInstanceOf(SplitViewDetected);
    expect(e2.code).toBe("inconsistent");

    // A bigger checkpoint than the log now has: the log cannot prove it still extends it (a rollback), so the key is refused.
    remembered.set(ORIGIN, forgedNote(h, current.size + 10, randomBytes(32), [W1, W2]));
    expect(((await split.requireLogged("receipt_key", digest).catch((x) => x)) as TransparencyError).code).toBe("inconsistent");

    // A second path (a mirror of the checkpoint) that serves a different view.
    const mirror = "https://mirror.test/tlog/checkpoint";
    const viaMirror = new ClientLog({ logUrl: BASE, logKey, witnesses: [W1.verifierKey, W2.verifierKey], mirrors: [mirror], fetch: appFetch(h, { [mirror]: () => new Response(forgedNote(h, current.size, randomBytes(32))) }) });
    expect(await viaMirror.requireLogged("receipt_key", digest).catch((x) => x)).toBeInstanceOf(SplitViewDetected);
    // A mirror that agrees (it serves the log's own checkpoint) passes.
    const agreeing = new ClientLog({ logUrl: BASE, logKey, witnesses: [W1.verifierKey, W2.verifierKey], mirrors: [mirror], fetch: appFetch(h, { [mirror]: () => new Response(forgedNote(h, current.size, current.root)) }) });
    expect(await agreeing.requireLogged("receipt_key", digest)).toMatchObject({ sha256: digest });
    // An unreachable mirror is a refusal, not a pass.
    const down = new ClientLog({ logUrl: BASE, logKey, witnesses: [W1.verifierKey, W2.verifierKey], mirrors: [mirror], fetch: appFetch(h, { [mirror]: () => new Response("gone", { status: 503 }) }) });
    expect(((await down.requireLogged("receipt_key", digest).catch((x) => x)) as TransparencyError).code).toBe("mirror_unavailable");
  });

  test("with transparency on, the SDK client checks that the receipt key is logged", async () => {
    await cosignAll();
    const k = await h.fundedKey();
    const on = new AnyRoute({ baseUrl: BASE, apiKey: k.secret, fetch: appFetch(h), transparency: { logKey, witnesses: [W1.verifierKey, W2.verifierKey] } });
    const r = await on.chat.completions.create({ model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
    expect(r.anyroute.receiptVerification?.valid).toBe(true);
    expect(r.anyroute.receiptVerification?.checks.find((c) => c.id === "key_logged")).toMatchObject({ status: "pass" });

    const unwitnessed = new AnyRoute({ baseUrl: BASE, apiKey: k.secret, fetch: appFetch(h), transparency: { logKey, witnesses: [W3.verifierKey] } });
    const r2 = await unwitnessed.chat.completions.create({ model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
    expect(r2.anyroute.receiptVerification?.valid).toBe(false);
    expect(r2.anyroute.receiptVerification?.checks.find((c) => c.id === "key_logged")).toMatchObject({ status: "fail" });

    const off = new AnyRoute({ baseUrl: BASE, apiKey: k.secret, fetch: appFetch(h) });
    const r3 = await off.chat.completions.create({ model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
    expect(r3.anyroute.receiptVerification?.valid).toBe(true);
    expect(r3.anyroute.receiptVerification?.checks.some((c) => c.id === "key_logged")).toBe(false);
    expect(off.transparency).toBeNull();
  });
});

describe("measurement bundles and sidecar bindings are logged when they are verified", () => {
  let h: Harness;
  let sidecar: ReturnType<typeof Bun.serve>;
  let dcap: ReturnType<typeof Bun.serve>;
  const rekor = new MockRekor();
  const bundleSigner = newSigner();
  const state = { verified: true, dev: false };

  beforeAll(async () => {
    sidecar = Bun.serve({ port: 0, fetch: (req) => Response.json(sidecarDocument(new URL(req.url).searchParams.get("nonce") ?? "", { dev: state.dev })) });
    dcap = Bun.serve({ port: 0, fetch: () => Response.json(state.verified ? { verified: true } : { verified: false, tcb_status: "Revoked" }) });
    h = await startRouter({
      providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama] }],
      env: { ...TLOG_ENV, MEASUREMENTS_ENABLED: "true", MEASUREMENT_PUBLIC_KEY: bundleSigner.publicPem, REKOR_URL: rekor.baseUrl, TDX_VERIFIER_URL: `http://127.0.0.1:${dcap.port}/verify` },
    });
    h.ctx.cfg.measurements.rekorPublicKey = rekor.publicKeyPem;
    h.ctx.cfg.attestation.verifiers = ["dcap"];
    await h.ctx.db.update(providers).set({ teeKind: "tdx", attestationUrl: `http://127.0.0.1:${sidecar.port}/attest` }).where(eq(providers.id, "alpha"));
    await h.ctx.tlog!.idle();
  });
  afterAll(async () => {
    sidecar.stop(true);
    dcap.stop(true);
    await h.close();
  });
  const entries = (kind: string) => h.ctx.db.select().from(tlogEntries).where(eq(tlogEntries.kind, kind));

  test("a hardware-verified sidecar quote logs the bindings it committed to; a rejected one logs nothing", async () => {
    state.verified = false;
    expect(((await runAttestor(h.ctx)).results[0] as { ok: boolean }).ok).toBe(false);
    await h.ctx.tlog!.idle();
    expect(await entries("attestation_binding")).toHaveLength(0);

    state.verified = true;
    expect(((await runAttestor(h.ctx)).results[0] as { ok: boolean }).ok).toBe(true);
    await h.ctx.tlog!.idle();
    const [row] = await entries("attestation_binding");
    expect(row.sha256).toBe(sha256(canonicalJson(bindingsFor())));
    expect(JSON.parse(row.entry).key).toMatchObject({ provider_id: "alpha", bindings: bindingsFor() });
    // Attesting again with the same bindings adds nothing.
    await runAttestor(h.ctx);
    await h.ctx.tlog!.idle();
    expect(await entries("attestation_binding")).toHaveLength(1);
  });

  test("a measurement bundle is logged once its transparency-log entry verifies", async () => {
    const s = signedBundle(bundleSigner);
    const posted = await rekor.fetch(`${rekor.baseUrl}/api/v1/log/entries`, { method: "POST", body: JSON.stringify(s.entry) });
    const uuid = Object.keys(await posted.json())[0]!;
    const view = await submitBundle(h.ctx, { bundle: s.bundle, signature: s.signature, rekorUuid: uuid }, { fetchImpl: rekor.fetch as never });
    expect(view.status).toBe("verified");
    await h.ctx.tlog!.idle();
    const [row] = await entries("measurement_bundle");
    expect(row.sha256).toBe(s.digest);
    expect(JSON.parse(row.entry).key).toMatchObject({ provider_id: "alpha", bundle_digest: "0x" + s.digest, rekor_uuid: uuid });
  });
});

describe("off by default", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => {
    await h.close();
  });

  test("no log routes, no job and no appends when TLOG_ENABLED is not set", async () => {
    expect(h.ctx.tlog).toBeUndefined();
    expect(h.ctx.cfg.tlog.enabled).toBe(false);
    for (const p of ["/tlog/checkpoint", "/tlog/tile/0/000", "/api/v1/tlog", "/api/v1/tlog/lookup?kind=receipt_key&sha256=" + "00".repeat(32)]) expect((await h.request(p)).status).toBe(404);
    expect((await h.request("/api/v1/tlog/cosignatures", { method: "POST", body: "x" })).status).toBe(404);
    await h.ctx.signer.rotateIfDue(true);
    expect(await h.ctx.db.select().from(tlogEntries)).toHaveLength(0);
  });

  test("configuration: witness keys are validated, and production needs a pinned log key and enough witnesses", () => {
    expect(() => loadConfig({ TLOG_ENABLED: "true", TLOG_WITNESSES: "not-a-key" })).toThrow("TLOG_WITNESSES");
    expect(() => loadConfig({ TLOG_ENABLED: "true", TLOG_WITNESSES: noteSigner("w", 1, randomBytes(32)).verifierKey })).toThrow("cosignature/v1");
    expect(() => loadConfig({ TLOG_ENABLED: "true", TLOG_WITNESSES: `${W1.verifierKey},${W1.verifierKey}` })).toThrow("twice");
    expect(() => loadConfig({ TLOG_ENABLED: "true", TLOG_ORIGIN: "has space" })).toThrow("TLOG_ORIGIN");
    expect(() => loadConfig({ TLOG_ENABLED: "true", TLOG_SIGNING_KEY: "bm90IGEga2V5" })).toThrow("TLOG_SIGNING_KEY");
    const seed = randomBytes(32);
    const c = loadConfig({ TLOG_ENABLED: "true", TLOG_SIGNING_KEY: formatSignerKey("log.test/tlog", seed), TLOG_WITNESSES: `${W1.verifierKey}\n${W2.verifierKey}` }).tlog;
    expect(c).toMatchObject({ enabled: true, origin: "log.test/tlog", quorum: 2 });
    expect(c.witnesses.map((w) => w.name)).toEqual([W1.name, W2.name]);
    expect(() => loadConfig({ TLOG_ENABLED: "true", TLOG_ORIGIN: "other.test/tlog", TLOG_SIGNING_KEY: formatSignerKey("log.test/tlog", seed) })).toThrow("different log");
    // The derived development key is stable for one APP_SECRET.
    const a = loadConfig({ TLOG_ENABLED: "true", APP_SECRET: "a".repeat(40) }).tlog.signingKey;
    expect(Buffer.from(loadConfig({ TLOG_ENABLED: "true", APP_SECRET: "a".repeat(40) }).tlog.signingKey).equals(a)).toBe(true);

    const production = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: "0x" + "1".repeat(40), CALLPAY_ADDRESS: "0x" + "1".repeat(40), PROVIDER_BOND_ADDRESS: "0x" + "1".repeat(40), RECEIPT_ANCHOR_ADDRESS: "0x" + "1".repeat(40), ROUTER_PRIVATE_KEY: "0x" + "2".repeat(64) };
    expect(loadConfig(production).tlog.enabled).toBe(false);
    expect(() => loadConfig({ ...production, TLOG_ENABLED: "true", TLOG_WITNESSES: `${W1.verifierKey},${W2.verifierKey}` })).toThrow("TLOG_SIGNING_KEY");
    const key = formatSignerKey("router.example/tlog", seed);
    expect(() => loadConfig({ ...production, TLOG_ENABLED: "true", TLOG_SIGNING_KEY: key, TLOG_WITNESSES: W1.verifierKey })).toThrow("TLOG_WITNESS_QUORUM");
    expect(loadConfig({ ...production, TLOG_ENABLED: "true", TLOG_SIGNING_KEY: key, TLOG_WITNESSES: `${W1.verifierKey},${W2.verifierKey}` }).tlog.origin).toBe("router.example/tlog");
    const { ROUTER_PRIVATE_KEY: _r, ...worker } = production;
    expect(loadConfig({ ...worker, RUNTIME_ROLE: "worker", WORKER_JOBS: "tlog", TLOG_ENABLED: "true", TLOG_SIGNING_KEY: key, TLOG_WITNESSES: `${W1.verifierKey},${W2.verifierKey}` }).workerJobs).toEqual(["tlog"]);
  });
});

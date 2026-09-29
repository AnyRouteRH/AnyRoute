import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseRekorEntry, type RawRekorEntry } from "../src/services/measurements.ts";
import { decodeEntryBundle, decodeTileIndex, EMPTY_ROOT, encodeEntryBundle, encodeTileIndex, leafHash, MerkleTree, parseTilePath, tilePath, tileWidth, verifyConsistency, verifyInclusion } from "../src/tlog/merkle.ts";
import {
  cosign,
  cosignedMessage,
  formatCheckpoint,
  formatSignerKey,
  formatVerifierKey,
  noteSigner,
  parseCheckpoint,
  parseNote,
  parseSignerKey,
  parseVerifierKey,
  SIG_COSIGNATURE_V1,
  SIG_ED25519,
  signatureLine,
  verifyCosignature,
  verifyNoteSignature,
} from "../src/tlog/note.ts";
import { attestationBindingEntry, entryText, ohttpKeyEntry, receiptKeyEntry } from "../src/tlog/entries.ts";
import { Witness, type WitnessState } from "../src/tlog/witness.ts";
import * as sdk from "../packages/client/src/tlog.ts";
import { auditPath, mth } from "./measurement-fixtures.ts";

// The Merkle, note and witness code of the transparency log (src/tlog), against published vectors where they exist:
// the RFC 6962 test tree used by Certificate Transparency implementations, a real inclusion proof from the public
// Sigstore log, and the signed-note example from the Go reference implementation (golang.org/x/mod/sumdb/note).

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Buffer.from(s, "hex");

// ---- RFC 6962 ----------------------------------------------------------------------------------------------------

// The eight leaves of the reference test tree and the roots of its first 1..8 leaves.
const LEAVES = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map(unhex);
const ROOTS = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];
// Reference inclusion and consistency proofs for the same tree.
const INCLUSION = [
  { index: 0, size: 8, proof: ["96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7", "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4"] },
  { index: 0, size: 1, proof: [] },
];
const CONSISTENCY = [
  { from: 1, to: 1, proof: [] },
  { from: 1, to: 8, proof: ["96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7", "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4"] },
  { from: 6, to: 8, proof: ["0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a", "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0", "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7"] },
  { from: 2, to: 5, proof: ["5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b"] },
];

describe("RFC 6962 Merkle tree", () => {
  const tree = new MerkleTree();
  for (const l of LEAVES) tree.appendEntry(l);

  test("roots of every prefix match the reference tree, and the empty tree is SHA-256 of nothing", () => {
    expect(ROOTS.map((_, i) => hex(tree.root(i + 1)))).toEqual(ROOTS);
    expect(hex(tree.root(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(EMPTY_ROOT)).toBe(hex(tree.root(0)));
  });

  test("inclusion and consistency proofs match the reference proofs", () => {
    for (const v of INCLUSION) expect(tree.inclusionProof(v.index, v.size).map(hex)).toEqual(v.proof);
    for (const v of CONSISTENCY) expect(tree.consistencyProof(v.from, v.to).map(hex)).toEqual(v.proof);
  });

  test("every proof in the reference tree verifies, and none verifies against another root or index", async () => {
    for (let n = 1; n <= 8; n++)
      for (let i = 0; i < n; i++) {
        const p = tree.inclusionProof(i, n);
        expect(verifyInclusion(i, n, leafHash(LEAVES[i]), p, unhex(ROOTS[n - 1]))).toBe(true);
        expect(await sdk.verifyInclusion(i, n, leafHash(LEAVES[i]), p, unhex(ROOTS[n - 1]))).toBe(true);
        expect(verifyInclusion(i, n, leafHash(LEAVES[i]), p, unhex(ROOTS[(n + 2) % 8]))).toBe(n === ((n + 2) % 8) + 1);
        if (n > 1) expect(verifyInclusion((i + 1) % n, n, leafHash(LEAVES[i]), p, unhex(ROOTS[n - 1]))).toBe(false);
        if (n < 8) expect(verifyInclusion(i, n + 1, leafHash(LEAVES[i]), p, unhex(ROOTS[n]))).toBe(false); // the root binds the size
      }
    for (let a = 0; a <= 8; a++)
      for (let b = a; b <= 8; b++) {
        const p = tree.consistencyProof(a, b);
        const ra = a ? unhex(ROOTS[a - 1]) : EMPTY_ROOT;
        const rb = b ? unhex(ROOTS[b - 1]) : EMPTY_ROOT;
        expect(verifyConsistency(a, b, p, ra, rb)).toBe(true);
        expect(await sdk.verifyConsistency(a, b, p, ra, rb)).toBe(true);
        if (a > 0 && a < b) {
          expect(verifyConsistency(a, b, p, ra, unhex(ROOTS[(b + 3) % 8]))).toBe(false);
          expect(await sdk.verifyConsistency(a, b, p, unhex(ROOTS[(a + 3) % 8]), rb)).toBe(false);
          expect(verifyConsistency(a, b, p.slice(1), ra, rb)).toBe(false);
        }
      }
  });

  test("a real inclusion proof from the public Sigstore log verifies", async () => {
    const raw = JSON.parse(readFileSync(new URL("./fixtures/rekor/entry-200000000.json", import.meta.url), "utf8")) as Record<string, RawRekorEntry>;
    const [uuid, body] = Object.entries(raw)[0];
    const e = parseRekorEntry(uuid, body);
    const p = e.inclusionProof!;
    const leaf = leafHash(Buffer.from(e.body, "base64"));
    const proof = p.hashes.map(unhex);
    expect(verifyInclusion(p.logIndex, p.treeSize, leaf, proof, unhex(p.rootHash))).toBe(true);
    expect(await sdk.verifyInclusion(p.logIndex, p.treeSize, leaf, proof, unhex(p.rootHash))).toBe(true);
    expect(verifyInclusion(p.logIndex + 1, p.treeSize, leaf, proof, unhex(p.rootHash))).toBe(false);
  });

  test("larger trees agree with an independently written recursive implementation", () => {
    const data = Array.from({ length: 700 }, (_, i) => Buffer.from(`entry-${i}`));
    const t = new MerkleTree(data.map(leafHash));
    for (const n of [1, 2, 3, 255, 256, 257, 511, 512, 700]) {
      expect(hex(t.root(n))).toBe(hex(mth(data.slice(0, n))));
      for (const i of [0, n >> 1, n - 1]) expect(t.inclusionProof(i, n).map(hex)).toEqual(auditPath(i, data.slice(0, n)).map(hex));
    }
    for (const [a, b] of [[1, 700], [255, 256], [256, 257], [300, 699], [512, 700]]) expect(verifyConsistency(a, b, t.consistencyProof(a, b), t.root(a), t.root(b))).toBe(true);
  });
});

// ---- tlog-tiles --------------------------------------------------------------------------------------------------

describe("tlog-tiles layout", () => {
  test("tile indices use the x-prefixed groups of three digits", () => {
    expect(encodeTileIndex(0)).toBe("000");
    expect(encodeTileIndex(5)).toBe("005");
    expect(encodeTileIndex(1000)).toBe("x001/000");
    expect(encodeTileIndex(1234067)).toBe("x001/x234/067");
    for (const n of [0, 7, 999, 1000, 1234067, 987654321]) expect(decodeTileIndex(encodeTileIndex(n))).toBe(n);
    for (const bad of ["5", "0005", "x005", "001/002", "x000/005", "x01/002", "abc"]) expect(decodeTileIndex(bad)).toBeNull();
  });

  test("tile paths parse only in canonical form", () => {
    expect(tilePath({ level: 0, index: 1234067, width: null })).toBe("tile/0/x001/x234/067");
    expect(tilePath({ level: "entries", index: 0, width: 7 })).toBe("tile/entries/000.p/7");
    expect(parseTilePath("0/x001/x234/067")).toEqual({ level: 0, index: 1234067, width: null });
    expect(parseTilePath("entries/000.p/7")).toEqual({ level: "entries", index: 0, width: 7 });
    expect(parseTilePath("2/001.p/255")).toEqual({ level: 2, index: 1, width: 255 });
    for (const bad of ["0/000.p/0", "0/000.p/256", "0/000.p/07", "01/000", "0/0", "x/000", "entries/000.p/", "0/000/"]) expect(parseTilePath(bad)).toBeNull();
  });

  test("tiles hold the node hashes of their level; widths follow the tree size", () => {
    const t = new MerkleTree(Array.from({ length: 70_000 }, (_, i) => leafHash(Buffer.from(String(i)))));
    expect(tileWidth(0, 0, t.size)).toBe(256);
    expect(tileWidth(0, 273, t.size)).toBe(70_000 - 273 * 256);
    expect(tileWidth(0, 274, t.size)).toBe(0);
    expect(tileWidth(1, 0, t.size)).toBe(256);
    expect(tileWidth(1, 1, t.size)).toBe(Math.floor(70_000 / 256) - 256);
    expect(tileWidth(2, 0, t.size)).toBe(1);
    const level1 = t.tile(1, 0, 3);
    expect(level1.length).toBe(96);
    expect(hex(level1.subarray(32, 64))).toBe(hex(t.rangeHash(256, 512)));
    expect(hex(t.tile(2, 0))).toBe(hex(t.rangeHash(0, 65_536)));
    expect(() => t.tile(2, 0, 2)).toThrow();
  });

  test("entry bundles carry a 16-bit length before every entry", () => {
    const entries = [Buffer.from(""), Buffer.from("a"), randomBytes(300)];
    const b = encodeEntryBundle(entries);
    expect(b.subarray(0, 5).toString("hex")).toBe("0000000161");
    expect(decodeEntryBundle(b).map(hex)).toEqual(entries.map(hex));
    expect(() => decodeEntryBundle(b.subarray(0, b.length - 1))).toThrow();
    expect(() => encodeEntryBundle([Buffer.alloc(65_536)])).toThrow();
  });
});

// ---- signed notes, checkpoints, cosignatures -------------------------------------------------------------------

describe("signed notes", () => {
  // The example key and note from the Go reference implementation's documentation.
  const VKEY = "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW";
  const SKEY = "PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz";
  const TEXT = "If you think cryptography is the answer to your problem,\nthen you don't know what your problem is.\n";
  const SIG = "— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n";

  test("key ids, key encodings and signatures match the reference example byte for byte", async () => {
    const v = parseVerifierKey(VKEY);
    expect(v).toMatchObject({ name: "PeterNeumann", type: SIG_ED25519 });
    expect(hex(v.keyId)).toBe("c74f20a3");
    const { name, seed } = parseSignerKey(SKEY);
    const s = noteSigner(name, SIG_ED25519, seed);
    expect(s.verifierKey).toBe(VKEY);
    expect(formatSignerKey(name, seed)).toBe(SKEY);
    expect(signatureLine(s.name, s.keyId, s.sign(Buffer.from(TEXT)))).toBe(SIG);
    expect(verifyNoteSignature(parseNote(TEXT + "\n" + SIG), v)).toBe(true);
    expect(verifyNoteSignature(parseNote(TEXT.replace("answer", "answers") + "\n" + SIG), v)).toBe(false);
    expect(await sdk.parseVerifierKey(VKEY)).toMatchObject({ name: "PeterNeumann", type: 1 });
  });

  test("malformed notes and keys are refused", () => {
    expect(() => parseNote(TEXT)).toThrow();
    expect(() => parseNote(TEXT + "\n")).toThrow();
    expect(() => parseNote(TEXT + "\n" + SIG.replace("—", "-"))).toThrow();
    expect(() => parseNote(TEXT + "\n" + SIG.trimEnd())).toThrow();
    expect(() => parseVerifierKey(VKEY.replace("c74f20a3", "c74f20a4"))).toThrow("id does not match");
    expect(() => parseVerifierKey("a b+c74f20a3+ARpc")).toThrow();
    expect(() => noteSigner("has space", SIG_ED25519, randomBytes(32))).toThrow();
  });

  test("checkpoints are origin, size and base64 root; extension lines are refused", () => {
    const root = randomBytes(32);
    const text = formatCheckpoint("log.example/tlog", 42, root);
    expect(text).toBe(`log.example/tlog\n42\n${root.toString("base64")}\n`);
    expect(parseCheckpoint(text)).toMatchObject({ origin: "log.example/tlog", size: 42 });
    expect(hex(parseCheckpoint(text).root)).toBe(hex(root));
    for (const bad of [text + "ext\n", "log\n042\n" + root.toString("base64") + "\n", "log\n1\nAAAA\n", "a log\n1\n" + root.toString("base64") + "\n", text.trimEnd()]) expect(() => parseCheckpoint(bad)).toThrow();
    expect(sdk.parseCheckpointText(text).size).toBe(42);
  });

  test("a cosignature/v1 covers the timestamp and the checkpoint, under a 0x04 key id", () => {
    const seed = randomBytes(32);
    const w = noteSigner("witness.example/w1", SIG_COSIGNATURE_V1, seed);
    const v = parseVerifierKey(w.verifierKey);
    expect(v.type).toBe(SIG_COSIGNATURE_V1);
    expect(hex(v.keyId)).not.toBe(hex(noteSigner("witness.example/w1", SIG_ED25519, seed).keyId));
    const text = formatCheckpoint("log.example/tlog", 7, randomBytes(32));
    const line = cosign(w, text, 1_790_000_000);
    const sig = parseNote(`${text}\n${line}`).signatures[0];
    expect(sig.sig.length).toBe(72);
    expect(sig.sig.readBigUInt64BE(0)).toBe(1_790_000_000n);
    expect(verifyCosignature(text, sig, v)).toBe(1_790_000_000);
    expect(cosignedMessage(text, 5).toString()).toBe(`cosignature/v1\ntime 5\n${text}`);
    expect(verifyCosignature(formatCheckpoint("log.example/tlog", 8, randomBytes(32)), sig, v)).toBeNull();
    const shifted = Buffer.from(sig.sig);
    shifted.writeBigUInt64BE(1_790_000_001n);
    expect(verifyCosignature(text, { ...sig, sig: shifted }, v)).toBeNull();
    expect(() => cosign(noteSigner("x", SIG_ED25519, seed), text, 1)).toThrow();
    expect(formatVerifierKey(v.name, v.type, v.publicKey)).toBe(w.verifierKey);
  });
});

// ---- entries -----------------------------------------------------------------------------------------------------

describe("log entries", () => {
  test("entries are canonical JSON naming the digest a client computes from the key it holds", async () => {
    const pub = randomBytes(32).toString("hex");
    const e = receiptKeyEntry({ id: "abcdef0123456789", publicKey: pub, validFrom: new Date(0) });
    expect(e.sha256).toBe(await sdk.receiptKeyDigest(unhex(pub)));
    expect(entryText(e)).toBe(`{"key":{"alg":"EdDSA","key_id":"abcdef0123456789","public_key":"${pub}","valid_from":"1970-01-01T00:00:00.000Z"},"kind":"receipt_key","sha256":"${e.sha256}","type":"anyroute.tlog.entry","v":1}`);
    const config = randomBytes(41);
    const o = ohttpKeyEntry({ epoch: 3, keyId: 3, kemId: 32, config: config.toString("base64url"), configSha256: await sdk.ohttpKeyConfigDigest(config), validFrom: new Date(0), acceptUntil: new Date(1) });
    expect(o.sha256).toBe(await sdk.ohttpKeyConfigDigest(config));
    const bindings = { tls_pubkey: "04ab", receipt_pubkey: "cd".repeat(32), model_digest: "sha256:" + "33".repeat(32) };
    expect(attestationBindingEntry("p", bindings, null).sha256).toBe(await sdk.bindingsDigest(bindings));
  });
});

// ---- the witness -------------------------------------------------------------------------------------------------

describe("witness", () => {
  const logSigner = noteSigner("log.example/tlog", SIG_ED25519, randomBytes(32));
  const wSigner = noteSigner("witness.example/w1", SIG_COSIGNATURE_V1, randomBytes(32));
  const logKey = parseVerifierKey(logSigner.verifierKey);
  const signed = (tree: MerkleTree, size = tree.size, by = logSigner) => {
    const text = formatCheckpoint(by.name, size, tree.root(size));
    return `${text}\n${signatureLine(by.name, by.keyId, by.sign(Buffer.from(text)))}`;
  };
  const memory = () => {
    const m = new Map<string, WitnessState>();
    return { m, store: { load: (o: string) => m.get(o) ?? null, save: (o: string, s: WitnessState) => void m.set(o, s) } };
  };

  test("cosigns a checkpoint consistent with the last one it cosigned, and refuses a fork", async () => {
    const tree = new MerkleTree(Array.from({ length: 5 }, (_, i) => leafHash(Buffer.from(`e${i}`))));
    const { m, store } = memory();
    const w = new Witness(logKey, wSigner, store);
    const proofs = (t: MerkleTree) => async (a: number, b: number) => t.consistencyProof(a, b);

    const first = await w.process(signed(tree), proofs(tree));
    expect(first).toMatchObject({ ok: true, size: 5 });
    expect(m.get("log.example/tlog")).toEqual({ size: 5, root: hex(tree.root()) });
    if (!first.ok) throw new Error("unreachable");
    const cosig = parseNote(first.note).signatures.find((s) => s.name === wSigner.name)!;
    expect(verifyCosignature(parseNote(first.note).text, cosig, parseVerifierKey(wSigner.verifierKey))).not.toBeNull();

    for (let i = 5; i < 9; i++) tree.appendEntry(Buffer.from(`e${i}`));
    expect(await w.process(signed(tree), proofs(tree))).toMatchObject({ ok: true, size: 9 });
    expect(await w.process(signed(tree), proofs(tree))).toMatchObject({ ok: true, size: 9 }); // the same checkpoint again

    // A fork: same size, other contents, validly signed by the log.
    const fork = new MerkleTree(Array.from({ length: 9 }, (_, i) => leafHash(Buffer.from(i === 3 ? "evil" : `e${i}`))));
    expect(await w.process(signed(fork), proofs(fork))).toMatchObject({ ok: false, code: "fork" });
    // A bigger fork cannot prove it extends what the witness cosigned.
    fork.appendEntry(Buffer.from("e9"));
    expect(await w.process(signed(fork), proofs(fork))).toMatchObject({ ok: false, code: "inconsistent" });
    expect(await w.process(signed(fork), async () => [])).toMatchObject({ ok: false, code: "inconsistent" });
    expect(m.get("log.example/tlog")!.size).toBe(9); // nothing a refusal saw was remembered

    expect(await w.process(signed(tree, 5), proofs(tree))).toMatchObject({ ok: false, code: "stale" });
    const other = noteSigner("log.example/tlog", SIG_ED25519, randomBytes(32));
    expect(await w.process(signed(tree, 9, other), proofs(tree))).toMatchObject({ ok: false, code: "bad_signature" });
    expect(await w.process("garbage", proofs(tree))).toMatchObject({ ok: false, code: "malformed" });
    const elsewhere = noteSigner("other.example/tlog", SIG_ED25519, randomBytes(32));
    expect(await w.process(signed(tree, 9, elsewhere), proofs(tree))).toMatchObject({ ok: false, code: "wrong_log" });
  });
});

import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../src/lib/util.ts";
import {
  asBytes32,
  bundleBytes,
  bundleMismatch,
  digestHex,
  hashedrekordEntry,
  keyId,
  parseBundle,
  parsePrivateKey,
  parsePublicKey,
  publicKeyOf,
  publicKeyPem,
  sameKey,
  sha256Of,
  signBytes,
  spkiDer,
  tdxRegisters,
  verifyBundleEntry,
  verifySignature,
} from "../src/services/measurement-bundle.ts";
import { checkpointSigned, entryIncluded, parseRekorEntry, setSigned, type RawRekorEntry } from "../src/services/measurements.ts";
import { DIGESTS, REGS, tdxQuote } from "./measurement-fixtures.ts";
import { COMPOSE_TEXT, LLAMA_IMAGE, PROVIDER, newSigner, partsFor, signedBundle } from "./bundle-fixtures.ts";
import { verifyEcdsaDigest } from "./p256-verify.ts";
import { MockRekor } from "./rekor-mock.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/rekor/${name}`, import.meta.url), "utf8");

// ---- The real log ---------------------------------------------------------------------------------------------
// test/fixtures/rekor/entry-200000000.json is one entry of the public Sigstore log, read once with a GET of
// /api/v1/log/entries?logIndex=200000000, and rekor-log-public-key.txt is that log's key from /api/v1/log/publicKey.

describe("an entry captured from the public Sigstore Rekor v1 log", () => {
  const raw = JSON.parse(fixture("entry-200000000.json")) as Record<string, RawRekorEntry>;
  const [uuid, rawEntry] = Object.entries(raw)[0]!;
  const key = fixture("rekor-log-public-key.txt");
  const entry = parseRekorEntry(uuid, rawEntry);

  test("the existing proof checks accept it: inclusion proof and signed checkpoint", () => {
    expect(entry.kind).toBe("hashedrekord");
    expect(entryIncluded(entry)).toBe(true);
    expect(checkpointSigned(entry, key)).toBe(true);
    expect(checkpointSigned(entry, publicKeyPem(newSigner().publicKey))).toBe(false);
  });
  test("its signed entry timestamp verifies against the log key, and only untouched", () => {
    expect(setSigned(entry, key)).toBe(true);
    expect(setSigned({ ...entry, integratedTime: entry.integratedTime! + 1 }, key)).toBe(false);
    expect(setSigned({ ...entry, logIndex: entry.logIndex! + 1 }, key)).toBe(false);
    expect(setSigned({ ...entry, body: Buffer.from("{}").toString("base64") }, key)).toBe(false);
    expect(setSigned({ ...entry, signedEntryTimestamp: null }, key)).toBe(false);
    expect(setSigned(entry, "not a key")).toBe(false);
  });
  test("its uuid is the tree id followed by the hash of its body, which verifyBundleEntry insists on", () => {
    const leaf = createHash("sha256").update(Buffer.concat([Buffer.from([0]), Buffer.from(rawEntry.body, "base64")])).digest("hex");
    expect(uuid).toHaveLength(80);
    expect(uuid.endsWith(leaf)).toBe(true);
    // Not our bundle, so the entry is refused, but only after the log-level checks pass: the reason is about the hash.
    const other = signedBundle(newSigner());
    const r = verifyBundleEntry(entry, { bytes: other.bytes, publicKey: newSigner().publicKey, rekorPublicKey: key });
    expect(r).toMatchObject({ ok: false, reason: "the entry's artifact hash is not the bundle digest" });
    expect(verifyBundleEntry({ ...entry, uuid: "24296fb24b8ad77a" + "00".repeat(32) }, { bytes: other.bytes, publicKey: newSigner().publicKey })).toMatchObject({ ok: false, reason: "the entry's uuid does not name its body" });
  });
  test("the entry we submit has the same shape the log stores for a hashedrekord entry", () => {
    const real = JSON.parse(Buffer.from(rawEntry.body, "base64").toString());
    const s = signedBundle(newSigner());
    const ours = s.entry;
    const shape = (v: unknown): unknown => (v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])])) : typeof v);
    expect(shape(ours)).toEqual(shape(real));
    expect(ours.apiVersion).toBe(real.apiVersion);
    expect(ours.kind).toBe("hashedrekord");
    // the public key is sent as base64 of a PEM, as the log stores it
    expect(Buffer.from(ours.spec.signature.publicKey.content, "base64").toString()).toStartWith("-----BEGIN PUBLIC KEY-----");
    expect(Buffer.from(real.spec.signature.publicKey.content, "base64").toString()).toStartWith("-----BEGIN CERTIFICATE-----");
  });
});

// ---- The bundle -----------------------------------------------------------------------------------------------

describe("the bundle document", () => {
  const signer = newSigner();

  test("canonical bytes do not depend on key order, and change with any field", () => {
    const { bundle } = signedBundle(signer);
    const shuffled = JSON.parse(JSON.stringify(bundle, ["type", "signer", "version", "tdx", "images", "model", "source", "compose_hash", "created_at", "provider"])) as Record<string, unknown>;
    shuffled.signer = bundle.signer;
    shuffled.tdx = bundle.tdx;
    shuffled.images = bundle.images;
    shuffled.model = bundle.model;
    shuffled.source = bundle.source;
    expect(bundleBytes(parseBundle(shuffled)).equals(bundleBytes(bundle))).toBe(true);
    expect(bundleBytes(bundle).toString()).toBe(canonicalJson(bundle));
    expect(bundleBytes(bundle).toString()).not.toMatch(/\s{2}|\n/);
    for (const change of [{ provider: "other" }, { createdAt: "2026-09-29T10:00:01.000Z" }, { composeHash: "sha256:" + "23".repeat(32) }]) {
      expect(digestHex(bundleBytes(signedBundle(signer, change).bundle))).not.toBe(digestHex(bundleBytes(bundle)));
    }
  });
  test("the schema is strict: unknown fields, malformed hashes and non-https URLs are refused", () => {
    const { bundle } = signedBundle(signer);
    const bad = (mut: (b: any) => void) => {
      const c = JSON.parse(JSON.stringify(bundle));
      mut(c);
      return () => parseBundle(c);
    };
    expect(() => parseBundle(bundle)).not.toThrow();
    expect(bad((b) => (b.extra = 1))).toThrow("invalid measurement bundle");
    expect(bad((b) => (b.source.extra = 1))).toThrow();
    expect(bad((b) => (b.compose_hash = "0x" + "22".repeat(32)))).toThrow();
    expect(bad((b) => (b.compose_hash = "sha256:" + "AB".repeat(32)))).toThrow();
    expect(bad((b) => (b.source.commit = "abc"))).toThrow();
    expect(bad((b) => (b.source.repository = "http://example.test/x"))).toThrow();
    expect(bad((b) => (b.model.weights[0].url = "file:///etc/passwd"))).toThrow();
    expect(bad((b) => (b.images = []))).toThrow();
    expect(bad((b) => (b.tdx.mrtd = ["aa"]))).toThrow();
    expect(bad((b) => (b.version = 2))).toThrow();
    expect(bad((b) => (b.signer.algorithm = "ed25519"))).toThrow();
    expect(bad((b) => (b.created_at = "yesterday"))).toThrow();
    expect(() => parseBundle(null)).toThrow();
  });
  test("digests are written as sha256:<hex> and compare as bytes32", () => {
    const { bundle } = signedBundle(signer);
    expect(bundle.compose_hash).toBe(DIGESTS.compose);
    expect(asBytes32(bundle.compose_hash)).toBe("0x" + "22".repeat(32));
    expect(sha256Of("0x" + "ab".repeat(32))).toBe("sha256:" + "ab".repeat(32));
    expect(() => sha256Of("nope")).toThrow("not a sha256 digest");
    // MRTD and RTMR3 lists are lower-cased, de-duplicated and sorted
    const b = signedBundle(signer, { tdx: { mrtd: ["BB".repeat(48), "aa".repeat(48), "0x" + "AA".repeat(48)], rtmr3: [] } }).bundle;
    expect(b.tdx.mrtd).toEqual(["aa".repeat(48), "bb".repeat(48)]);
  });
});

// PEM armour lines, assembled here so that this file carries no literal private-key marker.
const armor = (edge: "BEGIN" | "END") => `-----${edge} ${"PRIVATE"} KEY-----`;

describe("the measurement key", () => {
  test("a P-256 key is read from PEM, \\n-escaped PEM or base64 SPKI; a private key is refused as a public key", () => {
    const s = newSigner();
    const escaped = s.publicPem.trim().replace(/\n/g, "\\n");
    expect(sameKey(parsePublicKey(s.publicPem), s.publicKey)).toBe(true);
    expect(sameKey(parsePublicKey(escaped), s.publicKey)).toBe(true);
    expect(sameKey(parsePublicKey(spkiDer(s.publicKey).toString("base64")), s.publicKey)).toBe(true);
    expect(() => parsePublicKey(s.privatePem)).toThrow("private key");
    expect(() => parsePublicKey("garbage")).toThrow("not a public key");
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    expect(() => parsePublicKey(publicKeyPem(p384.publicKey))).toThrow("P-256");
    const ed = generateKeyPairSync("ed25519");
    expect(() => parsePublicKey(publicKeyPem(ed.publicKey))).toThrow("P-256");
  });
  test("a private key is read from PKCS#8 PEM, SEC1 PEM or base64 PKCS#8, and errors never quote it", () => {
    const s = newSigner();
    expect(sameKey(publicKeyOf(parsePrivateKey(s.privatePem)), s.publicKey)).toBe(true);
    expect(sameKey(publicKeyOf(parsePrivateKey(s.privatePem.trim().replace(/\n/g, "\\n"))), s.publicKey)).toBe(true);
    const sec1 = s.privateKey.export({ type: "sec1", format: "pem" }).toString();
    expect(sameKey(publicKeyOf(parsePrivateKey(sec1)), s.publicKey)).toBe(true);
    const b64 = (s.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
    expect(sameKey(publicKeyOf(parsePrivateKey(b64)), s.publicKey)).toBe(true);
    const secret = "SECRET-MATERIAL-1234567890";
    try {
      parsePrivateKey(`${armor("BEGIN")}\n${secret}\n${armor("END")}`);
      throw new Error("should not parse");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
      expect((e as Error).message).toContain("not a private key");
    }
    expect(() => parsePrivateKey(publicKeyPem(generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey))).toThrow();
  });
  test("keyId is the sha256 of the SubjectPublicKeyInfo", () => {
    const s = newSigner();
    expect(keyId(s.publicKey)).toBe(createHash("sha256").update(spkiDer(s.publicKey)).digest("hex"));
    expect(keyId(s.publicKey)).not.toBe(keyId(newSigner().publicKey));
  });
});

describe("the signature", () => {
  test("verifies over the bundle bytes with the signer's key and nothing else", () => {
    const s = newSigner();
    const { bytes, signature } = signedBundle(s);
    expect(verifySignature(bytes, signature, s.publicKey)).toBe(true);
    expect(verifySignature(bytes, signature, newSigner().publicKey)).toBe(false);
    expect(verifySignature(Buffer.concat([bytes, Buffer.from(" ")]), signature, s.publicKey)).toBe(false);
    expect(verifySignature(bytes, "", s.publicKey)).toBe(false);
    expect(verifySignature(bytes, "not base64 !!", s.publicKey)).toBe(false);
  });
  test("is ECDSA over the sha256 of the bytes, which is what Rekor checks for a hashedrekord entry", () => {
    // Rekor is given only the artifact hash: it verifies the DER signature against that digest. Check the same thing
    // with a second, independent implementation.
    const s = newSigner();
    const { bytes, signature, digest } = signedBundle(s);
    expect(hashedrekordEntry(bytes, signature, s.publicKey).spec.data.hash).toEqual({ algorithm: "sha256", value: digest });
    const der = Buffer.from(signature, "base64");
    expect(verifyEcdsaDigest(der, Buffer.from(digest, "hex"), spkiDer(s.publicKey))).toBe(true);
    expect(verifyEcdsaDigest(der, createHash("sha256").update("other").digest(), spkiDer(s.publicKey))).toBe(false);
    expect(verifyEcdsaDigest(der, Buffer.from(digest, "hex"), spkiDer(newSigner().publicKey))).toBe(false);
    // and the signature is DER (SEQUENCE), not the fixed-size IEEE form
    expect(Buffer.from(signature, "base64")[0]).toBe(0x30);
  });
});

describe("quote registers", () => {
  test("MRTD and RTMR3 are read from a v4 quote at the offsets the attestor uses; anything else is null", () => {
    expect(tdxRegisters(tdxQuote("00".repeat(64)))).toEqual({ mrtd: REGS.mrtd, rtmr3: REGS.rtmr3 });
    expect(tdxRegisters("0x" + tdxQuote("00".repeat(64)))).toEqual({ mrtd: REGS.mrtd, rtmr3: REGS.rtmr3 });
    expect(tdxRegisters("00")).toBeNull();
    expect(tdxRegisters("03" + tdxQuote("00".repeat(64)).slice(2))).toBeNull();
  });
});

describe("what a bundle must say about a recorded measurement", () => {
  const s = newSigner();
  const m = { providerId: PROVIDER, imageDigest: asBytes32(DIGESTS.image), composeHash: asBytes32(DIGESTS.compose), modelDigest: asBytes32(DIGESTS.model), quote: tdxQuote("00".repeat(64)) };
  const bundle = (over = {}) => signedBundle(s, over).bundle;

  test("the compose hash, an image, the model and the registers must all match", () => {
    expect(bundleMismatch(bundle(), m)).toBeNull();
    expect(bundleMismatch(bundle(), { ...m, providerId: "beta" })).toContain("different provider");
    expect(bundleMismatch(bundle(), { ...m, composeHash: asBytes32("sha256:" + "23".repeat(32)) })).toContain("compose hash");
    expect(bundleMismatch(bundle(), { ...m, imageDigest: asBytes32("sha256:" + "77".repeat(32)) })).toContain("image digest");
    expect(bundleMismatch(bundle(), { ...m, modelDigest: asBytes32("sha256:" + "88".repeat(32)) })).toContain("model digest");
    // any of the bundle's images may be the one the sidecar declares
    expect(bundleMismatch(bundle(), { ...m, imageDigest: asBytes32(LLAMA_IMAGE) })).toBeNull();
  });
  test("an MRTD or RTMR3 allow-list is enforced when present, and skipped when empty", () => {
    expect(bundleMismatch(bundle({ tdx: { mrtd: ["cc".repeat(48)], rtmr3: [] } }), m)).toContain("MRTD");
    expect(bundleMismatch(bundle({ tdx: { mrtd: [], rtmr3: ["cc".repeat(48)] } }), m)).toContain("RTMR3");
    expect(bundleMismatch(bundle({ tdx: { mrtd: [REGS.mrtd], rtmr3: [REGS.rtmr3] } }), m)).toBeNull();
    expect(bundleMismatch(bundle({ tdx: { mrtd: [], rtmr3: [] } }), { ...m, quote: "00" })).toBeNull();
    expect(bundleMismatch(bundle({ tdx: { mrtd: [REGS.mrtd], rtmr3: [] } }), { ...m, quote: "00" })).toContain("no readable TDX registers");
  });
});

// ---- The entry check, against a log we control -----------------------------------------------------------------

describe("verifyBundleEntry", () => {
  const signer = newSigner();
  const fresh = async (mutate?: (s: ReturnType<typeof signedBundle>) => Record<string, unknown>) => {
    const log = new MockRekor();
    const s = signedBundle(signer);
    const res = await log.fetch(`${log.baseUrl}/api/v1/log/entries`, { method: "POST", body: JSON.stringify(mutate ? mutate(s) : s.entry) });
    expect(res.status).toBe(201);
    const [uuid, raw] = Object.entries((await res.json()) as Record<string, RawRekorEntry>)[0]!;
    return { log, s, uuid, entry: parseRekorEntry(uuid, raw) };
  };

  test("accepts the entry the publisher submitted, with checkpoint and signed entry timestamp when the log key is given", async () => {
    const { log, s, entry } = await fresh();
    const ok = verifyBundleEntry(entry, { bytes: s.bytes, publicKey: signer.publicKey, rekorPublicKey: log.publicKeyPem });
    expect(ok).toMatchObject({ ok: true, checkpointVerified: true, setVerified: true });
    // without the log's key the entry still verifies, and says the checkpoint was not checked
    expect(verifyBundleEntry(entry, { bytes: s.bytes, publicKey: signer.publicKey })).toMatchObject({ ok: true, checkpointVerified: false, setVerified: false });
    // with the wrong log key the entry verifies but the log's signatures do not
    expect(verifyBundleEntry(entry, { bytes: s.bytes, publicKey: signer.publicKey, rekorPublicKey: newSigner().publicPem })).toMatchObject({ ok: true, checkpointVerified: false, setVerified: false });
    // a \n-escaped log key (as some environments store PEMs) works too
    expect(verifyBundleEntry(entry, { bytes: s.bytes, publicKey: signer.publicKey, rekorPublicKey: log.publicKeyPem.trim().replace(/\n/g, "\\n") })).toMatchObject({ checkpointVerified: true });
  });
  test("refuses an entry for other bytes, another key, a bad signature, or a broken proof", async () => {
    const { s, entry, uuid } = await fresh();
    const good = { bytes: s.bytes, publicKey: signer.publicKey };
    expect(verifyBundleEntry(entry, { ...good, bytes: Buffer.concat([s.bytes, Buffer.from(" ")]) })).toMatchObject({ ok: false, reason: "the entry's artifact hash is not the bundle digest" });
    expect(verifyBundleEntry(entry, { ...good, publicKey: newSigner().publicKey })).toMatchObject({ ok: false, reason: "the entry was not signed with the measurement key" });
    expect(verifyBundleEntry({ ...entry, inclusionProof: { ...entry.inclusionProof!, hashes: ["00".repeat(32), ...entry.inclusionProof!.hashes.slice(1)] } }, good)).toMatchObject({ ok: false, reason: "the entry's inclusion proof does not verify" });
    expect(verifyBundleEntry({ ...entry, inclusionProof: null }, good)).toMatchObject({ ok: false, retry: true });
    expect(verifyBundleEntry({ ...entry, uuid: uuid.slice(0, 16) + "00".repeat(32) }, good)).toMatchObject({ ok: false, reason: "the entry's uuid does not name its body" });

    // an entry that carries our key and hash but a signature made over something else
    const other = signedBundle(signer, { createdAt: "2026-09-30T10:00:00.000Z" });
    const forged = await fresh((x) => ({ ...x.entry, spec: { ...x.entry.spec, signature: { ...x.entry.spec.signature, content: other.signature } } }));
    expect(verifyBundleEntry(forged.entry, { bytes: forged.s.bytes, publicKey: signer.publicKey })).toMatchObject({ ok: false, reason: "the entry's signature does not verify against the bundle" });
  });
  test("refuses entries of another kind, hash algorithm or key format, even when the log's proof for them is valid", async () => {
    const log = new MockRekor();
    const s = signedBundle(signer);
    const good = { bytes: s.bytes, publicKey: signer.publicKey };
    const ours = { ...s.entry, spec: { ...s.entry.spec } };
    // each variant is appended to the log as its own entry, so its uuid and inclusion proof are genuine
    const check = (body: unknown) => {
      const uuid = log.add(body);
      return verifyBundleEntry(parseRekorEntry(uuid, log.entryJson(uuid)![uuid] as RawRekorEntry), good);
    };
    expect(check(ours)).toMatchObject({ ok: true });
    expect(check({ ...ours, kind: "intoto" })).toMatchObject({ ok: false, reason: "the entry is not a hashedrekord 0.0.1 entry" });
    expect(check({ ...ours, apiVersion: "0.0.2" })).toMatchObject({ ok: false, reason: "the entry is not a hashedrekord 0.0.1 entry" });
    expect(check({ ...ours, spec: { ...ours.spec, data: { hash: { algorithm: "sha512", value: "00".repeat(64) } } } })).toMatchObject({ ok: false, reason: "the entry's artifact hash is not the bundle digest" });
    expect(check({ ...ours, spec: { ...ours.spec, signature: { ...ours.spec.signature, publicKey: { content: Buffer.from("not a key").toString("base64") } } } })).toMatchObject({ ok: false, reason: "the entry carries no readable public key" });
    expect(check({ ...ours, spec: { ...ours.spec, signature: { content: s.signature } } })).toMatchObject({ ok: false, reason: "the entry carries no readable public key" });
    expect(check("plain text, not json")).toMatchObject({ ok: false, reason: "the entry body is not JSON" });
  });
});

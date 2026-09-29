import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../lib/util.ts";
import { checkpointSigned, entryIncluded, normalizeDigest, setSigned, type RekorEntry } from "./measurements.ts";

// Measurement bundle: one signed document that says what an attested provider's measurement is made of.
//
// A confidential endpoint's quote commits to a compose hash, and the compose file pins the rest by hash: the sidecar
// source (commit and tarball sha256), the model weights, and every image digest. The bundle lists those pins next to the
// hardware registers (MRTD, and RTMR3 when the publisher wants to pin one instance) and is signed with a dedicated
// measurement key. Its digest is what goes into a public transparency log, as a Sigstore Rekor `hashedrekord` entry:
//
//   artifact   the canonical JSON bytes of the bundle (keys sorted, no whitespace)
//   digest     sha256(artifact)
//   signature  ECDSA P-256 over the artifact with SHA-256 (DER), by the measurement key
//
// Rekor's `hashedrekord` type verifies an ECDSA signature against a hash it is given, so that is what the entry holds.
// (Ed25519 is not an option there: Rekor accepts it only as Ed25519ph, which Node's crypto does not implement.)
//
// Anyone can check a published bundle without trusting the router: recompute the digest, verify the signature with the
// key in the bundle (and compare that key with the one the router publishes), fetch the entry from the log by uuid or
// by digest and verify its inclusion proof. verifyBundleEntry below is that check; the router runs the same one.

export const BUNDLE_TYPE = "anyroute.measurement.bundle";
export const BUNDLE_VERSION = 1;
export const SIGNATURE_ALGORITHM = "ecdsa-p256-sha256";

const sha256Ref = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex>");
const register = z.string().regex(/^[0-9a-f]{96}$/, "expected 48 bytes as 96 lowercase hex");
const httpsUrl = z.string().max(400).regex(/^https:\/\/[^\s]+$/, "expected an https URL");

export const bundleSchema = z
  .object({
    type: z.literal(BUNDLE_TYPE),
    version: z.literal(BUNDLE_VERSION),
    provider: z.string().min(1).max(128),
    created_at: z.iso.datetime(),
    /** sha256 of the CVM's app-compose.json: the hash the platform measures into RTMR3 and the sidecar binds into its quote. */
    compose_hash: sha256Ref,
    source: z
      .object({
        repository: httpsUrl,
        commit: z.string().regex(/^[0-9a-f]{40}$/, "expected a 40 hex git commit"),
        path: z.string().min(1).max(200),
        /** sha256 of the repository's tar.gz for `commit`, the value the compose file checks before it runs anything. */
        tarball_sha256: sha256Ref,
      })
      .strict(),
    model: z
      .object({
        /** The digest the sidecar computes over the served weights and binds into its quote. */
        digest: sha256Ref,
        weights: z.array(z.object({ file: z.string().min(1).max(300), sha256: sha256Ref, url: httpsUrl }).strict()).max(64),
      })
      .strict(),
    images: z.array(z.object({ service: z.string().min(1).max(64), reference: z.string().min(1).max(300), digest: sha256Ref }).strict()).min(1).max(16),
    tdx: z.object({ mrtd: z.array(register).max(32), rtmr3: z.array(register).max(32) }).strict(),
    signer: z.object({ algorithm: z.literal(SIGNATURE_ALGORITHM), key_id: z.string().regex(/^[0-9a-f]{64}$/), public_key_pem: z.string().min(80).max(400) }).strict(),
  })
  .strict();

export type MeasurementBundle = z.infer<typeof bundleSchema>;

/** Parse an untrusted bundle; throws an Error whose message names the first problems. */
export function parseBundle(input: unknown): MeasurementBundle {
  const r = bundleSchema.safeParse(input);
  if (!r.success) throw new Error(`invalid measurement bundle: ${r.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

// ---- Digests and canonical bytes ---------------------------------------------------------------------------

/** The bytes that are signed and logged: canonical JSON (sorted keys, no whitespace, UTF-8). */
export const bundleBytes = (bundle: MeasurementBundle): Buffer => Buffer.from(canonicalJson(bundle), "utf8");
export const digestHex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** "sha256:<hex>" as the bundle writes digests; throws unless the input is a 32-byte sha256 in any spelling the router accepts. */
export function sha256Of(v: unknown, what = "digest"): string {
  const n = normalizeDigest(v);
  if (!n) throw new Error(`${what} is not a sha256 digest`);
  return `sha256:${n.slice(2)}`;
}
/** 0x-prefixed lowercase bytes32, the form the measurements table stores. */
export const asBytes32 = (ref: string): `0x${string}` => {
  const n = normalizeDigest(ref);
  if (!n) throw new Error("not a sha256 digest");
  return n;
};

// ---- Keys --------------------------------------------------------------------------------------------------

const unescapeNewlines = (s: string) => s.replace(/\\n/g, "\n").trim();

function assertP256(key: KeyObject, what: string): KeyObject {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error(`${what} must be an ECDSA P-256 key`);
  return key;
}

/** A public key from PEM (real or \n-escaped newlines) or base64 SPKI. A private key is refused, so that one pasted
 *  into a public setting is noticed rather than used. */
export function parsePublicKey(text: string): KeyObject {
  const src = unescapeNewlines(text);
  if (/PRIVATE KEY/.test(src)) throw new Error("this is a private key; give the public key only");
  let key: KeyObject;
  try {
    key = src.includes("BEGIN") ? createPublicKey(src) : createPublicKey({ key: Buffer.from(src, "base64"), format: "der", type: "spki" });
  } catch {
    throw new Error("not a public key (expected a PEM or base64 SPKI)");
  }
  return assertP256(key, "the public key");
}

/** A private key from PEM (PKCS#8 or SEC1) or base64 PKCS#8. Error messages never include key material. */
export function parsePrivateKey(text: string): KeyObject {
  const src = unescapeNewlines(text);
  let key: KeyObject;
  try {
    key = src.includes("BEGIN") ? createPrivateKey(src) : createPrivateKey({ key: Buffer.from(src, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("not a private key (expected a PKCS#8 or SEC1 PEM, or base64 PKCS#8)");
  }
  return assertP256(key, "the private key");
}

export const publicKeyOf = (privateKey: KeyObject): KeyObject => createPublicKey(privateKey);
export const publicKeyPem = (key: KeyObject): string => key.export({ type: "spki", format: "pem" }).toString();
export const spkiDer = (key: KeyObject): Buffer => key.export({ type: "spki", format: "der" }) as Buffer;
/** sha256 of the SubjectPublicKeyInfo DER, hex: the identifier the bundle and the router endpoint use for a key. */
export const keyId = (key: KeyObject): string => createHash("sha256").update(spkiDer(key)).digest("hex");
export const sameKey = (a: KeyObject, b: KeyObject) => spkiDer(a).equals(spkiDer(b));

export function signBytes(bytes: Uint8Array, privateKey: KeyObject): string {
  return cryptoSign("sha256", bytes, { key: privateKey, dsaEncoding: "der" }).toString("base64");
}
export function verifySignature(bytes: Uint8Array, signatureB64: string, publicKey: KeyObject): boolean {
  try {
    const sig = Buffer.from(signatureB64, "base64");
    return sig.length > 0 && cryptoVerify("sha256", bytes, { key: publicKey, dsaEncoding: "der" }, sig);
  } catch {
    return false;
  }
}

// ---- Building --------------------------------------------------------------------------------------------

export type BundleParts = {
  provider: string;
  createdAt: string;
  composeHash: string;
  source: { repository: string; commit: string; path: string; tarballSha256: string };
  model: { digest: string; weights: { file: string; sha256: string; url: string }[] };
  images: { service: string; reference: string; digest: string }[];
  tdx: { mrtd: string[]; rtmr3: string[] };
  publicKey: KeyObject;
};

export function buildBundle(p: BundleParts): MeasurementBundle {
  const lower = (list: string[]) => [...new Set(list.map((v) => v.trim().toLowerCase().replace(/^0x/, "")))].sort();
  return parseBundle({
    type: BUNDLE_TYPE,
    version: BUNDLE_VERSION,
    provider: p.provider,
    created_at: p.createdAt,
    compose_hash: sha256Of(p.composeHash, "compose hash"),
    source: { repository: p.source.repository, commit: p.source.commit.toLowerCase(), path: p.source.path, tarball_sha256: sha256Of(p.source.tarballSha256, "source tarball hash") },
    model: { digest: sha256Of(p.model.digest, "model digest"), weights: p.model.weights.map((w) => ({ file: w.file, sha256: sha256Of(w.sha256, "weights hash"), url: w.url })) },
    images: p.images.map((i) => ({ service: i.service, reference: i.reference, digest: sha256Of(i.digest, `${i.service} image digest`) })),
    tdx: { mrtd: lower(p.tdx.mrtd), rtmr3: lower(p.tdx.rtmr3) },
    signer: { algorithm: SIGNATURE_ALGORITHM, key_id: keyId(p.publicKey), public_key_pem: publicKeyPem(p.publicKey) },
  });
}

/** The entry a publisher submits to Rekor v1: `POST /api/v1/log/entries` with this JSON. */
export function hashedrekordEntry(bytes: Uint8Array, signatureB64: string, publicKey: KeyObject) {
  return {
    apiVersion: "0.0.1",
    kind: "hashedrekord",
    spec: {
      data: { hash: { algorithm: "sha256", value: digestHex(bytes) } },
      signature: { content: signatureB64, publicKey: { content: Buffer.from(publicKeyPem(publicKey)).toString("base64") } },
    },
  };
}

// ---- Quote registers -------------------------------------------------------------------------------------

/** MRTD and RTMR3 of a TDX v4/v5 quote, hex; null when the bytes are not a quote. Same offsets as the attestor's parser. */
export function tdxRegisters(quoteHex: string): { mrtd: string; rtmr3: string } | null {
  const b = Buffer.from(quoteHex.replace(/^0x/, ""), "hex");
  if (b.length < 632) return null;
  const version = b.readUInt16LE(0);
  if (version !== 4 && version !== 5) return null;
  const at = (off: number) => b.subarray(48 + off, 48 + off + 48).toString("hex");
  return { mrtd: at(136), rtmr3: at(472) };
}

// ---- Checks ------------------------------------------------------------------------------------------------

/** What a measurement the router recorded from a verified quote must look like for a bundle to describe it. Returns
 *  the first mismatch, or null. */
export function bundleMismatch(bundle: MeasurementBundle, m: { providerId: string; imageDigest: string; composeHash: string; modelDigest: string; quote?: string }): string | null {
  if (bundle.provider !== m.providerId) return "the bundle is for a different provider";
  if (asBytes32(bundle.compose_hash) !== m.composeHash) return "the bundle's compose hash is not the one the quote committed to";
  if (!bundle.images.some((i) => asBytes32(i.digest) === m.imageDigest)) return "the image digest the quote committed to is not among the bundle's images";
  if (asBytes32(bundle.model.digest) !== m.modelDigest) return "the bundle's model digest is not the one the quote committed to";
  if (bundle.tdx.mrtd.length || bundle.tdx.rtmr3.length) {
    const regs = m.quote ? tdxRegisters(m.quote) : null;
    if (!regs) return "the recorded quote has no readable TDX registers to compare with the bundle";
    if (bundle.tdx.mrtd.length && !bundle.tdx.mrtd.includes(regs.mrtd)) return "the quote's MRTD is not in the bundle's allow-list";
    if (bundle.tdx.rtmr3.length && !bundle.tdx.rtmr3.includes(regs.rtmr3)) return "the quote's RTMR3 is not in the bundle's allow-list";
  }
  return null;
}

export type EntryCheck =
  | { ok: true; leafHash: string; checkpointVerified: boolean; setVerified: boolean }
  | { ok: false; reason: string; retry: boolean };

const fail = (reason: string, retry = false): EntryCheck => ({ ok: false, reason, retry });

/** Check a Rekor entry as the record of this bundle. It must be a hashedrekord entry that
 *   - is named by its own leaf hash and is included in the tree its inclusion proof describes,
 *   - holds the sha256 of exactly these bundle bytes,
 *   - carries the measurement public key, and a signature by it over those bytes.
 *  With the log's key, the checkpoint and the signed entry timestamp are verified as well and reported (a missing or
 *  failing signature there does not fail the entry: the caller decides what an unsigned checkpoint is worth).
 *  `retry` is true for a failure that may pass later (no inclusion proof yet). */
export function verifyBundleEntry(e: RekorEntry, o: { bytes: Uint8Array; publicKey: KeyObject; rekorPublicKey?: string | null }): EntryCheck {
  const uuid = e.uuid.toLowerCase();
  const leaf = createHash("sha256").update(Buffer.concat([Buffer.from([0]), Buffer.from(e.body, "base64")])).digest("hex");
  if (!/^(?:[0-9a-f]{16})?[0-9a-f]{64}$/.test(uuid) || !uuid.endsWith(leaf)) return fail("the entry's uuid does not name its body");
  if (!e.inclusionProof) return fail("the log returned no inclusion proof for the entry", true);
  if (!entryIncluded(e)) return fail("the entry's inclusion proof does not verify");
  let body: any;
  try {
    body = JSON.parse(Buffer.from(e.body, "base64").toString("utf8"));
  } catch {
    return fail("the entry body is not JSON");
  }
  if (body?.kind !== "hashedrekord" || body?.apiVersion !== "0.0.1") return fail("the entry is not a hashedrekord 0.0.1 entry");
  const hash = body?.spec?.data?.hash;
  if (hash?.algorithm !== "sha256" || typeof hash?.value !== "string" || hash.value.toLowerCase() !== digestHex(o.bytes)) return fail("the entry's artifact hash is not the bundle digest");
  let entryKey: KeyObject;
  try {
    entryKey = createPublicKey(Buffer.from(String(body?.spec?.signature?.publicKey?.content ?? ""), "base64").toString("utf8"));
  } catch {
    return fail("the entry carries no readable public key");
  }
  if (!sameKey(entryKey, o.publicKey)) return fail("the entry was not signed with the measurement key");
  if (!verifySignature(o.bytes, String(body?.spec?.signature?.content ?? ""), o.publicKey)) return fail("the entry's signature does not verify against the bundle");
  const rekorKey = o.rekorPublicKey?.trim() ? unescapeNewlines(o.rekorPublicKey) : null;
  return { ok: true, leafHash: leaf, checkpointVerified: rekorKey ? checkpointSigned(e, rekorKey) : false, setVerified: rekorKey ? setSigned(e, rekorKey) : false };
}

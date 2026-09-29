import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { isAddress, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson } from "../lib/util.ts";

// Signing and verification for IPX oracle updates. This file has no database, chain or config imports, so the
// standalone verifier (scripts/ipx-oracle-verify.ts) and a consumer can use it as is.
//
// An update is a JSON object. Its digest is SHA-256 over the canonical JSON of the update WITHOUT its `signature`
// member (object keys sorted recursively, no whitespace). The oracle key signs the 32 digest bytes:
//   ed25519           Ed25519 (RFC 8032); the signer is the 32-byte public key.
//   secp256k1-eip191  EIP-191 personal_sign over the 32 bytes; the signer is the recovered address.
// The private key is read by the caller from the environment. Nothing here generates, prints or stores one.

export const ORACLE_KIND = "ipx-index-price";
export const ORACLE_VERSION = 1;
export const ORACLE_ALGORITHMS = ["ed25519", "secp256k1-eip191"] as const;
export type OracleAlgorithm = (typeof ORACLE_ALGORITHMS)[number];
export type OracleStatus = "ok" | "thin" | "halted";

export type UpdateBody = {
  v: typeof ORACLE_VERSION;
  kind: typeof ORACLE_KIND;
  /** "ANYR-IPX/<class>" */
  index: string;
  class: string;
  status: OracleStatus;
  /** USDG per 1,000,000 tokens as a decimal string, and scaled by 10^decimals. Null in a halted record. */
  price: string | null;
  price_e8: string | null;
  decimals: number;
  unit: string;
  /** Unix seconds when the update was made, and when a consumer must treat it as unusable. */
  timestamp: number;
  valid_until: number;
  stale_after_s: number;
  /** Per class, increases by one per signed record. */
  sequence: number;
  /** Trailing-24h volume below the threshold. Null in a halted record (not evaluated). */
  thin: boolean | null;
  volume_usdg_24h: string | null;
  thin_threshold_usdg: string | null;
  /** Recommendation to the consumer: only allow positions to be reduced. */
  reduce_only: boolean;
  reduce_only_reasons: string[];
  halted: boolean;
  halt_reason: string | null;
  /** The IPX sample behind the price. Null in a halted record. */
  source: { window_from: number; window_to: number; receipt_root: Hex | null; receipts_in_root: number; raw_price_e8: string } | null;
  /** The per-update move limit; `applied` when the published price differs from the sample because of it. */
  clamp: { applied: boolean; max_move_bps: number; previous_price_e8: string | null } | null;
};

export type OracleSignature = { algorithm: OracleAlgorithm; signer: string; digest: Hex; value: Hex };
export type SignedUpdate = UpdateBody & { signature: OracleSignature };

const ED_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const bytesOf = (hex: string) => Buffer.from(hex.replace(/^0x/, ""), "hex");
const hexOf = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;

export const isPrivateKeyHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/** Holds one oracle key. The key is not readable from outside, is not part of toJSON and never appears in inspect output. */
export class OracleSigner {
  readonly publicKey: string;
  readonly #signBytes: (message: Uint8Array) => Promise<Uint8Array>;

  constructor(readonly algorithm: OracleAlgorithm, privateKey: Hex) {
    if (!isPrivateKeyHex(privateKey)) throw new Error("The oracle key must be 0x followed by 32 bytes of hex.");
    if (algorithm === "ed25519") {
      const priv = createPrivateKey({ key: Buffer.concat([ED_PKCS8_PREFIX, bytesOf(privateKey)]), format: "der", type: "pkcs8" });
      const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
      this.publicKey = hexOf(spki.subarray(spki.length - 32));
      this.#signBytes = async (m) => new Uint8Array(nodeSign(null, Buffer.from(m), priv));
    } else if (algorithm === "secp256k1-eip191") {
      const account = privateKeyToAccount(privateKey);
      this.publicKey = account.address;
      this.#signBytes = async (m) => bytesOf(await account.signMessage({ message: { raw: m } }));
    } else throw new Error("Unsupported oracle algorithm.");
  }

  /** Sign arbitrary bytes with the scheme above. */
  signBytes(message: Uint8Array): Promise<Uint8Array> {
    return this.#signBytes(message);
  }

  async signDigest(digest: Hex): Promise<Hex> {
    return hexOf(await this.#signBytes(bytesOf(digest)));
  }

  toJSON() {
    return { algorithm: this.algorithm, public_key: this.publicKey };
  }
}

/** The public key (or address) that belongs to a private key, without keeping the signer. */
export function publicKeyOf(algorithm: OracleAlgorithm, privateKey: Hex): string {
  return new OracleSigner(algorithm, privateKey).publicKey;
}

export const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function updateDigest(update: UpdateBody | SignedUpdate): Hex {
  const { signature: _omit, ...body } = update as SignedUpdate;
  return ("0x" + createHash("sha256").update(canonicalJson(body)).digest("hex")) as Hex;
}

export async function signUpdate(signer: OracleSigner, body: UpdateBody): Promise<SignedUpdate> {
  const digest = updateDigest(body);
  return { ...body, signature: { algorithm: signer.algorithm, signer: signer.publicKey, digest, value: await signer.signDigest(digest) } };
}

export async function verifySignature(algorithm: OracleAlgorithm, publicKey: string, digest: Hex, signature: string): Promise<boolean> {
  try {
    if (algorithm === "ed25519") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(publicKey) || !/^0x[0-9a-fA-F]{128}$/.test(signature)) return false;
      const key = createPublicKey({ key: Buffer.concat([ED_SPKI_PREFIX, bytesOf(publicKey)]), format: "der", type: "spki" });
      return nodeVerify(null, bytesOf(digest), key, bytesOf(signature));
    }
    if (algorithm === "secp256k1-eip191") {
      if (!isAddress(publicKey, { strict: false }) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
      return sameKey(await recoverMessageAddress({ message: { raw: digest }, signature: signature as Hex }), publicKey);
    }
    return false;
  } catch {
    return false;
  }
}

// ---- What a consumer should do with an update ---------------------------------------------------------

export type ConsumerAction = "normal" | "reduce_only" | "halt";
export type Assessment = { status: "ok" | "thin" | "halted" | "stale" | "invalid_time" | "unavailable"; consumer_action: ConsumerAction; stale: boolean; age_s: number | null };
/** How far ahead of the reader's clock a timestamp may be. */
export const CLOCK_SKEW_S = 60;

/** Stale-price guard: an update past `valid_until` must not be used. Also the rule for halted and price-less records. */
export function assess(update: SignedUpdate | null, nowS: number): Assessment {
  if (!update) return { status: "unavailable", consumer_action: "halt", stale: false, age_s: null };
  const age = Math.max(0, nowS - update.timestamp);
  if (update.status === "halted" || update.halted || update.price_e8 === null) return { status: "halted", consumer_action: "halt", stale: nowS > update.valid_until, age_s: age };
  if (nowS > update.valid_until) return { status: "stale", consumer_action: "halt", stale: true, age_s: age };
  // An update dated ahead of the reader's clock would stay "fresh" for longer than stale_after_s: not usable.
  if (update.timestamp > nowS + CLOCK_SKEW_S) return { status: "invalid_time", consumer_action: "halt", stale: false, age_s: 0 };
  if (update.reduce_only || update.status === "thin") return { status: "thin", consumer_action: "reduce_only", stale: false, age_s: age };
  return { status: "ok", consumer_action: "normal", stale: false, age_s: age };
}

export type Verification = {
  /** Digest and signature are valid, and the signer is the pinned key when one was given. */
  ok: boolean;
  signature_valid: boolean;
  digest_valid: boolean;
  pinned: boolean;
  problems: string[];
  assessment: Assessment;
};


/**
 * Verify one update the way a consumer must. Pass `publicKey` (pinned out of band) to make `ok` mean "signed by that
 * key"; without it the signature is only checked against the key the update names, and `pinned` is false.
 */
export async function verifyUpdate(update: unknown, opts: { publicKey?: string; algorithm?: OracleAlgorithm; nowS?: number; maxAgeS?: number } = {}): Promise<Verification> {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const problems: string[] = [];
  const u = update as SignedUpdate | null;
  const shaped = !!u && typeof u === "object" && u.v === ORACLE_VERSION && u.kind === ORACLE_KIND && !!u.signature && typeof u.signature === "object" && typeof u.timestamp === "number" && typeof u.valid_until === "number";
  if (!shaped) return { ok: false, signature_valid: false, digest_valid: false, pinned: false, problems: ["not an IPX oracle update"], assessment: assess(null, nowS) };
  const algorithm = u.signature.algorithm;
  if (!ORACLE_ALGORITHMS.includes(algorithm)) problems.push("unknown signature algorithm");
  if (opts.algorithm && opts.algorithm !== algorithm) problems.push("signature algorithm is not the expected one");
  const digestValid = updateDigest(u).toLowerCase() === String(u.signature.digest).toLowerCase();
  if (!digestValid) problems.push("digest does not match the update contents");
  const signatureValid = digestValid && (await verifySignature(algorithm, u.signature.signer, u.signature.digest, u.signature.value));
  if (digestValid && !signatureValid) problems.push("signature does not verify against the named signer");
  const pinned = !!opts.publicKey;
  if (opts.publicKey && !sameKey(opts.publicKey, u.signature.signer)) problems.push("signer is not the pinned public key");
  if (u.timestamp > nowS + CLOCK_SKEW_S) problems.push("timestamp is in the future");
  if (opts.maxAgeS !== undefined && nowS - u.timestamp > opts.maxAgeS) problems.push("older than the caller's maximum age");
  const assessment = assess(u, nowS);
  if (assessment.stale) problems.push("past valid_until: the update is stale");
  const trustworthy = digestValid && signatureValid && (!opts.publicKey || sameKey(opts.publicKey, u.signature.signer));
  return { ok: trustworthy, signature_valid: signatureValid, digest_valid: digestValid, pinned, problems, assessment };
}

/** The text served next to an update so a consumer can check it without reading this code. */
export function verificationInstructions(algorithm: OracleAlgorithm, publicKey: string | null) {
  return {
    algorithm,
    public_key: publicKey,
    key_note: "Pin this key when the oracle is registered with a consumer. A key read from the same response as the update proves nothing by itself.",
    digest: "SHA-256 of the canonical JSON of the update without its `signature` member: object keys sorted recursively, no whitespace. `signature.digest` must equal 0x + that hash.",
    signature:
      algorithm === "ed25519"
        ? "Ed25519 (RFC 8032) over the 32 digest bytes. `signature.value` is 64 bytes of hex; `signature.signer` is the 32-byte public key."
        : "EIP-191 personal_sign over the 32 digest bytes (prefix \"\\x19Ethereum Signed Message:\\n32\"). `signature.value` is 65 bytes of hex; `signature.signer` is the address recovered from it.",
    freshness: "Do not use an update after `valid_until` (unix seconds). Halt the market when it passes and when `status` is \"halted\".",
    thin: "When `reduce_only` is true (the class is THIN), only allow positions to be reduced.",
    reference_verifier: "bun scripts/ipx-oracle-verify.ts --url <this URL> --public-key <pinned key>",
  };
}

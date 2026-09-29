import { and, asc, eq, gt, isNotNull, lte, or, sql } from "drizzle-orm";
import { encodeAbiParameters, keccak256 } from "viem";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { blindKeys, blindNullifiers } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import type { Pico } from "../lib/money.ts";
import { decrypt, encrypt, log } from "../lib/util.ts";
import { generateIssuerKey, importIssuerPublicKey, parseIssuerSpki, Signer, suite, tokenKeyId } from "./rsa.ts";
import { b64url, bytesEqual, challengeDigest, decodeToken, hex, nullifierOf, signedPart, tokenChallenge } from "./token.ts";

// Per-epoch issuer keys, one per denomination, and token verification.
//
// Epoch e covers [e * epochSeconds, (e + 1) * epochSeconds) since the Unix epoch (weekly by default). A key
// signs only inside its epoch, is redeemable until BLIND_REDEEM_GRACE_SECONDS after that, and loses its
// private half when its epoch ends. The next epoch's keys are created ahead of time, so they are published
// before they are used.

export type BlindKey = typeof blindKeys.$inferSelect;
export type KeyStatus = "upcoming" | "issuing" | "redeem_only" | "expired" | "revoked";

/** What one token of this key is worth (pico-USD): its denomination at the unit price the key was created with. */
export const keyValue = (k: Pick<BlindKey, "denomination" | "unitPrice">): Pico => BigInt(k.denomination) * k.unitPrice;

/** A token that verified: what it is worth and which key signed it. Not yet spent. */
export type VerifiedToken = { nullifier: string; keyId: string; epoch: number; denomination: number; key: BlindKey };

export class BlindIssuer {
  /** Test hook: the clock. */
  now: () => number = () => Date.now();
  readonly challenge: Uint8Array;
  readonly challengeDigest: Uint8Array;
  private readonly signers = new Map<string, Signer>();
  private readonly verifiers = new Map<string, Promise<CryptoKey>>();
  private readonly creating = new Map<number, Promise<number>>();
  private readyThrough = -1;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {
    this.challenge = tokenChallenge(cfg.blind.issuerName);
    this.challengeDigest = challengeDigest(this.challenge);
  }

  /** RFC 9577 challenge a 401 carries so a client can find out what this router wants (keys: GET /api/v1/blind/keys). */
  get challengeHeader(): Record<string, string> {
    return { "www-authenticate": `PrivateToken challenge="${b64url(this.challenge)}"` };
  }

  // ---- epochs and key lifecycle ------------------------------------------------------------------

  epochAt(ms = this.now()) {
    return Math.floor(ms / 1000 / this.cfg.blind.epochSeconds);
  }

  /** When epoch e's keys may sign, stop signing, and stop being accepted. */
  window(epoch: number) {
    const w = this.cfg.blind.epochSeconds * 1000;
    const g = this.cfg.blind.redeemGraceSeconds * 1000;
    return { validFrom: new Date(epoch * w), issueUntil: new Date((epoch + 1) * w), redeemUntil: new Date((epoch + 1) * w + g) };
  }

  status(k: BlindKey, at = this.now()): KeyStatus {
    if (k.revokedAt) return "revoked";
    if (at < k.validFrom.getTime()) return "upcoming";
    if (at < k.issueUntil.getTime()) return k.privateEnc ? "issuing" : "redeem_only";
    return at < k.redeemUntil.getTime() ? "redeem_only" : "expired";
  }

  /** Create any missing keys for the current epoch and the next one. Idempotent and safe under concurrency. */
  async ensureCurrent(): Promise<void> {
    const epoch = this.epochAt();
    if (epoch + 1 <= this.readyThrough) return;
    await this.ensureEpoch(epoch);
    await this.ensureEpoch(epoch + 1);
    this.readyThrough = epoch + 1;
  }

  /** Returns how many keys this call created. */
  ensureEpoch(epoch: number): Promise<number> {
    let p = this.creating.get(epoch);
    if (!p) {
      p = this.createMissing(epoch).finally(() => this.creating.delete(epoch));
      this.creating.set(epoch, p);
    }
    return p;
  }

  private async createMissing(epoch: number): Promise<number> {
    const have = new Set((await this.db.select({ d: blindKeys.denomination }).from(blindKeys).where(eq(blindKeys.epoch, epoch))).map((r) => r.d));
    let created = 0;
    for (const denomination of this.cfg.blind.denominations) {
      if (have.has(denomination)) continue;
      const material = await generateIssuerKey();
      const rows = await this.db
        .insert(blindKeys)
        .values({
          keyId: material.keyId,
          epoch,
          denomination,
          unitPrice: this.cfg.blind.unitPricePico,
          spki: b64url(material.spki),
          privateEnc: encrypt(this.cfg.appSecret, Buffer.from(material.pkcs8).toString("base64")),
          ...this.window(epoch),
        })
        .onConflictDoNothing()
        .returning({ keyId: blindKeys.keyId });
      created += rows.length; // another process may have created this (epoch, denomination) first: then nothing is added
    }
    return created;
  }

  /**
   * Weekly rotation: make sure the current and next epochs have keys, and wipe the private half of every key
   * whose epoch has ended or that was revoked. Run by the `blind-key-rotation` job; safe to run at any time.
   */
  async rotate(): Promise<{ epoch: number; created: number; wiped: number }> {
    const epoch = this.epochAt();
    const created = (await this.ensureEpoch(epoch)) + (await this.ensureEpoch(epoch + 1));
    this.readyThrough = Math.max(this.readyThrough, epoch + 1);
    const wiped = await this.db
      .update(blindKeys)
      .set({ privateEnc: null })
      .where(and(isNotNull(blindKeys.privateEnc), or(lte(blindKeys.issueUntil, new Date(this.now())), isNotNull(blindKeys.revokedAt))))
      .returning({ keyId: blindKeys.keyId });
    for (const w of wiped) this.signers.delete(w.keyId);
    if (created || wiped.length) log.info("blind issuer keys rotated", { epoch, created, wiped: wiped.length });
    return { epoch, created, wiped: wiped.length };
  }

  /** Stop accepting one epoch's tokens (a compromised or mis-issued key) and destroy its private half. */
  async revokeEpoch(epoch: number): Promise<number> {
    const rows = await this.db
      .update(blindKeys)
      .set({ revokedAt: new Date(this.now()), privateEnc: null })
      .where(and(eq(blindKeys.epoch, epoch), sql`${blindKeys.revokedAt} is null`))
      .returning({ keyId: blindKeys.keyId });
    for (const r of rows) this.signers.delete(r.keyId);
    return rows.length;
  }

  /** Keys a client may still need: not yet expired, oldest epoch first. */
  async publicKeys(): Promise<BlindKey[]> {
    await this.ensureCurrent();
    return this.db
      .select()
      .from(blindKeys)
      .where(gt(blindKeys.redeemUntil, new Date(this.now())))
      .orderBy(asc(blindKeys.epoch), asc(blindKeys.denomination));
  }

  async keyById(keyId: string): Promise<BlindKey | null> {
    const [row] = await this.db.select().from(blindKeys).where(eq(blindKeys.keyId, keyId));
    return row ?? null;
  }

  /**
   * On-chain commitment for one epoch: keccak256(abi.encode(epoch, denominations, keyIds)), the value
   * BlindIssuer.commitEpoch stores and emits. Denominations ascend.
   */
  async commitment(epoch: number): Promise<{ commitment: `0x${string}`; denominations: number[]; keyIds: `0x${string}`[] } | null> {
    const rows = (await this.db.select().from(blindKeys).where(eq(blindKeys.epoch, epoch))).sort((a, b) => a.denomination - b.denomination);
    if (rows.length !== this.cfg.blind.denominations.length) return null;
    return epochCommitment(epoch, rows.map((r) => ({ denomination: r.denomination, keyId: r.keyId })));
  }

  // ---- issuing -----------------------------------------------------------------------------------

  /** The key a purchase names, if it may sign right now. Otherwise a specific refusal. */
  async issuingKey(keyId: string): Promise<BlindKey> {
    const k = /^[0-9a-f]{64}$/.test(keyId) ? await this.keyById(keyId) : null;
    if (!k) throw new ApiError(404, "Unknown token key. List the current keys with GET /api/v1/blind/keys.", "unknown_token_key");
    const s = this.status(k);
    if (s === "issuing") return k;
    if (s === "upcoming") throw new ApiError(409, "That key's epoch has not started.", "epoch_not_open", { epoch: k.epoch, valid_from: k.validFrom.toISOString() });
    if (s === "revoked") throw new ApiError(409, "That key was revoked.", "token_key_revoked", { epoch: k.epoch });
    throw new ApiError(409, "That key's epoch has ended and no longer issues tokens.", "epoch_closed", { epoch: k.epoch });
  }

  async signer(k: BlindKey): Promise<Signer> {
    const cached = this.signers.get(k.keyId);
    if (cached) return cached;
    if (!k.privateEnc) throw new ApiError(409, "That key's epoch has ended and no longer issues tokens.", "epoch_closed", { epoch: k.epoch });
    const signer = new Signer(new Uint8Array(Buffer.from(decrypt(this.cfg.appSecret, k.privateEnc), "base64")));
    if (tokenKeyId(signer.spki) !== k.keyId) throw new Error("blind issuer key does not match its recorded key id");
    this.signers.set(k.keyId, signer);
    return signer;
  }

  /** The key's modulus, for checking that a blinded message is below it. */
  modulus(k: BlindKey): Uint8Array {
    return parseIssuerSpki(new Uint8Array(Buffer.from(k.spki, "base64url"))).n;
  }

  // ---- redeeming ---------------------------------------------------------------------------------

  private verifier(k: BlindKey): Promise<CryptoKey> {
    let v = this.verifiers.get(k.keyId);
    if (!v) {
      v = importIssuerPublicKey(new Uint8Array(Buffer.from(k.spki, "base64url")));
      this.verifiers.set(k.keyId, v);
      v.catch(() => this.verifiers.delete(k.keyId));
    }
    return v;
  }

  /**
   * Check a presented token without spending it: well-formed, for this router's challenge, signed by a key
   * that is still accepted, and a valid RSA-PSS signature. Every refusal is a 401 with a stable `type`.
   */
  async verify(tokenBytes: Uint8Array): Promise<VerifiedToken> {
    const invalid = (message = "Invalid token.", type = "invalid_token", metadata?: Record<string, unknown>) => new ApiError(401, message, type, metadata, this.challengeHeader);
    const token = decodeToken(tokenBytes);
    if (!token) throw invalid("Malformed token: expected a 354-byte type 0x0002 Privacy Pass token.");
    if (!bytesEqual(token.challengeDigest, this.challengeDigest)) throw invalid("Token was not issued for this router's challenge.");
    const key = await this.keyById(hex(token.keyId));
    if (!key) throw invalid("Token key is unknown.", "unknown_token_key");
    const s = this.status(key);
    if (s === "revoked") throw invalid("Token key was revoked.", "token_key_revoked", { epoch: key.epoch });
    if (s === "expired") throw invalid("Token epoch is over; tokens are redeemable until the end of the grace period.", "token_epoch_expired", { epoch: key.epoch });
    if (s === "upcoming") throw invalid("Token key is not valid yet.", "token_epoch_not_open", { epoch: key.epoch });
    const ok = await suite().verify(await this.verifier(key), token.authenticator, signedPart(tokenBytes));
    if (!ok) throw invalid("Token signature is invalid.");
    return { nullifier: nullifierOf(tokenBytes), keyId: key.keyId, epoch: key.epoch, denomination: key.denomination, key };
  }

  /** Redemption counts per key, from the nullifier table (issuance counts live on the key row). */
  async redeemedCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ keyId: blindNullifiers.keyId, n: sql<number>`count(*)::int` })
      .from(blindNullifiers)
      .where(eq(blindNullifiers.status, "spent"))
      .groupBy(blindNullifiers.keyId);
    return new Map(rows.map((r) => [r.keyId, r.n]));
  }
}

/** keccak256(abi.encode(uint64 epoch, uint32[] denominations, bytes32[] keyIds)); mirrors BlindIssuer.sol. */
export function epochCommitment(epoch: number, keys: { denomination: number; keyId: string }[]) {
  const denominations = keys.map((k) => k.denomination);
  const keyIds = keys.map((k) => `0x${k.keyId}` as `0x${string}`);
  const commitment = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "uint32[]" }, { type: "bytes32[]" }], [BigInt(epoch), denominations, keyIds]));
  return { commitment, denominations, keyIds };
}

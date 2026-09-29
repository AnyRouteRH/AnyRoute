import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { receiptKeys } from "../db/schema.ts";
import { canonicalJson, decrypt, encrypt, sha256 } from "../lib/util.ts";
import { keyPublished } from "../tlog/hooks.ts";
import { coseSign1, decodeCoseSign1, decodeClaims, encodeClaims, receiptLeafV2, COSE_ALG_EDDSA, type ClaimsV2 } from "./v2.ts";

// Ed25519 receipt signing with weekly rotation. Every key ever used stays in receipt_keys
// (public half forever) so old receipts keep verifying; the public keys are also registered
// on-chain in ReceiptAnchor so verification never has to trust this server.

export type ReceiptKey = { id: string; publicKeyHex: string; privateKey?: KeyObject; publicKey: KeyObject; validFrom: Date; retiredAt: Date | null };

const rawPublic = (pub: KeyObject) => Buffer.from(pub.export({ format: "jwk" }).x as string, "base64url");
const keyIdOf = (pub: KeyObject) => sha256(rawPublic(pub)).slice(0, 16);
const publicFromRaw = (hex: string) =>
  createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(hex, "hex").toString("base64url") }, format: "jwk" });

export const canonicalBytes = (payload: unknown) => Buffer.from(canonicalJson(payload));

export class ReceiptSigner {
  private active: ReceiptKey | null = null;
  private cache = new Map<string, ReceiptKey>();

  constructor(
    private db: Db,
    private secret: string,
    private rotationDays: number,
    private pinnedKey?: string, // base64 PKCS8 DER; disables rotation
  ) {}

  async init() {
    if (this.pinnedKey) {
      const priv = createPrivateKey({ key: Buffer.from(this.pinnedKey, "base64"), format: "der", type: "pkcs8" });
      if (priv.asymmetricKeyType !== "ed25519") throw new Error("RECEIPT_SIGNING_KEY must be an Ed25519 PKCS8 key.");
      const pub = createPublicKey(priv);
      const id = keyIdOf(pub);
      const publicKeyHex = rawPublic(pub).toString("hex");
      await this.db
        .insert(receiptKeys)
        .values({ id, publicKey: publicKeyHex, validFrom: new Date() })
        .onConflictDoNothing();
      const [row] = await this.db.select().from(receiptKeys).where(eq(receiptKeys.id, id));
      this.active = { id, publicKeyHex, privateKey: priv, publicKey: pub, validFrom: row.validFrom, retiredAt: null };
      return;
    }
    await this.rotateIfDue();
  }

  /** Create a new key when none is active or the active one is older than the rotation period. */
  async rotateIfDue(force = false): Promise<{ rotated: boolean; key: ReceiptKey }> {
    if (this.pinnedKey && this.active) return { rotated: false, key: this.active };
    const [current] = await this.db
      .select()
      .from(receiptKeys)
      .where(isNull(receiptKeys.retiredAt))
      .orderBy(desc(receiptKeys.validFrom))
      .limit(1);
    const due = !current || !current.privateKeyEnc || force || Date.now() - current.validFrom.getTime() >= this.rotationDays * 86_400_000;
    if (!due) {
      this.active = this.load(current);
      return { rotated: false, key: this.active };
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const id = keyIdOf(publicKey);
    const publicKeyHex = rawPublic(publicKey).toString("hex");
    const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const validFrom = new Date();
    await this.db.transaction(async (tx) => {
      if (current) await tx.update(receiptKeys).set({ retiredAt: validFrom }).where(eq(receiptKeys.id, current.id));
      await tx.insert(receiptKeys).values({ id, publicKey: publicKeyHex, privateKeyEnc: encrypt(this.secret, der), validFrom });
    });
    keyPublished(this.db, "receipt_key"); // transparency log (a no-op unless TLOG_ENABLED)
    this.active = { id, publicKeyHex, privateKey, publicKey, validFrom, retiredAt: null };
    this.cache.set(id, this.active);
    return { rotated: true, key: this.active };
  }

  private load(row: typeof receiptKeys.$inferSelect): ReceiptKey {
    const cached = this.cache.get(row.id);
    if (cached && cached.retiredAt?.getTime() === row.retiredAt?.getTime()) return cached;
    const publicKey = publicFromRaw(row.publicKey);
    const privateKey = row.privateKeyEnc
      ? createPrivateKey({ key: Buffer.from(decrypt(this.secret, row.privateKeyEnc), "base64"), format: "der", type: "pkcs8" })
      : undefined;
    const k = { id: row.id, publicKeyHex: row.publicKey, publicKey, privateKey, validFrom: row.validFrom, retiredAt: row.retiredAt };
    this.cache.set(row.id, k);
    return k;
  }

  get keyId() {
    if (!this.active) throw new Error("receipt signer not initialized");
    return this.active.id;
  }

  sign(payload: unknown): { keyId: string; sig: string; bytes: Buffer; sigBytes: Buffer } {
    if (!this.active?.privateKey) throw new Error("receipt signer not initialized");
    const bytes = canonicalBytes(payload);
    const sigBytes = edSign(null, bytes, this.active.privateKey);
    return { keyId: this.active.id, sig: sigBytes.toString("base64"), bytes, sigBytes };
  }

  /** Receipt v2: COSE_Sign1 over the CBOR claims, EdDSA with the same active key; kid is the key id's 8 bytes. */
  signCose(claims: ClaimsV2): { keyId: string; cose: Buffer; leaf: `0x${string}` } {
    if (!this.active?.privateKey) throw new Error("receipt signer not initialized");
    const key = this.active.privateKey;
    const cose = Buffer.from(coseSign1(encodeClaims(claims), Buffer.from(this.active.id, "hex"), (tbs) => edSign(null, tbs, key)));
    return { keyId: this.active.id, cose, leaf: receiptLeafV2(cose) };
  }

  async publicKey(keyId: string): Promise<ReceiptKey | null> {
    if (this.cache.has(keyId)) return this.cache.get(keyId)!;
    const [row] = await this.db.select().from(receiptKeys).where(eq(receiptKeys.id, keyId));
    return row ? this.load(row) : null;
  }

  async verify(payload: unknown, sigB64: string, keyId: string): Promise<boolean> {
    const k = await this.publicKey(keyId);
    if (!k) return false;
    try {
      return edVerify(null, canonicalBytes(payload), k.publicKey, Buffer.from(sigB64, "base64"));
    } catch {
      return false;
    }
  }

  async jwks() {
    const rows = await this.db.select().from(receiptKeys).orderBy(desc(receiptKeys.validFrom));
    return {
      keys: rows.map((r) => ({
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(r.publicKey, "hex").toString("base64url"),
        kid: r.id,
        use: "sig",
        alg: "EdDSA",
        valid_from: r.validFrom.toISOString(),
        retired_at: r.retiredAt?.toISOString() ?? null,
        onchain_tx: r.onchainTx ?? null,
      })),
    };
  }
}

export function verifyWithRawKey(payload: unknown, sigB64: string, publicKeyHex: string) {
  try {
    return edVerify(null, canonicalBytes(payload), publicFromRaw(publicKeyHex), Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

/** The key id (16 hex) and claims a v2 receipt names, without checking anything. Throws on malformed bytes. */
export function inspectCose(cose: Uint8Array): { keyId: string | null; alg: number | null; claims: ClaimsV2 } {
  const d = decodeCoseSign1(cose);
  return { keyId: d.kid ? Buffer.from(d.kid).toString("hex") : null, alg: d.alg, claims: decodeClaims(d.payload) };
}

/** Check a v2 receipt's COSE_Sign1 (alg EdDSA) against a raw Ed25519 public key in hex. */
export function verifyCoseWithRawKey(cose: Uint8Array, publicKeyHex: string): boolean {
  try {
    const d = decodeCoseSign1(cose);
    if (d.alg !== COSE_ALG_EDDSA) return false;
    return edVerify(null, d.toBeSigned, publicFromRaw(publicKeyHex), d.signature);
  } catch {
    return false;
  }
}

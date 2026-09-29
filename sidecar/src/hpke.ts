import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { bytesToHex, sha256Hex } from "./util.ts";

// End-to-end encryption of requests and responses to a key that only exists inside the enclave.
//
// Suite (RFC 9180, base mode): DHKEM(X25519, HKDF-SHA256) kem_id 0x0020, HKDF-SHA256 kdf_id 0x0001, AES-128-GCM
// aead_id 0x0001. The HPKE implementation is @hpke/core, which drives the runtime's WebCrypto; nothing in this
// file implements a primitive. The public key is generated at boot, bound into the attestation report data as
// `hpke_pubkey`, and served at /attest.
//
// Request (content-type application/anyroute-hpke), bytes:
//   [0]      version, 0x01
//   [1..8]   client time, milliseconds since the Unix epoch, unsigned 64-bit big-endian
//   [9..40]  enc, the 32-byte encapsulated key
//   [41..]   ct, the HPKE AEAD ciphertext (plaintext plus a 16-byte tag)
// HPKE info = "anyroute-hpke/v1"; aad = bytes [0..8] followed by the ASCII request path (for example
// "/v1/chat/completions"). The plaintext is the JSON body a plain client would have sent. The time bounds replay
// to a window and the path stops a ciphertext from being replayed against another endpoint; a request whose enc
// was already seen inside the window is refused.
//
// Response (content-type application/anyroute-hpke, or application/anyroute-hpke-stream for an event stream).
// RFC 9180 section 9.8 (bidirectional encryption) and the construction of RFC 9458 section 4.4 are followed:
//   secret        = context.Export("anyroute-hpke/v1 response", 16)
//   response_nonce = 16 random bytes, sent first
//   prk           = HKDF-Extract(salt = enc || response_nonce, secret)
//   key           = HKDF-Expand(prk, "key", 16); base_nonce = HKDF-Expand(prk, "nonce", 12)
// The nonce is fresh per response, so a replayed request never reuses a key. After the 16 nonce bytes come
// frames, each  flag(1) || length(4, big-endian) || ciphertext  where the ciphertext is AES-128-GCM under `key`,
// nonce = base_nonce XOR (frame index as a big-endian integer in its last 4 bytes), aad = the flag byte. The flag is
// 0x01 on the last frame only, so cutting a stream short is detectable; a JSON response is a single last frame.
// For an event stream the frame plaintexts, concatenated, are the upstream bytes (followed by the receipt event).

export const HPKE_CONTENT_TYPE = "application/anyroute-hpke";
export const HPKE_STREAM_CONTENT_TYPE = "application/anyroute-hpke-stream";
export const HPKE_WIRE_VERSION = 1;
export const REQUEST_HEADER_LEN = 9;
export const ENC_LEN = 32;
export const TAG_LEN = 16;
export const RESPONSE_NONCE_LEN = 16;
export const MAX_FRAME_BYTES = 1 << 30;
export const HPKE_SUITE = { kem: "DHKEM(X25519, HKDF-SHA256)", kem_id: 0x0020, kdf: "HKDF-SHA256", kdf_id: 0x0001, aead: "AES-128-GCM", aead_id: 0x0001 } as const;

const utf8 = (s: string) => new TextEncoder().encode(s);
export const HPKE_INFO = utf8("anyroute-hpke/v1");
export const RESPONSE_EXPORT_CONTEXT = utf8("anyroute-hpke/v1 response");
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

export const newSuite = () => new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
export const requestAad = (header: Uint8Array, path: string) => cat(header, utf8(path));

export type HpkeFailure = "malformed" | "expired" | "replayed" | "decryption_failed";
export class HpkeError extends Error {
  constructor(
    readonly reason: HpkeFailure,
    message: string,
  ) {
    super(message);
    this.name = "HpkeError";
  }
}

// ---- response framing (shared by the enclave and the client) --------------------------------------------

export class FrameCipher {
  private readonly key: Buffer;
  private readonly baseNonce: Buffer;
  private seq = 0;
  constructor(secret: Uint8Array, enc: Uint8Array, responseNonce: Uint8Array) {
    const salt = Buffer.concat([enc, responseNonce]);
    this.key = Buffer.from(hkdfSync("sha256", secret, salt, "key", 16));
    this.baseNonce = Buffer.from(hkdfSync("sha256", secret, salt, "nonce", 12));
  }

  private nextNonce(): Buffer {
    if (this.seq > 0xffffffff) throw new Error("too many frames");
    const n = Buffer.from(this.baseNonce);
    n.writeUInt32BE((n.readUInt32BE(8) ^ this.seq) >>> 0, 8);
    this.seq++;
    return n;
  }

  seal(plaintext: Uint8Array, final: boolean): Uint8Array {
    const flag = Buffer.from([final ? 1 : 0]);
    const c = createCipheriv("aes-128-gcm", this.key, this.nextNonce());
    c.setAAD(flag);
    const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
    const head = Buffer.alloc(5);
    head[0] = flag[0];
    head.writeUInt32BE(ct.length, 1);
    return new Uint8Array(Buffer.concat([head, ct]));
  }

  open(flag: number, ct: Uint8Array): Uint8Array {
    const buf = Buffer.from(ct);
    const d = createDecipheriv("aes-128-gcm", this.key, this.nextNonce());
    d.setAAD(Buffer.from([flag]));
    d.setAuthTag(buf.subarray(buf.length - TAG_LEN));
    try {
      return new Uint8Array(Buffer.concat([d.update(buf.subarray(0, buf.length - TAG_LEN)), d.final()]));
    } catch {
      throw new Error("frame authentication failed");
    }
  }
}

/** Encrypts one response to the client whose request was just opened. Not reusable across requests. */
export class HpkeResponder {
  /** The 16 response-nonce bytes: the first bytes of the response body. */
  readonly prefix: Uint8Array;
  private readonly cipher: FrameCipher;
  private closed = false;
  constructor(enc: Uint8Array, secret: Uint8Array, responseNonce: Uint8Array = new Uint8Array(randomBytes(RESPONSE_NONCE_LEN))) {
    this.prefix = responseNonce;
    this.cipher = new FrameCipher(secret, enc, responseNonce);
  }

  /** One frame. After a frame with `final` set, no more may be produced. */
  frame(plaintext: Uint8Array, final: boolean): Uint8Array {
    if (this.closed) throw new Error("the response is already complete");
    if (final) this.closed = true;
    return this.cipher.seal(plaintext, final);
  }

  /** A whole response in one piece: nonce, then one last frame. */
  sealOnce(plaintext: Uint8Array): Uint8Array {
    return cat(this.prefix, this.frame(plaintext, true));
  }
}

// ---- the enclave side -----------------------------------------------------------------------------------

class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}
  /** False when this key was already admitted inside the window. The oldest entries go first when full. */
  admit(key: string, now: number): boolean {
    for (const [k, expires] of this.seen) {
      if (expires > now) break;
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + this.ttlMs);
    while (this.seen.size > this.capacity) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
}

export type HpkeOptions = { clockSkewMs: number; replayCapacity?: number; now?: () => number };

export class HpkeEndpoint {
  private readonly replay: ReplayCache;
  private readonly now: () => number;
  private constructor(
    private readonly suite: CipherSuite,
    private readonly keyPair: CryptoKeyPair,
    /** Hex of the raw 32-byte X25519 public key: what clients encrypt to and what the report data binds. */
    readonly publicKeyHex: string,
    private readonly clockSkewMs: number,
    opts: HpkeOptions,
  ) {
    this.replay = new ReplayCache(opts.replayCapacity ?? 200_000, clockSkewMs * 2);
    this.now = opts.now ?? Date.now;
  }

  /** A fresh key pair. The private key stays in this object; nothing exports or stores it. */
  static async generate(opts: HpkeOptions): Promise<HpkeEndpoint> {
    const suite = newSuite();
    const kp = await suite.kem.generateKeyPair();
    const pub = new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey));
    return new HpkeEndpoint(suite, kp, bytesToHex(pub), opts.clockSkewMs, opts);
  }

  get keyId(): string {
    return sha256Hex(Buffer.from(this.publicKeyHex, "hex")).slice(0, 16);
  }

  /** Open a request body. Throws HpkeError; the messages carry nothing about the content. */
  async open(body: Uint8Array, path: string): Promise<{ plaintext: Uint8Array; responder: HpkeResponder }> {
    if (body.length < REQUEST_HEADER_LEN + ENC_LEN + TAG_LEN) throw new HpkeError("malformed", "the encrypted request is too short");
    if (body[0] !== HPKE_WIRE_VERSION) throw new HpkeError("malformed", "unsupported encrypted request version");
    const header = body.subarray(0, REQUEST_HEADER_LEN);
    const sentAt = Number(Buffer.from(header.subarray(1)).readBigUInt64BE());
    const t = this.now();
    if (Math.abs(t - sentAt) > this.clockSkewMs) throw new HpkeError("expired", "the request time is outside the accepted window; check the client clock");
    const enc = body.subarray(REQUEST_HEADER_LEN, REQUEST_HEADER_LEN + ENC_LEN);
    const ct = body.subarray(REQUEST_HEADER_LEN + ENC_LEN);
    let plaintext: Uint8Array;
    let secret: Uint8Array;
    try {
      const ctx = await this.suite.createRecipientContext({ recipientKey: this.keyPair, enc, info: HPKE_INFO });
      plaintext = new Uint8Array(await ctx.open(ct, requestAad(header, path)));
      secret = new Uint8Array(await ctx.export(RESPONSE_EXPORT_CONTEXT, 16));
    } catch {
      throw new HpkeError("decryption_failed", "the request could not be decrypted (wrong or outdated key, or altered in transit); fetch the current key from /attest");
    }
    // Only a request that opened under our key can occupy a slot in the replay cache.
    if (!this.replay.admit(bytesToHex(enc), t)) throw new HpkeError("replayed", "this encrypted request was already received");
    return { plaintext, responder: new HpkeResponder(new Uint8Array(enc), secret) };
  }
}

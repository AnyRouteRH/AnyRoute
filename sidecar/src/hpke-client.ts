import { FrameCipher, HPKE_INFO, HPKE_WIRE_VERSION, MAX_FRAME_BYTES, newSuite, REQUEST_HEADER_LEN, RESPONSE_EXPORT_CONTEXT, RESPONSE_NONCE_LEN, requestAad, TAG_LEN } from "./hpke.ts";
import { hexToBytes } from "./util.ts";

// Reference client for the encrypted transport described in hpke.ts. The sidecar itself never runs this; it is
// here so integrators have a working implementation to port and the tests have a real counterpart.

const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** Reads a response body, incrementally. Any forged, reordered, altered or extended frame throws. */
export class ResponseOpener {
  private buf: Buffer = Buffer.alloc(0);
  private cipher: FrameCipher | null = null;
  private done = false;
  constructor(
    private readonly enc: Uint8Array,
    private readonly secret: Uint8Array,
  ) {}

  get finished(): boolean {
    return this.done;
  }

  /** Feed received bytes; returns the plaintexts of the frames those bytes completed, in order. */
  feed(chunk: Uint8Array): Uint8Array[] {
    if (this.done && chunk.length) throw new Error("data after the final frame");
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Uint8Array[] = [];
    if (!this.cipher) {
      if (this.buf.length < RESPONSE_NONCE_LEN) return out;
      this.cipher = new FrameCipher(this.secret, this.enc, this.buf.subarray(0, RESPONSE_NONCE_LEN));
      this.buf = this.buf.subarray(RESPONSE_NONCE_LEN);
    }
    while (!this.done && this.buf.length >= 5) {
      const flag = this.buf[0];
      const len = this.buf.readUInt32BE(1);
      if (flag > 1 || len < TAG_LEN || len > MAX_FRAME_BYTES) throw new Error("malformed frame header");
      if (this.buf.length < 5 + len) break;
      out.push(this.cipher.open(flag, this.buf.subarray(5, 5 + len)));
      this.buf = this.buf.subarray(5 + len);
      if (flag === 1) this.done = true;
    }
    if (this.done && this.buf.length) throw new Error("data after the final frame");
    return out;
  }

  /** Call when the body ends: a response without its final frame was cut short. */
  end(): void {
    if (!this.done) throw new Error("the response was cut short (no final frame)");
  }
}

export type SealedRequest = { body: Uint8Array; opener: ResponseOpener };

/** Encrypt `plaintext` (the JSON request body) to the enclave's HPKE public key (hex, from /attest). */
export async function sealRequest(publicKeyHex: string, path: string, plaintext: Uint8Array, opts: { now?: number } = {}): Promise<SealedRequest> {
  const suite = newSuite();
  const recipientPublicKey = await suite.kem.deserializePublicKey(hexToBytes(publicKeyHex));
  const header = new Uint8Array(REQUEST_HEADER_LEN);
  header[0] = HPKE_WIRE_VERSION;
  new DataView(header.buffer).setBigUint64(1, BigInt(opts.now ?? Date.now()));
  const ctx = await suite.createSenderContext({ recipientPublicKey, info: HPKE_INFO });
  const ct = new Uint8Array(await ctx.seal(plaintext, requestAad(header, path)));
  const enc = new Uint8Array(ctx.enc);
  const secret = new Uint8Array(await ctx.export(RESPONSE_EXPORT_CONTEXT, 16));
  return { body: cat(header, enc, ct), opener: new ResponseOpener(enc, secret) };
}

/** Open a complete response body (JSON responses, or a stream already read to the end). */
export function openResponse(opener: ResponseOpener, wire: Uint8Array): Uint8Array {
  const parts = opener.feed(wire);
  opener.end();
  return cat(...parts);
}

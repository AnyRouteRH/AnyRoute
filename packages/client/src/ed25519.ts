import { bytesToBase64Url } from "./bytes.js";

/** Returns true when the signature is valid, false when it is not. Throws {@link UnsupportedCrypto} when it cannot say. */
export type Ed25519Verifier = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => Promise<boolean>;

export class UnsupportedCrypto extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCrypto";
  }
}

const asBuffer = (b: Uint8Array) => b as unknown as BufferSource;

async function viaWebCrypto(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new UnsupportedCrypto("WebCrypto is not available");
  let key: CryptoKey;
  try {
    key = await subtle.importKey("raw", asBuffer(publicKey), { name: "Ed25519" }, false, ["verify"]);
  } catch (e) {
    throw new UnsupportedCrypto(`this runtime's WebCrypto cannot import Ed25519 keys (${(e as Error).message})`);
  }
  return subtle.verify({ name: "Ed25519" }, key, asBuffer(signature), asBuffer(message));
}

async function viaNodeCrypto(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  // The specifier is built at run time so browser bundlers do not try to resolve it.
  const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ ["node", "crypto"].join(":"))) as typeof import("node:crypto");
  const key = mod.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytesToBase64Url(publicKey) }, format: "jwk" });
  return mod.verify(null, message, key, signature);
}

/**
 * Ed25519 verification with what the runtime has: WebCrypto first (Node 20+, Bun, current browsers), then node:crypto.
 * Callers that run somewhere with neither pass their own verifier (for example one built on a pure-JS library).
 */
export const defaultEd25519Verify: Ed25519Verifier = async (publicKey, message, signature) => {
  if (publicKey.length !== 32) return false;
  if (signature.length !== 64) return false;
  try {
    return await viaWebCrypto(publicKey, message, signature);
  } catch (first) {
    if (!(first instanceof UnsupportedCrypto)) return false;
    try {
      return await viaNodeCrypto(publicKey, message, signature);
    } catch {
      throw first;
    }
  }
};

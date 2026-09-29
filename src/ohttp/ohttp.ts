import { AEAD_AES_128_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256 } from "hpke";
import { AeadId, KdfId, KemId, KeyConfig, OHTTPClient, OHTTPServer, OHTTPError, OHTTPErrorCode, isOHTTPError, type KeyConfigWithPrivate } from "ohttp-ts";

// Oblivious HTTP (RFC 9458) for the gateway, on ohttp-ts (key configurations, request and response encapsulation) and
// hpke (RFC 9180; WebCrypto underneath, so the X25519, HKDF and AES-GCM run in the platform's crypto). This module
// fixes one ciphersuite, DHKEM(X25519, HKDF-SHA256) with HKDF-SHA256 and AES-128-GCM, and hides the libraries' larger
// surface (other KEMs, chunked messages, the Request/Response helpers) behind the few calls the gateway and its
// clients use. Binary HTTP (RFC 9292) is handled separately, in bhttp.ts, which the gateway needs to bound and
// allow-list a request before anything is built from it.

export { OHTTPError, OHTTPErrorCode, isOHTTPError };
export type PublicKeyConfig = KeyConfig;
export type { KeyConfigWithPrivate };
type PublicConfig = PublicKeyConfig;

export const KEM_X25519 = KemId.X25519_HKDF_SHA256;
export const KDF_HKDF_SHA256_ID = KdfId.HKDF_SHA256;
export const AEAD_AES_128_GCM_ID = AeadId.AES_128_GCM;

export const MEDIA_KEYS = "application/ohttp-keys";
export const MEDIA_REQ = "message/ohttp-req";
export const MEDIA_RES = "message/ohttp-res";

/** The only suite this gateway offers and this client uses. */
export const SUITE = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM);

/** Bytes before the ciphertext of an encapsulated request: header (7) and the X25519 encapsulated key (32). */
export const REQUEST_PREFIX = 7 + 32;

// ---- key configurations (RFC 9458 section 3) -----------------------------------------------------------------------

export const parseKeyConfig = (b: Uint8Array): PublicConfig => KeyConfig.parse(b);
export const serializeKeyConfig = (c: PublicConfig): Uint8Array => KeyConfig.serialize(c);
/** `application/ohttp-keys`: length-prefixed configurations. Throws on any encoding error, as a client must. */
export const parseKeyConfigList = (b: Uint8Array): PublicConfig[] => KeyConfig.parseMultiple(b);
export const serializeKeyConfigList = (c: PublicConfig[]): Uint8Array => KeyConfig.serializeMultiple(c);
/** The first configuration in a list that offers this suite; throws if none does. */
export const selectKeyConfig = (list: PublicConfig[]): PublicConfig => KeyConfig.select(SUITE, list);

/** A new gateway key: the raw key pair (to store) and its serialized key configuration. */
export async function generateGatewayKey(keyId: number): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array; config: Uint8Array }> {
  const kc = await KeyConfig.generate(SUITE, keyId, true); // extractable only here, so the private key can be stored encrypted
  return { publicKey: kc.publicKey, privateKey: await SUITE.SerializePrivateKey(kc.keyPair.privateKey as CryptoKey), config: KeyConfig.serialize(kc) };
}

/** A stored gateway key, ready to open requests. The private key is not extractable from the result. */
export const loadGatewayKey = (keyId: number, publicKey: Uint8Array, privateKey: Uint8Array): Promise<KeyConfigWithPrivate> => KeyConfig.import(SUITE, keyId, publicKey, privateKey);

// ---- gateway side (sections 4.3 and 4.4) ---------------------------------------------------------------------------

export type OpenedRequest = {
  /** The binary HTTP request. */
  request: Uint8Array;
  /** Encapsulate the binary HTTP response for the client that sent this request. Call it once. */
  respond(response: Uint8Array): Promise<Uint8Array>;
};

/**
 * Remove the HPKE protection from an encapsulated request with one gateway key. Throws an OHTTPError: DecryptionFailed
 * for a request this key cannot open (wrong key, altered bytes, wrong key identifier), UnsupportedCipherSuite for a
 * KEM, KDF or AEAD that is not offered, InvalidMessage for a malformed message, MessageTooLarge past `maxMessageSize`.
 */
export async function openRequest(key: KeyConfigWithPrivate, encapsulated: Uint8Array, maxMessageSize: number): Promise<OpenedRequest> {
  const server = new OHTTPServer([key], { padding: 0, maxMessageSize });
  const { request, context } = await server.decapsulate(encapsulated);
  return { request, respond: (response) => context.encryptResponse(response) };
}

// ---- client side ---------------------------------------------------------------------------------------------------

export type SentRequest = {
  /** The `message/ohttp-req` body to send. */
  encapsulated: Uint8Array;
  /** Remove the encapsulation from the `message/ohttp-res` body that answers this request. */
  openResponse(encapsulatedResponse: Uint8Array): Promise<Uint8Array>;
};

/** Encapsulate a binary HTTP request to a gateway key. Every call uses a fresh ephemeral key, as the RFC requires. */
export async function sealRequest(config: PublicConfig, request: Uint8Array, maxMessageSize: number): Promise<SentRequest> {
  const client = new OHTTPClient(SUITE, config, { padding: 0, maxMessageSize });
  const { encapsulatedRequest, context } = await client.encapsulate(request);
  return { encapsulated: encapsulatedRequest, openResponse: (res) => context.decryptResponse(res) };
}

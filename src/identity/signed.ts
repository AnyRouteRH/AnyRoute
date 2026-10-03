import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "../lib/util.ts";
import type { Ctx } from "../context.ts";

// Documents the router signs with its Ed25519 receipt key (the key published at /.well-known/anyroute-receipt-keys.json):
// liveness probe receipts and track-record certificates. Signature over the canonical JSON of `payload`, as for record
// certificates, so the same offline checker works with the published key set.

export type SignedDocument<P = Record<string, unknown>> = { payload: P; key_id: string; signature: string };
type Jwk = { kid: string; kty?: string; crv?: string; alg?: string; x: string; valid_from?: string | null; retired_at?: string | null };

export function signDocument<P extends Record<string, unknown>>(ctx: Ctx, payload: P): SignedDocument<P> {
  const signed = ctx.signer.sign(payload);
  return { payload, key_id: signed.keyId, signature: signed.sig };
}

/** Checks the signature against an independently obtained key set and that `at` falls in the key's issuance window. */
export function verifySignedDocument(doc: unknown, keys: { keys: Jwk[] }, at: string): boolean {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const { payload, key_id, signature } = doc as SignedDocument;
  if (!payload || typeof payload !== "object" || typeof key_id !== "string" || !/^[0-9a-f]{16}$/.test(key_id) || typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
  const key = keys.keys.find(k => k.kid === key_id);
  if (!key || key.kty !== "OKP" || key.crv !== "Ed25519" || key.alg !== "EdDSA") return false;
  const issued = Date.parse(at), from = Date.parse(key.valid_from ?? ""), retired = key.retired_at == null ? Infinity : Date.parse(key.retired_at);
  if (!Number.isFinite(issued) || !Number.isFinite(from) || Number.isNaN(retired) || issued < from || issued > retired) return false;
  try {
    const raw = Buffer.from(key.x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (raw.length !== 32 || createHash("sha256").update(raw).digest("hex").slice(0, 16) !== key_id) return false;
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature, "base64"));
  } catch { return false; }
}

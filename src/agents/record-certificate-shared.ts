import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "../lib/util.ts";

// Server copy of packages/client/src/record-certificate.ts: the src/ tree ships in the image on its own and must
// not import from packages/. Constants, types and validators are identical to the client's (a test checks it);
// verification uses node:crypto instead of the client's portable helpers.
type Jwk = { kid: string; kty?: string; crv?: string; alg?: string; x: string; valid_from?: string | null; retired_at?: string | null };
type KeySet = { keys: Jwk[] };

export const RECORD_CERTIFICATE_TTL_MS = 7 * 86_400_000;
export const RECORD_CERTIFICATE_NOTICE = "Signed by AnyRoute's router, which sees the agent's activity; not a zero-knowledge proof.";
export type RecordClaim = `requests_at_least:${number}` | `no_denials_days:${number}` | `no_kills_days:${number}` | `active_days_at_least:${number}`;
export type RecordCertificate = {
  payload: { version: 1; type: "anyroute.agent.record-certificate"; pseudonym: string; claims: RecordClaim[]; issued_at: string; expires_at: string; notice: string };
  key_id: string;
  signature: string;
};
export function validRecordClaim(value: unknown): value is RecordClaim {
  if (typeof value !== "string" || !/^(requests_at_least|no_denials_days|no_kills_days|active_days_at_least):[1-9]\d{0,14}$/.test(value)) return false;
  const [kind, n] = value.split(":");
  return Number.isSafeInteger(Number(n)) && (!(kind === "no_denials_days" || kind === "no_kills_days") || Number(n) <= 90);
}
const exact = (o: object, names: string[]) => Object.keys(o).sort().join(",") === names.sort().join(",");
export function isRecordCertificate(value: unknown): value is RecordCertificate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as RecordCertificate, p = c.payload;
  return exact(c, ["payload", "key_id", "signature"]) && !!p && typeof p === "object" && !Array.isArray(p)
    && exact(p, ["version", "type", "pseudonym", "claims", "issued_at", "expires_at", "notice"])
    && p.version === 1 && p.type === "anyroute.agent.record-certificate" && p.notice === RECORD_CERTIFICATE_NOTICE
    && typeof p.pseudonym === "string" && /^[0-9a-f]{64}$/.test(p.pseudonym)
    && Array.isArray(p.claims) && p.claims.length > 0 && p.claims.length <= 16 && p.claims.every(validRecordClaim)
    && new Set(p.claims).size === p.claims.length
    && typeof p.issued_at === "string" && typeof p.expires_at === "string"
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.issued_at) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.expires_at)
    && Number.isFinite(Date.parse(p.issued_at)) && Number.isFinite(Date.parse(p.expires_at))
    && typeof c.key_id === "string" && /^[0-9a-f]{16}$/.test(c.key_id)
    && typeof c.signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(c.signature);
}
/** Checks the signature against an independently trusted key set, and the time window; not the router's underlying observations. */
export async function verifyRecordCertificate(value: unknown, options: { keys: KeySet; nowMs?: number }): Promise<boolean> {
  if (!isRecordCertificate(value)) return false;
  const { payload, key_id, signature } = value;
  const issued = Date.parse(payload.issued_at), expires = Date.parse(payload.expires_at), now = options.nowMs ?? Date.now();
  if (!Number.isFinite(now) || issued > now || expires <= now || expires - issued !== RECORD_CERTIFICATE_TTL_MS) return false;
  const key = options.keys.keys.find(k => k.kid === key_id);
  if (!key || key.kty !== "OKP" || key.crv !== "Ed25519" || key.alg !== "EdDSA") return false;
  const from = Date.parse(key.valid_from ?? ""), retired = key.retired_at == null ? Infinity : Date.parse(key.retired_at);
  if (!Number.isFinite(from) || Number.isNaN(retired) || issued < from || issued > retired) return false;
  try {
    const raw = Buffer.from(key.x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (raw.length !== 32 || createHash("sha256").update(raw).digest("hex").slice(0, 16) !== key_id) return false;
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature, "base64"));
  } catch { return false; }
}

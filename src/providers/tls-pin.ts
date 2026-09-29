import { X509Certificate, createHash } from "node:crypto";
import { eq, like } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { kv } from "../db/schema.ts";

// Quote-pinned TLS. An attested sidecar serves a self-signed certificate for a key generated inside the TEE. The
// certificate's SAN carries `<32 hex>.<32 hex>.attest.anyroute`, the sha256 of the boot quote, and the quote's
// report_data binds the key. No public CA can vouch for such an endpoint, so the attestor trusts the certificate
// only after proving all three (services/attestor.ts), and then stores it here as the provider's pin. Every later
// call to that provider (inference, probes, discovery, the next attestation) accepts exactly that certificate and
// nothing else, so requests only ever reach the attested key.

export type TlsPin = {
  /** The attested certificate, used as the only trust anchor for the provider's connections. */
  certPem: string;
  /** sha256 (hex) of the certificate's SubjectPublicKeyInfo DER. */
  spkiSha256: string;
  /** sha256 (hex) of the quote the certificate names. */
  attestationRef: string;
  pinnedAt: string;
};

export type PeerCertificate = {
  certPem: string;
  /** SubjectPublicKeyInfo DER, hex: the value a sidecar binds as `tls_pubkey`. */
  spkiHex: string;
  spkiSha256: string;
  /** The attestation reference from the SAN, or null when the certificate names none (or several). */
  attestationRef: string | null;
};

const ATTEST_SAN = /^([0-9a-f]{32})\.([0-9a-f]{32})\.attest\.anyroute$/;
const KEY_PREFIX = "tls-pin:";

export const spkiSha256Of = (der: Uint8Array) => createHash("sha256").update(new X509Certificate(Buffer.from(der)).publicKey.export({ type: "spki", format: "der" })).digest("hex");

/** Read what the router needs from a peer certificate (DER). Throws on anything that is not an X.509 certificate. */
export function describePeerCertificate(der: Uint8Array): PeerCertificate {
  const cert = new X509Certificate(Buffer.from(der));
  const spki = cert.publicKey.export({ type: "spki", format: "der" });
  const refs = new Set(
    (cert.subjectAltName ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("DNS:"))
      .map((s) => ATTEST_SAN.exec(s.slice(4).toLowerCase()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => m[1] + m[2]),
  );
  return {
    certPem: cert.toString(),
    spkiHex: spki.toString("hex"),
    spkiSha256: createHash("sha256").update(spki).digest("hex"),
    attestationRef: refs.size === 1 ? [...refs][0] : null,
  };
}

/**
 * TLS options that accept exactly the pinned certificate. `ca` makes it the only trust anchor, so a connection to
 * any other key fails the handshake before a byte of the request is sent. The host name is not checked: the
 * endpoint's identity is its attested key. Where the runtime honours checkServerIdentity it re-checks the key.
 */
export function pinnedTlsOptions(pin: Pick<TlsPin, "certPem" | "spkiSha256">) {
  return {
    ca: pin.certPem,
    checkServerIdentity: (_host: string, cert: { raw?: Uint8Array }) => {
      if (!cert?.raw) return undefined;
      return spkiSha256Of(cert.raw) === pin.spkiSha256 ? undefined : new Error("The provider's TLS key is not the attested key.");
    },
  };
}

function parsePin(value: unknown): TlsPin | null {
  const v = value as Partial<TlsPin> | null;
  if (!v || typeof v.certPem !== "string" || typeof v.spkiSha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.spkiSha256)) return null;
  return { certPem: v.certPem, spkiSha256: v.spkiSha256, attestationRef: String(v.attestationRef ?? ""), pinnedAt: String(v.pinnedAt ?? "") };
}

export async function loadTlsPins(db: Db | Tx): Promise<Map<string, TlsPin>> {
  const rows = await db.select().from(kv).where(like(kv.key, `${KEY_PREFIX}%`));
  const out = new Map<string, TlsPin>();
  for (const r of rows) {
    const pin = parsePin(r.value);
    if (pin) out.set(r.key.slice(KEY_PREFIX.length), pin);
  }
  return out;
}

export async function loadTlsPin(db: Db | Tx, providerId: string): Promise<TlsPin | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, KEY_PREFIX + providerId));
  return row ? parsePin(row.value) : null;
}

export async function saveTlsPin(db: Db | Tx, providerId: string, pin: TlsPin) {
  await db.insert(kv).values({ key: KEY_PREFIX + providerId, value: pin }).onConflictDoUpdate({ target: kv.key, set: { value: pin, updatedAt: new Date() } });
}

export async function clearTlsPin(db: Db | Tx, providerId: string) {
  await db.delete(kv).where(eq(kv.key, KEY_PREFIX + providerId));
}

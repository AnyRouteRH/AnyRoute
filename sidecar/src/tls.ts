import { createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { sha256Hex } from "./util.ts";

// In-memory self-signed TLS identity. The key never leaves the process. The certificate carries the
// attestation reference in a SAN entry, `<first 32 hex>.<last 32 hex>.attest.anyroute` (two DNS labels because
// a label is limited to 63 characters), so a client that pins the certificate can check it against the
// evidence served at /attest. Node's crypto module cannot build certificates, so this file encodes the small
// subset of X.509 v3 that is needed (ECDSA P-256 with SHA-256, SAN, basic constraints, key usage). The
// certificate is marked as a CA with path length 0 only so that a client can pin it as its own trust anchor;
// its key exists only inside this process.

export const ATTEST_SAN_SUFFIX = "attest.anyroute";

export type TlsIdentity = {
  keyPem: string;
  certPem: string;
  certDer: Buffer;
  /** SubjectPublicKeyInfo DER of the TLS key: the value bound into the attestation report data. */
  spkiDer: Buffer;
  spkiHex: string;
  spkiSha256: string;
  attestSan: string;
  notBefore: Date;
  notAfter: Date;
};

export const attestSanFor = (attestationRef: string) => {
  if (!/^[0-9a-f]{64}$/.test(attestationRef)) throw new Error("attestation reference must be 64 lowercase hex characters");
  return `${attestationRef.slice(0, 32)}.${attestationRef.slice(32)}.${ATTEST_SAN_SUFFIX}`;
};

/** Recover the attestation reference from a certificate SAN entry, or null when it is not an attestation name. */
export function attestationRefFromSan(san: string): string | null {
  const m = /^([0-9a-f]{32})\.([0-9a-f]{32})\.attest\.anyroute$/.exec(san.toLowerCase());
  return m ? m[1] + m[2] : null;
}

/** Generate the TLS key pair. The public half is needed before the attestation quote is requested. */
export function generateTlsKey(): { privateKey: KeyObject; spkiDer: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, spkiDer: publicKey.export({ type: "spki", format: "der" }) };
}

// ---- minimal DER encoding ------------------------------------------------------------------------

const lenBytes = (n: number) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lenBytes(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const oid = (dotted: string) => {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octets = (b: Buffer) => tlv(0x04, b);
const bitString = (b: Buffer) => tlv(0x03, Buffer.from([0x00]), b);
const integer = (b: Buffer) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let body = b.subarray(i);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0x00]), body]);
  return tlv(0x02, body);
};
const utcTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  if (y >= 2050 || y < 1950) throw new Error("certificate validity outside UTCTime range");
  return tlv(0x17, Buffer.from(`${p(y % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, "ascii"));
};

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_CN = "2.5.4.3";
const OID_SAN = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EKU = "2.5.29.37";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

const ipBytes = (ip: string): Buffer => {
  if (isIP(ip) === 4) return Buffer.from(ip.split(".").map(Number));
  // IPv6: expand "::" and pack 8 groups.
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return Buffer.concat(groups.map((g) => Buffer.from(g.padStart(4, "0"), "hex")));
};

const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

export type CertOptions = {
  attestationRef: string;
  /** Extra DNS names or IP addresses the operator serves the sidecar on. */
  hostnames?: string[];
  validityDays?: number;
  now?: Date;
  /** Simulated attestation: the subject says so and a `dev-simulated.attest.anyroute` name is added. */
  dev?: boolean;
};

export const DEV_SAN = "dev-simulated.attest.anyroute";

/** Build the self-signed certificate for `privateKey` (an ECDSA P-256 key made by generateTlsKey). */
export function createTlsIdentity(privateKey: KeyObject, opts: CertOptions): TlsIdentity {
  const attestSan = attestSanFor(opts.attestationRef);
  const spkiDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const now = opts.now ?? new Date();
  const notBefore = new Date(Math.floor((now.getTime() - 5 * 60_000) / 1000) * 1000);
  const notAfter = new Date(Math.floor((now.getTime() + (opts.validityDays ?? 90) * 86_400_000) / 1000) * 1000);

  const names = [attestSan, ...(opts.dev ? [DEV_SAN] : []), ...(opts.hostnames ?? [])];
  const generalNames = names.map((n) => (isIP(n) ? tlv(0x87, ipBytes(n)) : tlv(0x82, Buffer.from(n, "ascii"))));

  const name = seq(set(seq(oid(OID_CN), utf8(opts.dev ? "anyroute-sidecar (DEV: simulated attestation)" : "anyroute-sidecar"))));
  const sigAlg = seq(oid(OID_ECDSA_SHA256));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;

  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // version: v3
    integer(serial),
    sigAlg,
    name, // issuer
    seq(utcTime(notBefore), utcTime(notAfter)),
    name, // subject
    spkiDer,
    tlv(
      0xa3,
      seq(
        extension(OID_BASIC_CONSTRAINTS, true, seq(bool(true), integer(Buffer.from([0])))),
        extension(OID_KEY_USAGE, true, tlv(0x03, Buffer.from([0x02, 0x84]))), // digitalSignature, keyCertSign
        extension(OID_EKU, false, seq(oid(OID_SERVER_AUTH))),
        extension(OID_SAN, false, seq(...generalNames)),
      ),
    ),
  );
  const signature = cryptoSign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const certDer = seq(tbs, sigAlg, bitString(signature));
  const certPem = pem("CERTIFICATE", certDer);
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    keyPem,
    certPem,
    certDer,
    spkiDer,
    spkiHex: spkiDer.toString("hex"),
    spkiSha256: sha256Hex(spkiDer),
    attestSan,
    notBefore,
    notAfter,
  };
}

function pem(label: string, der: Buffer) {
  const b64 = der.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

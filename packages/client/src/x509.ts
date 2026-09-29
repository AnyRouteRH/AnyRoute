import { base64ToBytes } from "./bytes.js";

// Just enough X.509 to read what an attestation check needs from a sidecar's self-signed certificate: the
// SubjectPublicKeyInfo, the DNS names in the subjectAltName extension, and the validity window. It does not verify
// the certificate's signature (the certificate is pinned as its own trust anchor, so its signature proves nothing).

type Tlv = { tag: number; start: number; body: Uint8Array; end: number };

function readTlv(buf: Uint8Array, at: number): Tlv {
  if (at + 2 > buf.length) throw new Error("truncated DER");
  const tag = buf[at];
  let len = buf[at + 1];
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || p + n > buf.length) throw new Error("unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
    p += n;
  }
  if (p + len > buf.length) throw new Error("truncated DER");
  return { tag, start: at, body: buf.subarray(p, p + len), end: p + len };
}

function children(body: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < body.length; ) {
    const t = readTlv(body, at);
    out.push(t);
    at = t.end;
  }
  return out;
}

const OID_SAN = [0x55, 0x1d, 0x11];
const sameBytes = (a: Uint8Array, b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function parseTime(t: Tlv): Date {
  const s = new TextDecoder().decode(t.body);
  const m = t.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new Error("unsupported certificate time");
  const year = t.tag === 0x17 ? (Number(m[1]) >= 50 ? 1900 : 2000) + Number(m[1]) : Number(m[1]);
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

export type CertificateInfo = {
  /** DER of the SubjectPublicKeyInfo, the value a TLS key binding is checked against. */
  spki: Uint8Array;
  dnsNames: string[];
  notBefore: Date;
  notAfter: Date;
};

export function pemToDer(pem: string): Uint8Array {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new Error("no certificate found in the PEM text");
  return base64ToBytes(m[1].replace(/\s+/g, ""));
}

export function parseCertificate(input: Uint8Array | string): CertificateInfo {
  const der = typeof input === "string" ? pemToDer(input) : input;
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error("not a certificate");
  const tbs = readTlv(cert.body, 0);
  if (tbs.tag !== 0x30) throw new Error("not a certificate");
  const fields = children(tbs.body);
  let i = 0;
  if (fields[i]?.tag === 0xa0) i++; // version
  i++; // serial
  i++; // signature algorithm
  i++; // issuer
  const validity = fields[i++];
  i++; // subject
  const spkiField = fields[i++];
  if (!validity || !spkiField || spkiField.tag !== 0x30) throw new Error("malformed certificate");
  const [nb, na] = children(validity.body);
  const spki = tbs.body.subarray(spkiField.start, spkiField.end);
  const dnsNames: string[] = [];
  for (const f of fields.slice(i)) {
    if (f.tag !== 0xa3) continue;
    for (const ext of children(children(f.body)[0].body)) {
      const parts = children(ext.body);
      if (parts[0]?.tag !== 0x06 || !sameBytes(parts[0].body, OID_SAN)) continue;
      const value = parts[parts.length - 1]; // OCTET STRING wrapping the GeneralNames
      for (const name of children(readTlv(value.body, 0).body)) if (name.tag === 0x82) dnsNames.push(new TextDecoder().decode(name.body));
    }
  }
  return { spki, dnsNames, notBefore: parseTime(nb), notAfter: parseTime(na) };
}

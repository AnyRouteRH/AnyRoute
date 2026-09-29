import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { attestSanFor, attestationRefFromSan, createTlsIdentity, DEV_SAN, generateTlsKey } from "../src/tls.ts";
import { sha256Hex } from "../src/util.ts";

const REF = sha256Hex("some quote");

describe("enclave TLS certificate", () => {
  test("is a valid self-signed certificate over the generated key, with the attestation reference in a SAN", () => {
    const { privateKey, spkiDer } = generateTlsKey();
    const id = createTlsIdentity(privateKey, { attestationRef: REF, hostnames: ["sidecar.example", "127.0.0.1"], validityDays: 30 });
    const cert = new X509Certificate(id.certPem);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.publicKey.export({ type: "spki", format: "der" }).equals(spkiDer)).toBe(true);
    expect(id.spkiHex).toBe(spkiDer.toString("hex"));
    expect(id.spkiSha256).toBe(sha256Hex(spkiDer));
    expect(cert.subjectAltName).toContain(`DNS:${attestSanFor(REF)}`);
    expect(cert.subjectAltName).toContain("DNS:sidecar.example");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(cert.subjectAltName).not.toContain(DEV_SAN);
    expect(cert.checkHost("sidecar.example")).toBe("sidecar.example");
    expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(cert.ca).toBe(true);
    const days = (new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(new X509Certificate(id.certPem).fingerprint256).toBe(new X509Certificate(id.certDer).fingerprint256);
  });

  test("the SAN round-trips to the reference and each label fits in a DNS label", () => {
    const san = attestSanFor(REF);
    for (const label of san.split(".")) expect(label.length).toBeLessThanOrEqual(63);
    expect(attestationRefFromSan(san)).toBe(REF);
    expect(attestationRefFromSan("example.com")).toBeNull();
    expect(() => attestSanFor("short")).toThrow();
  });

  test("dev certificates say so in the subject and the SAN", () => {
    const { privateKey } = generateTlsKey();
    const id = createTlsIdentity(privateKey, { attestationRef: REF, dev: true });
    const cert = new X509Certificate(id.certPem);
    expect(cert.subject).toContain("DEV");
    expect(cert.subjectAltName).toContain(DEV_SAN);
  });

  test("two certificates from one key carry different serials", () => {
    const { privateKey } = generateTlsKey();
    const a = new X509Certificate(createTlsIdentity(privateKey, { attestationRef: REF }).certPem);
    const b = new X509Certificate(createTlsIdentity(privateKey, { attestationRef: REF }).certPem);
    expect(a.serialNumber).not.toBe(b.serialNumber);
  });
});

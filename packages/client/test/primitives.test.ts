import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { base64ToBytes, bytesToBase64, bytesToHex, canonicalJson, hexToBytes, keccak256Hex, parseCertificate, parseTdxQuote, sha256Hex, utf8 } from "../src/index.js";
import { real } from "./helpers.js";

describe("canonical JSON", () => {
  test("sorts keys recursively, drops undefined, stringifies bigint, leaves arrays in order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined, x: 2 }], c: 10n } })).toBe('{"a":{"c":"10","d":[3,{"x":2,"z":1}]},"b":1}');
  });
  test("equals the sidecar's bindings digest input for the captured bindings", async () => {
    const boot = real.boot();
    expect(await sha256Hex(utf8(canonicalJson(boot.bindings)))).toBe(boot.report_data.bindings_digest);
  });
});

describe("hashes", () => {
  test("keccak256 known vectors (original Keccak padding, not SHA3-256)", () => {
    expect(keccak256Hex(new Uint8Array())).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256Hex(utf8("abc"))).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    // 200 bytes crosses the 136-byte rate boundary (checked against an independent reference sponge).
    expect(keccak256Hex(utf8("a".repeat(200)))).toBe("0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d");
  });
  test("sha256 agrees with node:crypto", async () => {
    const data = utf8("anyroute");
    expect(await sha256Hex(data)).toBe(createHash("sha256").update(data).digest("hex"));
  });
  test("byte encodings round-trip and reject garbage", () => {
    const b = new Uint8Array([0, 1, 250, 251, 255]);
    expect(bytesToHex(hexToBytes("0x0001fafbff"))).toBe("0001fafbff");
    expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    expect(base64ToBytes("-_8")).toEqual(new Uint8Array([251, 255]));
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => base64ToBytes("a b")).toThrow();
  });
});

describe("TDX quote and certificate readers on captured evidence", () => {
  test("the quote's registers and report_data are what the document reports", () => {
    const boot = real.boot();
    const f = parseTdxQuote(hexToBytes(real.quoteHex()));
    expect(f.version).toBe(4);
    expect(f.teeType).toBe(0x81);
    expect(f.mrtd).toBe(boot.evidence.measurements.mrtd);
    expect(f.rtmr3).toBe(boot.evidence.measurements.rtmr3);
    expect(f.reportData).toBe(boot.evidence.report_data);
  });
  test("the quote in the document is the quote in the fixture file", () => {
    expect(real.boot().evidence.quote).toBe(real.quoteHex());
  });
  test("rejects short or foreign quotes", () => {
    expect(() => parseTdxQuote(new Uint8Array(100))).toThrow(/too short/);
    const q = hexToBytes(real.quoteHex());
    q[0] = 3;
    expect(() => parseTdxQuote(q)).toThrow(/version/);
  });
  test("the certificate carries the attestation name and the attested TLS key", async () => {
    const boot = real.boot();
    const cert = parseCertificate(real.certPem());
    expect(cert.dnsNames).toContain(boot.attestation_san);
    expect(bytesToHex(cert.spki)).toBe(boot.bindings.tls_pubkey);
    expect(await sha256Hex(cert.spki)).toBe(boot.tls.spki_sha256);
    expect(cert.notBefore.toISOString()).toBe("2026-09-29T08:11:34.000Z");
    expect(cert.notAfter.toISOString()).toBe("2026-10-29T08:16:34.000Z");
  });
  test("agrees with node's own X.509 parser", async () => {
    const { X509Certificate } = await import("node:crypto");
    const x = new X509Certificate(real.certPem());
    const mine = parseCertificate(real.certPem());
    expect(bytesToHex(new Uint8Array(x.publicKey.export({ type: "spki", format: "der" })))).toBe(bytesToHex(mine.spki));
    expect(x.subjectAltName).toContain(mine.dnsNames[0]);
  });
});

import { describe, expect, test } from "bun:test";
import { bytesToHex, canonicalJson, evaluateAttestation, hexToBytes, sha256Hex, utf8, verifyProvider, type AttestDocument, type ProviderVerification, type RouterAttestation } from "../src/index.js";
import { json, real, stubFetch } from "./helpers.js";

const now = () => real.now;
const status = (v: ProviderVerification, id: string) => v.checks.find((c) => c.id === id)?.status;
const clone = <T>(x: T): T => structuredClone(x);
/** Change the final hex digit, whatever it is. */
const flipLast = (h: string) => h.slice(0, -1) + (parseInt(h.slice(-1), 16) ^ 1).toString(16);

const base = () => ({ providerId: "example-provider", router: real.router() as RouterAttestation, boot: real.boot() as AttestDocument, fresh: { doc: real.fresh().response as AttestDocument, nonceHex: real.fresh().nonce }, certificate: real.certPem() });

describe("real TDX evidence", () => {
  test("passes every check this client can make, and says what it did not check", async () => {
    const v = await evaluateAttestation(base(), { now, expected: { modelDigest: "sha256:1144b5db331424ae40213378a83575a5cf67090b0ce1ad49cf66ec75f17e2095" } });
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.simulated).toBe(false);
    for (const id of ["router.status", "router.quote_verified", "router.fresh", "router.matches_provider", "provider.simulated", "provider.quote", "provider.ref_is_quote_hash", "provider.san_is_ref", "provider.report_data", "provider.measurements", "provider.receipt_key", "provider.fresh_quote", "provider.tls_san", "provider.tls_key", "provider.tls_valid", "expected.model"]) {
      expect([id, status(v, id)]).toEqual([id, "pass"]);
    }
    // Honest gaps: nothing here verified Intel's signature over the quote, and no image digest was supplied to compare.
    expect(status(v, "quote.signature")).toBe("not_checked");
    expect(status(v, "expected.image")).toBe("not_checked");
    expect(v.notChecked.join(" ")).toMatch(/enclave/);
    expect(v.bound?.modelDigest).toBe("sha256:1144b5db331424ae40213378a83575a5cf67090b0ce1ad49cf66ec75f17e2095");
    expect(v.bound?.receiptKeyId).toBe("644b0e2c91520ec4");
    expect(v.bound?.attestationRef).toBe("2407bc5921f607291e765ada315fd731b5a97b7e037def81d0fb53714f7dd760");
  });

  test("the reference in the certificate name is the SHA-256 of the quote", async () => {
    const boot = real.boot();
    const ref = await sha256Hex(hexToBytes(boot.evidence.quote));
    expect(ref).toBe(boot.attestation_ref);
    expect(boot.attestation_san).toBe(`${ref.slice(0, 32)}.${ref.slice(32)}.attest.anyroute`);
  });

  test("without a certificate the transport is reported as not checked, and can be required", async () => {
    const { certificate: _c, ...noCert } = base();
    const v = await evaluateAttestation(noCert, { now });
    expect(v.ok).toBe(true);
    expect(status(v, "provider.tls_san")).toBe("not_checked");
    const strict = await evaluateAttestation(noCert, { now, requireCertificate: true });
    expect(strict.ok).toBe(false);
    expect(status(strict, "provider.tls_san")).toBe("fail");
  });

  test("a quote quoted at the router's request time is stale after the allowed age", async () => {
    const v = await evaluateAttestation(base(), { now: () => real.now + 2 * 3_600_000 });
    expect(v.ok).toBe(false);
    expect(status(v, "router.fresh")).toBe("fail");
    expect((await evaluateAttestation(base(), { now: () => real.now + 2 * 3_600_000, maxAttestationAgeMs: 3 * 3_600_000 })).ok).toBe(true);
  });

  test("an expired certificate fails", async () => {
    const v = await evaluateAttestation(base(), { now: () => Date.parse("2026-12-01T00:00:00Z"), maxAttestationAgeMs: 1e12 });
    expect(status(v, "provider.tls_valid")).toBe("fail");
    expect(v.ok).toBe(false);
  });
});

describe("refusals", () => {
  test("router says unverified, simulated, or nothing", async () => {
    for (const router of [{ ...real.router(), status: "unverified", reason: "attestation_stale" }, { ...real.router(), status: "simulated", tee: "dev" }, null]) {
      const v = await evaluateAttestation({ ...base(), router: router as RouterAttestation | null }, { now });
      expect(v.ok).toBe(false);
      expect(status(v, "router.status")).toBe("fail");
    }
  });

  test("the router has not verified a quote", async () => {
    const r = clone(real.router());
    r.checks.quote_verified = false;
    const v = await evaluateAttestation({ ...base(), router: r }, { now });
    expect(v.ok).toBe(false);
    expect(status(v, "router.quote_verified")).toBe("fail");
  });

  test("a quote whose bytes were altered no longer matches the reference or the bindings", async () => {
    const boot = clone(real.boot());
    const q = hexToBytes(boot.evidence.quote);
    q[48 + 520 + 3] ^= 1; // one bit of report_data
    boot.evidence.quote = bytesToHex(q);
    const v = await evaluateAttestation({ ...base(), boot, fresh: null }, { now });
    expect(v.ok).toBe(false);
    expect(status(v, "provider.ref_is_quote_hash")).toBe("fail");
    expect(status(v, "provider.report_data")).toBe("fail");
    expect(status(v, "provider.measurements")).toBe("pass"); // registers unchanged
  });

  test("bindings that the quote does not commit to are rejected, whichever field was changed", async () => {
    for (const field of ["tls_pubkey", "receipt_pubkey", "image_digest", "compose_hash", "model_digest"]) {
      const boot = clone(real.boot());
      const value = boot.bindings[field] as string;
      boot.bindings[field] = flipLast(value);
      const v = await evaluateAttestation({ ...base(), boot, fresh: null }, { now });
      expect([field, v.ok]).toEqual([field, false]);
      expect([field, status(v, "provider.report_data")]).toEqual([field, "fail"]);
    }
  });

  test("an extra binding the quote does not cover is also caught", async () => {
    const boot = clone(real.boot());
    boot.bindings.hpke_pubkey = "aa".repeat(32);
    const v = await evaluateAttestation({ ...base(), boot, fresh: null }, { now });
    expect(v.ok).toBe(false);
    expect(status(v, "provider.report_data")).toBe("fail");
  });

  test("document claims about registers that differ from the quote are caught", async () => {
    const boot = clone(real.boot());
    boot.evidence.measurements!.mrtd = "00".repeat(48);
    const v = await evaluateAttestation({ ...base(), boot, fresh: null }, { now });
    expect(status(v, "provider.measurements")).toBe("fail");
    expect(v.ok).toBe(false);
  });

  test("a certificate name that is not derived from the quote", async () => {
    const boot = clone(real.boot());
    boot.attestation_san = boot.attestation_san!.replace(/^./, "0");
    const v = await evaluateAttestation({ ...base(), boot, fresh: null }, { now });
    expect(status(v, "provider.san_is_ref")).toBe("fail");
    expect(status(v, "provider.tls_san")).toBe("fail");
    expect(v.ok).toBe(false);
  });

  test("a connection presenting a different certificate key is not bound to the quote", async () => {
    const other = clone(real.boot());
    other.bindings.tls_pubkey = flipLast(other.bindings.tls_pubkey!);
    // The certificate is the real one, but the (altered) document commits to another key.
    const v = await evaluateAttestation({ ...base(), boot: other, fresh: null }, { now });
    expect(status(v, "provider.tls_key")).toBe("fail");
    expect(v.ok).toBe(false);
    // And a public-CA style certificate without the attestation name fails the name check.
    const pem = real.certPem();
    const der = Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
    const at = der.indexOf(Buffer.from("attest.anyroute"));
    der[at] ^= 1;
    const forged = "-----BEGIN CERTIFICATE-----\n" + der.toString("base64") + "\n-----END CERTIFICATE-----\n";
    const v2 = await evaluateAttestation({ ...base(), certificate: forged, fresh: null }, { now });
    expect(status(v2, "provider.tls_san")).toBe("fail");
    expect(v2.ok).toBe(false);
  });

  test("the router's recorded digests must equal the provider's bound ones", async () => {
    const r = clone(real.router());
    r.measurement!.model_digest = "0x" + "ab".repeat(32);
    const v = await evaluateAttestation({ ...base(), router: r }, { now });
    expect(status(v, "router.matches_provider")).toBe("fail");
    expect(v.ok).toBe(false);
  });

  test("an expected digest that does not match refuses; one that matches in another notation passes", async () => {
    const bad = await evaluateAttestation(base(), { now, expected: { modelDigest: "sha256:" + "ab".repeat(32) } });
    expect(bad.ok).toBe(false);
    expect(status(bad, "expected.model")).toBe("fail");
    const good = await evaluateAttestation(base(), { now, expected: { modelDigest: "0x1144b5db331424ae40213378a83575a5cf67090b0ce1ad49cf66ec75f17e2095", composeHash: "4BB1069E88343C2F600F3C08B4460BE233E50094253BF2E5DC27208CDF0DB583", mrtd: real.boot().evidence.measurements.mrtd } });
    expect(good.ok).toBe(true);
    expect(status(good, "expected.compose")).toBe("pass");
    expect(status(good, "expected.mrtd")).toBe("pass");
  });

  test("a fresh quote that does not bind our nonce, or reuses an old one, is refused", async () => {
    const fresh = base().fresh;
    const wrongNonce = await evaluateAttestation({ ...base(), fresh: { ...fresh, nonceHex: "00".repeat(32) } }, { now });
    expect(status(wrongNonce, "provider.fresh_quote")).toBe("fail");
    expect(wrongNonce.ok).toBe(false);
    // Bindings that changed between boot and now (a different instance behind the address).
    const doc = clone(fresh.doc);
    doc.bindings.model_digest = "sha256:" + "cd".repeat(32);
    const changed = await evaluateAttestation({ ...base(), fresh: { doc, nonceHex: fresh.nonceHex } }, { now });
    expect(status(changed, "provider.fresh_quote")).toBe("fail");
  });

  test("simulated evidence is refused unless the caller opts in, and is then still labelled simulated", async () => {
    const boot = clone(real.boot());
    boot.dev = true;
    boot.evidence.dev = true;
    boot.evidence.kind = "dev";
    boot.evidence.format = "dev-simulated";
    const v = await evaluateAttestation({ ...base(), boot, fresh: null, certificate: null }, { now });
    expect(v.ok).toBe(false);
    expect(v.simulated).toBe(true);
    expect(status(v, "provider.simulated")).toBe("fail");
    const allowed = await evaluateAttestation({ ...base(), boot, fresh: null, certificate: null, router: { ...real.router(), status: "simulated", tee: "dev", checks: { ...real.router().checks, quote_verified: false } } }, { now, allowSimulated: true });
    expect(allowed.simulated).toBe(true);
    expect(status(allowed, "provider.simulated")).toBe("pass");
    expect(allowed.checks.find((c) => c.id === "provider.simulated")!.detail).toMatch(/SIMULATED/);
  });

  test("hardware evidence with the router only reporting the record cannot be sent to", async () => {
    const v = await evaluateAttestation({ providerId: "example-provider", router: real.router(), boot: null }, { now });
    expect(v.ok).toBe(false);
    expect(status(v, "provider.document")).toBe("fail");
  });

  test("an unsupported evidence format or unreadable quote is a failure, not a pass", async () => {
    const boot = clone(real.boot());
    boot.evidence.format = "sev-snp-report";
    expect((await evaluateAttestation({ ...base(), boot, fresh: null }, { now })).ok).toBe(false);
    const boot2 = clone(real.boot());
    boot2.evidence.quote = "0400";
    const v = await evaluateAttestation({ ...base(), boot: boot2, fresh: null }, { now });
    expect(status(v, "provider.quote")).toBe("fail");
    expect(v.ok).toBe(false);
  });

  test("a quote verifier the caller supplies decides the signature check", async () => {
    const accept = await evaluateAttestation(base(), { now, quoteVerifier: async () => ({ ok: true, detail: "dcap: UpToDate" }) });
    expect(status(accept, "quote.signature")).toBe("pass");
    expect(accept.ok).toBe(true);
    const reject = await evaluateAttestation(base(), { now, quoteVerifier: async () => ({ ok: false, detail: "TCB revoked" }) });
    expect(reject.ok).toBe(false);
    const boom = await evaluateAttestation(base(), { now, quoteVerifier: async () => Promise.reject(new Error("offline")) });
    expect(boom.ok).toBe(false);
  });
});

describe("verifyProvider over HTTP", () => {
  const routes = (over: Partial<Record<string, () => Response>> = {}) =>
    stubFetch({
      "/api/v1/attestation/example-provider": over.router ?? (() => json({ data: real.router() })),
      "/attest": over.attest ?? (() => json(real.boot())),
      "/attest?nonce=": () => json({}),
    });

  test("reads the router record, then /attest, then a fresh /attest?nonce, and passes on real evidence", async () => {
    const seen: string[] = [];
    const { fetch } = stubFetch({
      "/api/v1/attestation/example-provider": () => json({ data: real.router() }),
      "/attest": ({ url }) => {
        seen.push(url.search);
        return url.searchParams.get("nonce") ? json(real.fresh().response) : json(real.boot());
      },
    });
    const v = await verifyProvider({ routerUrl: "https://router.test", providerId: "example-provider", attestUrl: "https://provider.test:8443/attest", fetch, nonceHex: real.fresh().nonce, certificate: real.certPem(), now });
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(seen).toEqual(["", `?nonce=${real.fresh().nonce}`]);
  });

  test("a random nonce (the default) cannot be answered by a recorded fresh quote", async () => {
    const { fetch } = stubFetch({
      "/api/v1/attestation/example-provider": () => json({ data: real.router() }),
      "/attest": ({ url }) => (url.searchParams.get("nonce") ? json(real.fresh().response) : json(real.boot())),
    });
    const v = await verifyProvider({ routerUrl: "https://router.test", providerId: "example-provider", attestUrl: "https://provider.test", fetch, certificate: real.certPem(), now });
    expect(v.ok).toBe(false);
    expect(status(v, "provider.fresh_quote")).toBe("fail");
  });

  test("an unknown provider, an unreachable provider or a router error are refusals with a reason", async () => {
    const missing = await verifyProvider({ routerUrl: "https://router.test", providerId: "nobody", attestUrl: "https://provider.test", fetch: routes().fetch, now });
    expect(missing.ok).toBe(false);
    expect(status(missing, "router.status")).toBe("fail");

    const down = stubFetch({ "/api/v1/attestation/example-provider": () => json({ data: real.router() }) });
    const unreachable = await verifyProvider({ routerUrl: "https://router.test", providerId: "example-provider", attestUrl: "https://provider.test", fetch: down.fetch, now });
    expect(unreachable.ok).toBe(false);
    expect(status(unreachable, "fetch")).toBe("fail");

    const err = stubFetch({ "/api/v1/attestation/example-provider": () => json({}, 500) });
    const routerDown = await verifyProvider({ routerUrl: "https://router.test", providerId: "example-provider", attestUrl: "https://provider.test", fetch: err.fetch, now });
    expect(routerDown.ok).toBe(false);
  });

  test("without an attest URL only the router's word is available, which is never enough", async () => {
    const v = await verifyProvider({ routerUrl: "https://router.test", providerId: "example-provider", fetch: routes().fetch, now });
    expect(v.ok).toBe(false);
  });

  test("canonical bindings digest helper agrees with the sidecar's rule", async () => {
    const boot = real.boot();
    expect(bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(canonicalJson(boot.bindings)) as unknown as BufferSource)))).toBe(boot.evidence.report_data.slice(0, 64));
  });
});

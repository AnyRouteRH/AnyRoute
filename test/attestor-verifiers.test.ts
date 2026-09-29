import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { composeHashFromEventLog, createVerifiers, verifiersConfigured, verifyJwt, verifyWithAll, type AttestationVerifierConfig, type VerifierInput } from "../src/services/attestor-verifiers.ts";
import { parseTdxQuote } from "../src/services/attestor.ts";
import { REGS, rsaKey, signJwt, tdxQuote } from "./measurement-fixtures.ts";

// Mocked-HTTP tests for the pluggable quote verifiers: every fetch goes to a fake that records the request.

const NOW = 1_800_000_000_000;
const quoteHex = tdxQuote("cc".repeat(64));
const registers = parseTdxQuote(quoteHex);
const input = (extra: Partial<VerifierInput> = {}): VerifierInput => ({ kind: "tdx", quoteHex, registers, ...extra });

const base: AttestationVerifierConfig = {
  verifiers: ["dcap"],
  tdxVerifierUrl: "https://dcap.example.test/verify",
  tdxVerifierKey: "dcap-secret",
  intelTa: { url: "https://ita.example.test/appraisal/v2/attest", jwksUrl: "https://ita.example.test/certs", apiKey: "ita-key" },
  dstackVerifierUrl: "https://dstack.example.test/verify",
  dstackVerifierKey: undefined,
};

type Call = { url: string; init: RequestInit };
function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const route = routes[u];
    return route ? route(init) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("dcap verifier", () => {
  test("accepts verified or an acceptable TCB status and sends the bearer key", async () => {
    const { f, calls } = fakeFetch({ [base.tdxVerifierUrl!]: () => json({ tcb_status: "UpToDate" }) });
    const [v] = createVerifiers(base, f);
    expect(await v.verify(input())).toMatchObject({ ok: true, status: "UpToDate" });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer dcap-secret");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ quote: quoteHex });
    expect(calls[0].init.redirect).toBe("error");
  });
  test("rejects a bad TCB status, an HTTP error and a missing endpoint", async () => {
    const bad = fakeFetch({ [base.tdxVerifierUrl!]: () => json({ tcb_status: "OutOfDate" }) });
    expect((await createVerifiers(base, bad.f)[0].verify(input())).ok).toBe(false);
    const down = fakeFetch({ [base.tdxVerifierUrl!]: () => json({}, 503) });
    expect(await createVerifiers(base, down.f)[0].verify(input())).toMatchObject({ ok: false, reason: "verifier HTTP 503" });
    const none = createVerifiers({ ...base, tdxVerifierUrl: undefined }, fakeFetch({}).f)[0];
    expect((await none.verify(input())).reason).toContain("TDX_VERIFIER_URL");
  });
});

describe("intel trust authority verifier", () => {
  const key = rsaKey();
  const cfg: AttestationVerifierConfig = { ...base, verifiers: ["intel-ta"] };
  const claims = (over: Record<string, unknown> = {}) => ({ exp: NOW / 1000 + 300, iat: NOW / 1000, attester_type: "TDX", attester_tcb_status: "UpToDate", tdx_mrtd: REGS.mrtd, tdx_rtmr0: REGS.rtmr0, tdx_rtmr3: REGS.rtmr3, tdx_is_debuggable: false, ...over });
  const verifier = (token: string | (() => Response), jwks: unknown = key.jwks) => {
    const fake = fakeFetch({
      [cfg.intelTa.url]: () => (typeof token === "string" ? json({ token }) : token()),
      [cfg.intelTa.jwksUrl]: () => json(jwks),
    });
    return { ...fake, v: createVerifiers(cfg, fake.f, () => NOW)[0] };
  };

  test("accepts a token signed by the published key and posts the quote as base64 with the API key", async () => {
    const { v, calls } = verifier(signJwt(key.privateKey, claims()));
    expect(await v.verify(input())).toMatchObject({ ok: true, status: "UpToDate" });
    const post = calls.find((c) => c.url === cfg.intelTa.url)!;
    expect((post.init.headers as Record<string, string>)["x-api-key"]).toBe("ita-key");
    expect(JSON.parse(String(post.init.body))).toEqual({ tdx: { quote: Buffer.from(quoteHex, "hex").toString("base64") } });
  });
  test("reads claims nested under a tdx object and accepts other RSA algorithms", async () => {
    const nested = { exp: NOW / 1000 + 300, attester_type: "TDX", tdx: { attester_tcb_status: "SWHardeningNeeded", tdx_mrtd: REGS.mrtd } };
    for (const alg of ["PS256", "RS384", "RS512"]) {
      const { v } = verifier(signJwt(key.privateKey, nested, { alg, kid: "test-key" }));
      expect((await v.verify(input())).ok).toBe(true);
    }
  });
  test("rejects a token signed by another key, an unknown kid, alg none and a tampered payload", async () => {
    const other = rsaKey();
    expect((await verifier(signJwt(other.privateKey, claims())).v.verify(input())).reason).toContain("signature does not verify");
    expect((await verifier(signJwt(key.privateKey, claims(), { alg: "PS384", kid: "other" })).v.verify(input())).reason).toContain("no matching signing key");
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.x`;
    expect((await verifier(none).v.verify(input())).reason).toContain("unsupported token algorithm");
    const parts = signJwt(key.privateKey, claims()).split(".");
    const forged = [parts[0], Buffer.from(JSON.stringify(claims({ attester_tcb_status: "UpToDate", tdx_mrtd: "ff".repeat(48) }))).toString("base64url"), parts[2]].join(".");
    expect((await verifier(forged).v.verify(input())).ok).toBe(false);
  });
  test("rejects expired tokens, unacceptable TCB status, debuggable TDs, mismatched registers and other attesters", async () => {
    const run = async (c: Record<string, unknown>) => (await verifier(signJwt(key.privateKey, claims(c))).v.verify(input())).reason ?? "";
    expect(await run({ exp: NOW / 1000 - 1 })).toContain("expired");
    expect(await run({ exp: undefined })).toContain("expired");
    expect(await run({ nbf: NOW / 1000 + 3600 })).toContain("not yet valid");
    expect(await run({ attester_tcb_status: "OutOfDate" })).toContain("OutOfDate");
    expect(await run({ attester_tcb_status: undefined })).toContain("no TCB status");
    expect(await run({ tdx_is_debuggable: true })).toContain("debuggable");
    expect(await run({ tdx_mrtd: "ee".repeat(48) })).toContain("mrtd");
    expect(await run({ tdx_rtmr3: "ee".repeat(48) })).toContain("rtmr3");
    expect(await run({ attester_type: "SGX" })).toContain("non-TDX");
    expect(await run({ tdx_report_data: "dd".repeat(64) })).toContain("report_data");
  });
  test("accepts report_data in hex or base64 when it matches the quote", async () => {
    for (const rd of [registers.reportData, Buffer.from(registers.reportData, "hex").toString("base64")]) {
      expect((await verifier(signJwt(key.privateKey, claims({ tdx_report_data: rd }))).v.verify(input())).ok).toBe(true);
    }
  });
  test("fails on service errors, a missing token, a missing key and non-TDX evidence", async () => {
    expect((await verifier(() => json({}, 401)).v.verify(input())).reason).toBe("Intel Trust Authority HTTP 401");
    expect((await verifier(() => json({ nothing: 1 })).v.verify(input())).reason).toContain("no token");
    const noKeys = fakeFetch({ [cfg.intelTa.url]: () => json({ token: signJwt(key.privateKey, claims()) }), [cfg.intelTa.jwksUrl]: () => json({}, 500) });
    expect((await createVerifiers(cfg, noKeys.f, () => NOW)[0].verify(input())).reason).toContain("key set HTTP 500");
    const nokey = createVerifiers({ ...cfg, intelTa: { ...cfg.intelTa, apiKey: undefined } }, fakeFetch({}).f)[0];
    expect((await nokey.verify(input())).reason).toContain("INTEL_TA_API_KEY");
    expect((await verifier(signJwt(key.privateKey, claims())).v.verify({ kind: "snp", quoteHex, registers: null })).reason).toContain("TDX quotes only");
  });
  test("a JWK with no usable key material never verifies", () => {
    expect(verifyJwt(signJwt(key.privateKey, claims()), { keys: [{ kid: "test-key", kty: "RSA" }] }, NOW)).toEqual({ ok: false, reason: "token signature does not verify" });
  });
});

describe("dstack verifier", () => {
  const cfg: AttestationVerifierConfig = { ...base, verifiers: ["dstack"] };
  const compose = "5e".repeat(32);
  const eventLog = JSON.stringify([{ imr: 3, event: "app-id", event_payload: "01" }, { imr: 3, event: "compose-hash", event_payload: compose }]);
  const answer = (body: unknown, status = 200) => fakeFetch({ [cfg.dstackVerifierUrl!]: () => json(body, status) });

  test("accepts a valid quote and returns the compose hash the verifier reports", async () => {
    const reported = "7a".repeat(32);
    const { f, calls } = answer({ is_valid: true, details: { quote_verified: true, event_log_verified: true, tcb_info: { mrtd: REGS.mrtd, rtmr3: REGS.rtmr3, compose_hash: reported } } });
    const r = await createVerifiers(cfg, f)[0].verify(input({ eventLog, vmConfig: "{}" }));
    expect(r).toMatchObject({ ok: true, composeHash: reported });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ quote: quoteHex, event_log: eventLog, vm_config: "{}" });
  });
  test("falls back to the compose-hash event only when the verifier validated the event log", async () => {
    const verified = answer({ is_valid: true, details: { quote_verified: true, event_log_verified: true } });
    expect((await createVerifiers(cfg, verified.f)[0].verify(input({ eventLog }))).composeHash).toBe(compose);
    const unknown = answer({ is_valid: true, details: {} });
    expect((await createVerifiers(cfg, unknown.f)[0].verify(input({ eventLog }))).composeHash).toBeUndefined();
    expect(composeHashFromEventLog("not json")).toBeUndefined();
    expect(composeHashFromEventLog(JSON.stringify([{ imr: 2, event: "compose-hash", event_payload: compose }]))).toBeUndefined();
  });
  test("rejects invalid quotes, unverified logs, register mismatches, missing evidence and HTTP errors", async () => {
    const run = async (body: unknown, extra: Partial<VerifierInput> = { eventLog }, status = 200) => (await createVerifiers(cfg, answer(body, status).f)[0].verify(input(extra))).reason ?? "";
    expect(await run({ is_valid: false, reason: "tcb revoked" })).toContain("tcb revoked");
    expect(await run({ is_valid: true, details: { event_log_verified: false } })).toContain("not verified");
    expect(await run({ is_valid: true, details: { tcb_info: { mrtd: "ee".repeat(48) } } })).toContain("mrtd");
    expect(await run({ is_valid: true }, {})).toContain("no dstack event log");
    expect(await run({}, { eventLog }, 500)).toBe("dstack verifier HTTP 500");
    const none = createVerifiers({ ...cfg, dstackVerifierUrl: undefined }, fakeFetch({}).f)[0];
    expect((await none.verify(input({ eventLog }))).reason).toContain("DSTACK_VERIFIER_URL");
  });
});

describe("running several verifiers", () => {
  const both: AttestationVerifierConfig = { ...base, verifiers: ["dcap", "dstack"] };
  const compose = "5e".repeat(32);
  const eventLog = JSON.stringify([{ imr: 3, event: "compose-hash", event_payload: compose }]);

  test("all must accept; the first rejection wins and later verifiers are not consulted", async () => {
    const fake = fakeFetch({ [both.tdxVerifierUrl!]: () => json({ tcb_status: "Revoked" }), [both.dstackVerifierUrl!]: () => json({ is_valid: true }) });
    const r = await verifyWithAll(createVerifiers(both, fake.f), input({ eventLog }));
    expect(r.ok).toBe(false);
    expect(fake.calls.map((c) => c.url)).toEqual([both.tdxVerifierUrl!]);
    const ok = fakeFetch({ [both.tdxVerifierUrl!]: () => json({ verified: true }), [both.dstackVerifierUrl!]: () => json({ is_valid: true, details: { event_log_verified: true } }) });
    expect(await verifyWithAll(createVerifiers(both, ok.f), input({ eventLog }))).toMatchObject({ ok: true, verifiers: ["dcap", "dstack"], composeHash: compose });
  });
  test("unreachable verifiers throw, as the single DCAP verifier always did", async () => {
    const boom = (async () => {
      throw new Error("connect refused");
    }) as unknown as typeof fetch;
    await expect(verifyWithAll(createVerifiers(base, boom), input())).rejects.toThrow("connect refused");
  });
  test("verifiersConfigured needs every listed verifier's endpoint", () => {
    expect(verifiersConfigured(base)).toBe(true);
    expect(verifiersConfigured({ ...base, tdxVerifierUrl: undefined })).toBe(false);
    expect(verifiersConfigured({ ...both, dstackVerifierUrl: undefined })).toBe(false);
    expect(verifiersConfigured({ ...base, verifiers: ["intel-ta"] })).toBe(true);
    expect(verifiersConfigured({ ...base, verifiers: ["intel-ta"], intelTa: { ...base.intelTa, apiKey: undefined } })).toBe(false);
  });
});

describe("configuration", () => {
  const cfg = (env: Record<string, string>) => loadConfig({ ANYROUTE_ENV: "test", ...env });
  test("defaults to the DCAP verifier and everything measurement-related off", () => {
    const c = cfg({});
    expect(c.attestation.verifiers).toEqual(["dcap"]);
    expect(c.measurements.enabled).toBe(false);
    expect(c.measurements.registry).toBeNull();
  });
  test("rejects unknown, duplicate and under-configured verifiers", () => {
    expect(() => cfg({ ATTESTATION_VERIFIERS: "dcap,magic" })).toThrow("ATTESTATION_VERIFIERS");
    expect(() => cfg({ ATTESTATION_VERIFIERS: "dcap,dcap" })).toThrow("twice");
    expect(() => cfg({ ATTESTATION_VERIFIERS: "intel-ta" })).toThrow("INTEL_TA_API_KEY");
    expect(() => cfg({ ATTESTATION_VERIFIERS: "dstack" })).toThrow("DSTACK_VERIFIER_URL");
    const c = cfg({ ATTESTATION_VERIFIERS: "dcap, intel-ta,dstack", INTEL_TA_API_KEY: "k", DSTACK_VERIFIER_URL: "http://x.test/verify" });
    expect(c.attestation.verifiers).toEqual(["dcap", "intel-ta", "dstack"]);
  });
});

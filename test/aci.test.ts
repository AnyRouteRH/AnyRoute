import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { aciReportData, aciStaticModels, bodyHash, checkAciReceipt, checkAciReport, compactUpstream, jcs, keysetDigest, type AciGateway } from "../src/providers/aci.ts";
import { pinnedTlsOptions } from "../src/providers/tls-pin.ts";
import { createTlsIdentity, generateTlsKey } from "../sidecar/src/tls.ts";
import { parseProviderModels } from "../src/services/registry.ts";
import { parseTdxQuote } from "../src/services/attestor.ts";
import { APP_COMPOSE, CLAIMS_OK, OTHER_KEY, RECEIPT_KEY, V, VECTOR_KEY, composeHashOf, gatewayReport, keyset, session, signedReceipt } from "./aci-fixtures.ts";

const NONCE = "5c".repeat(32);
const NOW = 1_800_000_000;
const HOST = "gateway.example.com";

function check(report: ReturnType<typeof gatewayReport>, o: { nonce?: string; now?: number; host?: string } = {}) {
  const f = parseTdxQuote(report.attestation.evidence.quote);
  return checkAciReport(report, { nonce: o.nonce ?? NONCE, nowS: o.now ?? NOW, host: o.host ?? HOST, quoteReportData: f.reportData, quoteRtmr3: f.rtmr3 });
}
const gatewayOf = (report: ReturnType<typeof gatewayReport>) => {
  const r = check(report);
  if (!r.ok) throw new Error(r.reason);
  return r.gateway;
};

describe("digests and report data (the specification's published vectors)", () => {
  test("keyset JCS and digest", () => {
    const ks = JSON.parse(V.keysetJcs);
    expect(jcs(ks)).toBe(V.keysetJcs);
    expect(keysetDigest(ks)).toBe(V.keysetDigest);
  });
  test("report_data for a nonce and for none", () => {
    expect(aciReportData(V.keysetDigest, V.nonce)).toBe(V.reportDataWithNonce);
    expect(aciReportData(V.keysetDigest, null)).toBe(V.reportDataNullNonce);
    expect(() => aciReportData(V.keysetDigest, "ABC")).toThrow();
    expect(() => aciReportData("sha256:xyz", V.nonce)).toThrow();
  });
  test("body hashes and the vector key", () => {
    expect(bodyHash(V.requestBody)).toBe(V.requestBodyHash);
    expect(bodyHash(V.responseBody)).toBe(V.responseBodyHash);
    expect(VECTOR_KEY.pub).toBe(V.receiptPublicKey);
  });
});

describe("the vector receipt", () => {
  const ks = JSON.parse(V.keysetJcs);
  const g: AciGateway = { v: 1, keysetDigest: V.keysetDigest, workloadId: null, receiptKeys: ks.receipt_signing_keys, tlsSpki: [], notAfter: ks.not_after, staleAfter: null, serving: "aggregator", sourceProvenance: null, composeHash: null, osImageHash: null, appId: null, keysetEndorsement: "absent", attestedAt: "" };
  const doc = JSON.parse(V.document);
  const ex = { requestBody: V.requestBody, responseBody: new TextEncoder().encode(V.responseBody), receiptId: "rcpt-0001" };

  test("verifies, and takes its claims from the session it cites", () => {
    const ua = checkAciReceipt(doc, g, ex, JSON.parse(V.session));
    expect(ua.checks).toEqual({ signature: true, keyset: true, request_hash: true, response_hash: true });
    expect(ua.receipt_verified).toBe(true);
    expect(ua.upstream).toEqual({ result: "verified", required: true, session_id: V.sessionId, model_id: "demo-model" });
    expect(ua.claims.tee_attested).toEqual({ status: "asserted", source: "hardware_proven" });
    expect(ua.claims.gpu_attested).toEqual({ status: "unknown" });
    expect(ua.gpu_attested).toBe(false);
    expect(ua.attested).toBe(true);
  });
  test("without the session the claims are unknown and the answer is not attested", () => {
    const ua = checkAciReceipt(doc, g, ex);
    expect(ua.receipt_verified).toBe(true);
    expect(ua.claims.tee_attested).toBeNull();
    expect(ua.attested).toBe(false);
    expect(ua.reason).toBe("tee_attested is not asserted");
  });
  test("a session that does not hash to the cited id is not read", () => {
    const s = { ...JSON.parse(V.session), upstream_name: "someone-else" };
    const ua = checkAciReceipt(doc, g, ex, s);
    expect(ua.attested).toBe(false);
    expect(ua.reason).toBe("the cited session does not hash to its id");
  });
  test("any edit breaks the signature; other bytes break the hashes", () => {
    expect(checkAciReceipt({ ...doc, served_at: doc.served_at + 1 }, g, ex, JSON.parse(V.session)).checks.signature).toBe(false);
    const otherResponse = checkAciReceipt(doc, g, { ...ex, responseBody: new TextEncoder().encode(V.responseBody + " ") }, JSON.parse(V.session));
    expect(otherResponse.checks.response_hash).toBe(false);
    expect(otherResponse.attested).toBe(false);
    const otherRequest = checkAciReceipt(doc, g, { ...ex, requestBody: V.requestBody.replace("hi", "ho") }, JSON.parse(V.session));
    expect(otherRequest.checks.request_hash).toBe(false);
    expect(otherRequest.reason).toBe("the receipt does not commit to the request the router sent");
    const unseen = checkAciReceipt(doc, g, { ...ex, responseBody: null }, JSON.parse(V.session));
    expect(unseen.checks.response_hash).toBeNull();
    expect(unseen.attested).toBe(false);
    const swapped = checkAciReceipt(doc, g, { ...ex, receiptId: "rcpt-other" }, JSON.parse(V.session));
    expect(swapped.attested).toBe(false);
  });
});

describe("gateway receipts", () => {
  const report = gatewayReport(NONCE);
  const g = gatewayOf(report);
  const req = JSON.stringify({ model: "demo-model", messages: [{ role: "user", content: "hi" }], provider: { aci_verified: true, zdr: true } });
  const res = new TextEncoder().encode('{"id":"x","choices":[{"message":{"content":"ok"}}]}');
  const ex = { requestBody: req, responseBody: res, receiptId: "rcpt-1" };
  const receipt = (upstream: Parameters<typeof signedReceipt>[0]["upstream"], over: Partial<Parameters<typeof signedReceipt>[0]> = {}) =>
    signedReceipt({ keysetDigest: g.keysetDigest, receiptId: "rcpt-1", requestBody: req, responseBody: res, upstream, servedAt: NOW, ...over });

  test("claims in the receipt itself; tri-state kept as stated", () => {
    const ua = checkAciReceipt(receipt({ result: "verified", required: true, session_id: "ab".repeat(32), claims: CLAIMS_OK }), g, ex);
    expect(ua.attested).toBe(true);
    expect(ua.gpu_attested).toBe(true);
    expect(ua.claims).toEqual({
      tee_attested: { status: "asserted", source: "hardware_proven" },
      tcb_up_to_date: { status: "asserted", source: "hardware_proven" },
      gpu_attested: { status: "asserted", source: "verifier_derived" },
      model_weights_provenance: { status: "unknown" },
      zdr: null,
    });
    const compact = compactUpstream(ua);
    expect(compact).toMatchObject({ kind: "aci/1", receipt_id: "rcpt-1", keyset_digest: g.keysetDigest, attested: true, gpu_attested: true, constraints: { aci_verified: true, zdr: true } });
    expect(compact).not.toHaveProperty("checks");
  });
  test("an as_-prefixed session id is the same content address", () => {
    const s = session(CLAIMS_OK, NOW);
    expect(checkAciReceipt(receipt({ result: "verified", required: true, session_id: `as_${s.id}` }), g, ex, s.doc).attested).toBe(true);
    const late = session(CLAIMS_OK, NOW - 10_000);
    expect(checkAciReceipt(receipt({ result: "verified", required: true, session_id: late.id }), g, ex, late.doc).reason).toBe("the response was served outside the cited session's validity");
  });
  test("a routed response (upstream not verified) is not attested", () => {
    const ua = checkAciReceipt(receipt({ result: "failed", required: false }), g, ex);
    expect(ua.receipt_verified).toBe(true);
    expect(ua.attested).toBe(false);
    expect(ua.reason).toContain("the upstream was not verified");
  });
  test("tee_attested refuted or unknown is not attested; gpu is read separately", () => {
    const refuted = checkAciReceipt(receipt({ result: "verified", required: true, session_id: "ab".repeat(32), claims: { ...CLAIMS_OK, tee_attested: { status: "refuted" } } }), g, ex);
    expect(refuted.attested).toBe(false);
    expect(refuted.gpu_attested).toBe(true);
    const noGpu = checkAciReceipt(receipt({ result: "verified", required: true, session_id: "ab".repeat(32), claims: { ...CLAIMS_OK, gpu_attested: { status: "unknown" } } }), g, ex);
    expect(noGpu.attested).toBe(true);
    expect(noGpu.gpu_attested).toBe(false);
  });
  test("a key outside the attested keyset, another keyset, or another version is refused", () => {
    const up = { result: "verified", required: true, session_id: "ab".repeat(32), claims: CLAIMS_OK };
    expect(checkAciReceipt(receipt(up, { key: OTHER_KEY }), g, ex).checks.signature).toBe(false);
    expect(checkAciReceipt(receipt(up, { keyId: "unknown-key" }), g, ex).reason).toBe("the receipt's key is not a receipt key of the attested keyset");
    const other = checkAciReceipt(receipt(up, { keysetDigest: "sha256:" + "00".repeat(32) }), g, ex);
    expect(other.checks.keyset).toBe(false);
    expect(other.attested).toBe(false);
    const doc = receipt(up);
    expect(checkAciReceipt({ ...doc, api_version: "aci/2" }, g, ex).attested).toBe(false);
    expect(checkAciReceipt(null, g, ex).attested).toBe(false);
  });
});

describe("gateway reports", () => {
  test("a well-formed report establishes the gateway", () => {
    const r = check(gatewayReport(NONCE));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.gateway).toMatchObject({
      keysetDigest: keysetDigest(keyset()),
      receiptKeys: [{ key_id: "receipt-ed25519-v1", algo: "ed25519", public_key: RECEIPT_KEY.pub }],
      tlsSpki: ["5a".repeat(32)],
      composeHash: composeHashOf(APP_COMPOSE),
      osImageHash: "56".repeat(32),
      appId: "12".repeat(20),
      serving: "aggregator",
      keysetEndorsement: "absent",
      sourceProvenance: { repo_url: "https://git.example/gateway.git", repo_commit: "ab".repeat(20), image_digest: null },
    });
  });
  test("each binding is enforced", () => {
    const reason = (report: ReturnType<typeof gatewayReport>, o?: Parameters<typeof check>[1]) => {
      const r = check(report, o);
      return r.ok ? null : r.reason;
    };
    expect(reason(gatewayReport(NONCE, { bindNonce: "11".repeat(32) }))).toBe("report_data does not bind this nonce and keyset");
    const edited = gatewayReport(NONCE);
    edited.attestation.workload_keyset.not_after += 1;
    expect(reason(edited)).toBe("workload_keyset_digest does not match the served keyset");
    const quoteSwap = gatewayReport(NONCE);
    quoteSwap.attestation.evidence.quote = gatewayReport("22".repeat(32)).attestation.evidence.quote;
    expect(reason(quoteSwap)).toBe("the quote's report_data is not the report's");
    expect(reason(gatewayReport(NONCE, { keyset: keyset({ notAfter: NOW }) }))).toBe("keyset has expired (not_after)");
    expect(reason(gatewayReport(NONCE, { staleAfter: NOW - 1 }))).toBe("report is stale (freshness.stale_after)");
    expect(reason(gatewayReport(NONCE, { staleAfter: NOW + 60 }))).toBeNull();
    expect(reason(gatewayReport(NONCE, { tamperEvent: true }))).toBe('RTMR3 event "compose-hash" does not hash to its digest');
    expect(reason(gatewayReport(NONCE, { measuredCompose: "77".repeat(32) }))).toBe("app_compose is not the measured compose");
    expect(reason(gatewayReport(NONCE, { registers: { rtmr3: "00".repeat(48) } }))).toBe("event log does not replay to the quote's RTMR3");
    expect(reason(gatewayReport(NONCE, { keyset: keyset({ receiptKey: "zz" }) }))).toBe("keyset lists no Ed25519 receipt signing key");
    const v2 = { ...gatewayReport(NONCE), api_version: "aci/2" };
    expect(reason(v2)).toBe("api_version is not aci/1");
  });
  test("TLS pins are read for the endpoint's host only; an endorsement is recorded, not verified", () => {
    const g = gatewayOf(gatewayReport(NONCE, { endorsement: true }));
    expect(g.keysetEndorsement).toBe("present_not_verified");
    const r = check(gatewayReport(NONCE), { host: "other.example.com" });
    expect(r.ok && r.gateway.tlsSpki).toEqual([]);
  });
});

describe("the key pin", () => {
  test("keeps the host-name check and accepts only the pinned key", () => {
    const key = generateTlsKey();
    const id = createTlsIdentity(key.privateKey, { attestationRef: "ab".repeat(32), hostnames: ["gateway.example.com"] });
    const cert = new X509Certificate(id.certPem);
    const peer = { raw: cert.raw, subject: { CN: "anyroute-sidecar" }, subjectaltname: cert.subjectAltName } as never;
    const pinned = pinnedTlsOptions({ certPem: "", spkiSha256: id.spkiSha256, spkiOnly: true });
    expect(pinned).not.toHaveProperty("ca");
    expect(pinned.checkServerIdentity("gateway.example.com", peer)).toBeUndefined();
    expect(pinned.checkServerIdentity("elsewhere.example.com", peer)).toBeInstanceOf(Error);
    const other = pinnedTlsOptions({ certPem: "", spkiSha256: "00".repeat(32), spkiOnly: true });
    expect(other.checkServerIdentity("gateway.example.com", peer)?.message).toBe("The provider's TLS key is not the attested key.");
  });
});

describe("the static model list", () => {
  // Shaped like a public GET /v1/models catalogue, with invented models.
  const catalogue = {
    data: [
      { id: "demo/chat-large", name: "Demo: Chat Large", created: 1780000000, description: "Served by some upstream.", hugging_face_id: "demo/Chat-Large", is_tee: true, providers: ["upstream-a"], context_length: 262144, max_output_length: 300000, pricing: { prompt: "0.00000044", completion: "0.00000132", input_cache_read: "0.000000028" }, input_modalities: ["text"], output_modalities: ["text"], supported_parameters: ["max_tokens", "tools", "temperature"], supported_sampling_parameters: ["temperature", "top_p"], supported_features: ["tools"], quantization: "fp8" },
      { id: "demo/chat-uncensored", name: "Demo Uncensored", is_tee: true, context_length: 32768, pricing: { prompt: "0.0000001", completion: "0.0000002" } },
      { id: "demo/abliterated-7b", name: "Plain name", is_tee: true, context_length: 32768, pricing: { prompt: "0.0000001", completion: "0.0000002" } },
      { id: "vendor/closed-model", name: "Routed", is_tee: false, context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
      { id: "demo/no-price", name: "No price", is_tee: true, context_length: 8192, pricing: {} },
    ],
  };
  test("TEE models only, no restricted variants, upstream prices unchanged, no descriptions or route names", () => {
    const { models, skipped } = aciStaticModels(catalogue);
    expect(models.map((m) => m.id)).toEqual(["demo/chat-large"]);
    expect(skipped).toEqual([
      { id: "demo/chat-uncensored", reason: "restricted variant" },
      { id: "demo/abliterated-7b", reason: "restricted variant" },
      { id: "vendor/closed-model", reason: "not offered inside a TEE" },
      { id: "demo/no-price", reason: "no price or context length" },
    ]);
    const m = models[0];
    expect(m).toEqual({
      id: "demo/chat-large",
      name: "Demo: Chat Large",
      created: 1780000000,
      hugging_face_id: "demo/Chat-Large",
      anyroute: { slug: "demo/chat-large" },
      input_modalities: ["text"],
      output_modalities: ["text"],
      quantization: "fp8",
      context_length: 262144,
      max_completion_tokens: 262144,
      pricing: { prompt: "0.00000044", completion: "0.00000132", input_cache_read: "0.000000028" },
      supported_parameters: ["max_tokens", "temperature", "tools", "top_p"],
      supported_features: ["tools"],
    });
    expect(parseProviderModels({ data: models }).errors).toEqual([]);
  });
  test("a chosen subset", () => {
    expect(aciStaticModels(catalogue, { only: new Set(["demo/chat-large", "demo/chat-uncensored"]) }).models.map((m) => m.id)).toEqual(["demo/chat-large"]);
  });
});

import { describe, expect, test } from "bun:test";
import { checkAciReceipt, checkAciReport, compactUpstream, type AciGateway } from "../src/providers/aci.ts";
import { parseTdxQuote } from "../src/services/attestor.ts";
import { proofFromReceipt } from "../web/lib/arena.js";
import { CLAIMS_OK, gatewayReport, signedReceipt } from "./aci-fixtures.ts";

// The Arena's proof badge reads the router's signed receipt. This feeds it what the real gateway-receipt checker
// writes (providers/aci.ts compactUpstream) inside a payload shaped like api/chat.ts finalize, so the two cannot drift.

const NONCE = "5c".repeat(32);
const NOW = 1_800_000_000;
const report = gatewayReport(NONCE);
const gateway: AciGateway = (() => {
  const f = parseTdxQuote(report.attestation.evidence.quote);
  const r = checkAciReport(report, { nonce: NONCE, nowS: NOW, host: "gateway.example.com", quoteReportData: f.reportData, quoteRtmr3: f.rtmr3 });
  if (!r.ok) throw new Error(r.reason);
  return r.gateway;
})();
const req = JSON.stringify({ model: "demo-model", messages: [{ role: "user", content: "hi" }], provider: { aci_verified: true, zdr: true } });
const res = new TextEncoder().encode('{"id":"x","choices":[{"message":{"content":"ok"}}]}');
const ex = { requestBody: req, responseBody: res, receiptId: "rcpt-1" };
const gatewayReceipt = (upstream: Parameters<typeof signedReceipt>[0]["upstream"]) =>
  signedReceipt({ keysetDigest: gateway.keysetDigest, receiptId: "rcpt-1", requestBody: req, responseBody: res, upstream, servedAt: NOW });

/** The router's receipt for a call this gateway served, whose disclosure class follows the check the way chat.ts servedWith() does. */
function routerReceipt(ua: ReturnType<typeof checkAciReceipt>) {
  return {
    id: "gen-1",
    sig: "00",
    key_id: "k1",
    alg: "Ed25519",
    payload: {
      v: 1,
      id: "gen-1",
      model: "demo-model",
      provider: "phala-confidential-ai",
      attestation: "0x" + "cd".repeat(32),
      disclosure: ua.attested ? "attested" : "policy",
      lane: "attested",
      upstream_attestation: compactUpstream(ua),
    },
  };
}

describe("the arena's proof badge on real gateway receipts", () => {
  test("every claim asserted", () => {
    const ua = checkAciReceipt(gatewayReceipt({ result: "verified", required: true, session_id: "ab".repeat(32), claims: CLAIMS_OK }), gateway, ex);
    const proof = proofFromReceipt(routerReceipt(ua));
    expect(proof!.attested).toBe(true);
    expect(proof!.checks.map((c: { key: string; state: string }) => `${c.key}:${c.state}`)).toEqual(["provider:yes", "tee:yes", "gpu:yes", "tcb:yes"]);
    expect(proof!.provider).toBe("phala-confidential-ai");
  });
  test("attested, but no GPU claim", () => {
    const ua = checkAciReceipt(gatewayReceipt({ result: "verified", required: true, session_id: "ab".repeat(32), claims: { ...CLAIMS_OK, gpu_attested: { status: "unknown" } } }), gateway, ex);
    expect(ua.attested).toBe(true);
    const proof = proofFromReceipt(routerReceipt(ua));
    expect(proof!.attested).toBe(true);
    expect(proof!.checks.find((c: { key: string }) => c.key === "gpu")).toMatchObject({ state: "unknown", text: "GPU status not reported" });
  });
  test("TCB out of date is shown as such", () => {
    const ua = checkAciReceipt(gatewayReceipt({ result: "verified", required: true, session_id: "ab".repeat(32), claims: { ...CLAIMS_OK, tcb_up_to_date: { status: "refuted" } } }), gateway, ex);
    const proof = proofFromReceipt(routerReceipt(ua));
    expect(proof!.checks.find((c: { key: string }) => c.key === "tcb")).toMatchObject({ state: "no", text: "TCB out of date" });
  });
  test("an upstream the gateway did not verify is not attested, with the checker's reason", () => {
    const ua = checkAciReceipt(gatewayReceipt({ result: "failed", required: false }), gateway, ex);
    const proof = proofFromReceipt(routerReceipt(ua));
    expect(proof!.attested).toBe(false);
    expect(proof!.reason).toBe(ua.reason!);
    expect(proof!.checks.map((c: { key: string; state: string }) => `${c.key}:${c.state}`)).toEqual(["provider:no", "tee:unknown", "gpu:unknown", "tcb:unknown"]);
  });
  test("a receipt for other bytes does not verify, so no claim is credited", () => {
    const ua = checkAciReceipt(gatewayReceipt({ result: "verified", required: true, session_id: "ab".repeat(32), claims: CLAIMS_OK }), gateway, { ...ex, responseBody: new TextEncoder().encode("other") });
    expect(ua.receipt_verified).toBe(false);
    const proof = proofFromReceipt(routerReceipt(ua));
    expect(proof!.attested).toBe(false);
    expect(proof!.checks.map((c: { key: string; state: string }) => `${c.key}:${c.state}`)).toEqual(["provider:no", "tee:no", "gpu:no", "tcb:unknown"]);
  });
});

import { randomBytes } from "node:crypto";
import type { Ctx } from "../../context.ts";
import { boundedJson, peekProviderCertificate, providerFetch } from "../../providers/network.ts";
import { describePeerCertificate } from "../../providers/tls-pin.ts";
import { parseTdxQuote } from "../../services/attestor.ts";
import { createVerifiers, verifyWithAll, type VerifyOutcome, type VerifierInput } from "../../services/attestor-verifiers.ts";
import { sealedBindingsSchema, sealedReportData, type SealedRegistration } from "./bindings.ts";
export type SealedResult = { attested: false; reason: string } | { attested: true; verified_by: string[]; tls_spki_sha256: string };
export type SealedIO = {
  certificate(url: URL): Promise<Buffer>;
  report(url: URL, pin: { certPem: string; spkiSha256: string }): Promise<unknown>;
  verify(input: VerifierInput): Promise<VerifyOutcome>;
};
export function sealedIO(ctx: Ctx): SealedIO {
  // Public destinations only, including outside production; redirects are never followed.
  const policy = { production: true };
  return {
    certificate: url => peekProviderCertificate(url, policy, AbortSignal.timeout(20_000)),
    report: async (url, tlsPin) => {
      const res = await providerFetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) }, { ...policy, tlsPin });
      if (!res.ok) throw new Error("Endpoint unavailable.");
      return boundedJson(res);
    },
    verify: input => verifyWithAll(createVerifiers(ctx.cfg.attestation), input),
  };
}
/** A fresh quote proves the key on the very TLS connection used to fetch it. No software evidence is accepted. */
export async function verifySealed(hash: string, expected: SealedRegistration, io: SealedIO, nonce = randomBytes(32).toString("hex")): Promise<SealedResult> {
  const reject = (reason: string): SealedResult => ({ attested: false, reason });
  try {
    const url = new URL(expected.attestation_url);
    const peer = describePeerCertificate(await io.certificate(url));
    url.searchParams.set("nonce", nonce);
    const raw = await io.report(url, peer) as Record<string, any>;
    if (!raw || raw.type !== "anyroute.sealed-agent.attestation/1" || raw.evidence?.dev !== false || raw.evidence?.kind !== "dstack") return reject("hardware_evidence_required");
    const bindings = sealedBindingsSchema.parse(raw.bindings);
    if (bindings.agent_key_hash !== hash) return reject("agent_key_mismatch");
    if (bindings.agent_image_digest !== expected.agent_image_digest || bindings.compose_hash !== expected.compose_hash) return reject("deployment_mismatch");
    if (bindings.tls_spki_sha256 !== peer.spkiSha256) return reject("tls_binding_mismatch");
    const quote = raw.evidence.quote;
    if (typeof quote !== "string" || !/^[0-9a-f]+$/.test(quote)) return reject("invalid_quote");
    const bytes = Buffer.from(quote, "hex");
    // parseTdxQuote is also used by the provider attestor; additionally constrain the body to TDX v4 here.
    if (bytes.length < 632 || bytes.readUInt16LE(0) !== 4 || bytes.readUInt32LE(4) !== 0x81 || (bytes[48 + 120] & 1)) return reject("unsafe_tdx_quote");
    const fields = parseTdxQuote(quote);
    if (fields.reportData !== sealedReportData(bindings, nonce)) return reject("report_data_mismatch");
    const verified = await io.verify({ kind: "tdx", quoteHex: quote, registers: fields, eventLog: typeof raw.evidence.event_log === "string" ? raw.evidence.event_log : null });
    if (!verified.ok || !verified.verifiers.length) return reject("quote_rejected");
    if (verified.composeHash !== expected.compose_hash.slice(7)) return reject("measured_compose_mismatch");
    return { attested: true, verified_by: verified.verifiers, tls_spki_sha256: peer.spkiSha256 };
  } catch { return reject("verification_unavailable"); }
}

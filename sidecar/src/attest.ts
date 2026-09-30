import type { Runtime } from "./boot.ts";
import type { QuoteEvidence } from "./attestation/index.ts";
import { HPKE_CONTENT_TYPE, HPKE_STREAM_CONTENT_TYPE, HPKE_SUITE } from "./hpke.ts";
import { TEMPLATE_VERSION } from "./classifier.ts";
import { bindingsDigest, bindingsObject } from "./reportdata.ts";
import { bytesToHex } from "./util.ts";
import { SIDECAR_VERSION } from "./version.ts";

/**
 * The evidence document served at /attest. A verifier rebuilds report_data from `bindings` (and the nonce, for a
 * fresh quote), checks it against the report_data inside the quote, verifies the quote's signature and
 * certificate chain itself, and compares the digests with what it expects. The sidecar does none of the
 * signature verification: `checks` says so.
 */
export function attestationDocument(rt: Runtime, evidence: QuoteEvidence, nonceHex: string | null) {
  return {
    v: 1,
    type: "anyroute.sidecar.attestation",
    sidecar_version: SIDECAR_VERSION,
    dev: rt.dev,
    ...(rt.dev ? { warning: "SIMULATED EVIDENCE: no hardware produced this quote. Reject it in any production use." } : {}),
    attestation_ref: rt.attestationRef,
    attestation_san: rt.tls?.attestSan ?? null,
    evidence: {
      kind: evidence.kind,
      format: evidence.format,
      dev: evidence.dev,
      quote: evidence.quote,
      report_data: evidence.reportData,
      event_log: evidence.eventLog,
      measurements: evidence.measurements,
      generated_at: evidence.generatedAt,
      nonce: nonceHex,
      boot: evidence === rt.bootEvidence,
    },
    bindings: bindingsObject(rt.bindings),
    report_data: {
      derivation:
        "sha256(canonical_json(bindings)) || nonce; the nonce is 32 bytes, all zero for the boot quote. bindings.v=2 additionally commits source_hash, engine and model; absence of bindings.v denotes legacy v1. The classifier_* and hpke_pubkey bindings are present only when that feature is on, so a deployment without them derives the same value as before they existed.",
      bindings_digest: bytesToHex(bindingsDigest(rt.bindings)),
    },
    checks: {
      report_data_matches_quote: !evidence.dev,
      quote_signature_verified_by_sidecar: false,
    },
    attestation_ref_derivation: "sha256 of the boot quote bytes; carried in the certificate SAN as <first 32 hex>.<last 32 hex>.attest.anyroute",
    model: { digest: rt.model.digest, digest_source: rt.model.source, files: rt.model.files ?? null, bytes: rt.model.bytes ?? null },
    compose_hash: rt.composeHash.value ? { value: rt.composeHash.value, source: rt.composeHash.source } : null,
    image_digest: rt.imageDigest.value ? { value: rt.imageDigest.value, source: rt.imageDigest.source } : null,
    classifier: classifierSection(rt),
    hpke: hpkeSection(rt),
    router_record_checked: rt.routerChecked,
    tls: rt.tls
      ? { mode: "self_signed", spki_sha256: rt.tls.spkiSha256, not_before: rt.tls.notBefore.toISOString(), not_after: rt.tls.notAfter.toISOString() }
      : null,
    receipt_key: { alg: "Ed25519", key_id: rt.signer.keyId, public_key: rt.signer.publicKeyHex },
  };
}

/** What the classifier is, as bound into the report data (its digest and policy hash) and what it enforces. */
function classifierSection(rt: Runtime) {
  const c = rt.classifier;
  if (!c) return { enabled: false };
  return {
    enabled: true,
    digest: c.digest,
    digest_source: rt.classifierWeights?.source ?? "declared",
    files: rt.classifierWeights?.files ?? null,
    bytes: rt.classifierWeights?.bytes ?? null,
    policy_hash: c.policy,
    policy_derivation: `sha256(canonical_json({v, system_prompt, check_response, non_text_input})) with v "${TEMPLATE_VERSION}" and system_prompt built from the categories below`,
    categories: c.categories.map((x) => ({ id: x.id, description: x.description })),
    check_response: c.opts.checkResponse,
    non_text_input: c.opts.nonTextInput,
    receipt_field: "classifier: {enabled, digest, blocked}; a bit per exchange, never the content or the category",
  };
}

/** The key requests can be encrypted to. It is bound in the report data as bindings.hpke_pubkey. */
function hpkeSection(rt: Runtime) {
  const h = rt.hpke;
  if (!h) return { enabled: false };
  return {
    enabled: true,
    suite: HPKE_SUITE,
    mode: "base",
    public_key: h.publicKeyHex,
    key_id: h.keyId,
    request_content_type: HPKE_CONTENT_TYPE,
    response_content_type: { json: HPKE_CONTENT_TYPE, event_stream: HPKE_STREAM_CONTENT_TYPE },
    info: "anyroute-hpke/v1",
    clock_skew_seconds: rt.cfg.hpke.clockSkewSeconds,
    format: "see the encrypted transport section of the sidecar README",
  };
}

export function discoveryDocument(rt: Runtime) {
  return {
    v: 1,
    type: "anyroute.sidecar",
    name: "anyroute-sidecar",
    version: SIDECAR_VERSION,
    dev: rt.dev,
    endpoints: {
      attest: "/attest",
      healthz: "/healthz",
      chat_completions: "/v1/chat/completions",
      embeddings: "/v1/embeddings",
      models: "/v1/models",
      receipt_by_id: "/v1/receipts/{id}",
    },
    receipts: {
      alg: "Ed25519",
      key_id: rt.signer.keyId,
      public_key: rt.signer.publicKeyHex,
      signed_bytes: "canonical JSON of the payload (keys sorted, no whitespace)",
      header: "x-anyroute-receipt",
      header_encoding: "base64url of the JSON envelope",
      sse_event: "anyroute.receipt",
      leaf: "keccak256(keccak256(canonical_payload || signature))",
    },
    attestation: { kind: rt.bootEvidence.kind, dev: rt.dev, ref: rt.attestationRef, san: rt.tls?.attestSan ?? null },
    model_digest: rt.model.digest,
    model_digest_source: rt.model.source,
    image_digest: rt.imageDigest.value || null,
    compose_hash: rt.composeHash.value || null,
    tls_spki_sha256: rt.tls?.spkiSha256 ?? null,
    royalty_recipient: rt.cfg.royalty.recipient ?? null,
    classifier: rt.classifier ? { enabled: true, digest: rt.classifier.digest, policy_hash: rt.classifier.policy } : { enabled: false },
    hpke: rt.hpke ? { enabled: true, public_key: rt.hpke.publicKeyHex, key_id: rt.hpke.keyId, content_type: HPKE_CONTENT_TYPE } : { enabled: false },
  };
}

import { readFile } from "node:fs/promises";
import type { KeyObject } from "node:crypto";
import { createAttestationProvider, type AttestationProvider, type QuoteEvidence } from "./attestation/index.ts";
import { ChatLabelClassifier, ContentGate, enforcedCategories } from "./classifier.ts";
import { assertClassifierAllowlistConfigured, assertModelAllowlistConfigured, enforceClassifierPin, enforceComposePin, enforceModelPin, hashModelPath, loadAllowlist } from "./digest.ts";
import type { SidecarConfig } from "./config.ts";
import { HpkeEndpoint } from "./hpke.ts";
import { QuotaManager, type BucketConfig } from "./quota.ts";
import { EnclaveSigner, ReceiptIndex, ReceiptQueue } from "./receipts.ts";
import { verifyAgainstRouter } from "./router-check.ts";
import { reportData, reportDataHex, type Bindings } from "./reportdata.ts";
import { createTlsIdentity, generateTlsKey, type TlsIdentity } from "./tls.ts";
import { normalizeDigest, sha256Hex, SidecarError, stderrLogger, type Logger } from "./util.ts";

// Boot sequence. Every step that can refuse to start runs before the keys are generated and before anything
// listens, in this order (cheapest checks first):
//   1. the attestation provider is constructed (this is where the dev provider is refused)
//   2. (nothing: the classifier is checked with the allow-lists and the weights, below)
//   3. the allow-lists are loaded and the model allow-list must be non-empty; with the classifier on, so must the
//      classifier allow-list
//   4. the weights are hashed (or a declared digest is checked against them) and must be on the allow-list; with the
//      classifier on, its weights are measured and pinned the same way, against their own list
//   5. the compose hash is collected from the platform, the configuration and the compose file; they must agree;
//      when a compose allow-list is configured it must contain the hash
//   6. optionally the router's record for this provider is compared with the served model digest
//   7. the Ed25519 receipt key, the TLS key and (when enabled) the HPKE key are generated, the quote is requested
//      with report data that binds them, the digests and the classifier, and the certificate is issued with the
//      quote's hash in its SAN.

export type Sourced = { value: string; source: string };

export type Runtime = {
  cfg: SidecarConfig;
  logger: Logger;
  fetchImpl: typeof fetch;
  provider: AttestationProvider;
  dev: boolean;
  signer: EnclaveSigner;
  tls: TlsIdentity | null;
  bindings: Bindings;
  bootEvidence: QuoteEvidence;
  /** sha256 of the boot quote bytes, 64 hex characters: carried in the certificate SAN and in every receipt. */
  attestationRef: string;
  model: { digest: string; source: "measured" | "declared"; files?: number; bytes?: number };
  /** The in-enclave classifier, when enabled. It only ever reports counts. */
  classifier: ContentGate | null;
  /** How the classifier's digest was obtained. */
  classifierWeights: Runtime["model"] | null;
  /** The request-encryption key, when enabled. */
  hpke: HpkeEndpoint | null;
  composeHash: Sourced;
  imageDigest: Sourced;
  routerChecked: boolean;
  queue: ReceiptQueue;
  receiptIndex: ReceiptIndex;
  quota: QuotaManager;
  upstreamApiKey?: string;
  anchorToken?: string;
  startedAt: number;
  /** Request a fresh quote bound to a client nonce; rate limited. */
  freshQuote(nonce: Uint8Array): Promise<QuoteEvidence>;
};

export type BootDeps = {
  env?: Record<string, string | undefined>;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Tests inject a provider; production builds it from the configuration. */
  provider?: AttestationProvider;
  now?: () => number;
};

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** Hash the weights at `spec.path`, or take the declared digest; a declared digest must match what is measured. */
async function measureWeights(
  spec: { path?: string; digest?: string; exclude: string[] },
  o: { label: string; field: string; mismatchCode: string; logger: Logger },
): Promise<Runtime["model"]> {
  const declared = spec.digest ? normalizeDigest(spec.digest, `${o.field}.digest`) : undefined;
  if (spec.path) {
    o.logger("info", `hashing ${o.label} weights`, { path: spec.path });
    const h = await hashModelPath(spec.path, { exclude: spec.exclude, logger: (l, m, f) => l !== "info" && o.logger(l, m, f) });
    if (declared && declared !== h.digest) {
      throw new SidecarError(o.mismatchCode, `${o.field}.digest ${declared} does not match the weights at ${o.field}.path (${h.digest}); refusing to start`);
    }
    return { digest: h.digest, source: "measured", files: h.files, bytes: h.bytes };
  }
  o.logger("warn", `${o.label} digest is declared, not measured: this process did not hash any weights`, { digest: declared });
  return { digest: declared!, source: "declared" };
}

export async function boot(cfg: SidecarConfig, deps: BootDeps = {}): Promise<Runtime> {
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? stderrLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  // 1
  const provider = deps.provider ?? createAttestationProvider(cfg.attestation, env);
  const dev = provider.kind === "dev";
  if (dev && env.SIDECAR_DEV_ATTESTATION !== "true") {
    throw new SidecarError("DEV_ATTESTATION_DISABLED", "simulated attestation is refused unless SIDECAR_DEV_ATTESTATION=true");
  }
  if (dev) logger("warn", "DEV ATTESTATION: evidence is simulated and proves nothing; every response and receipt is marked dev");

  // 3
  const allow = await loadAllowlist(cfg.allowlist, env);
  assertModelAllowlistConfigured(allow);
  if (cfg.classifier.enabled) assertClassifierAllowlistConfigured(allow);

  // 4
  const model = await measureWeights(cfg.model, { label: "served", field: "model", mismatchCode: "MODEL_DIGEST_MISMATCH", logger });
  enforceModelPin(model.digest, allow);
  let classifierWeights: Runtime["model"] | null = null;
  if (cfg.classifier.enabled) {
    classifierWeights = await measureWeights(cfg.classifier.model, { label: "classifier", field: "classifier.model", mismatchCode: "CLASSIFIER_DIGEST_MISMATCH", logger });
    enforceClassifierPin(classifierWeights.digest, allow);
  }

  // 5
  const found: Sourced[] = [];
  const platform = await provider.platformInfo();
  if (platform.composeHash) found.push({ value: platform.composeHash, source: "platform" });
  if (cfg.compose.hash) found.push({ value: normalizeDigest(cfg.compose.hash, "compose.hash"), source: "config" });
  if (cfg.compose.file) {
    let bytes: Buffer;
    try {
      bytes = await readFile(cfg.compose.file);
    } catch (e) {
      throw new SidecarError("COMPOSE_UNREADABLE", `cannot read compose file ${cfg.compose.file}: ${(e as Error).message}`);
    }
    found.push({ value: `sha256:${sha256Hex(bytes)}`, source: "compose_file" });
  }
  const distinct = new Set(found.map((f) => f.value));
  if (distinct.size > 1) {
    throw new SidecarError("COMPOSE_HASH_CONFLICT", `the compose hash differs between sources (${found.map((f) => `${f.source}=${f.value}`).join(", ")}); refusing to start`);
  }
  const composeHash: Sourced = found[0] ?? { value: "", source: "none" };
  enforceComposePin(composeHash.value || null, allow);
  const imageDigest: Sourced = cfg.image.digest ? { value: normalizeDigest(cfg.image.digest, "image_digest"), source: "declared" } : { value: "", source: "none" };

  // 6
  let routerChecked = false;
  if (cfg.router.url && cfg.router.providerId) {
    const r = await verifyAgainstRouter(
      { url: cfg.router.url, providerId: cfg.router.providerId, apiKey: nonEmpty(env[cfg.router.apiKeyEnv]), failClosed: cfg.router.failClosed },
      { modelDigest: model.digest },
      fetchImpl,
    );
    routerChecked = r.checked;
  }

  // 7
  const signer = EnclaveSigner.generate();
  let tlsKey: KeyObject | null = null;
  let tlsSpkiHex = "";
  if (cfg.server.tls === "self_signed") {
    const k = generateTlsKey();
    tlsKey = k.privateKey;
    tlsSpkiHex = k.spkiDer.toString("hex");
  } else if (!dev) {
    logger("warn", "server.tls is off: the transport is not covered by the attestation; terminate TLS in front of this process only inside the same trust boundary");
  }
  const hpke = cfg.hpke.enabled ? await HpkeEndpoint.generate({ clockSkewMs: cfg.hpke.clockSkewSeconds * 1000, now }) : null;
  let classifier: ContentGate | null = null;
  if (classifierWeights) {
    const c = cfg.classifier;
    classifier = new ContentGate(
      new ChatLabelClassifier({
        baseUrl: c.baseUrl!,
        model: c.model.servedName!,
        apiKey: nonEmpty(env[c.apiKeyEnv]),
        timeoutMs: c.timeoutMs,
        fetchImpl,
        digest: classifierWeights.digest,
        categories: enforcedCategories(c.categories),
      }),
      { checkResponse: c.checkResponse, nonTextInput: c.nonTextInput, chunkChars: c.chunkChars, overlapChars: c.overlapChars, maxChunks: c.maxChunks, concurrency: c.concurrency },
      now,
    );
  }
  if (classifier && cfg.classifier.nonTextInput === "allow") {
    logger("warn", "classifier.non_text_input is allow: images, audio and files are forwarded without being examined");
  }
  const bindings: Bindings = {
    tlsPubkey: tlsSpkiHex,
    receiptPubkey: signer.publicKeyHex,
    imageDigest: imageDigest.value,
    composeHash: composeHash.value,
    modelDigest: model.digest,
    ...(classifier ? { classifier: { digest: classifier.digest, policy: classifier.policy } } : {}),
    ...(hpke ? { hpkePubkey: hpke.publicKeyHex } : {}),
  };
  const rd = reportData(bindings);
  const bootEvidence = await provider.quote(rd);
  if (bootEvidence.reportData !== reportDataHex(bindings)) {
    throw new SidecarError("QUOTE_REPORT_DATA_MISMATCH", "the attestation provider returned evidence for different report data than requested");
  }
  if (bootEvidence.dev !== dev) throw new SidecarError("QUOTE_MISMATCH", "attestation evidence and provider disagree about whether it is simulated");
  const attestationRef = sha256Hex(Buffer.from(bootEvidence.quote, "hex"));
  const hostnames = cfg.server.hostnames.length ? cfg.server.hostnames : ["localhost", "127.0.0.1"];
  const tls = tlsKey ? createTlsIdentity(tlsKey, { attestationRef, hostnames, validityDays: cfg.server.certValidityDays, dev }) : null;

  const overrides = new Map<string, BucketConfig>();
  for (const k of cfg.auth.keys) if (k.quota) overrides.set(k.id, k.quota);
  const quota = new QuotaManager({ default: cfg.quota.default, global: cfg.quota.global, overrides }, now);

  // Fresh quotes cost the platform a hardware call: allow at most N per minute.
  const window: number[] = [];
  const freshQuote = async (nonce: Uint8Array) => {
    const t = now();
    while (window.length && window[0] <= t - 60_000) window.shift();
    if (window.length >= cfg.attestation.freshQuotesPerMinute) throw new SidecarError("QUOTE_RATE_LIMITED", "too many fresh quote requests; try again shortly");
    window.push(t);
    const fresh = await provider.quote(reportData(bindings, nonce));
    return fresh;
  };

  logger("info", "sidecar ready", {
    attestation: provider.kind,
    dev,
    model_digest: model.digest,
    model_digest_source: model.source,
    classifier_digest: classifier?.digest ?? null,
    hpke_key_id: hpke?.keyId ?? null,
    compose_hash_source: composeHash.source,
    attestation_ref: attestationRef,
    receipt_key_id: signer.keyId,
  });

  return {
    cfg,
    logger,
    fetchImpl,
    provider,
    dev,
    signer,
    tls,
    bindings,
    bootEvidence,
    attestationRef,
    model,
    composeHash,
    imageDigest,
    classifier,
    classifierWeights,
    hpke,
    routerChecked,
    queue: new ReceiptQueue(cfg.receipts.queueCapacity),
    receiptIndex: new ReceiptIndex(),
    quota,
    upstreamApiKey: nonEmpty(env[cfg.upstream.apiKeyEnv]),
    anchorToken: nonEmpty(env[cfg.anchor.tokenEnv]),
    startedAt: now(),
    freshQuote,
  };
}

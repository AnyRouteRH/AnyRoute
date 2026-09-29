import { readFile } from "node:fs/promises";
import type { KeyObject } from "node:crypto";
import { createAttestationProvider, type AttestationProvider, type QuoteEvidence } from "./attestation/index.ts";
import { assertModelAllowlistConfigured, enforceComposePin, enforceModelPin, hashModelPath, loadAllowlist } from "./digest.ts";
import type { SidecarConfig } from "./config.ts";
import { QuotaManager, type BucketConfig } from "./quota.ts";
import { EnclaveSigner, ReceiptIndex, ReceiptQueue } from "./receipts.ts";
import { verifyAgainstRouter } from "./router-check.ts";
import { reportData, reportDataHex, type Bindings } from "./reportdata.ts";
import { createTlsIdentity, generateTlsKey, type TlsIdentity } from "./tls.ts";
import { normalizeDigest, sha256Hex, SidecarError, stderrLogger, type Logger } from "./util.ts";

// Boot sequence. Every step that can refuse to start runs before the keys are generated and before anything
// listens, in this order (cheapest checks first):
//   1. the attestation provider is constructed (this is where the dev provider is refused)
//   2. the classifier setting is checked (no classifier ships in this version, so `enabled: true` is refused)
//   3. the allow-lists are loaded and the model allow-list must be non-empty
//   4. the weights are hashed (or a declared digest is checked against them) and must be on the allow-list
//   5. the compose hash is collected from the platform, the configuration and the compose file; they must agree;
//      when a compose allow-list is configured it must contain the hash
//   6. optionally the router's record for this provider is compared with the served model digest
//   7. the Ed25519 receipt key and the TLS key are generated, the quote is requested with report data that binds
//      them and the digests, and the certificate is issued with the quote's hash in its SAN.

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

  // 2
  if (cfg.classifier.enabled) throw new SidecarError("CLASSIFIER_UNAVAILABLE", "classifier.enabled is true but this version ships no classifier; refusing to start rather than run without one");

  // 3
  const allow = await loadAllowlist(cfg.allowlist, env);
  assertModelAllowlistConfigured(allow);

  // 4
  let model: Runtime["model"];
  const declared = cfg.model.digest ? normalizeDigest(cfg.model.digest, "model.digest") : undefined;
  if (cfg.model.path) {
    logger("info", "hashing served weights", { path: cfg.model.path });
    const h = await hashModelPath(cfg.model.path, { exclude: cfg.model.exclude, logger: (l, m, f) => l !== "info" && logger(l, m, f) });
    if (declared && declared !== h.digest) {
      throw new SidecarError("MODEL_DIGEST_MISMATCH", `model.digest ${declared} does not match the weights at model.path (${h.digest}); refusing to start`);
    }
    model = { digest: h.digest, source: "measured", files: h.files, bytes: h.bytes };
  } else {
    logger("warn", "model digest is declared, not measured: this process did not hash any weights", { digest: declared });
    model = { digest: declared!, source: "declared" };
  }
  enforceModelPin(model.digest, allow);

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
  const bindings: Bindings = {
    tlsPubkey: tlsSpkiHex,
    receiptPubkey: signer.publicKeyHex,
    imageDigest: imageDigest.value,
    composeHash: composeHash.value,
    modelDigest: model.digest,
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

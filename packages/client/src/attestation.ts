import { bytesToHex, equalBytes, hexToBytes, isHex, randomBytes } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { sha256, sha256Hex } from "./hash.js";
import { parseTdxQuote, type TdxFields } from "./tdx.js";
import type { Check, Fetch } from "./types.js";
import { parseCertificate } from "./x509.js";

// Verify-before-send. Before a request goes to an attested provider the client reads two documents and refuses unless
// they agree with each other and with the quote inside them:
//
//   1. the router's record, GET /api/v1/attestation/:providerId: has the router itself verified a quote (hardware
//      signature and certificate chain) recently, and which digests did it record;
//   2. the provider's own /attest document: a TDX quote whose report_data commits to the provider's TLS key, receipt
//      key and image / compose / model digests, and whose SHA-256 is the reference carried in its TLS certificate.
//
// The client does not repeat Intel's quote-signature check (that needs collateral from Intel's services); it says so
// in `notChecked`, and a caller who can run one passes `quoteVerifier`.

export const ATTEST_SAN_SUFFIX = "attest.anyroute";
export const attestSanFor = (ref: string) => `${ref.slice(0, 32)}.${ref.slice(32)}.${ATTEST_SAN_SUFFIX}`;

export type RouterAttestation = {
  provider: string;
  status: "attested" | "simulated" | "unverified";
  reason?: string;
  tee: string | null;
  attested_at: string | null;
  attestation_hash: string | null;
  verifiers: string[];
  measurement: null | {
    image_digest: string;
    compose_hash: string;
    model_digest: string;
    status: string;
    attested_now: boolean;
    first_attested_at: string;
    last_seen_at: string;
    transparency_log: { found: boolean; inclusion_verified: boolean; checkpoint_signature_verified: boolean; entry?: string | null; uuid?: string | null; log_index?: number | null; checked_at?: string | null; subject?: "measurement_bundle" | "image_digest" | null; entry_url?: string | null; bundle?: { digest: string; signer_key_id: string; created_at: string | null; signature_verified: boolean; url: string } | null };
    registers?: { mrtd: string; rtmr3: string } | null;
    registry: { address: string | null; state: string; tx_hash: string | null; registered_at: string | null };
  };
  checks: { quote_verified: boolean; digests_bound_to_quote: boolean; transparency_log_entry: boolean; transparency_log_checkpoint_signature: boolean; registered_on_chain: boolean };
  not_checked: string[];
};

export type Bindings = { tls_pubkey?: string; receipt_pubkey?: string; image_digest?: string; compose_hash?: string; model_digest?: string; hpke_pubkey?: string; [k: string]: unknown };

export type AttestDocument = {
  v?: number;
  type?: string;
  dev?: boolean;
  attestation_ref: string;
  attestation_san?: string | null;
  evidence: { kind: string; format: string; dev?: boolean; quote: string; report_data: string; nonce: string | null; boot?: boolean; measurements?: Record<string, string>; generated_at?: string };
  bindings: Bindings;
  report_data?: { bindings_digest?: string };
  receipt_key?: { alg?: string; key_id: string; public_key: string };
  tls?: { spki_sha256?: string } | null;
  [k: string]: unknown;
};

export type ExpectedDigests = {
  modelDigest?: string;
  imageDigest?: string;
  composeHash?: string;
  /** Hex of the 48-byte MRTD register. */
  mrtd?: string;
  rtmr3?: string;
};

/** A quote-signature check the caller can run (their own DCAP verifier, for example). Receives the quote hex. */
export type QuoteVerifier = (quoteHex: string) => Promise<{ ok: boolean; detail?: string }>;

export type BoundIdentity = {
  attestationRef: string;
  attestationSan: string;
  tlsPubkey: string;
  receiptPubkey: string;
  receiptKeyId: string | null;
  hpkePubkey: string | null;
  imageDigest: string;
  composeHash: string;
  modelDigest: string;
  measurements: Pick<TdxFields, "mrtd" | "rtmr0" | "rtmr1" | "rtmr2" | "rtmr3"> | null;
  teeKind: string | null;
};

export type ProviderVerification = {
  ok: boolean;
  providerId: string;
  /** True when the evidence is development-only. Only ever true with `allowSimulated`. */
  simulated: boolean;
  checks: Check[];
  /** Details of each failed check, for an error message. */
  failures: string[];
  /** Present when the provider's own document was read and parsed. Never trust these values unless `ok`. */
  bound: BoundIdentity | null;
  router: RouterAttestation | null;
  attestedAt: string | null;
  verifiedAt: string;
  notChecked: string[];
};

export type EvaluateInput = {
  providerId: string;
  router: RouterAttestation | null;
  boot: AttestDocument | null;
  fresh?: { doc: AttestDocument; nonceHex: string } | null;
  certificate?: Uint8Array | string | null;
};

export type EvaluateOptions = {
  expected?: ExpectedDigests;
  allowSimulated?: boolean;
  requireCertificate?: boolean;
  maxAttestationAgeMs?: number;
  quoteVerifier?: QuoteVerifier;
  now?: () => number;
};

const pass = (id: string, detail: string): Check => ({ id, status: "pass", detail });
const fail = (id: string, detail: string): Check => ({ id, status: "fail", detail });
const skip = (id: string, detail: string): Check => ({ id, status: "not_checked", detail });

const NOT_CHECKED_GENERIC = [
  "That prompts stay inside the enclave: attestation shows what software is running and on what hardware, not what it does with data.",
  "That the running software matches its published source: reproducible-build provenance is not checked here.",
];

/** `sha256:<hex>`, `0x<hex>` and bare hex all compare as the lowercase hex. */
export function digestHex(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const m = /^(?:sha256:)?(?:0x)?([0-9a-fA-F]{64})$/.exec(value.trim());
  return m ? m[1].toLowerCase() : null;
}
const same = (a?: string | null, b?: string | null) => {
  const x = digestHex(a ?? undefined);
  const y = digestHex(b ?? undefined);
  return !!x && !!y && x === y;
};

const REGISTERS = ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3"] as const;

/**
 * Pure evaluation of the two documents (and an optional certificate). No network. Every judgement is a Check; `ok` is
 * true only when nothing failed and every check this function treats as required actually passed.
 */
export async function evaluateAttestation(input: EvaluateInput, opts: EvaluateOptions = {}): Promise<ProviderVerification> {
  const now = (opts.now ?? Date.now)();
  const checks: Check[] = [];
  const required = new Set<string>();
  const need = (c: Check) => {
    required.add(c.id);
    checks.push(c);
  };
  const { router, boot } = input;

  // ---- what the router says --------------------------------------------------------------------------------------
  const routerSimulated = router?.status === "simulated" || router?.tee === "dev";
  const simOk = opts.allowSimulated === true;
  if (!router) {
    need(fail("router.status", "The router returned no attestation record for this provider."));
  } else if (router.status === "attested") {
    need(pass("router.status", "The router reports this provider as attested."));
  } else if (router.status === "simulated") {
    need(simOk ? pass("router.status", "SIMULATED: the router reports development evidence, accepted because allowSimulated was set.") : fail("router.status", "The router reports simulated (development) evidence, which proves nothing about hardware."));
  } else {
    need(fail("router.status", `The router reports this provider as unverified${router.reason ? ` (${router.reason})` : ""}.`));
  }
  if (router) {
    if (routerSimulated && simOk) checks.push(skip("router.quote_verified", "Simulated evidence has no hardware quote to verify."));
    else need(router.checks?.quote_verified === true ? pass("router.quote_verified", `The router verified the quote${router.verifiers?.length ? ` with ${router.verifiers.join(", ")}` : ""}.`) : fail("router.quote_verified", "The router has not verified a quote for this provider."));
    checks.push(
      router.checks?.digests_bound_to_quote
        ? pass("router.digests_recorded", "The router recorded the image, compose and model digests as committed inside the verified quote.")
        : skip("router.digests_recorded", "The router has not recorded the digests as bound to a verified quote. Only this client's own check of the provider's document backs them."),
    );
    const maxAge = opts.maxAttestationAgeMs ?? 3_600_000;
    const at = router.attested_at ? Date.parse(router.attested_at) : NaN;
    need(Number.isFinite(at) && now - at <= maxAge && at - now < 300_000 ? pass("router.fresh", `Verified by the router at ${router.attested_at}.`) : fail("router.fresh", `The router's verification is missing or older than ${Math.round(maxAge / 60000)} minutes.`));
  }

  // ---- what the provider's own document proves -------------------------------------------------------------------
  let bound: BoundIdentity | null = null;
  let simulated = routerSimulated;
  if (!boot) {
    need(fail("provider.document", "The provider's /attest document was not read."));
  } else {
    const ev = boot.evidence;
    const devDoc = boot.dev === true || ev?.dev === true || ev?.kind === "dev" || ev?.format === "dev-simulated";
    simulated = simulated || devDoc;
    if (devDoc || routerSimulated) {
      need(opts.allowSimulated ? pass("provider.simulated", "SIMULATED evidence accepted because allowSimulated was set. No hardware is behind it.") : fail("provider.simulated", "The evidence is simulated (development only). It proves nothing about hardware and is refused."));
    } else {
      need(pass("provider.simulated", "The evidence is not marked as simulated."));
    }

    const b = boot.bindings ?? {};
    const ref = String(boot.attestation_ref ?? "").toLowerCase();
    const bindingsOk = isHex(b.tls_pubkey) && isHex(b.receipt_pubkey, 32) && !!digestHex(b.image_digest) && !!digestHex(b.compose_hash) && !!digestHex(b.model_digest) && (b.hpke_pubkey === undefined || isHex(b.hpke_pubkey));
    need(bindingsOk ? pass("provider.bindings", "The document names a TLS key, a receipt key and image, compose and model digests.") : fail("provider.bindings", "The bindings are missing a TLS key, a receipt key or a valid image, compose or model digest."));

    let fields: TdxFields | null = null;
    let quoteBytes: Uint8Array | null = null;
    if (ev?.format === "tdx-quote-v4" && typeof ev.quote === "string") {
      try {
        quoteBytes = hexToBytes(ev.quote);
        fields = parseTdxQuote(quoteBytes);
      } catch (e) {
        need(fail("provider.quote", `The quote cannot be read: ${(e as Error).message}`));
      }
      if (fields) need(pass("provider.quote", "The quote parses as an Intel TDX version 4 quote."));
    } else if (devDoc) {
      checks.push(skip("provider.quote", "Simulated evidence carries no hardware quote."));
    } else {
      need(fail("provider.quote", `Unsupported evidence format ${String(ev?.format)}.`));
    }

    // The reference in the certificate SAN is the SHA-256 of the boot quote.
    if (quoteBytes && ev.boot !== false && ev.nonce == null) {
      const h = await sha256Hex(quoteBytes);
      need(h === ref ? pass("provider.ref_is_quote_hash", "attestation_ref equals SHA-256 of the quote.") : fail("provider.ref_is_quote_hash", "attestation_ref is not the SHA-256 of the quote in the document."));
    } else if (devDoc) {
      checks.push(skip("provider.ref_is_quote_hash", "Not applicable to simulated evidence."));
    } else {
      need(fail("provider.ref_is_quote_hash", "The document is not the boot quote, so its hash cannot be compared with the reference."));
    }
    const expectedSan = /^[0-9a-f]{64}$/.test(ref) ? attestSanFor(ref) : null;
    need(expectedSan && boot.attestation_san === expectedSan ? pass("provider.san_is_ref", `The certificate name is ${expectedSan}.`) : fail("provider.san_is_ref", "attestation_san is not derived from attestation_ref."));

    // report_data = sha256(canonical_json(bindings)) || nonce
    if (fields) {
      const digest = bytesToHex(await sha256(canonicalJson(b)));
      const zeroNonce = "0".repeat(64);
      const okData = fields.reportData === digest + zeroNonce;
      need(okData ? pass("provider.report_data", "The quote's report_data is SHA-256(bindings) followed by a zero nonce: the TLS key, receipt key and digests are committed in the quote.") : fail("provider.report_data", "The quote's report_data does not commit to these bindings."));
      // Registers the document claims must be the quote's own.
      const claimed = ev.measurements ?? {};
      const mism = REGISTERS.filter((r) => claimed[r] !== undefined && claimed[r] !== fields![r]);
      need(mism.length === 0 && REGISTERS.every((r) => claimed[r] !== undefined) ? pass("provider.measurements", "The measurement registers in the document are the ones inside the quote.") : fail("provider.measurements", mism.length ? `Registers differ from the quote: ${mism.join(", ")}.` : "The document does not list the quote's measurement registers."));
    } else if (devDoc) {
      checks.push(skip("provider.report_data", "Not applicable to simulated evidence."));
    }

    if (bindingsOk) {
      const rk = boot.receipt_key;
      const hpke = typeof b.hpke_pubkey === "string" ? b.hpke_pubkey.replace(/^0x/i, "").toLowerCase() : null;
      bound = {
        attestationRef: ref,
        attestationSan: boot.attestation_san ?? "",
        tlsPubkey: b.tls_pubkey!.toLowerCase(),
        receiptPubkey: b.receipt_pubkey!.toLowerCase(),
        receiptKeyId: rk?.key_id ?? null,
        hpkePubkey: hpke,
        imageDigest: "sha256:" + digestHex(b.image_digest),
        composeHash: "sha256:" + digestHex(b.compose_hash),
        modelDigest: "sha256:" + digestHex(b.model_digest),
        measurements: fields ? { mrtd: fields.mrtd, rtmr0: fields.rtmr0, rtmr1: fields.rtmr1, rtmr2: fields.rtmr2, rtmr3: fields.rtmr3 } : null,
        teeKind: ev?.kind ?? null,
      };
      if (rk) {
        const consistent = rk.public_key?.toLowerCase() === bound.receiptPubkey;
        need(consistent ? pass("provider.receipt_key", `Receipts from this provider are signed by key ${rk.key_id}, which the quote commits to.`) : fail("provider.receipt_key", "The receipt key in the document is not the one committed in the bindings."));
      } else {
        need(fail("provider.receipt_key", "The document does not state its receipt key."));
      }
    }

    // ---- a fresh quote for a nonce we chose (proves the enclave is live now) -----------------------------------
    if (input.fresh) {
      const { doc: f, nonceHex } = input.fresh;
      const fq = f.evidence?.format === "tdx-quote-v4" ? safe(() => parseTdxQuote(hexToBytes(f.evidence.quote))) : null;
      const digest = bytesToHex(await sha256(canonicalJson(f.bindings ?? {})));
      const sameBindings = canonicalJson(f.bindings ?? {}) === canonicalJson(b) && f.attestation_ref === boot.attestation_ref;
      const echoed = f.evidence?.nonce != null && f.evidence.nonce.replace(/^0x/, "").toLowerCase() === nonceHex.toLowerCase();
      const sameRegs = !!fq && !!fields && REGISTERS.every((r) => fq[r] === fields![r]);
      const rd = !!fq && fq.reportData === digest + nonceHex.toLowerCase();
      need(
        echoed && rd && sameBindings && sameRegs
          ? pass("provider.fresh_quote", "A fresh quote bound to a nonce chosen by this client carries the same bindings and measurements as the boot quote.")
          : fail("provider.fresh_quote", "The fresh quote does not bind our nonce, or differs from the boot quote in its bindings or measurements."),
      );
    } else {
      checks.push(skip("provider.fresh_quote", "No fresh nonce quote was requested; only the boot quote was read."));
    }
  }

  // ---- TLS certificate ---------------------------------------------------------------------------------------------
  if (input.certificate) {
    try {
      const cert = parseCertificate(input.certificate);
      const wantSan = bound?.attestationSan || (boot ? String(boot.attestation_san ?? "") : "");
      const names = cert.dnsNames.map((n) => n.toLowerCase());
      need(wantSan && names.includes(wantSan.toLowerCase()) ? pass("provider.tls_san", "The connection's certificate carries the attestation name, so it belongs to the attested instance.") : fail("provider.tls_san", "The certificate does not carry the attestation name derived from the quote's hash: this transport is not bound to the quote."));
      need(bound && bytesToHex(cert.spki) === bound.tlsPubkey ? pass("provider.tls_key", "The certificate's public key is the TLS key committed in the quote.") : fail("provider.tls_key", "The certificate's public key is not the TLS key committed in the quote."));
      const t = now;
      need(t >= cert.notBefore.getTime() - 300_000 && t <= cert.notAfter.getTime() ? pass("provider.tls_valid", "The certificate is inside its validity period.") : fail("provider.tls_valid", "The certificate is outside its validity period."));
    } catch (e) {
      need(fail("provider.tls_san", `The certificate cannot be read: ${(e as Error).message}`));
    }
  } else if (opts.requireCertificate) {
    need(fail("provider.tls_san", "A certificate was required but none was available, so the transport is not bound to the quote."));
  } else {
    checks.push(skip("provider.tls_san", "No connection certificate was available (browsers cannot read it), so the transport is not checked against the quote."));
  }

  // ---- agreement between the router's record and the provider's document -------------------------------------------
  if (router?.measurement && bound) {
    const m = router.measurement;
    const mism = [
      !same(m.image_digest, bound.imageDigest) && "image",
      !same(m.compose_hash, bound.composeHash) && "compose",
      !same(m.model_digest, bound.modelDigest) && "model",
    ].filter(Boolean);
    need(mism.length === 0 ? pass("router.matches_provider", "The router's recorded digests equal the provider's bound digests.") : fail("router.matches_provider", `The router's recorded ${mism.join(", ")} digest differs from what the provider's quote commits to.`));
  } else {
    checks.push(skip("router.matches_provider", "The router has no measurement recorded to compare with."));
  }

  // ---- what the caller expects -------------------------------------------------------------------------------------
  const ex = opts.expected ?? {};
  const expect = (id: string, label: string, want: string | undefined, got: string | undefined, cmp: (a: string, b: string) => boolean) => {
    if (want === undefined) return checks.push(skip(id, `No expected ${label} supplied.`));
    if (!got) return need(fail(id, `The provider's ${label} is unknown, so it cannot match the one you expect.`));
    return need(cmp(want, got) ? pass(id, `The ${label} equals the one you expect.`) : fail(id, `The provider's ${label} is not the one you expect.`));
  };
  expect("expected.model", "model digest", ex.modelDigest, bound?.modelDigest, same);
  expect("expected.image", "image digest", ex.imageDigest, bound?.imageDigest, same);
  expect("expected.compose", "compose hash", ex.composeHash, bound?.composeHash, same);
  const hexEq = (a: string, b: string) => a.replace(/^0x/, "").toLowerCase() === b.toLowerCase();
  expect("expected.mrtd", "MRTD register", ex.mrtd, bound?.measurements?.mrtd, hexEq);
  expect("expected.rtmr3", "RTMR3 register", ex.rtmr3, bound?.measurements?.rtmr3, hexEq);

  // ---- the hardware signature --------------------------------------------------------------------------------------
  if (opts.quoteVerifier && boot?.evidence?.quote && !simulated) {
    try {
      const r = await opts.quoteVerifier(boot.evidence.quote);
      need(r.ok ? pass("quote.signature", r.detail ?? "The supplied quote verifier accepted the quote.") : fail("quote.signature", r.detail ?? "The supplied quote verifier rejected the quote."));
    } catch (e) {
      need(fail("quote.signature", `The quote verifier failed: ${(e as Error).message}`));
    }
  } else {
    checks.push(skip("quote.signature", "This client does not check Intel's signature and certificate chain over the quote; it relies on the router's verification (router.quote_verified). Pass quoteVerifier to check it yourself."));
  }

  const failures = checks.filter((c) => c.status === "fail").map((c) => c.detail);
  const allRequired = [...required].every((id) => checks.some((c) => c.id === id && c.status === "pass"));
  return {
    ok: failures.length === 0 && allRequired && (!simulated || opts.allowSimulated === true),
    providerId: input.providerId,
    simulated,
    checks,
    failures,
    bound,
    router,
    attestedAt: router?.attested_at ?? null,
    verifiedAt: new Date(now).toISOString(),
    notChecked: [
      ...(router?.not_checked ?? NOT_CHECKED_GENERIC),
      ...(opts.expected?.modelDigest === undefined ? ["That the model digest is the model you wanted: no expected digest was supplied, so the bound digest is reported but not compared."] : []),
      ...(opts.quoteVerifier ? [] : ["Intel's signature and certificate chain over the quote: this client relies on the router's verification."]),
    ],
  };
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Fetches one document; a runtime that can read the connection's certificate returns it too (see @anyroute/client/node). */
export type AttestFetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ json: unknown; certificate?: Uint8Array | null }>;

export const defaultAttestFetcher =
  (fetchImpl: Fetch = fetch): AttestFetcher =>
  async (url, init) => {
    const res = await fetchImpl(url, { signal: init?.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
    return { json: await res.json() };
  };

export type VerifyProviderOptions = EvaluateOptions & {
  routerUrl: string;
  providerId: string;
  /** The provider's /attest URL, or its base URL. Without it only the router's record can be read, which is never enough to send. */
  attestUrl?: string;
  fetch?: Fetch;
  attestFetcher?: AttestFetcher;
  /** Also request /attest?nonce=<random> to prove the enclave is live now. Default true. */
  freshNonce?: boolean;
  /** Replay a recorded exchange by fixing the nonce (64 hex characters). Leave unset: a reused nonce proves nothing about liveness. */
  nonceHex?: string;
  /** A certificate (PEM or DER) to check when the runtime cannot read it from the connection. */
  certificate?: Uint8Array | string;
  signal?: AbortSignal;
};

export async function fetchRouterAttestation(routerUrl: string, providerId: string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<RouterAttestation | null> {
  const res = await fetchImpl(`${routerUrl.replace(/\/$/, "")}/api/v1/attestation/${encodeURIComponent(providerId)}`, { signal, headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/v1/attestation/${providerId} failed with ${res.status}`);
  return ((await res.json()) as { data: RouterAttestation }).data;
}

const attestBase = (u: string) => u.replace(/\/attest\/?(\?.*)?$/, "").replace(/\/$/, "");

/** Fetch both documents and evaluate them. Never throws for a bad provider: the result says `ok: false` and why. */
export async function verifyProvider(o: VerifyProviderOptions): Promise<ProviderVerification> {
  const fetchImpl = o.fetch ?? fetch;
  let router: RouterAttestation | null = null;
  try {
    router = await fetchRouterAttestation(o.routerUrl, o.providerId, fetchImpl, o.signal);
  } catch (e) {
    return unreachable(o, `The router's attestation record could not be read: ${(e as Error).message}`);
  }
  let boot: AttestDocument | null = null;
  let fresh: EvaluateInput["fresh"] = null;
  let certificate: Uint8Array | string | null = o.certificate ?? null;
  if (o.attestUrl) {
    const base = attestBase(o.attestUrl);
    const get = o.attestFetcher ?? defaultAttestFetcher(fetchImpl);
    try {
      const r = await get(`${base}/attest`, { signal: o.signal });
      boot = r.json as AttestDocument;
      if (r.certificate) certificate = r.certificate;
      if (o.freshNonce !== false) {
        const nonceHex = o.nonceHex ?? bytesToHex(randomBytes(32));
        const f = await get(`${base}/attest?nonce=${nonceHex}`, { signal: o.signal });
        fresh = { doc: f.json as AttestDocument, nonceHex };
        // Both documents must have come over a connection with the same certificate.
        if (r.certificate && f.certificate && !equalBytes(r.certificate, f.certificate)) return unreachable(o, "The provider presented different certificates for the boot and fresh documents.", router, boot);
      }
    } catch (e) {
      return unreachable(o, `The provider's /attest could not be read: ${(e as Error).message}`, router, boot);
    }
  }
  return evaluateAttestation({ providerId: o.providerId, router, boot, fresh, certificate }, o);
}

async function unreachable(o: VerifyProviderOptions, why: string, router: RouterAttestation | null = null, boot: AttestDocument | null = null): Promise<ProviderVerification> {
  const r = await evaluateAttestation({ providerId: o.providerId, router, boot }, o);
  const checks = [...r.checks, fail("fetch", why)];
  return { ...r, ok: false, checks, failures: [...r.failures, why] };
}

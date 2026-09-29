import { X509Certificate, constants, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { boundedJson } from "../providers/network.ts";
import type { Config } from "../config.ts";

// Pluggable quote verifiers for the attestor. Which ones run is ATTESTATION_VERIFIERS (default: dcap, the
// generic DCAP verification service the router has always used). Every configured verifier must accept a
// quote; each one only ever ADDS a requirement, so enabling another can make attestation stricter, never looser.
//
//   dcap      POST {quote} to TDX_VERIFIER_URL; accepts verified=true or an acceptable TCB status.
//   intel-ta  Intel Trust Authority: POST the quote, receive a signed JWT, verify its signature against the
//             service's published JWKS, then read the appraisal claims.
//   dstack    A dstack verifier service (POST {quote, event_log, vm_config}); also yields the compose hash the
//             verified event log recorded, which the attestor compares with the compose hash the report claims.
//   phala     Phala Cloud's public quote verifier (POST {hex} to PHALA_VERIFIER_URL). It checks the quote's
//             signature and certificate chain; its answer names the registers and report_data it verified, which
//             must be this quote's. On dstack the quote's MRCONFIGID is 0x01 || compose hash, which is returned as
//             the compose hash. It reports no TCB status, so list dcap or intel-ta as well to enforce one.
//
// Every verifier also cross-checks any measurements it reports against the registers parsed locally from the
// quote, so a verifier cannot vouch for a different quote than the one presented. None of them can prove the
// digests a provider claims; that binding is checked by the attestor against the quote's report_data.

export type VerifierName = "dcap" | "intel-ta" | "dstack" | "phala";
export type FetchFn = typeof fetch;

export type QuoteRegisters = { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string; reportData: string };

export type VerifierInput = {
  kind: "tdx" | "snp";
  /** Hex of the quote or SEV-SNP report, no 0x prefix. */
  quoteHex: string;
  /** Registers parsed locally from a TDX quote (null for SNP). */
  registers: QuoteRegisters | null;
  /** dstack event log (a JSON string) and VM config, when the report carries them. */
  eventLog?: string | null;
  vmConfig?: string | null;
};

export type VerifierResult = {
  ok: boolean;
  reason?: string;
  /** TCB status or similar, as the verifier reported it. */
  status?: string;
  /** Compose hash (lowercase hex, no prefix) recovered from evidence the verifier itself validated. */
  composeHash?: string;
};

export interface QuoteVerifier {
  readonly name: VerifierName;
  verify(input: VerifierInput): Promise<VerifierResult>;
}

export type AttestationVerifierConfig = Pick<Config["attestation"], "verifiers" | "tdxVerifierUrl" | "tdxVerifierKey" | "intelTa" | "dstackVerifierUrl" | "dstackVerifierKey"> & { phalaVerifierUrl?: string };

const ACCEPTED_TCB = new Set(["UpToDate", "SWHardeningNeeded"]);
const REGISTER_KEYS = ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3"] as const;
const strip0x = (s: string) => s.replace(/^0x/i, "").toLowerCase();

/** Compare registers a verifier reported with those parsed from the quote; returns the first mismatch. */
function registerMismatch(reported: Record<string, unknown> | undefined, local: QuoteRegisters | null): string | null {
  if (!reported || !local) return null;
  for (const k of REGISTER_KEYS) {
    const v = reported[k] ?? reported[`tdx_${k}`];
    if (typeof v === "string" && v && strip0x(v) !== local[k]) return `${k} reported by the verifier does not match the quote`;
  }
  return null;
}

class DcapVerifier implements QuoteVerifier {
  readonly name = "dcap" as const;
  constructor(private cfg: AttestationVerifierConfig, private fetchImpl: FetchFn) {}
  async verify(input: VerifierInput): Promise<VerifierResult> {
    if (!this.cfg.tdxVerifierUrl) return { ok: false, reason: "no DCAP verifier configured (TDX_VERIFIER_URL)" };
    const res = await this.fetchImpl(this.cfg.tdxVerifierUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", ...(this.cfg.tdxVerifierKey ? { authorization: `Bearer ${this.cfg.tdxVerifierKey}` } : {}) },
      body: JSON.stringify({ quote: input.quoteHex.replace(/^0x/, "") }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, reason: `verifier HTTP ${res.status}` };
    const j = (await boundedJson(res)) as { verified?: boolean; status?: string; tcb_status?: string };
    const status = j.tcb_status ?? j.status;
    const ok = j.verified === true || status === "UpToDate" || status === "SWHardeningNeeded";
    return { ok, reason: ok ? undefined : `quote not verified (${status ?? "unknown"})`, status };
  }
}

// ---- Intel Trust Authority ---------------------------------------------------------------------------

type Jwk = { kty?: string; kid?: string; n?: string; e?: string; alg?: string; x5c?: string[] };
const JWT_ALGS: Record<string, { hash: string; pss: boolean }> = {
  RS256: { hash: "sha256", pss: false },
  RS384: { hash: "sha384", pss: false },
  RS512: { hash: "sha512", pss: false },
  PS256: { hash: "sha256", pss: true },
  PS384: { hash: "sha384", pss: true },
  PS512: { hash: "sha512", pss: true },
};

function keyOf(k: Jwk): KeyObject | null {
  try {
    if (k.n && k.e) return createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" });
    if (k.x5c?.[0]) return new X509Certificate(Buffer.from(k.x5c[0], "base64")).publicKey;
  } catch {
    /* unusable key */
  }
  return null;
}

/** Verify an RSA-signed (RS or PS family) JWT against a JWKS and its time claims. Never accepts "none" or an HMAC algorithm. */
export function verifyJwt(token: string, jwks: { keys?: Jwk[] }, nowMs = Date.now()): { ok: true; claims: Record<string, any> } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: "malformed token" };
  let header: { alg?: string; kid?: string };
  let claims: Record<string, any>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed token" };
  }
  const alg = header.alg ? JWT_ALGS[header.alg] : undefined;
  if (!alg) return { ok: false, reason: `unsupported token algorithm (${String(header.alg)})` };
  const candidates = (jwks.keys ?? []).filter((k) => (header.kid ? k.kid === header.kid : true) && (!k.kty || k.kty === "RSA"));
  if (!candidates.length) return { ok: false, reason: "no matching signing key in the JWKS" };
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], "base64url");
  let signed = false;
  for (const k of candidates) {
    const key = keyOf(k);
    if (!key) continue;
    try {
      const opts = alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : key;
      if (cryptoVerify(alg.hash, data, opts as never, sig)) {
        signed = true;
        break;
      }
    } catch {
      /* try the next key */
    }
  }
  if (!signed) return { ok: false, reason: "token signature does not verify" };
  const now = Math.floor(nowMs / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "token expired or has no expiry" };
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return { ok: false, reason: "token not yet valid" };
  return { ok: true, claims };
}

class IntelTrustAuthorityVerifier implements QuoteVerifier {
  readonly name = "intel-ta" as const;
  constructor(private cfg: AttestationVerifierConfig["intelTa"], private fetchImpl: FetchFn, private nowMs: () => number) {}
  async verify(input: VerifierInput): Promise<VerifierResult> {
    if (input.kind !== "tdx") return { ok: false, reason: "intel-ta verifies TDX quotes only" };
    if (!this.cfg.apiKey) return { ok: false, reason: "no Intel Trust Authority key configured (INTEL_TA_API_KEY)" };
    const res = await this.fetchImpl(this.cfg.url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": this.cfg.apiKey },
      body: JSON.stringify({ tdx: { quote: Buffer.from(input.quoteHex.replace(/^0x/, ""), "hex").toString("base64") } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, reason: `Intel Trust Authority HTTP ${res.status}` };
    const token = ((await boundedJson(res)) as { token?: unknown }).token;
    if (typeof token !== "string") return { ok: false, reason: "Intel Trust Authority returned no token" };
    const keysRes = await this.fetchImpl(this.cfg.jwksUrl, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!keysRes.ok) return { ok: false, reason: `Intel Trust Authority key set HTTP ${keysRes.status}` };
    const jwt = verifyJwt(token, (await boundedJson(keysRes)) as { keys?: Jwk[] }, this.nowMs());
    if (!jwt.ok) return { ok: false, reason: `Intel Trust Authority token rejected: ${jwt.reason}` };
    // Appraisal claims sit at the top level of the token or under a "tdx" object, depending on the API version.
    const c = { ...jwt.claims, ...(jwt.claims.tdx && typeof jwt.claims.tdx === "object" ? jwt.claims.tdx : {}) } as Record<string, any>;
    if (c.attester_type && String(c.attester_type).toUpperCase() !== "TDX") return { ok: false, reason: "token appraises a non-TDX attester" };
    const status = String(c.attester_tcb_status ?? "");
    if (!ACCEPTED_TCB.has(status)) return { ok: false, reason: `quote not verified (${status || "no TCB status"})` };
    if (c.tdx_is_debuggable === true) return { ok: false, reason: "TD is debuggable" };
    const mismatch = registerMismatch(c, input.registers);
    if (mismatch) return { ok: false, reason: mismatch };
    if (typeof c.tdx_report_data === "string" && input.registers) {
      const rd = /^(?:0x)?[0-9a-fA-F]{128}$/.test(c.tdx_report_data) ? strip0x(c.tdx_report_data) : Buffer.from(c.tdx_report_data, "base64").toString("hex");
      if (rd !== input.registers.reportData) return { ok: false, reason: "report_data reported by the verifier does not match the quote" };
    }
    return { ok: true, status };
  }
}

// ---- dstack ------------------------------------------------------------------------------------------

/** The compose hash a dstack event log recorded into RTMR3 (event "compose-hash"), lowercase hex. */
export function composeHashFromEventLog(eventLog: string | null | undefined): string | undefined {
  if (!eventLog) return undefined;
  try {
    const events = JSON.parse(eventLog) as { imr?: number; event?: string; event_payload?: string }[];
    const hit = Array.isArray(events) ? events.find((ev) => ev?.imr === 3 && ev.event === "compose-hash" && typeof ev.event_payload === "string") : undefined;
    return hit && /^[0-9a-fA-F]{64}$/.test(hit.event_payload!) ? hit.event_payload!.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

class DstackVerifier implements QuoteVerifier {
  readonly name = "dstack" as const;
  constructor(private url: string | undefined, private key: string | undefined, private fetchImpl: FetchFn) {}
  async verify(input: VerifierInput): Promise<VerifierResult> {
    if (input.kind !== "tdx") return { ok: false, reason: "dstack verifies TDX quotes only" };
    if (!this.url) return { ok: false, reason: "no dstack verifier configured (DSTACK_VERIFIER_URL)" };
    if (!input.eventLog) return { ok: false, reason: "report carries no dstack event log" };
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ quote: input.quoteHex.replace(/^0x/, ""), event_log: input.eventLog, ...(input.vmConfig ? { vm_config: input.vmConfig } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, reason: `dstack verifier HTTP ${res.status}` };
    const j = (await boundedJson(res)) as { is_valid?: boolean; reason?: string; details?: Record<string, any> };
    const d = j.details ?? {};
    if (j.is_valid !== true) return { ok: false, reason: `quote not verified (${String(j.reason ?? "invalid").slice(0, 120)})` };
    if (d.quote_verified === false || d.event_log_verified === false) return { ok: false, reason: "quote or event log not verified by the dstack verifier" };
    const tcb = (d.tcb_info && typeof d.tcb_info === "object" ? d.tcb_info : {}) as Record<string, any>;
    const mismatch = registerMismatch(tcb, input.registers);
    if (mismatch) return { ok: false, reason: mismatch };
    const reported = tcb.compose_hash ?? d.app_info?.compose_hash ?? d.compose_hash;
    const composeHash = typeof reported === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/.test(reported) ? strip0x(reported) : d.event_log_verified === true ? composeHashFromEventLog(input.eventLog) : undefined;
    return { ok: true, status: "verified", composeHash };
  }
}

// ---- Phala public verifier ------------------------------------------------------------------------

/** TD report body fields read straight from the quote bytes (the header is 48 bytes). */
function tdBodyField(quoteHex: string, offset: number, length: number): Buffer | null {
  const b = Buffer.from(quoteHex.replace(/^0x/, ""), "hex");
  return b.length >= 48 + offset + length ? b.subarray(48 + offset, 48 + offset + length) : null;
}

/** The compose hash a dstack host puts in MRCONFIGID (0x01 || sha256 || zero padding), lowercase hex. */
export function composeHashFromMrConfigId(mrConfigIdHex: string | null | undefined): string | undefined {
  const m = /^01([0-9a-f]{64})0{30}$/.exec(strip0x(mrConfigIdHex ?? ""));
  return m ? m[1] : undefined;
}

class PhalaPublicVerifier implements QuoteVerifier {
  readonly name = "phala" as const;
  constructor(private url: string | undefined, private fetchImpl: FetchFn) {}
  async verify(input: VerifierInput): Promise<VerifierResult> {
    if (input.kind !== "tdx") return { ok: false, reason: "phala verifies TDX quotes only" };
    if (!this.url) return { ok: false, reason: "no Phala verifier configured (PHALA_VERIFIER_URL)" };
    const quoteHex = input.quoteHex.replace(/^0x/, "").toLowerCase();
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ hex: quoteHex }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, reason: `Phala verifier HTTP ${res.status}` };
    const j = (await boundedJson(res, 4 * 1024 * 1024)) as { quote?: { verified?: unknown; header?: Record<string, unknown>; body?: Record<string, unknown> } };
    const q = j.quote ?? {};
    if (q.verified !== true) return { ok: false, reason: "quote not verified (Phala verifier)" };
    if (q.header?.tee_type !== undefined && q.header.tee_type !== "TEE_TDX") return { ok: false, reason: "Phala verifier did not appraise a TDX quote" };
    const body = (q.body ?? {}) as Record<string, unknown>;
    // The answer must describe this quote: every register it reports, and its report_data, must match.
    if (!input.registers || typeof body.mrtd !== "string" || typeof body.reportdata !== "string") return { ok: false, reason: "Phala verifier did not report the quote's registers" };
    const mismatch = registerMismatch(body, input.registers);
    if (mismatch) return { ok: false, reason: mismatch };
    if (strip0x(body.reportdata) !== input.registers.reportData) return { ok: false, reason: "report_data reported by the verifier does not match the quote" };
    // TDATTRIBUTES bit 0 is DEBUG; a debuggable TD's memory is readable by the host.
    const attributes = tdBodyField(quoteHex, 120, 8);
    if (!attributes || (attributes[0] & 1) === 1) return { ok: false, reason: "TD is debuggable" };
    const mrConfigId = tdBodyField(quoteHex, 184, 48)?.toString("hex");
    const reported = typeof body.mr_config_id === "string" ? strip0x(body.mr_config_id) : undefined;
    if (reported !== undefined && reported !== mrConfigId) return { ok: false, reason: "mr_config_id reported by the verifier does not match the quote" };
    return { ok: true, status: "verified", composeHash: composeHashFromMrConfigId(mrConfigId) };
  }
}

export function createVerifiers(cfg: AttestationVerifierConfig, fetchImpl: FetchFn = fetch, nowMs: () => number = Date.now): QuoteVerifier[] {
  return cfg.verifiers.map((name) => {
    if (name === "intel-ta") return new IntelTrustAuthorityVerifier(cfg.intelTa, fetchImpl, nowMs);
    if (name === "dstack") return new DstackVerifier(cfg.dstackVerifierUrl, cfg.dstackVerifierKey, fetchImpl);
    if (name === "phala") return new PhalaPublicVerifier(cfg.phalaVerifierUrl, fetchImpl);
    return new DcapVerifier(cfg, fetchImpl);
  });
}

/** True when every configured verifier has the endpoint it needs (readiness check). */
export function verifiersConfigured(cfg: AttestationVerifierConfig): boolean {
  const http = (v: string | undefined) => {
    if (!v) return false;
    try {
      return ["http:", "https:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  };
  return cfg.verifiers.every((n) => (n === "dcap" ? http(cfg.tdxVerifierUrl) : n === "dstack" ? http(cfg.dstackVerifierUrl) : n === "phala" ? http(cfg.phalaVerifierUrl) : !!cfg.intelTa.apiKey && http(cfg.intelTa.url) && http(cfg.intelTa.jwksUrl)));
}

export type VerifyOutcome = { ok: boolean; reason?: string; status?: string; verifiers: string[]; composeHash?: string };

/** Run every verifier; the first rejection wins. A compose hash two verifiers disagree on rejects the quote.
 *  Network failures propagate (the attestor job logs them and the provider's attestation ages out). */
export async function verifyWithAll(verifiers: QuoteVerifier[], input: VerifierInput): Promise<VerifyOutcome> {
  let status: string | undefined;
  let composeHash: string | undefined;
  const names: string[] = [];
  for (const v of verifiers) {
    // A verifier that cannot be reached throws, as the single DCAP verifier always has; the attestor job logs it.
    const r = await v.verify(input);
    if (!r.ok) return { ok: false, reason: r.reason ?? `${v.name} rejected the quote`, status: r.status, verifiers: names };
    names.push(v.name);
    status ??= r.status;
    if (r.composeHash) {
      if (composeHash && composeHash !== r.composeHash) return { ok: false, reason: "verifiers disagree on the compose hash", verifiers: names };
      composeHash = r.composeHash;
    }
  }
  return { ok: true, status, verifiers: names, composeHash };
}

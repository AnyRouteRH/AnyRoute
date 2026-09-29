import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { eq, like } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { kv } from "../db/schema.ts";
import { inferredVariant } from "../router/lane.ts";
import { boundedJson, providerFetch } from "./network.ts";
import type { TlsPin } from "./tls-pin.ts";

// Attested inference gateways that speak the "aci/1" protocol: an OpenAI-compatible API run inside an Intel TDX
// confidential VM, which publishes a workload keyset (receipt signing keys, request-encryption keys, TLS key pins)
// bound into its quote, signs a receipt for every response, and records in that receipt whether the upstream that
// generated the answer was itself verified inside a TEE.
//
// Two halves:
//   the gateway, attested by the attestor (services/attestor.ts): GET <attestation_url>?nonce=<64 hex>, then
//     1. api_version "aci/1", tee_type "tdx"
//     2. workload_keyset_digest = "sha256:" || sha256(JCS(workload_keyset)), recomputed from the served keyset
//     3. report_data = sha256('{"keyset_digest":"<digest>","nonce":"<nonce>","purpose":"aci.report_data.v1"}'),
//        and the quote's 64-byte report_data field is those 32 bytes followed by 32 zero bytes
//     4. the quote verifies (the router's configured quote verifiers), is not debuggable, and its registers match
//     5. the dstack event log replays to the quote's RTMR3, every RTMR3 event digest matches its payload, and the
//        measured compose hash is sha256 of the served app_compose
//     6. the keyset has not expired (not_after) and, when the report carries freshness.stale_after, neither has it
//     7. over https: the certificate the endpoint presents has a SubjectPublicKeyInfo whose sha256 the keyset lists
//        for that host; from then on the provider's connections accept only that key (providers/tls-pin.ts)
//   each response, checked here: the receipt the gateway names in `x-receipt-id` (GET <base>/aci/receipts/<id>)
//     - is Ed25519-signed over JCS(receipt without `signature`) by a receipt key of the attested keyset
//     - names the attested keyset digest (and workload id, when both carry one)
//     - commits to the exact request bytes the router sent (request.received) and, when the router saw the whole
//       response, the exact response bytes (response.returned)
//     - records upstream.verified: result "verified", required true, and the upstream's typed claims, from the
//       receipt or from the content-addressed session it cites
//
// Not checked: a `keyset_endorsement` has no signing input defined for aci/1 as served, so it is recorded as
// present and not verified. The gateway's source provenance is recorded, not appraised: which release is acceptable
// is the operator's MRTD / RTMR3 allow-list.

export const ACI_VERSION = "aci/1";
const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

// ---- Canonical bytes and digests ----------------------------------------------------------------------------

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sorted(src[k]);
    return out;
  }
  return v;
}

/** RFC 8785 (JCS) form of an aci/1 artifact: ASCII member names and integer numbers, sorted, no whitespace. */
export const jcs = (v: unknown): string => JSON.stringify(sorted(v));
const sha256Hex = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const sha384 = (b: Uint8Array) => createHash("sha384").update(b).digest();
/** "sha256:<hex>" of raw bytes: the form aci/1 body hashes, keyset digests and evidence digests use. */
export const bodyHash = (b: string | Uint8Array) => "sha256:" + sha256Hex(b);
export const keysetDigest = (keyset: unknown) => bodyHash(jcs(keyset));

/** The 32-byte report_data (hex) a gateway's quote must carry for this keyset digest and nonce (null: none sent). */
export function aciReportData(digest: string, nonce: string | null): string {
  if (!DIGEST.test(digest)) throw new Error("keyset digest is not sha256:<64 hex>");
  if (nonce !== null && !HEX64.test(nonce)) throw new Error("nonce must be 64 lowercase hex characters");
  return sha256Hex(`{"keyset_digest":"${digest}","nonce":${nonce === null ? "null" : `"${nonce}"`},"purpose":"aci.report_data.v1"}`);
}

// ---- The gateway ----------------------------------------------------------------------------------------------

export type AciKey = { key_id: string; algo: "ed25519"; public_key: string };

/** What the attestor established about a gateway. Stored per provider; every receipt is checked against it. */
export type AciGateway = {
  v: 1;
  keysetDigest: string;
  workloadId: string | null;
  receiptKeys: AciKey[];
  /** sha256 of the SubjectPublicKeyInfo the keyset lists for the endpoint's host. */
  tlsSpki: string[];
  notAfter: number;
  staleAfter: number | null;
  serving: string | null;
  sourceProvenance: { repo_url: string | null; repo_commit: string | null; image_digest: string | null } | null;
  composeHash: string | null;
  osImageHash: string | null;
  appId: string | null;
  keysetEndorsement: "absent" | "present_not_verified";
  attestedAt: string;
};

export type AciReportCheck =
  | { ok: true; gateway: AciGateway; quoteHex: string; eventLog: string | null; vmConfig: string | null }
  | { ok: false; reason: string };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const lowerHex = (v: unknown) => (typeof v === "string" && HEX64.test(v.toLowerCase()) ? v.toLowerCase() : null);

/** A report is an aci/1 gateway report when it says so; anything else is left to the other attestation paths. */
export const isAciReport = (r: unknown): r is Record<string, any> => !!r && typeof r === "object" && (r as Record<string, unknown>).api_version === ACI_VERSION && typeof (r as Record<string, unknown>).attestation === "object";

type DstackEvent = { imr?: number; event_type?: number; digest?: string; event?: string; event_payload?: string };

/** Replay the RTMR3 events, checking each digest against its payload; returns what the measured events name. */
function replayRtmr3(eventLog: string, quoteRtmr3: string): { ok: true; compose: string | null; osImage: string | null; appId: string | null } | { ok: false; reason: string } {
  let events: DstackEvent[];
  try {
    events = JSON.parse(eventLog);
  } catch {
    return { ok: false, reason: "event log is not JSON" };
  }
  if (!Array.isArray(events)) return { ok: false, reason: "event log is not a list" };
  let mr: Buffer = Buffer.alloc(48);
  const measured: Record<string, string[]> = {};
  let ready = false;
  for (const e of events) {
    if (e?.imr !== 3) continue;
    if (typeof e.digest !== "string" || !/^[0-9a-f]{96}$/i.test(e.digest) || typeof e.event !== "string" || typeof e.event_payload !== "string" || !Number.isInteger(e.event_type)) return { ok: false, reason: "malformed RTMR3 event" };
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type! >>> 0);
    const expected = sha384(Buffer.concat([type, Buffer.from(":"), Buffer.from(e.event), Buffer.from(":"), Buffer.from(e.event_payload, "hex")])).toString("hex");
    if (expected !== e.digest.toLowerCase()) return { ok: false, reason: `RTMR3 event "${e.event}" does not hash to its digest` };
    mr = sha384(Buffer.concat([mr, Buffer.from(e.digest, "hex")]));
    if (e.event === "system-ready") ready = true;
    if (!ready) (measured[e.event] ??= []).push(e.event_payload.toLowerCase());
  }
  if (mr.toString("hex") !== quoteRtmr3.toLowerCase()) return { ok: false, reason: "event log does not replay to the quote's RTMR3" };
  const one = (name: string) => {
    const v = measured[name] ?? [];
    return v.length === 1 ? v[0] : v.length > 1 ? undefined : null;
  };
  const compose = one("compose-hash");
  if (compose === undefined) return { ok: false, reason: "more than one compose-hash event before system-ready" };
  return { ok: true, compose, osImage: one("os-image-hash") ?? null, appId: one("app-id") ?? null };
}

/**
 * Checks 1–3, 5 and 6 of the header comment, from the report alone. The quote's own report_data and RTMR3 come
 * from the caller's parse of the quote; its signature is the quote verifiers' job (check 4) and the TLS key is
 * checked against a live connection (check 7).
 */
export function checkAciReport(report: Record<string, any>, o: { nonce: string; nowS: number; host: string; quoteReportData: string; quoteRtmr3: string }): AciReportCheck {
  if (report.api_version !== ACI_VERSION) return { ok: false, reason: `api_version is not ${ACI_VERSION}` };
  const att = report.attestation;
  if (!att || typeof att !== "object") return { ok: false, reason: "report has no attestation object" };
  if (att.tee_type !== "tdx") return { ok: false, reason: `unsupported tee_type ${JSON.stringify(att.tee_type)}` };
  const keyset = att.workload_keyset;
  if (!keyset || typeof keyset !== "object" || Array.isArray(keyset)) return { ok: false, reason: "workload_keyset is not an object" };
  const digest = keysetDigest(keyset);
  if (report.workload_keyset_digest !== digest) return { ok: false, reason: "workload_keyset_digest does not match the served keyset" };
  const rd = aciReportData(digest, o.nonce);
  if (att.report_data !== rd) return { ok: false, reason: "report_data does not bind this nonce and keyset" };
  const slot = rd + "00".repeat(32);
  if (o.quoteReportData.toLowerCase() !== slot) return { ok: false, reason: "the quote's report_data is not the report's" };
  const ev = (att.evidence ?? {}) as Record<string, unknown>;
  if (ev.quote_report_data !== undefined && String(ev.quote_report_data).toLowerCase() !== slot) return { ok: false, reason: "quote_report_data disagrees with the quote" };
  const quoteHex = typeof ev.quote === "string" ? ev.quote.replace(/^0x/, "").toLowerCase() : "";
  if (!quoteHex) return { ok: false, reason: "report carries no quote" };

  const notAfter = keyset.not_after;
  if (typeof notAfter !== "number" || !Number.isFinite(notAfter)) return { ok: false, reason: "keyset has no numeric not_after" };
  if (!(o.nowS < notAfter)) return { ok: false, reason: "keyset has expired (not_after)" };
  const staleAfter = typeof att.freshness?.stale_after === "number" ? att.freshness.stale_after : null;
  if (staleAfter !== null && !(o.nowS < staleAfter)) return { ok: false, reason: "report is stale (freshness.stale_after)" };

  const receiptKeys = (Array.isArray(keyset.receipt_signing_keys) ? keyset.receipt_signing_keys : [])
    .filter((k: any) => k && typeof k.key_id === "string" && k.algo === "ed25519" && typeof k.public_key === "string" && HEX64.test(k.public_key.toLowerCase()))
    .map((k: any) => ({ key_id: k.key_id, algo: "ed25519" as const, public_key: k.public_key.toLowerCase() }));
  if (!receiptKeys.length) return { ok: false, reason: "keyset lists no Ed25519 receipt signing key" };
  const host = o.host.toLowerCase();
  const tlsSpki = (Array.isArray(keyset.tls_public_keys) ? keyset.tls_public_keys : [])
    .filter((k: any) => k && (k.domain == null || String(k.domain).toLowerCase() === host))
    .map((k: any) => lowerHex(k.spki_sha256))
    .filter((x: string | null): x is string => !!x);

  const eventLog = typeof ev.event_log === "string" ? ev.event_log : null;
  let composeHash: string | null = null;
  let osImageHash: string | null = null;
  let appId: string | null = null;
  if (eventLog) {
    const replay = replayRtmr3(eventLog, o.quoteRtmr3);
    if (!replay.ok) return replay;
    ({ compose: composeHash, osImage: osImageHash, appId } = replay);
    if (typeof ev.app_compose === "string" && composeHash !== sha256Hex(ev.app_compose)) return { ok: false, reason: "app_compose is not the measured compose" };
  }
  const prov = att.source_provenance && typeof att.source_provenance === "object" ? att.source_provenance : null;
  return {
    ok: true,
    quoteHex,
    eventLog,
    vmConfig: typeof ev.vm_config === "string" ? ev.vm_config : null,
    gateway: {
      v: 1,
      keysetDigest: digest,
      workloadId: str(report.workload_id),
      receiptKeys,
      tlsSpki,
      notAfter,
      staleAfter,
      serving: str(report.service_capabilities?.serving),
      sourceProvenance: prov ? { repo_url: str(prov.repo_url), repo_commit: str(prov.repo_commit), image_digest: str(prov.image_digest) } : null,
      composeHash,
      osImageHash,
      appId,
      keysetEndorsement: att.keyset_endorsement == null ? "absent" : "present_not_verified",
      attestedAt: new Date(o.nowS * 1000).toISOString(),
    },
  };
}

// ---- Storage --------------------------------------------------------------------------------------------------

const KEY_PREFIX = "aci-gateway:";

function parseGateway(v: unknown): AciGateway | null {
  const g = v as Partial<AciGateway> | null;
  if (!g || g.v !== 1 || typeof g.keysetDigest !== "string" || !DIGEST.test(g.keysetDigest) || !Array.isArray(g.receiptKeys) || typeof g.notAfter !== "number") return null;
  return g as AciGateway;
}

export async function saveAciGateway(db: Db | Tx, providerId: string, g: AciGateway) {
  await db.insert(kv).values({ key: KEY_PREFIX + providerId, value: g }).onConflictDoUpdate({ target: kv.key, set: { value: g, updatedAt: new Date() } });
}
export async function clearAciGateway(db: Db | Tx, providerId: string) {
  await db.delete(kv).where(eq(kv.key, KEY_PREFIX + providerId));
}
export async function loadAciGateways(db: Db | Tx): Promise<Map<string, AciGateway>> {
  const rows = await db.select().from(kv).where(like(kv.key, `${KEY_PREFIX}%`));
  const out = new Map<string, AciGateway>();
  for (const r of rows) {
    const g = parseGateway(r.value);
    if (g) out.set(r.key.slice(KEY_PREFIX.length), g);
  }
  return out;
}
export async function loadAciGateway(db: Db | Tx, providerId: string): Promise<AciGateway | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, KEY_PREFIX + providerId));
  return row ? parseGateway(row.value) : null;
}

// ---- Per-response receipts -------------------------------------------------------------------------------------

/** What the router sent and received on one call to a gateway, captured by providers/upstream.ts. */
export type AciExchange = {
  receiptId: string | null;
  /** The exact request body bytes sent. */
  requestBody: string;
  /** The exact response body bytes received, or null when they were not all seen (cut short, or too large). */
  responseBody: () => Uint8Array | null;
  /** Read whatever of the response the parser left unread, so responseBody covers the whole body. */
  drain: () => Promise<void>;
};

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

function verifyEd25519(publicKeyHex: string, signatureHex: string, message: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** A typed claim, kept as the gateway states it: status asserted | refuted | unknown, and where it came from. */
export type AciClaim = { status: string; source?: string };
export const CLAIM_NAMES = ["tee_attested", "tcb_up_to_date", "gpu_attested", "model_weights_provenance", "zdr"] as const;
export type ClaimName = (typeof CLAIM_NAMES)[number];

/** The compact record that goes into the router's own signed receipt. */
export type UpstreamAttestation = {
  kind: typeof ACI_VERSION;
  receipt_id: string | null;
  workload_id: string | null;
  keyset_digest: string;
  /** The gateway's receipt verified: signature, keyset (and workload), and the request and response hashes. */
  receipt_verified: boolean;
  checks: { signature: boolean; keyset: boolean; request_hash: boolean; response_hash: boolean | null };
  upstream: { result: string | null; required: boolean | null; session_id: string | null; model_id: string | null };
  claims: Record<ClaimName, AciClaim | null>;
  /** Asserted by the receipt's claims, in a receipt that verified. */
  gpu_attested: boolean;
  /** The response counts as attested: receipt verified, upstream verified and required, tee_attested asserted. */
  attested: boolean;
  reason?: string;
};

function claimOf(v: unknown): AciClaim | null {
  if (typeof v === "boolean") return { status: v ? "asserted" : "refuted" };
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.status !== "string") return null;
  return { status: c.status.slice(0, 32), ...(typeof c.source === "string" ? { source: c.source.slice(0, 64) } : {}) };
}

const eventOf = (doc: Record<string, any>, type: string): Record<string, any> | undefined => (Array.isArray(doc.event_log) ? doc.event_log.find((e: any) => e?.type === type) : undefined);
/** The hash a receipt event records for a body: `body_hash`, or the returned-response `wire_hash`. */
const eventHash = (e: Record<string, any> | undefined): string | null => (typeof e?.body_hash === "string" ? e.body_hash : typeof e?.wire_hash === "string" ? e.wire_hash : null);
const sessionKey = (id: string) => id.replace(/^as_/, "").toLowerCase();

/**
 * Check a receipt document against the attested gateway and the bytes of the exchange. `session` is the record the
 * receipt's upstream.verified event cites, when the receipt carries no claims itself and the caller fetched it.
 * Pure: never throws, never fetches.
 */
export function checkAciReceipt(doc: unknown, g: AciGateway, ex: { requestBody: string | Uint8Array; responseBody: Uint8Array | null; receiptId: string | null }, session?: unknown): UpstreamAttestation {
  const d = (doc && typeof doc === "object" ? doc : {}) as Record<string, any>;
  const out: UpstreamAttestation = {
    kind: ACI_VERSION,
    receipt_id: typeof d.receipt_id === "string" ? d.receipt_id : ex.receiptId,
    workload_id: g.workloadId,
    keyset_digest: g.keysetDigest,
    receipt_verified: false,
    checks: { signature: false, keyset: false, request_hash: false, response_hash: null },
    upstream: { result: null, required: null, session_id: null, model_id: null },
    claims: { tee_attested: null, tcb_up_to_date: null, gpu_attested: null, model_weights_provenance: null, zdr: null },
    gpu_attested: false,
    attested: false,
  };
  const reasons: string[] = [];
  const key = g.receiptKeys.find((k) => k.key_id === d.key_id);
  if (!key) reasons.push("the receipt's key is not a receipt key of the attested keyset");
  else {
    const { signature, ...unsigned } = d;
    out.checks.signature = typeof signature === "string" && verifyEd25519(key.public_key, signature, jcs(unsigned));
    if (!out.checks.signature) reasons.push("the receipt signature does not verify");
  }
  if (d.api_version !== ACI_VERSION) reasons.push(`the receipt is not ${ACI_VERSION}`);
  out.checks.keyset = d.workload_keyset_digest === g.keysetDigest && (d.workload_id == null || g.workloadId == null || d.workload_id === g.workloadId);
  if (!out.checks.keyset) reasons.push("the receipt names a different keyset or workload");
  if (ex.receiptId && typeof d.receipt_id === "string" && d.receipt_id !== ex.receiptId) reasons.push("the receipt is not the one the response named");
  out.checks.request_hash = eventHash(eventOf(d, "request.received")) === bodyHash(ex.requestBody);
  if (!out.checks.request_hash) reasons.push("the receipt does not commit to the request the router sent");
  if (ex.responseBody) {
    out.checks.response_hash = eventHash(eventOf(d, "response.returned")) === bodyHash(ex.responseBody);
    if (!out.checks.response_hash) reasons.push("the receipt does not commit to the response the router received");
  } else reasons.push("the router did not see the whole response, so its hash was not checked");
  out.receipt_verified = reasons.length === 0;

  const up = eventOf(d, "upstream.verified");
  if (up) {
    out.upstream = {
      result: typeof up.result === "string" ? up.result : null,
      required: typeof up.required === "boolean" ? up.required : null,
      session_id: typeof up.session_id === "string" ? up.session_id : null,
      model_id: typeof up.model_id === "string" ? up.model_id : null,
    };
    let claims: Record<string, unknown> | null = up.claims && typeof up.claims === "object" ? up.claims : null;
    if (!claims && session && out.upstream.session_id) {
      const s = session as Record<string, any>;
      const servedAt = typeof d.served_at === "number" ? d.served_at : NaN;
      if (sha256Hex(jcs(s)) !== sessionKey(out.upstream.session_id)) reasons.push("the cited session does not hash to its id");
      else if (s.api_version !== ACI_VERSION) reasons.push(`the cited session is not ${ACI_VERSION}`);
      else if (!(servedAt >= s.established_at && servedAt <= s.expires_at)) reasons.push("the response was served outside the cited session's validity");
      else if (s.claims && typeof s.claims === "object") claims = s.claims;
    }
    const zdr = claims?.zdr ?? (up.provider_claims && typeof up.provider_claims === "object" ? up.provider_claims.zdr : undefined);
    for (const n of CLAIM_NAMES) out.claims[n] = claimOf(n === "zdr" ? zdr : claims?.[n]);
  } else reasons.push("the receipt records no upstream verification");

  const verifiedUpstream = out.upstream.result === "verified" && out.upstream.required === true;
  out.gpu_attested = out.receipt_verified && out.claims.gpu_attested?.status === "asserted";
  out.attested = out.receipt_verified && verifiedUpstream && out.claims.tee_attested?.status === "asserted";
  if (!out.attested) {
    if (out.receipt_verified && !verifiedUpstream) reasons.push(`the upstream was not verified (result ${JSON.stringify(out.upstream.result)}, required ${JSON.stringify(out.upstream.required)})`);
    else if (out.receipt_verified && out.claims.tee_attested?.status !== "asserted") reasons.push("tee_attested is not asserted");
    out.reason = reasons[0];
  }
  return out;
}

/**
 * The routing constraint the router adds to every request it sends a gateway: serve only from an upstream the
 * gateway verified inside a TEE before forwarding, and only from a zero-data-retention route. The receipt's
 * request hash covers these bytes, so the receipt also proves the constraint was asked for.
 */
export const ACI_CONSTRAINTS = Object.freeze({ aci_verified: true, zdr: true });

/** The part of an UpstreamAttestation that goes into the router's signed receipt. */
export function compactUpstream(ua: UpstreamAttestation) {
  return {
    kind: ua.kind,
    receipt_id: ua.receipt_id,
    workload_id: ua.workload_id,
    keyset_digest: ua.keyset_digest,
    receipt_verified: ua.receipt_verified,
    upstream: ua.upstream,
    claims: ua.claims,
    gpu_attested: ua.gpu_attested,
    attested: ua.attested,
    constraints: ACI_CONSTRAINTS,
    ...(ua.reason ? { reason: ua.reason } : {}),
  };
}

/** An attestation record for a call whose receipt could not be obtained at all. */
export function unverifiedUpstream(g: AciGateway, receiptId: string | null, reason: string): UpstreamAttestation {
  return { ...checkAciReceipt(null, g, { requestBody: "", responseBody: null, receiptId }), receipt_id: receiptId, reason };
}

async function getJson(url: string, o: { apiKey?: string; tlsPin?: Pick<TlsPin, "certPem" | "spkiSha256" | "spkiOnly"> | null; production: boolean; tries: number }): Promise<unknown> {
  let last = "";
  for (let i = 0; i < o.tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 250 * i));
    const res = await providerFetch(url, { headers: { accept: "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) }, redirect: "error", signal: AbortSignal.timeout(10_000) }, { production: o.production, allowDevelopmentMockLoopback: !o.production, tlsPin: o.tlsPin });
    if (res.ok) return boundedJson(res);
    last = `HTTP ${res.status}`;
    await res.body?.cancel().catch(() => undefined);
    // A receipt may be written a moment after the response; anything but "not yet" or a server error is final.
    if (res.status !== 404 && res.status < 500) break;
  }
  throw new Error(last || "unreachable");
}

/**
 * Fetch the receipt the gateway named for this exchange (and the session it cites when it carries no claims) and
 * check it. Never throws: anything that cannot be fetched or checked is an unverified result with its reason.
 */
export async function verifyAciExchange(o: { baseUrl: string; gateway: AciGateway; exchange: AciExchange; apiKey?: string; tlsPin?: TlsPin | null; production: boolean }): Promise<UpstreamAttestation> {
  const g = o.gateway;
  const ex = o.exchange;
  if (!ex.receiptId) return unverifiedUpstream(g, null, "the response named no receipt");
  await ex.drain().catch(() => undefined);
  const base = o.baseUrl.replace(/\/$/, "");
  let doc: unknown;
  try {
    doc = await getJson(`${base}/aci/receipts/${encodeURIComponent(ex.receiptId)}`, { apiKey: o.apiKey, tlsPin: o.tlsPin, production: o.production, tries: 3 });
  } catch (e) {
    return unverifiedUpstream(g, ex.receiptId, `the receipt could not be fetched (${(e as Error).message})`);
  }
  const inputs = { requestBody: ex.requestBody, responseBody: ex.responseBody(), receiptId: ex.receiptId };
  const first = checkAciReceipt(doc, g, inputs);
  const up = eventOf((doc ?? {}) as Record<string, any>, "upstream.verified");
  if (!first.upstream.session_id || (up?.claims && typeof up.claims === "object")) return first;
  let session: unknown;
  try {
    session = await getJson(`${base}/aci/sessions/${encodeURIComponent(first.upstream.session_id)}`, { apiKey: o.apiKey, tlsPin: o.tlsPin, production: o.production, tries: 2 });
  } catch (e) {
    return { ...first, attested: false, gpu_attested: false, reason: first.reason ?? `the cited session could not be fetched (${(e as Error).message})` };
  }
  return checkAciReceipt(doc, g, inputs, session);
}

// ---- GPU attestation, per model, over time ------------------------------------------------------------------

/** What verified gateway receipts have said about a model's GPU attestation. */
export type GpuAttestedRecord = { provider: string; last: boolean; lastStatus: string | null; lastAt: string; asserted: number; observed: number; firstAt: string };
const GPU_PREFIX = "aci-gpu:";

export async function loadGpuAttested(db: Db | Tx): Promise<Map<string, GpuAttestedRecord>> {
  const rows = await db.select().from(kv).where(like(kv.key, `${GPU_PREFIX}%`));
  const out = new Map<string, GpuAttestedRecord>();
  for (const r of rows) {
    const v = r.value as Partial<GpuAttestedRecord> | null;
    if (v && typeof v.last === "boolean" && typeof v.lastAt === "string") out.set(r.key.slice(GPU_PREFIX.length), v as GpuAttestedRecord);
  }
  return out;
}

/** Record one verified receipt's gpu_attested claim for a model. Receipts that did not verify say nothing. */
export async function recordGpuAttested(db: Db | Tx, modelId: string, providerId: string, ua: UpstreamAttestation, now = new Date()) {
  if (!ua.receipt_verified) return;
  const key = GPU_PREFIX + modelId;
  const [row] = await db.select().from(kv).where(eq(kv.key, key));
  const prev = (row?.value ?? null) as GpuAttestedRecord | null;
  const at = now.toISOString();
  const value: GpuAttestedRecord = {
    provider: providerId,
    last: ua.gpu_attested,
    lastStatus: ua.claims.gpu_attested?.status ?? null,
    lastAt: at,
    asserted: (prev?.asserted ?? 0) + (ua.gpu_attested ? 1 : 0),
    observed: (prev?.observed ?? 0) + 1,
    firstAt: prev?.firstAt ?? at,
  };
  await db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
}

// ---- The static model list ----------------------------------------------------------------------------------

/**
 * The provider-spec model list (admin providers.setStaticModels) for a gateway's public catalogue (GET /v1/models):
 * only models it offers inside a TEE (`is_tee`), none whose name marks refusal-removed weights (router/lane.ts),
 * priced exactly as the catalogue prices them. Descriptions and the catalogue's serving-route names are left out.
 */
export function aciStaticModels(catalogue: unknown, opts: { only?: Set<string> } = {}) {
  const list = Array.isArray((catalogue as { data?: unknown })?.data) ? (catalogue as { data: unknown[] }).data : [];
  const out: Record<string, unknown>[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const raw of list) {
    const m = raw as Record<string, any>;
    const id = typeof m?.id === "string" ? m.id : "";
    if (!id) continue;
    if (opts.only && !opts.only.has(id)) {
      skipped.push({ id, reason: "not in the requested set" });
      continue;
    }
    if (m.is_tee !== true) {
      skipped.push({ id, reason: "not offered inside a TEE" });
      continue;
    }
    if (inferredVariant({ id, name: m.name, hfRepo: m.hugging_face_id }) !== "mainstream") {
      skipped.push({ id, reason: "restricted variant" });
      continue;
    }
    const p = m.pricing ?? {};
    if (p.prompt == null || p.completion == null || !Number.isInteger(m.context_length) || m.context_length <= 0) {
      skipped.push({ id, reason: "no price or context length" });
      continue;
    }
    const params = [...new Set([...(m.supported_parameters ?? []), ...(m.supported_sampling_parameters ?? [])])].filter((x) => typeof x === "string").sort();
    out.push({
      id,
      name: typeof m.name === "string" ? m.name : id,
      ...(Number.isInteger(m.created) ? { created: m.created } : {}),
      ...(typeof m.hugging_face_id === "string" ? { hugging_face_id: m.hugging_face_id } : {}),
      anyroute: { slug: id.toLowerCase() },
      input_modalities: Array.isArray(m.input_modalities) ? m.input_modalities : ["text"],
      output_modalities: Array.isArray(m.output_modalities) ? m.output_modalities : ["text"],
      ...(typeof m.quantization === "string" ? { quantization: m.quantization } : {}),
      context_length: m.context_length,
      ...(Number.isInteger(m.max_output_length) && m.max_output_length > 0 ? { max_completion_tokens: Math.min(m.max_output_length, m.context_length) } : {}),
      pricing: { prompt: String(p.prompt), completion: String(p.completion), ...(p.input_cache_read != null ? { input_cache_read: String(p.input_cache_read) } : {}) },
      ...(params.length ? { supported_parameters: params } : {}),
      ...(Array.isArray(m.supported_features) && m.supported_features.length ? { supported_features: m.supported_features } : {}),
    });
  }
  return { models: out, skipped };
}

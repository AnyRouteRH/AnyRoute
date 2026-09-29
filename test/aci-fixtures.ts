import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { aciReportData, bodyHash, jcs, keysetDigest } from "../src/providers/aci.ts";
import { REGS, tdxQuote, type TdxRegisters } from "./measurement-fixtures.ts";

// Test support for aci/1 gateways (providers/aci.ts): keys, keysets, reports with a synthetic quote and a dstack
// event log that replays to its RTMR3, signed receipts and content-addressed sessions. Nothing here is real
// evidence; the shapes follow the aci/1 specification and its published test vectors.

// ---- The specification's published test vectors (spec/test-vectors.md of the aci/1 reference verifier,
// Apache-2.0), verbatim. Receipt key: the Ed25519 key whose seed is 32 bytes of 0x02.
export const V = {
  keysetJcs:
    '{"e2ee_public_keys":[{"algo":"x25519-aes-256-gcm-hkdf-sha256","key_id":"e2ee-1","public_key":"5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef22"}],"not_after":1800000000,"receipt_signing_keys":[{"algo":"ed25519","key_id":"receipt-1","public_key":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"}],"subject":"dstack-app://example-app","tls_public_keys":[{"domain":"api.example.com","spki_sha256":"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"}]}',
  keysetDigest: "sha256:53a5cd44b30dcc51999754c719f2628a041f174ecbf9662a6f8e898a10cd9371",
  nonce: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  reportDataWithNonce: "df2174d28130852b413646a3786927b93e94c11d770268b65def8bdba45cb49e",
  reportDataNullNonce: "0633919ca3f00e97bafaa3304278eb22420cc3ff0d19f87dfca2d3f7508150bc",
  session:
    '{"api_version":"aci/1","channel_binding":[{"origin":"https://upstream.example.com","spki_sha256":"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1","type":"tls_spki_sha256"}],"claims":{"extra":{"gpu_arch":"HOPPER","tcb_status":"UpToDate"},"gpu_attested":{"status":"unknown"},"model_weights_provenance":{"status":"unknown"},"os_known_good":{"status":"unknown"},"serving_software_known_good":{"status":"unknown"},"tcb_up_to_date":{"status":"unknown"},"tee_attested":{"reason":"example quote verified","source":"hardware_proven","status":"asserted"}},"endpoint":"https://upstream.example.com","established_at":1750000000,"evidence":{"data":"data:text/plain;base64,ZXhhbXBsZS1ldmlkZW5jZQ==","digest":"sha256:80d70e44d0ae1e829fd5f37c3ee4a60dfbea8d3aa18407ea3f34cf7ec91da34d"},"expires_at":1750003600,"upstream_name":"demo-upstream","verifier_id":"example/1"}',
  sessionId: "95ad1cb4dd25445808c2e9d116caf420b05703730b506395e8fc1ca6faeae28f",
  requestBody: '{"messages":[{"content":"hi","role":"user"}],"model":"demo-model"}',
  requestBodyHash: "sha256:94d809bf47380d8a2eab0eb6e126d4dda9364b0b4725cdf7ead52dd70b2aa87b",
  responseBody: '{"choices":[],"id":"chatcmpl-123"}',
  responseBodyHash: "sha256:dedfffe5b14d031b8e2c01996d021a15293cb7c63b56be7e4be9e89b6f0a5f61",
  document:
    '{"api_version":"aci/1","chat_id":"chatcmpl-123","endpoint":"/v1/chat/completions","event_log":[{"body_hash":"sha256:94d809bf47380d8a2eab0eb6e126d4dda9364b0b4725cdf7ead52dd70b2aa87b","type":"request.received"},{"body_hash":"sha256:94d809bf47380d8a2eab0eb6e126d4dda9364b0b4725cdf7ead52dd70b2aa87b","type":"request.forwarded"},{"model_id":"demo-model","required":true,"result":"verified","session_id":"95ad1cb4dd25445808c2e9d116caf420b05703730b506395e8fc1ca6faeae28f","type":"upstream.verified"},{"body_hash":"sha256:dedfffe5b14d031b8e2c01996d021a15293cb7c63b56be7e4be9e89b6f0a5f61","type":"response.returned"}],"key_id":"receipt-1","method":"POST","model":"demo-model","receipt_id":"rcpt-0001","served_at":1750000000,"signature":"d5b005e093bde3b577faf270b7184b09e169cacb0ecb206b103bd2581f997db03da616175454b063323a23ac1dc68f1ce506c2a6eba8aa0561d5e724f0b80c03","workload_keyset_digest":"sha256:53a5cd44b30dcc51999754c719f2628a041f174ecbf9662a6f8e898a10cd9371"}',
  receiptPublicKey: "8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394",
};

// ---- Keys --------------------------------------------------------------------------------------------------

export function ed25519(seedHex: string) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  const pub = (createPublicKey(priv).export({ type: "spki", format: "der" }) as Buffer).subarray(12).toString("hex");
  return { pub, sign: (msg: string) => cryptoSign(null, Buffer.from(msg), priv).toString("hex") };
}
export const VECTOR_KEY = ed25519("02".repeat(32));
export const RECEIPT_KEY = ed25519("07".repeat(32));
export const OTHER_KEY = ed25519("09".repeat(32));

export function keyset(o: { notAfter?: number; host?: string; spki?: string; receiptKey?: string } = {}) {
  return {
    subject: null,
    not_after: o.notAfter ?? 4_000_000_000,
    receipt_signing_keys: [{ key_id: "receipt-ed25519-v1", algo: "ed25519", public_key: o.receiptKey ?? RECEIPT_KEY.pub }],
    e2ee_public_keys: [{ key_id: "e2ee-x25519-v1", algo: "x25519-aes-256-gcm-hkdf-sha256", public_key: "ab".repeat(32) }],
    tls_public_keys: [{ spki_sha256: o.spki ?? "5a".repeat(32), domain: o.host ?? "gateway.example.com" }],
  };
}

// ---- A dstack event log whose RTMR3 events hash correctly -----------------------------------------------

const sha384 = (b: Uint8Array) => createHash("sha384").update(b).digest();
function rtmr3Event(event: string, payloadHex: string) {
  const type = 0x08000001;
  const t = Buffer.alloc(4);
  t.writeUInt32LE(type);
  const digest = sha384(Buffer.concat([t, Buffer.from(":"), Buffer.from(event), Buffer.from(":"), Buffer.from(payloadHex, "hex")])).toString("hex");
  return { imr: 3, event_type: type, digest, event, event_payload: payloadHex };
}

export const APP_COMPOSE = JSON.stringify({ manifest_version: 2, name: "gateway", runner: "docker-compose", docker_compose_file: "services: {}\n" });
export const composeHashOf = (appCompose: string) => createHash("sha256").update(appCompose).digest("hex");

export function eventLog(composeHex: string) {
  const events = [
    { imr: 0, event_type: 2147483659, digest: "00".repeat(48), event: "", event_payload: "" },
    rtmr3Event("system-preparing", ""),
    rtmr3Event("app-id", "12".repeat(20)),
    rtmr3Event("compose-hash", composeHex),
    rtmr3Event("instance-id", "34".repeat(20)),
    rtmr3Event("boot-mr-done", ""),
    rtmr3Event("os-image-hash", "56".repeat(32)),
    rtmr3Event("system-ready", ""),
  ];
  let mr: Buffer = Buffer.alloc(48);
  for (const e of events) if (e.imr === 3) mr = sha384(Buffer.concat([mr, Buffer.from(e.digest, "hex")]));
  return { json: JSON.stringify(events), rtmr3: mr.toString("hex") };
}

// ---- Reports ------------------------------------------------------------------------------------------------

export type ReportOptions = {
  keyset?: ReturnType<typeof keyset>;
  /** Bind this nonce instead of the one asked for (a replayed report). */
  bindNonce?: string;
  staleAfter?: number;
  appCompose?: string;
  /** The compose hash the event log measures (defaults to sha256 of appCompose). */
  measuredCompose?: string;
  /** Break one RTMR3 event's digest. */
  tamperEvent?: boolean;
  /** MRCONFIGID = 01 || this compose hash (as dstack does). */
  mrConfigCompose?: string;
  registers?: Partial<TdxRegisters>;
  endorsement?: boolean;
};

export function gatewayReport(nonce: string, o: ReportOptions = {}) {
  const ks = o.keyset ?? keyset();
  const digest = keysetDigest(ks);
  const rd = aciReportData(digest, o.bindNonce ?? nonce);
  const appCompose = o.appCompose ?? APP_COMPOSE;
  const log = eventLog(o.measuredCompose ?? composeHashOf(appCompose));
  const events = JSON.parse(log.json);
  if (o.tamperEvent) events[3].event_payload = "ee".repeat(32);
  const regs = { ...REGS, rtmr3: log.rtmr3, ...o.registers };
  const quote = Buffer.from(tdxQuote(rd + "00".repeat(32), regs), "hex");
  if (o.mrConfigCompose) Buffer.from("01" + o.mrConfigCompose + "00".repeat(15), "hex").copy(quote, 48 + 184);
  return {
    api_version: "aci/1",
    workload_keyset_digest: digest,
    attestation: {
      tee_type: "tdx",
      workload_keyset: ks,
      report_data: rd,
      ...(o.staleAfter !== undefined ? { freshness: { fetched_at: 1_700_000_000, stale_after: o.staleAfter } } : {}),
      source_provenance: { repo_url: "https://git.example/gateway.git", repo_commit: "ab".repeat(20), image_digest: null, image_provenance: null },
      ...(o.endorsement ? { keyset_endorsement: { algo: "ecdsa-secp256k1", value: "cd".repeat(65) } } : {}),
      evidence: {
        quote: quote.toString("hex"),
        quote_report_data: rd + "00".repeat(32),
        event_log: JSON.stringify(events),
        vm_config: JSON.stringify({ os_image_hash: "56".repeat(32), num_gpus: 0 }),
        app_compose: appCompose,
      },
    },
    service_capabilities: { supported_e2ee_versions: ["2"], serving: "aggregator" },
  };
}

/** What a quote verifier reports for a synthetic quote: its registers, report_data and MRCONFIGID, as the Phala verifier shapes it. */
export function phalaVerifierAnswer(quoteHex: string, verified = true) {
  const q = Buffer.from(quoteHex, "hex");
  const at = (o: number, l: number) => q.subarray(48 + o, 48 + o + l).toString("hex");
  return { quote: { verified, header: { tee_type: "TEE_TDX" }, body: { mrtd: at(136, 48), rtmr0: at(328, 48), rtmr1: at(376, 48), rtmr2: at(424, 48), rtmr3: at(472, 48), reportdata: at(520, 64), mr_config_id: at(184, 48) } } };
}

// ---- Receipts and sessions ---------------------------------------------------------------------------------

export type Claims = Record<string, { status: string; source?: string; reason?: string }>;
export const CLAIMS_OK: Claims = {
  tee_attested: { status: "asserted", source: "hardware_proven", reason: "verified TEE quote and bound request channel" },
  tcb_up_to_date: { status: "asserted", source: "hardware_proven" },
  gpu_attested: { status: "asserted", source: "verifier_derived" },
  model_weights_provenance: { status: "unknown" },
};

export function session(claims: Claims, servedAt: number) {
  const doc = {
    api_version: "aci/1",
    upstream_name: "demo-upstream",
    endpoint: "https://upstream.example.com",
    verifier_id: "example/1",
    established_at: servedAt - 60,
    expires_at: servedAt + 3600,
    channel_binding: [{ type: "tls_spki_sha256", origin: "https://upstream.example.com", spki_sha256: "d1".repeat(32) }],
    claims,
    evidence: { digest: bodyHash("example-evidence"), data: "data:text/plain;base64," + Buffer.from("example-evidence").toString("base64") },
  };
  return { id: createHash("sha256").update(jcs(doc)).digest("hex"), doc };
}

export function signedReceipt(o: {
  key?: ReturnType<typeof ed25519>;
  keyId?: string;
  keysetDigest: string;
  receiptId: string;
  requestBody: string | Uint8Array;
  responseBody: string | Uint8Array;
  upstream: { result: string; required: boolean; session_id?: string; claims?: Claims };
  servedAt: number;
  model?: string;
}) {
  const unsigned = {
    api_version: "aci/1",
    receipt_id: o.receiptId,
    chat_id: "chatcmpl-test",
    model: o.model ?? "demo-model",
    workload_keyset_digest: o.keysetDigest,
    endpoint: "/v1/chat/completions",
    method: "POST",
    served_at: o.servedAt,
    event_log: [
      { type: "request.received", body_hash: bodyHash(o.requestBody) },
      { type: "route.selected", target_route_id: "route-1" },
      { type: "upstream.verified", model_id: o.model ?? "demo-model", result: o.upstream.result, required: o.upstream.required, ...(o.upstream.session_id ? { session_id: o.upstream.session_id } : {}), ...(o.upstream.claims ? { claims: o.upstream.claims } : {}) },
      { type: "response.returned", body_hash: bodyHash(o.responseBody) },
    ],
    key_id: o.keyId ?? "receipt-ed25519-v1",
  };
  return { ...unsigned, signature: (o.key ?? RECEIPT_KEY).sign(jcs(unsigned)) };
}

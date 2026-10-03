import type { Fetch } from "./types.js";
import { canonicalJson } from "./canonical.js";
import { bytesToHex, hexToBytes, concatBytes, utf8 } from "./bytes.js";
import { sha256Hex } from "./hash.js";
import { parseTdxQuote } from "./tdx.js";
import { defaultEd25519Verify } from "./ed25519.js";

export const E2EE_SUITE = "x25519-aes-256-gcm-hkdf-sha256";
const asBuffer = (b: Uint8Array) => b as unknown as BufferSource;
const randomHex = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const rawHex = (v: string) => v.replace(/^0x/, "");
const hash = async (v: Uint8Array | string) => "sha256:" + await sha256Hex(v);
const MAX_WIRE = 32 * 1024 * 1024;
export type E2eeContext = { model: string; nonce: string; ts: number };
/** The caller must verify quote signature/collateral, reject debug, appraise measurements/event log, deployment and key custody. */
export type E2eeAttestationVerifier = (report: Readonly<Record<string, any>>, challenge: { nonce: string; keysetDigest: string; quote: Uint8Array }) => Promise<boolean>;
export type E2eeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch?: Fetch;
  signal?: AbortSignal;
  lane?: "attested" | "unlinkable";
  verifyAttestation: E2eeAttestationVerifier;
};
export type E2eeCompletion = { id?: string; model?: string; choices: { index?: number; delta?: { role?: string; content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; message?: { role?: string; content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[]; usage?: Record<string, unknown> };
export type E2eeChatBody = {
  model: string;
  messages: { role: "system" | "developer" | "user" | "assistant"; content: string }[];
  max_tokens?: number;
  stream?: boolean;
  /** Optional specific appraised upstream sessions. Gateway verified routing and ZDR are always required. */
  sessionIds?: string[];
};

export function e2eeAad(ctx: E2eeContext, field: string, id?: string) {
  return utf8(canonicalJson({ algo: E2EE_SUITE, model: ctx.model, field, nonce: ctx.nonce, ts: ctx.ts, purpose: id === undefined ? "aci.e2ee.request.v2" : "aci.e2ee.response.v2", ...(id === undefined ? {} : { id }) }));
}
export async function e2eeKeyPair() {
  // The generic WebCrypto overload also permits symmetric keys; require an asymmetric result.
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKey | CryptoKeyPair;
  if (!("publicKey" in pair) || !("privateKey" in pair)) throw new Error("X25519 key pair unavailable");
  return pair;
}
export async function e2eePublicKey(pair: CryptoKeyPair) { return bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))); }
async function aesKey(privateKey: CryptoKey, publicHex: string) {
  const pub = await crypto.subtle.importKey("raw", asBuffer(hexToBytes(rawHex(publicHex))), { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: asBuffer(utf8("aci.e2ee.v2.x25519")) }, hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/** Fresh ephemeral X25519 and GCM nonce per field, including empty content. */
export async function sealE2eeField(plaintext: string, recipient: string, aad: Uint8Array): Promise<string> {
  const ephemeral = await e2eeKeyPair();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: asBuffer(aad), tagLength: 128 }, await aesKey(ephemeral.privateKey, recipient), asBuffer(utf8(plaintext)));
  return bytesToHex(concatBytes(hexToBytes(await e2eePublicKey(ephemeral)), iv, new Uint8Array(encrypted)));
}
export async function openE2eeField(ciphertext: string, recipient: CryptoKey, aad: Uint8Array): Promise<string> {
  if (!/^(?:[0-9a-f]{2}){60,}$/.test(ciphertext)) throw new Error("Malformed encrypted field");
  const bytes = hexToBytes(ciphertext);
  const key = await aesKey(recipient, bytesToHex(bytes.subarray(0, 32)));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: asBuffer(bytes.subarray(32, 44)), additionalData: asBuffer(aad), tagLength: 128 }, key, asBuffer(bytes.subarray(44)));
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

async function boundedBytes(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.ok || !res.body) throw new Error("Encrypted chat evidence unavailable");
  const reader = res.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  try {
    while (true) { const v = await reader.read(); if (v.done) break; n += v.value.length; if (n > limit) throw new Error("Encrypted chat response exceeds limit"); parts.push(v.value); }
    return concatBytes(...parts);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function jsonFetch(f: Fetch, url: string, options: RequestInit) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(await f(url, options), 2 * 1024 * 1024)));
}
/** Local binding and expiry checks are independent of the caller's quote appraisal. Neither trusts a router boolean. */
export async function verifyE2eeReport(report: Record<string, any>, nonce: string, verifier: E2eeAttestationVerifier) {
  const att = report?.attestation; const keyset = att?.workload_keyset;
  if (typeof verifier !== "function" || report.api_version !== "aci/1" || att?.tee_type !== "tdx" || !keyset || !report.service_capabilities?.supported_e2ee_versions?.includes("2")) throw new Error("E2EE v2 attestation required");
  const digest = await hash(canonicalJson(keyset));
  const reportData = await sha256Hex(canonicalJson({ keyset_digest: digest, nonce, purpose: "aci.report_data.v1" }));
  const quoteHex = att.evidence?.quote?.replace(/^0x/, "");
  if (typeof quoteHex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(quoteHex)) throw new Error("Missing TDX quote");
  const quote = hexToBytes(quoteHex); const parsed = parseTdxQuote(quote);
  const now = Date.now() / 1000;
  if (report.workload_keyset_digest !== digest || att.report_data !== reportData || parsed.reportData !== reportData + "00".repeat(32) || !Number.isFinite(keyset.not_after) || now >= keyset.not_after || (att.freshness?.stale_after !== undefined && (!Number.isFinite(att.freshness.stale_after) || now >= att.freshness.stale_after))) throw new Error("Attestation nonce, keyset, quote or freshness mismatch");
  // TDATTRIBUTES DEBUG bit is bit 0 of the little-endian field at quote body offset 120.
  if ((quote[48 + 120] & 1) !== 0) throw new Error("Debug TDX workload refused");
  if (await verifier(report, { nonce, keysetDigest: digest, quote }) !== true) throw new Error("Caller refused gateway attestation");
  const key = keyset.e2ee_public_keys?.find((k: any) => k.algo === E2EE_SUITE && typeof k.key_id === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/.test(k.public_key));
  if (!key) throw new Error("Attested X25519 key unavailable");
  return { keyset, digest, publicKey: rawHex(key.public_key), workloadId: report.workload_id };
}

async function verifyComplete(o: { options: E2eeOptions; f: Fetch; base: string; keys: Awaited<ReturnType<typeof verifyE2eeReport>>; receiptId: string; model: string; request: string; wire: Uint8Array; sessionIds?: string[] }) {
  const { options, f, base, keys, receiptId, model, request, wire } = o;
  const d = await jsonFetch(f, `${base}/api/v1/e2ee/receipts/${encodeURIComponent(receiptId)}`, { signal: options.signal });
  const { signature, ...unsigned } = d;
  const key = keys.keyset.receipt_signing_keys?.find((k: any) => k.algo === "ed25519" && k.key_id === d.key_id);
  if (!key || !/^[0-9a-fA-F]{128}$/.test(signature ?? "") || !await defaultEd25519Verify(hexToBytes(rawHex(key.public_key)), utf8(canonicalJson(unsigned)), hexToBytes(signature))) throw new Error("Invalid gateway receipt signature");
  if (d.api_version !== "aci/1" || d.receipt_id !== receiptId || d.model !== model || d.endpoint !== "/v1/chat/completions" || d.method !== "POST" || d.workload_keyset_digest !== keys.digest || (keys.workloadId && d.workload_id !== keys.workloadId) || !Number.isFinite(d.served_at) || Math.abs(Date.now() / 1000 - d.served_at) > 300) throw new Error("Gateway receipt context mismatch");
  const events = Array.isArray(d.event_log) ? d.event_log : [];
  const one = (type: string) => { const all = events.filter((e: any) => e.type === type); if (all.length !== 1) throw new Error("Missing or duplicate receipt event"); return all[0]; };
  if (one("request.received").body_hash !== await hash(request) || one("response.returned").body_hash !== await hash(wire)) throw new Error("Gateway receipt wire or restored request hash mismatch");
  const up = one("upstream.verified");
  let claims = up.claims;
  if (!claims && /^[0-9a-f]{64}$/.test(up.session_id ?? "")) {
    const session = await jsonFetch(f, `${base}/api/v1/e2ee/sessions/${up.session_id}`, { signal: options.signal });
    if (await hash(canonicalJson(session)) !== `sha256:${up.session_id}` || session.api_version !== "aci/1" || !(d.served_at >= session.established_at && d.served_at <= session.expires_at)) throw new Error("Invalid upstream session commitment");
    claims = session.claims;
  }
  if (o.sessionIds && !o.sessionIds.includes(up.session_id)) throw new Error("Unexpected upstream session");
  if (up.result !== "verified" || up.required !== true || claims?.tee_attested?.status !== "asserted" || claims?.zdr?.status !== "asserted") throw new Error("Gateway receipt lacks verified upstream/ZDR claims");
  return d;
}

async function decryptEvent(ev: any, pair: CryptoKeyPair, ctx: E2eeContext, streaming: boolean) {
  if (ev?.error || !Array.isArray(ev?.choices)) throw new Error("Invalid encrypted response event");
  for (const [pos, choice] of ev.choices.entries()) {
    const i = choice.index ?? pos;
    if (!Number.isInteger(i) || i !== 0) throw new Error("Unexpected encrypted choice index");
    const kind = streaming ? "delta" : "message";
    const content = choice[kind];
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("Invalid encrypted choice");
    for (const k of Object.keys(content)) if (!["content", "reasoning", "reasoning_content", "role"].includes(k)) throw new Error("Unsupported response content field");
    for (const k of ["content", "reasoning", "reasoning_content"]) {
      if (content[k] === undefined || content[k] === null || (streaming && k === "content" && content[k] === "")) continue;
      if (typeof content[k] !== "string") throw new Error("Unsupported response modality");
      content[k] = await openE2eeField(content[k], pair.privateKey, e2eeAad(ctx, `choices.${i}.${kind}.${k}`, typeof ev.id === "string" ? ev.id : ""));
    }
  }
  return ev;
}

/** Decrypted streamed chunks are provisional until iteration completes and the signed full-wire receipt verifies. */
export async function e2eeChat(body: E2eeChatBody, options: E2eeOptions): Promise<E2eeCompletion | AsyncGenerator<E2eeCompletion>> {
  const ceiling = body.max_tokens ?? 512;
  const allowed = ["model", "messages", "max_tokens", "stream", "sessionIds"];
  if (Object.keys(body).some(k => !allowed.includes(k)) || typeof body.model !== "string" || !body.model || !Number.isInteger(ceiling) || ceiling < 1 || ceiling > 32768 || (body.stream !== undefined && typeof body.stream !== "boolean") || !Array.isArray(body.messages) || !body.messages.length || body.messages.some(m => !["system", "developer", "user", "assistant"].includes(m.role) || typeof m.content !== "string" || Object.keys(m).some(k => !["role", "content"].includes(k)))) throw new Error("Only text chat without tools, files or search is supported");
  // Arrays encoded as strings are restored as structured content by v2. Refuse this ambiguity in the text-only helper.
  for (const m of body.messages) { try { if (Array.isArray(JSON.parse(m.content))) throw new Error("Structured content is not supported"); } catch (e) { if (e instanceof Error && e.message === "Structured content is not supported") throw e; } }
  const f = options.fetch ?? globalThis.fetch; const base = options.baseUrl.replace(/\/$/, "");
  const nonce = randomHex();
  const report = await jsonFetch(f, `${base}/api/v1/e2ee/attestation?nonce=${nonce}`, { signal: options.signal });
  const keys = await verifyE2eeReport(report, nonce, options.verifyAttestation);
  const pair = await e2eeKeyPair();
  const ctx = { model: body.model, nonce: randomHex(), ts: Math.floor(Date.now() / 1000) };
  const plaintext = { model: body.model, messages: body.messages.map(m => ({ role: m.role, content: m.content })), max_tokens: ceiling, stream: !!body.stream, ...(body.stream ? { stream_options: { include_usage: true } } : {}), provider: { aci_verified: true, zdr: true, ...(body.sessionIds ? { aci_session_ids: body.sessionIds } : {}) } };
  const envelope = structuredClone(plaintext);
  for (const [i, m] of envelope.messages.entries()) m.content = await sealE2eeField(m.content, keys.publicKey, e2eeAad(ctx, `messages.${i}.content`));
  const headers = new Headers(options.headers); headers.set("content-type", "application/json");
  if (options.lane) headers.set("x-anyroute-lane", options.lane);
  headers.set("x-e2ee-version", "2"); headers.set("x-client-pub-key", await e2eePublicKey(pair)); headers.set("x-model-pub-key", keys.publicKey); headers.set("x-e2ee-nonce", ctx.nonce); headers.set("x-e2ee-timestamp", String(ctx.ts));
  const response = await f(`${base}/api/v1/e2ee/chat/completions`, { method: "POST", headers, body: JSON.stringify(envelope), signal: options.signal });
  const receiptId = response.headers.get("x-e2ee-receipt-id");
  if (!response.ok || !response.body || !receiptId || !/^[A-Za-z0-9._-]{1,128}$/.test(receiptId) || response.headers.get("x-e2ee-applied") !== "true" || response.headers.get("x-e2ee-version") !== "2" || response.headers.get("x-e2ee-algo") !== E2EE_SUITE) { await response.body?.cancel(); throw new Error("Encrypted chat refused or E2EE not applied"); }
  // The pinned gateway preserves JSON member order when compactly restoring the request.
  const verify = (wire: Uint8Array) => verifyComplete({ options, f, base, keys, receiptId, model: body.model, request: JSON.stringify(plaintext), wire, sessionIds: body.sessionIds });
  if (!body.stream) {
    const wire = await boundedBytes(response, MAX_WIRE);
    const event = await decryptEvent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(wire)), pair, ctx, false);
    await verify(wire); return event;
  }
  return (async function* () {
    const reader = response.body!.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: Uint8Array[] = []; let size = 0; let pending = ""; let done = false; let finish = false;
    try {
      while (true) {
        const v = await reader.read(); if (v.done) break;
        size += v.value.length; if (size > MAX_WIRE) throw new Error("Encrypted stream exceeds limit");
        parts.push(v.value); pending += decoder.decode(v.value, { stream: true });
        if (pending.length > 1024 * 1024) throw new Error("Encrypted SSE event exceeds limit");
        let at: number;
        while ((at = pending.search(/\r?\n\r?\n/)) >= 0) {
          const separator = pending.slice(at).match(/^\r?\n\r?\n/)![0];
          const block = pending.slice(0, at); pending = pending.slice(at + separator.length);
          const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          if (done) throw new Error("Data after stream sentinel");
          if (data === "[DONE]") { done = true; continue; }
          const event = await decryptEvent(JSON.parse(data), pair, ctx, true);
          if (event.choices.some((c: any) => typeof c.finish_reason === "string")) finish = true;
          yield event;
        }
      }
      pending += decoder.decode();
      if (!done || !finish || pending.trim()) throw new Error("Truncated encrypted stream");
      await verify(concatBytes(...parts));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  })();
}

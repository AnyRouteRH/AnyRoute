import { createHash } from "node:crypto";
import { verifyWithRawKey } from "../receipts/signer.ts";
import { decodeResponse, encodeRequest, type HeaderList } from "./bhttp.ts";
import { MEDIA_KEYS, MEDIA_REQ, MEDIA_RES, parseKeyConfigList, sealRequest, selectKeyConfig, type PublicKeyConfig } from "./ohttp.ts";
import { logEntryHash } from "./keys.ts";

// Client helper for the unlinkable lane: fetch and check the gateway's key configuration, then send a request
// through a relay to the gateway. The relay sees the encapsulated request and who sent it; the gateway sees the
// request and the relay. Neither sees both.
//
//   const keys = await fetchKeyConfig(routerUrl, { trustedSigners: [receiptKeyHex] });   // pinned, not trusted on first use
//   const res = await sendViaRelay({ relayUrl, keyConfig: keys.config, method: "POST", path: "/api/v1/chat/completions",
//     headers: [["authorization", authorizationHeader(token)], ["content-type", "application/json"]],
//     body: JSON.stringify({ model, messages, provider: { lane: "unlinkable" } }) });
//
// Never send an API key, an account cookie or any header that names you through this path.

type Fetch = typeof fetch;

/** Largest binary HTTP message the client will seal or open. */
const MAX_MESSAGE = 64 * 1024 * 1024;

export type KeyListDocument = {
  data: {
    v: number;
    kind: string;
    issued: string;
    router: string;
    gateway: { url: string; keys_url: string; media_type: string };
    epoch_seconds: number;
    grace_seconds: number;
    keys: { epoch: number; key_id: number; kem_id: number; public_key: string; config: string; config_sha256: string; status: string; valid_from: string; accept_until: string; private_key_destroyed: boolean; entry_hash: string }[];
    log: { algorithm: string; entries: number; head: string; first_prev: string };
    relays: { operator: string; url: string; key_id: string; independent: boolean }[];
  };
  signature: { alg: string; key_id: string; sig: string };
};

const base = (u: string) => u.replace(/\/$/, "");
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export async function fetchKeyList(routerUrl: string, fetchImpl: Fetch = fetch): Promise<KeyListDocument> {
  const res = await fetchImpl(`${base(routerUrl)}/api/v1/ohttp/key-list`);
  if (!res.ok) throw new Error(`GET /api/v1/ohttp/key-list failed with ${res.status}`);
  return (await res.json()) as KeyListDocument;
}

/**
 * Check a signed key list: the signature (against one of the signer keys you trust, hex Ed25519 public keys), and the
 * hash chain over the listed keys. Throws on any failure. Returns the keys that are safe to use now.
 */
export function verifyKeyList(doc: KeyListDocument, trustedSigners: string[], at = Date.now()): KeyListDocument["data"]["keys"] {
  if (doc.signature?.alg !== "Ed25519" || doc.data?.kind !== "ohttp-key-list" || doc.data.v !== 1) throw new Error("not an ohttp key list this client understands");
  if (!trustedSigners.some((k) => verifyWithRawKey(doc.data, doc.signature.sig, k))) throw new Error("key list signature does not verify against any trusted signer");
  let prev: Uint8Array = Buffer.from(doc.data.log.first_prev, "hex");
  if (prev.length !== 32) throw new Error("key list chain is malformed");
  for (const k of doc.data.keys) {
    if (createHash("sha256").update(Buffer.from(k.config, "base64url")).digest("hex") !== k.config_sha256) throw new Error(`key ${k.epoch}: config does not match its digest`);
    prev = logEntryHash(prev, { epoch: k.epoch, keyId: k.key_id, kemId: k.kem_id, configSha256: k.config_sha256, validFrom: new Date(k.valid_from), acceptUntil: new Date(k.accept_until) });
    if (Buffer.from(prev).toString("hex") !== k.entry_hash) throw new Error(`key ${k.epoch}: log entry does not chain`);
  }
  if (Buffer.from(prev).toString("hex") !== doc.data.log.head) throw new Error("key list chain does not end at its head");
  return doc.data.keys.filter((k) => !k.private_key_destroyed && (k.status === "current" || k.status === "grace") && Date.parse(k.accept_until) > at);
}

/**
 * Whether a key list continues a log head you saw before: the earlier head is the list's starting point or one of its
 * entries. A list that does not (a key removed or replaced since you looked) is a reason not to use it.
 */
export function logExtends(previousHead: string, doc: KeyListDocument): boolean {
  return doc.data.log.first_prev === previousHead || doc.data.keys.some((k) => k.entry_hash === previousHead) || doc.data.log.head === previousHead;
}

/**
 * The gateway's key configuration, checked against the signed key list. With `trustedSigners` (the router's receipt
 * signing keys, which you obtained some other way) a substituted key cannot get through; without it the signer keys
 * are fetched from the same router, which only protects against a key that differs between clients if you compare
 * `log.head` with other observers.
 */
export async function fetchKeyConfig(routerUrl: string, opts: { trustedSigners?: string[]; fetch?: Fetch; at?: number } = {}): Promise<{ config: PublicKeyConfig; encoded: Uint8Array; epoch: number; logHead: string }> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${base(routerUrl)}/api/v1/ohttp/keys`);
  if (!res.ok || (res.headers.get("content-type") ?? "").split(";")[0].trim() !== MEDIA_KEYS) throw new Error(`GET /api/v1/ohttp/keys did not return ${MEDIA_KEYS}`);
  const served = selectKeyConfig(parseKeyConfigList(new Uint8Array(await res.arrayBuffer()))); // throws on any encoding error or when no suite matches
  let signers = opts.trustedSigners;
  if (!signers) {
    const jwks = (await (await f(`${base(routerUrl)}/api/v1/receipts/keys`)).json()) as { keys: { x: string }[] };
    signers = jwks.keys.map((k) => Buffer.from(k.x, "base64url").toString("hex"));
  }
  const doc = await fetchKeyList(routerUrl, f);
  const listed = verifyKeyList(doc, signers, opts.at);
  const match = listed.find((k) => k.key_id === served.keyId && k.public_key === b64u(served.publicKey));
  if (!match) throw new Error("the served key configuration is not in the signed key list");
  return { config: served, encoded: new Uint8Array(Buffer.from(match.config, "base64url")), epoch: match.epoch, logHead: doc.data.log.head };
}

export type RelayResponse = { status: number; headers: Headers; body: Uint8Array; text(): string; json<T = unknown>(): T };

/**
 * Send one request to the gateway through a relay. `gateway` picks one of the relay's configured gateways (its name or
 * exact URL) when the relay serves more than one. The whole request is encapsulated with a fresh ephemeral key, and
 * the response is opened with the same context. A failure of the relay or gateway before the request was unwrapped (a
 * 4xx that is not `message/ohttp-res`) is thrown as an error, not returned.
 */
export async function sendViaRelay(o: {
  relayUrl: string;
  gateway?: string;
  keyConfig: PublicKeyConfig;
  method: string;
  path: string;
  headers?: HeaderList;
  body?: string | Uint8Array;
  padTo?: number;
  fetch?: Fetch;
  /** Extra headers for the relay itself (never the gateway); leave empty unless the relay operator asks for something. */
  relayHeaders?: Record<string, string>;
}): Promise<RelayResponse> {
  const f = o.fetch ?? fetch;
  const body = typeof o.body === "string" ? new TextEncoder().encode(o.body) : o.body;
  const bhttp = encodeRequest({ method: o.method, scheme: "https", authority: "", path: o.path, headers: o.headers ?? [], body }, { padTo: o.padTo ?? 0 });
  const sent = await sealRequest(o.keyConfig, bhttp, MAX_MESSAGE);
  const url = new URL(o.relayUrl);
  if (o.gateway) url.searchParams.set("gateway", o.gateway);
  const res = await f(url.toString(), { method: "POST", headers: { "content-type": MEDIA_REQ, accept: MEDIA_RES, ...(o.relayHeaders ?? {}) }, body: sent.encapsulated as never });
  const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const raw = new Uint8Array(await res.arrayBuffer());
  if (res.status !== 200 || ct !== MEDIA_RES) {
    // Not an encapsulated response: the relay or gateway refused before unwrapping (wrong or stale key, size, rate limit).
    throw Object.assign(new Error(`relay answered ${res.status} without an encapsulated response: ${new TextDecoder().decode(raw).slice(0, 300)}`), { status: res.status, unencapsulated: true, body: raw });
  }
  const inner = decodeResponse(await sent.openResponse(raw));
  const headers = new Headers();
  for (const [n, v] of inner.headers) headers.append(n, v);
  return {
    status: inner.status,
    headers,
    body: inner.body,
    text: () => new TextDecoder().decode(inner.body),
    json: <T = unknown>() => JSON.parse(new TextDecoder().decode(inner.body)) as T,
  };
}


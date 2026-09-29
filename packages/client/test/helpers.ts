import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { bytesToBase64Url, bytesToHex, utf8, canonicalBytes, keyIdOf, receiptLeaf, type JwkKey, type ReceiptEnvelope } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
export const fixtureJson = <T = any>(name: string): T => JSON.parse(fixture(name));
export const fixtureText = (name: string) => fixture(name);

/** The evidence captured from a real TDX deployment (see fixtures/PROVENANCE.txt). */
export const real = {
  boot: () => fixtureJson("attest-boot.json"),
  fresh: () => fixtureJson("attest-fresh.json") as { nonce: string; response: any },
  router: () => fixtureJson("router-attestation.json"),
  receipt: () => fixtureJson("receipt.json") as ReceiptEnvelope,
  certPem: () => fixtureText("sidecar-cert.crt"),
  quoteHex: () => fixtureText("quote-boot.hex").trim(),
  /** A moment inside the captured evidence's lifetime: the router had verified it ten minutes earlier. */
  now: Date.parse("2026-09-29T08:30:00Z"),
};

/** A router-style Ed25519 signer that publishes a JWKS entry the way the router does. */
export function makeRouterKey(validFrom = "2026-09-01T00:00:00.000Z", retiredAt: string | null = null) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
  return { privateKey, publicKey, raw, ready: keyIdOf(raw).then((kid): JwkKey => ({ kty: "OKP", crv: "Ed25519", x: bytesToBase64Url(raw), kid, use: "sig", alg: "EdDSA", valid_from: validFrom, retired_at: retiredAt, onchain_tx: null })) };
}

export async function signReceipt(privateKey: KeyObject, keyId: string, payload: Record<string, unknown>): Promise<ReceiptEnvelope> {
  const bytes = canonicalBytes(payload);
  const sig = sign(null, bytes, privateKey);
  return { id: String(payload.id ?? "rcpt"), payload, sig: sig.toString("base64"), key_id: keyId, alg: "Ed25519", leaf: receiptLeaf(bytes, new Uint8Array(sig)) };
}

export { bytesToHex, utf8, createPrivateKey, createPublicKey };

/** A fetch stub that answers by URL and records what was asked. */
export function stubFetch(routes: Record<string, (req: { url: URL; init?: RequestInit }) => Response | Promise<Response>>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), init });
    for (const [key, handler] of Object.entries(routes)) {
      const [method, path] = key.includes(" ") ? key.split(" ") : ["GET", key];
      if ((init?.method ?? "GET") === method && (url.pathname + url.search === path || url.pathname === path)) return handler({ url, init });
    }
    return new Response(JSON.stringify({ error: { message: `no stub for ${url.pathname}` } }), { status: 404 });
  }) as (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  return { fetch: f, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

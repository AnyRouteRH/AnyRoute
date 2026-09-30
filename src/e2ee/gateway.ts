import { createPublicKey, verify } from "node:crypto";
import type { Ctx } from "../context.ts";
import type { ProviderRow } from "../catalog/catalog.ts";
import { jcs, bodyHash } from "../providers/aci.ts";
import { boundedJson, providerFetch } from "../providers/network.ts";
import { openProviderHeaders } from "../providers/headers.ts";
import { decrypt } from "../lib/util.ts";
import { PHALA_PROVIDER } from "./config.ts";
import { fail } from "../lib/errors.ts";

export function configuredGateway(ctx: Ctx): ProviderRow {
  const p = ctx.catalog.providers.get(PHALA_PROVIDER);
  if (!p || p.status !== "live" || p.teeKind !== "tdx" || !p.apiKeyEnc || !p.attestationUrl) fail(503, "The Phala confidential AI provider is not configured.", "e2ee_unavailable");
  const declared = ctx.cfg.e2ee.provider;
  if (declared && (p.baseUrl.replace(/\/$/, "") !== declared.baseUrl || p.attestationUrl !== declared.attestationUrl)) fail(503, "The database Phala provider differs from the configured manifest.", "e2ee_unavailable");
  return p;
}
export function gatewayTransport(ctx: Ctx, p: ProviderRow) {
  return { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production, tlsPin: p.tlsPin };
}
export function gatewayHeaders(ctx: Ctx, p: ProviderRow) {
  const headers = new Headers({ ...openProviderHeaders(ctx.cfg.appSecret, p.headers), authorization: `Bearer ${decrypt(ctx.cfg.appSecret, p.apiKeyEnc!)}` });
  headers.delete("x-signing-algo"); // legacy selection is incompatible with v2
  return headers;
}
export async function gatewayJson(ctx: Ctx, p: ProviderRow, path: string) {
  const tries = path.startsWith("/aci/receipts/") ? 3 : 1;
  for (let i = 0; i < tries; i++) {
    const headers = gatewayHeaders(ctx, p); headers.set("accept", "application/json");
    const res = await providerFetch(p.baseUrl.replace(/\/$/, "") + path, {
      headers, signal: AbortSignal.timeout(10_000), redirect: "error",
    }, gatewayTransport(ctx, p));
    if (res.ok) return await boundedJson(res) as Record<string, any>;
    await res.body?.cancel();
    if (res.status !== 404 || i === tries - 1) throw new Error("Gateway evidence unavailable");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Gateway evidence unavailable");
}
/** Unlike the plaintext verifier, this deliberately does not assert request-hash verification. */
export async function assessResponse(ctx: Ctx, p: ProviderRow, receiptId: string, model: string, responseHash: string, sessionIds?: string[]) {
  const g = p.aci!;
  const d = await gatewayJson(ctx, p, `/aci/receipts/${encodeURIComponent(receiptId)}`);
  const key = g.receiptKeys.find(k => k.key_id === d.key_id);
  const { signature, ...unsigned } = d;
  if (!key || !/^[0-9a-f]{128}$/i.test(signature ?? "") || !verify(null, Buffer.from(jcs(unsigned)), createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.public_key, "hex")]), format: "der", type: "spki" }), Buffer.from(signature, "hex"))) throw new Error("Invalid gateway signature");
  if (d.api_version !== "aci/1" || d.receipt_id !== receiptId || d.model !== model || d.endpoint !== "/v1/chat/completions" || d.method !== "POST" || d.workload_keyset_digest !== g.keysetDigest || (g.workloadId && d.workload_id !== g.workloadId) || !Number.isFinite(d.served_at) || Math.abs(Date.now() / 1000 - d.served_at) > 300) throw new Error("Gateway receipt binding mismatch");
  const events = Array.isArray(d.event_log) ? d.event_log : [];
  const returned = events.filter((e: any) => e.type === "response.returned");
  const ups = events.filter((e: any) => e.type === "upstream.verified");
  if (returned.length !== 1 || returned[0].body_hash !== `sha256:${responseHash}` || ups.length !== 1) throw new Error("Incomplete gateway response");
  const up = ups[0];
  let claims = up.claims;
  if (!claims && /^[0-9a-f]{64}$/.test(up.session_id ?? "")) {
    const session = await gatewayJson(ctx, p, `/aci/sessions/${up.session_id}`);
    if (bodyHash(jcs(session)) !== `sha256:${up.session_id}` || session.api_version !== "aci/1" || !(d.served_at >= session.established_at && d.served_at <= session.expires_at)) throw new Error("Invalid upstream session");
    claims = session.claims;
  }
  if (sessionIds && !sessionIds.includes(up.session_id)) throw new Error("Unexpected upstream session");
  if (up.result !== "verified" || up.required !== true || claims?.tee_attested?.status !== "asserted" || claims?.zdr?.status !== "asserted") throw new Error("Unverified upstream");
  return { receipt_id: receiptId, keyset_digest: g.keysetDigest, response_hash_verified: true, request_hash_verified: false, upstream_verified: true, upstream_session_id: typeof up.session_id === "string" && /^[0-9a-f]{64}$/.test(up.session_id) ? up.session_id : null, gpu_attested: claims.gpu_attested?.status === "asserted" };
}

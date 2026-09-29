import { eq } from "drizzle-orm";
import { providers } from "../src/db/schema.ts";
import { keysetDigest } from "../src/providers/aci.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { runRegistry } from "../src/services/registry.ts";
import { encrypt } from "../src/lib/util.ts";
import { ADMIN, startRouter } from "./helpers.ts";
import { CLAIMS_OK, RECEIPT_KEY, gatewayReport, keyset, phalaVerifierAnswer, session, signedReceipt, type Claims, type ReportOptions } from "./aci-fixtures.ts";

// A router with one public provider and one attested aci/1 gateway, for tests of the agent surfaces (MCP, Telegram)
// that read what the attested lane returns. The gateway serves a report bound to the attestor's nonce, answers chat
// calls and signs a receipt for each; the quote verifier is a local stand-in. Nothing here is real evidence.

export const GW_MODEL = "gwtest/attested-chat";
export const PLAIN = { id: "plain", slug: "gwtest/plain-chat", prompt: "0.0000001", completion: "0.0000002" };
const claim = { source: "https://gateway.example/terms", as_of: "2025-01-15" };

export type GatewayState = {
  report: ReportOptions;
  verified: boolean;
  /** "verified": the gateway verified an upstream inside a TEE; "routed": it forwarded without verifying. */
  upstream: "verified" | "routed";
  claims: Claims;
  requests: { body: Record<string, any>; authorization: string | null }[];
};
const fresh = (): GatewayState => ({ report: {}, verified: true, upstream: "verified", claims: CLAIMS_OK, requests: [] });

const enc = new TextEncoder();
const answer = (model: string) =>
  enc.encode(JSON.stringify({ id: "chatcmpl-gw", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: "hello from the gateway" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }));

export async function startGatewayRouter() {
  const fx = { state: fresh() };
  const receipts = new Map<string, unknown>();
  const sessions = new Map<string, unknown>();
  let seq = 0;
  const gw = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      const state = fx.state;
      if (u.pathname === "/v1/aci/attestation") return Response.json(gatewayReport(u.searchParams.get("nonce") ?? "", state.report));
      if (u.pathname === "/v1/models") return Response.json({ data: [] });
      if (u.pathname.startsWith("/v1/aci/receipts/")) {
        const doc = receipts.get(decodeURIComponent(u.pathname.slice("/v1/aci/receipts/".length)));
        return doc ? Response.json(doc) : new Response("not found", { status: 404 });
      }
      if (u.pathname.startsWith("/v1/aci/sessions/")) {
        const doc = sessions.get(decodeURIComponent(u.pathname.slice("/v1/aci/sessions/".length)));
        return doc ? Response.json(doc) : new Response("not found", { status: 404 });
      }
      if (u.pathname === "/v1/chat/completions" && req.method === "POST") {
        const reqBytes = new Uint8Array(await req.arrayBuffer());
        const body = JSON.parse(new TextDecoder().decode(reqBytes));
        state.requests.push({ body, authorization: req.headers.get("authorization") });
        const bytes = answer(body.model);
        const id = `rcpt-${++seq}`;
        const servedAt = Math.floor(Date.now() / 1000);
        const s = session(state.claims, servedAt);
        sessions.set(s.id, s.doc);
        const upstream = state.upstream === "verified" ? { result: "verified", required: true, session_id: s.id, claims: state.claims } : { result: "failed", required: false };
        receipts.set(id, signedReceipt({ keysetDigest: keysetDigest(state.report.keyset ?? keyset()), receiptId: id, requestBody: reqBytes, responseBody: bytes, upstream, servedAt, key: RECEIPT_KEY, model: body.model }));
        return new Response(bytes, { headers: { "content-type": "application/json", "x-receipt-id": id } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const verifier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => Response.json(phalaVerifierAnswer(((await req.json()) as { hex: string }).hex, fx.state.verified)) });
  const h = await startRouter({ providers: [{ id: "vendor", name: "Vendor", models: [PLAIN] }], env: { ATTESTATION_VERIFIERS: "phala", PHALA_VERIFIER_URL: `http://127.0.0.1:${verifier.port}/verify` } });
  const model = (id: string, name: string) => ({ id, name, anyroute: { slug: id }, context_length: 32768, max_completion_tokens: 4096, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["max_tokens", "temperature"] });
  await h.ctx.db.insert(providers).values({
    id: "gw",
    name: "Gateway",
    baseUrl: `http://127.0.0.1:${gw.port}/v1`,
    apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "gateway-key"),
    status: "live",
    dataPolicy: { training: false, retains_prompts: false, zdr: true },
    teeKind: "tdx",
    attestationUrl: `http://127.0.0.1:${gw.port}/v1/aci/attestation`,
    staticModels: [model(GW_MODEL, "Attested gateway chat")],
  });
  await runRegistry(h.ctx);
  const declared = await h.request("/api/v1/disclosure/gw", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
  if (declared.status !== 200) throw new Error(`could not declare the gateway's retention: ${declared.status}`);

  const attest = async () => {
    const { results } = await runAttestor(h.ctx);
    await h.ctx.catalog.refresh();
    return (results as { provider: string; ok: boolean; reason?: string }[]).find((x) => x.provider === "gw");
  };
  return {
    h,
    /** Mutable: the gateway reads it on every request. */
    get state() {
      return fx.state;
    },
    /** A clean gateway, attested again. */
    async reset() {
      fx.state = fresh();
      return attest();
    },
    attest,
    /** Make the router's record of the gateway's attestation too old to count. */
    async makeStale() {
      await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 5) }).where(eq(providers.id, "gw"));
      await h.ctx.catalog.refresh();
    },
    async close() {
      gw.stop(true);
      verifier.stop(true);
      await h.close();
    },
  };
}

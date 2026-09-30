// A local fake router (Bun.serve on a random port) that answers like the real one: receipts signed with the RFC 8032
// Section 7.1 test 1 key (public test vector), the v2 receipt from packages/client's fixture, SSE with chain comments.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { bytesToBase64Url, canonicalBytes, hexToBytes, receiptLeaf } from "@anyroute/client";

export const V2 = JSON.parse(readFileSync(new URL("../../../packages/client/test/fixtures/receipt-v2.json", import.meta.url), "utf8")) as {
  public_key_hex: string;
  key_id: string;
  cose: string;
  leaf: string;
  claims: Record<string, any>;
  chunks: string[];
  chain_steps: string[];
};
const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // RFC 8032 test 1 secret (public)
const pub = hexToBytes(V2.public_key_hex);
const priv = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: bytesToBase64Url(hexToBytes(SEED_HEX)), x: bytesToBase64Url(pub) }, format: "jwk" });
export const JWKS = { keys: [{ kty: "OKP", crv: "Ed25519", x: bytesToBase64Url(pub), kid: V2.key_id, use: "sig", alg: "EdDSA", valid_from: "2026-01-01T00:00:00.000Z", retired_at: null }] };

export function receiptFor(id: string, extra: Record<string, unknown> = {}) {
  const payload = { id, model: "example/model", provider: "example-provider", ts: Date.parse("2026-09-30T12:00:00Z"), tokens_in: 5, tokens_out: 3, ...extra };
  const bytes = canonicalBytes(payload);
  const sig = new Uint8Array(sign(null, bytes, priv));
  return { id, sig: Buffer.from(sig).toString("base64"), key_id: V2.key_id, alg: "Ed25519", payload, leaf: receiptLeaf(bytes, sig), v2: { alg: "EdDSA", kid: V2.key_id, cose: V2.cose, claims: V2.claims, leaf: V2.leaf } };
}

export type Seen = { method: string; path: string; headers: Headers; body: any };

export function startFakeRouter() {
  const seen: Seen[] = [];
  const state = { batchPolls: 0, rateLimitLeft: 0, presets: new Map<string, any[]>(), tamperStream: false };
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers });
  const genHeaders = (id: string, lane: string) => ({ "x-generation-id": id, "x-receipt-id": id, "x-anyroute-lane": lane, "x-anyroute-disclosure": lane === "attested" ? "attested" : "policy" });
  const presetJson = (name: string) => {
    const versions = state.presets.get(name)!;
    const last = versions.at(-1);
    return { name, model: `@preset/${name}`, description: last.config.description ?? "", version: versions.length, hash: `h${versions.length}`, config: last.config, created_at: "2026-09-30T00:00:00.000Z", updated_at: "2026-09-30T00:00:00.000Z" };
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
      seen.push({ method: req.method, path: p + url.search, headers: req.headers, body });
      const lane = (body?.provider?.lane as string) ?? req.headers.get("x-anyroute-lane") ?? "public";

      if (p === "/.well-known/anyroute-receipt-keys.json") return json(JWKS);

      if (p === "/api/v1/chat/completions") {
        if (state.rateLimitLeft > 0) {
          state.rateLimitLeft--;
          return json({ error: { code: 429, message: "Rate limit exceeded.", type: "rate_limited" } }, 429, { "retry-after": "7" });
        }
        if (body.model === "missing/model") return json({ error: { code: 404, message: "Model missing/model is not available.", type: "model_not_found" } }, 404);
        const id = V2.claims.rid as string;
        if (!body.stream) {
          return json({ id, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 }, receipt: receiptFor(id) }, 200, genHeaders(id, lane));
        }
        const chunks = state.tamperStream ? [V2.chunks[0], V2.chunks[1].replace("lo", "LO"), V2.chunks[2]] : V2.chunks;
        let sse = "";
        chunks.forEach((d, i) => (sse += `data: ${d}\n\n: anyroute-chain ${i + 1} ${V2.chain_steps[i]}\n\n`));
        sse += `data: ${JSON.stringify({ receipt: receiptFor(id) })}\n\ndata: [DONE]\n\n`;
        return new Response(sse, { headers: { "content-type": "text/event-stream", ...genHeaders(id, lane) } });
      }

      if (p === "/api/v1/embeddings") return json({ object: "list", model: body.model, data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2, total_tokens: 2 }, receipt: receiptFor("gen-emb-1") }, 200, genHeaders("gen-emb-1", lane));
      if (p === "/api/v1/rerank") {
        const results = body.documents.map((d: any, index: number) => ({ index, relevance_score: typeof d === "string" && d.includes(body.query) ? 0.9 : 0.1 })).sort((a: any, b: any) => b.relevance_score - a.relevance_score).slice(0, body.top_n ?? undefined);
        return json({ id: "gen-rr-1", model: body.model, results, usage: { total_tokens: 12, search_units: 1, cost: 0.00001 }, cost: 0.00001, receipt: receiptFor("gen-rr-1") }, 200, genHeaders("gen-rr-1", lane));
      }

      // ---- batches ----
      const batch = (status: string) => ({ id: "batch_abc123", object: "batch", endpoint: "/v1/chat/completions", status, output_url: "/api/v1/batches/batch_abc123/output", errors_url: "/api/v1/batches/batch_abc123/errors", created_at: 1, in_progress_at: 2, expires_at: 3, completed_at: status === "completed" ? 4 : null, failed_at: null, expired_at: null, cancelled_at: status === "cancelled" ? 4 : null, request_counts: { total: 2, completed: status === "completed" ? 1 : 0, failed: status === "completed" ? 1 : 0 }, cost: { usd: 0.001, list_usd: 0.002, discount_bps: 5000 }, results_expire_at: 5 });
      if (p === "/api/v1/batches" && req.method === "POST") return json(batch("validating"));
      if (p === "/api/v1/batches" && req.method === "GET") return json({ object: "list", data: [batch("in_progress")], first_id: "batch_abc123", last_id: "batch_abc123", has_more: false });
      if (p === "/api/v1/batches/batch_abc123") return json(batch(++state.batchPolls >= 3 ? "completed" : "in_progress"));
      if (p === "/api/v1/batches/batch_abc123/cancel") return json(batch("cancelling"));
      if (p === "/api/v1/batches/batch_abc123/output")
        return new Response(JSON.stringify({ id: "batch_req_abc123_0", custom_id: "q1", response: { status_code: 200, request_id: "gen-b-1", body: { choices: [{ message: { content: "4" } }], receipt: receiptFor("gen-b-1") } }, error: null }) + "\n", { headers: { "content-type": "application/jsonl" } });
      if (p === "/api/v1/batches/batch_abc123/errors") return new Response(JSON.stringify({ id: "batch_req_abc123_1", custom_id: "q2", response: null, error: { code: "model_not_found", message: "no" } }) + "\n", { headers: { "content-type": "application/jsonl" } });

      // ---- presets ----
      const m = /^\/api\/v1\/presets(?:\/([a-z0-9-]+))?(?:\/(versions|diff|rollback))?$/.exec(p);
      if (m) {
        const [, name, sub] = m;
        if (!name) return json({ data: [...state.presets.keys()].map(presetJson), limit: 100 });
        if (!state.presets.has(name) && req.method !== "PUT") return json({ error: { code: 404, message: `No preset @preset/${name} in this account.`, type: "preset_not_found" } }, 404);
        if (req.method === "PUT") {
          const versions = state.presets.get(name) ?? [];
          const changed = JSON.stringify(versions.at(-1)?.config) !== JSON.stringify(body);
          if (changed) versions.push({ config: body });
          state.presets.set(name, versions);
          return json({ data: { ...presetJson(name), changed } }, versions.length === 1 && changed ? 201 : 200);
        }
        if (req.method === "DELETE") {
          const n = state.presets.get(name)!.length;
          state.presets.delete(name);
          return json({ data: { name, model: `@preset/${name}`, deleted: true, versions: n } });
        }
        if (sub === "versions") return json({ data: state.presets.get(name)!.map((_, i) => ({ version: i + 1, hash: `h${i + 1}`, model: `@preset/${name}@${i + 1}`, source: "put", created_at: "2026-09-30T00:00:00.000Z" })).reverse(), latest: state.presets.get(name)!.length });
        if (sub === "diff") return json({ data: { name, from: { version: Number(url.searchParams.get("from")) }, to: { version: Number(url.searchParams.get("to")) }, identical: false, changes: [{ path: "models", op: "replace" }] } });
        if (sub === "rollback") {
          const versions = state.presets.get(name)!;
          versions.push({ config: versions[Number(body.version) - 1].config });
          return json({ data: { ...presetJson(name), changed: true, restored_from: Number(body.version) } });
        }
        return json({ data: { ...presetJson(name), latest_version: state.presets.get(name)!.length } });
      }

      if (p === "/api/v1/models") {
        const all = [
          { id: "example/model", name: "Example", lanes: ["public", "attested"], attested_available: true, attestation: { best: "attested", manifest_ref: null, exec_profile_id: null, policy_hash: null }, architecture: { output_modalities: ["text"] } },
          { id: "example/open", name: "Open", lanes: ["public"], attested_available: false, attestation: null, architecture: { output_modalities: ["text"] } },
          { id: "example/rerank", name: "Rerank", lanes: ["public"], attested_available: false, attestation: null, architecture: { output_modalities: ["rerank"] } },
        ];
        const mod = url.searchParams.get("output_modalities");
        return json({ data: mod ? all.filter((x) => x.architecture.output_modalities.includes(mod)) : all });
      }

      const r = /^\/api\/v1\/receipts\/([^/]+)(\/proof)?$/.exec(p);
      if (r) {
        if (r[2]) return json({ data: { rid: r[1], leaf: V2.leaf, leaf_version: 2, rooted: true, anchored: false, root: V2.leaf, proof: [], status: "local" } });
        return json({ data: { ...receiptFor(r[1]), version: 2 } });
      }
      return json({ error: { code: 404, message: "Not found.", type: "not_found" } }, 404);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, state, stop: () => server.stop(true) };
}

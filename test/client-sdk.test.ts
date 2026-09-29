import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { keccak256 as viemKeccak, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import { AnyRoute, AttestationRefused, canonicalJson as sdkCanonicalJson, keccak256Hex, receiptLeaf as sdkLeaf, verifyMerkleProof, verifySidecarReceipt, verifyProvider, canonicalBytes as sdkCanonicalBytes } from "../packages/client/src/index.ts";
import { nodeAttestFetcher } from "../packages/client/src/node.ts";
import { tokenNullifier as sdkNullifier } from "../packages/client/src/blind.ts";
import { canonicalJson } from "../src/lib/util.ts";
import * as webVerify from "../web/lib/verify.js";
import { verifyReceipt as sdkVerifyReceipt } from "../packages/client/src/index.ts";
import { MerkleTree, receiptLeaf } from "../src/receipts/merkle.ts";
import { canonicalBytes } from "../src/receipts/signer.ts";
import { nullifierOf } from "../src/blind/privacy-token.ts";
import { decodeBase64 } from "../src/blind/privacy-token.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { API_KEY, cleanup, dstackProvider, harness as sidecarHarness } from "../sidecar/test/helpers.ts";
import { startServer } from "../sidecar/src/server.ts";
import { decodeReceiptHeader } from "../sidecar/src/receipts.ts";

// The SDK in packages/client is standalone (it cannot import the router). These tests hold it to the router's and the
// sidecar's real behaviour: the same canonical bytes, the same leaves and proofs, receipts from a running router, blind
// tokens from its issuer, and evidence produced by the sidecar's own code over real TLS.

setDefaultTimeout(60_000);

const shim = (h: Harness): ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) => async (input, init) => {
  const u = new URL(String(input), "http://router.test");
  return h.app.request(u.pathname + u.search, init);
};
const chat = { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 16 };

describe("same bytes as the router", () => {
  test("canonical JSON matches on structured, unicode and edge-case inputs", () => {
    const samples: unknown[] = [
      {},
      [],
      { b: 1, a: [3, { z: null, y: true, x: "é \"\\\n" }], c: { "": 0, "10": 1, "9": 2, "a-b": 3 } },
      { n: [0, -0, 1.5, 1e21, 1e-7, 123456789012345680000, -1], s: "😀 \u0000 \u001f" },
      { undefinedField: undefined, nested: { u: undefined, k: 1 } },
      { big: 10n, arr: [1n, { m: 2n }] },
      { "é": 1, e: 2, "😀": 3, "￿": 4 },
    ];
    // Deterministic pseudo-random documents.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const gen = (depth: number): unknown => {
      const r = rnd();
      if (depth > 3 || r < 0.3) return [rnd() * 1000 | 0, "s" + (rnd() * 99 | 0), null, true, rnd() * 1e6, "üñí😀"][(rnd() * 6) | 0];
      if (r < 0.6) return Array.from({ length: (rnd() * 4) | 0 }, () => gen(depth + 1));
      return Object.fromEntries(Array.from({ length: (rnd() * 5) | 0 }, () => ["k" + ((rnd() * 20) | 0) + ["", "é", "😀"][(rnd() * 3) | 0], gen(depth + 1)]));
    };
    for (let i = 0; i < 300; i++) samples.push(gen(0));
    for (const s of samples) expect(sdkCanonicalJson(s)).toBe(canonicalJson(s));
    expect(Buffer.from(sdkCanonicalBytes({ a: 1 })).equals(canonicalBytes({ a: 1 }))).toBe(true);
  });

  test("keccak256, receipt leaves and merkle proofs match viem and the router's tree", () => {
    for (const n of [0, 1, 31, 32, 135, 136, 137, 272, 500]) {
      const data = new Uint8Array(randomBytes(n));
      expect(keccak256Hex(data)).toBe(viemKeccak(data));
    }
    const bytes = canonicalBytes({ id: "x", n: 1 });
    const sig = new Uint8Array(randomBytes(64));
    expect(sdkLeaf(bytes, sig)).toBe(receiptLeaf(bytes, sig));
    const leaves = Array.from({ length: 11 }, (_, i) => viemKeccak(new Uint8Array([i])) as Hex);
    const tree = new MerkleTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyMerkleProof(leaves[i], tree.proof(i), tree.root)).toBe(true);
      expect(verifyMerkleProof(leaves[(i + 1) % leaves.length], tree.proof(i), tree.root)).toBe(false);
    }
  });
});

describe("the verify page's browser code agrees with the SDK and the router", () => {
  test("canonical bytes, keccak and receipt verdicts are identical", async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 200; i++) {
      const doc = { ["k" + ((rnd() * 9) | 0)]: [rnd(), "é😀", { "10": 1, "9": 2, b: null }], "3": i, z: { y: rnd() > 0.5 } };
      expect(webVerify.canonicalJson(doc)).toBe(canonicalJson(doc));
    }
    const data = new Uint8Array(randomBytes(300));
    expect(Buffer.from(webVerify.keccak256(data)).toString("hex")).toBe(keccak256Hex(data).slice(2));

    const h = await startRouter({ providers: [{ id: "vendor", name: "Vendor", models: [MODELS.llama] }] });
    try {
      const k = await h.fundedKey(5n);
      const c = new AnyRoute({ baseUrl: "http://router.test", apiKey: k.secret, fetch: shim(h) });
      const res = await c.chat.completions.create(chat);
      const keys = await c.receiptKeys();
      const receipt = res.anyroute.receipt!;
      const forged = structuredClone(receipt);
      (forged.payload as Record<string, unknown>).cost = "0";
      for (const r of [receipt, forged, { ...receipt, key_id: "0000000000000000" }, { ...receipt, leaf: "0x" + "11".repeat(32) }]) {
        const a = await sdkVerifyReceipt(r as never, { keys });
        const b = await webVerify.verifyReceipt(r, { keys });
        expect(b.valid).toBe(a.valid);
        expect(b.checks.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual(a.checks.map((x) => [x.id, x.status]));
      }
    } finally {
      await h.close();
    }
  });
});

describe("against a running router", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({
      env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "1000" },
      providers: [
        { id: "vendor", name: "Vendor", models: [MODELS.llama, MODELS.embed] },
        { id: "enclave", name: "Enclave", models: [MODELS.llamaPricey], tee: "dev" },
      ],
    });
  });
  afterAll(async () => {
    await h.close();
  });

  test("a receipt from a real chat call verifies against the keys the router publishes, and a tampered copy does not", async () => {
    const k = await h.fundedKey(5n);
    const c = new AnyRoute({ baseUrl: "http://router.test", apiKey: k.secret, fetch: shim(h) });
    const res = await c.chat.completions.create(chat);
    expect(res.anyroute.receipt?.payload.provider).toBe("vendor");
    expect(res.anyroute.receiptVerification?.valid).toBe(true);
    expect(res.anyroute.receiptVerification?.checks.find((x) => x.id === "leaf")?.status).toBe("pass");
    expect(res.anyroute.receiptVerification?.checks.find((x) => x.id === "key_window")?.status).toBe("pass");
    expect(res.anyroute.disclosure).toBe("vendor-forwarded");
    const forged = structuredClone(res.anyroute.receipt!);
    (forged.payload as Record<string, unknown>).cost = "0";
    expect((await c.verifyReceipt(forged)).valid).toBe(false);
    // The same receipt fetched by id, as anyone can.
    const again = await c.getReceipt(String(res.anyroute.receipt!.payload.id));
    expect((await c.verifyReceipt(again)).valid).toBe(true);
    // The router's own verifier agrees with the client's verdict.
    const server = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: forged.payload, sig: forged.sig, key_id: forged.key_id } })).json();
    expect(server.data.valid ?? server.data.signature_valid).toBe(false);
  });

  test("lane and disclosure options reach the router, which refuses when nothing qualifies", async () => {
    const k = await h.fundedKey(5n);
    const c = new AnyRoute({ baseUrl: "http://router.test", apiKey: k.secret, fetch: shim(h) });
    const e = await c.chat.completions.create(chat, { lane: "attested" }).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.code).toBe("lane_unavailable");
    const d = await c.chat.completions.create(chat, { disclosure: "none" }).catch((x) => x);
    expect(d.code).toBe("disclosure_unavailable");
    const u = await c.chat.completions.create(chat, { lane: "unlinkable" }).catch((x) => x);
    expect(u.status).toBe(501);
    // An unrestricted request is still served.
    expect((await c.chat.completions.create(chat, { disclosure: "any", lane: "public" })).anyroute.lane).toBe("public");
  });

  test("streaming: the final event's receipt verifies", async () => {
    const k = await h.fundedKey(5n);
    const c = new AnyRoute({ baseUrl: "http://router.test", apiKey: k.secret, fetch: shim(h) });
    const stream = await c.chat.completions.stream(chat);
    let chunks = 0;
    for await (const _ of stream) chunks++;
    expect(chunks).toBeGreaterThan(1);
    const meta = await stream.meta();
    expect(meta.receipt).not.toBeNull();
    expect(meta.receiptVerification?.valid).toBe(true);
  });

  test("blind tokens: buy with the SDK, spend with the SDK, and the receipt shows the nullifier the SDK computes", async () => {
    const k = await h.fundedKey(5n);
    const c = new AnyRoute({ baseUrl: "http://router.test", apiKey: k.secret, fetch: shim(h) });
    const bought = await c.buyTokens({ denomination: 1_000, count: 1 });
    expect(bought.tokens).toHaveLength(1);
    const token = bought.tokens[0];
    const res = await c.withPrivateToken(token).chat.completions.create(chat);
    expect(res.anyroute.receiptVerification?.valid).toBe(true);
    expect(res.anyroute.receipt?.payload.nullifier).toBe(await sdkNullifier(token));
    expect(res.anyroute.receipt?.payload.nullifier).toBe(nullifierOf(decodeBase64(token)!));
    expect(res.anyroute.receipt?.payload.payer).toBeNull();
    // A token is single use.
    const again = await c.withPrivateToken(token).chat.completions.create(chat).catch((x) => x);
    expect(again.status).toBe(401);
  });

  test("the router's honest 'simulated' and 'unverified' states are refused by verify-before-send", async () => {
    const k = await h.fundedKey(5n);
    const c = new AnyRoute({ baseUrl: "http://router.test", apiKey: k.secret, fetch: shim(h) });
    const before = await c.attestation("enclave");
    expect(before?.status).toBe("unverified");
    expect(await c.attestation("nobody")).toBeNull();
    const refused = await c.chat.completions.create(chat, { attested: { providerId: "enclave", attestUrl: "https://enclave.test" } }).catch((x) => x);
    expect(refused).toBeInstanceOf(AttestationRefused);
    expect(refused.verification.checks.find((x: { id: string }) => x.id === "router.status").status).toBe("fail");

    expect(((await runAttestor(h.ctx)).results as { ok: boolean }[]).every((r) => r.ok)).toBe(true);
    const sim = await c.attestation("enclave");
    expect(sim?.status).toBe("simulated");
    const v = await c.verifyProvider({ providerId: "enclave", attestUrl: "https://enclave.test" });
    expect(v.ok).toBe(false);
    expect(v.checks.find((x) => x.id === "router.status")?.detail).toMatch(/simulated/i);
  });
});

describe("against the sidecar over real TLS", () => {
  afterAll(cleanup);

  test("evidence the sidecar's own code produces passes the client's checks, receipts bind to it, and tampering does not", async () => {
    const h = await sidecarHarness({ provider: dstackProvider({ composeHash: `sha256:${"ce".repeat(32)}` }), raw: { attestation: { provider: "dstack" }, image_digest: `sha256:${"1e".repeat(32)}` }, env: {} });
    const server = startServer({ ...h.rt, cfg: { ...h.rt.cfg, server: { ...h.rt.cfg.server, host: "127.0.0.1", port: 0 } } });
    try {
      const base = `https://127.0.0.1:${server.port}`;
      const boot = (await (await fetch(`${base}/attest`, { tls: { ca: h.rt.tls!.certPem } })).json()) as any;
      // The router's side of the story, as the router's endpoint would report it for this provider.
      const router = {
        provider: "sidecar-test",
        status: "attested" as const,
        tee: "tdx",
        attested_at: new Date().toISOString(),
        attestation_hash: null,
        verifiers: ["dcap"],
        measurement: { image_digest: boot.bindings.image_digest, compose_hash: boot.bindings.compose_hash, model_digest: boot.bindings.model_digest, status: "observed", attested_now: true, first_attested_at: "", last_seen_at: "", transparency_log: { found: false, inclusion_verified: false, checkpoint_signature_verified: false }, registry: { address: null, state: "not_submitted", tx_hash: null, registered_at: null } },
        checks: { quote_verified: true, digests_bound_to_quote: true, transparency_log_entry: false, transparency_log_checkpoint_signature: false, registered_on_chain: false },
        not_checked: [],
      };
      const routerFetch = async () => new Response(JSON.stringify({ data: router }), { headers: { "content-type": "application/json" } });
      // The certificate is read from the very connection that served /attest, then compared with the quote.
      const v = await verifyProvider({ routerUrl: "http://router.test", providerId: "sidecar-test", attestUrl: `${base}/attest`, fetch: routerFetch as never, attestFetcher: nodeAttestFetcher(), expected: { modelDigest: h.model.digest } });
      expect(v.failures).toEqual([]);
      expect(v.ok).toBe(true);
      for (const id of ["provider.report_data", "provider.fresh_quote", "provider.tls_san", "provider.tls_key", "provider.receipt_key"]) expect(v.checks.find((x) => x.id === id)?.status).toBe("pass");

      // A real receipt from the sidecar verifies under the attested key and names this attestation.
      const res = await fetch(`${base}/v1/chat/completions`, { tls: { ca: h.rt.tls!.certPem }, method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: "ok", messages: [] }) });
      const env = decodeReceiptHeader(res.headers.get("x-anyroute-receipt")!);
      const sr = await verifySidecarReceipt(env as never, v.bound!);
      expect(sr.valid).toBe(true);
      env.payload.usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      expect((await verifySidecarReceipt(env as never, v.bound!)).valid).toBe(false);

      // Refusals: the router's record disagrees with what the sidecar binds; the caller expects another model.
      const lying = { ...router, measurement: { ...router.measurement, model_digest: "sha256:" + "aa".repeat(32) } };
      const bad = await verifyProvider({ routerUrl: "http://router.test", providerId: "sidecar-test", attestUrl: `${base}/attest`, fetch: (async () => new Response(JSON.stringify({ data: lying }))) as never, attestFetcher: nodeAttestFetcher() });
      expect(bad.ok).toBe(false);
      expect(bad.checks.find((x) => x.id === "router.matches_provider")?.status).toBe("fail");
      const wrongModel = await verifyProvider({ routerUrl: "http://router.test", providerId: "sidecar-test", attestUrl: `${base}/attest`, fetch: routerFetch as never, attestFetcher: nodeAttestFetcher(), expected: { modelDigest: "sha256:" + "bb".repeat(32) } });
      expect(wrongModel.ok).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("simulated (development) sidecar evidence is refused", async () => {
    const h = await sidecarHarness();
    const boot = (await (await h.call("/attest", { key: null })).json()) as any;
    expect(boot.dev).toBe(true);
    const router = { provider: "dev", status: "simulated", tee: "dev", attested_at: new Date().toISOString(), attestation_hash: null, verifiers: [], measurement: null, checks: { quote_verified: false, digests_bound_to_quote: false, transparency_log_entry: false, transparency_log_checkpoint_signature: false, registered_on_chain: false }, not_checked: [] };
    const { evaluateAttestation } = await import("../packages/client/src/index.ts");
    const v = await evaluateAttestation({ providerId: "dev", router: router as never, boot, certificate: h.rt.tls?.certPem ?? null });
    expect(v.simulated).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.checks.find((x) => x.id === "provider.simulated")?.status).toBe("fail");
  });
});

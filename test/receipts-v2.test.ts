import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { CborTag, cborDecode, cborEncode } from "../src/receipts/cbor.ts";
import { readFileSync } from "node:fs";
import { chainOf, coseSign1, decodeCoseSign1, encodeClaims, receiptLeafV2, tokenBucket } from "../src/receipts/v2.ts";
import { verifyCoseWithRawKey } from "../src/receipts/signer.ts";
import { MerkleTree } from "../src/receipts/merkle.ts";
import { runAnchor, runKeyRotation } from "../src/services/anchor.ts";
import { anchors } from "../src/db/schema.ts";
import { checkChain, decodeReceiptV2, verifyReceipt as sdkVerifyReceipt, verifyReceiptV2 as sdkVerifyV2 } from "../packages/client/src/index.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// RFC 8032 Section 7.1, test 1.
const RFC8032_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const rfcKey = () => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(RFC8032_SEED, "hex")]), format: "der", type: "pkcs8" });

describe("deterministic CBOR", () => {
  test("RFC 8949 Appendix A vectors", () => {
    const vectors: [Parameters<typeof cborEncode>[0], string][] = [
      [0, "00"], [23, "17"], [24, "1818"], [100, "1864"], [1000, "1903e8"], [1000000, "1a000f4240"], [1000000000000, "1b000000e8d4a51000"],
      [-1, "20"], [-100, "3863"], [-1000, "3903e7"], ["", "60"], ["a", "6161"], ["IETF", "6449455446"], ["ü", "62c3bc"],
      [Uint8Array.of(1, 2, 3, 4), "4401020304"], [[], "80"], [[1, [2, 3], [4, 5]], "8301820203820405"], [{}, "a0"],
      [{ a: 1, b: [2, 3] }, "a26161016162820203"], [true, "f5"], [false, "f4"], [null, "f6"], [new CborTag(1, 1363896240), "c11a514b67b0"],
    ];
    for (const [v, h] of vectors) {
      expect(hex(cborEncode(v))).toBe(h);
      expect(hex(cborEncode(cborDecode(Buffer.from(h, "hex"))))).toBe(h);
    }
  });

  test("map keys sort by encoded bytes, whatever the insertion order; malformed input is refused", () => {
    expect(hex(cborEncode({ b: 1, a: 2 }))).toBe(hex(cborEncode({ a: 2, b: 1 })));
    expect(hex(cborEncode({ aa: 1, b: 2 }))).toBe("a261620262616101"); // "b" (0x61 0x62) before "aa" (0x62 0x61 0x61)
    expect(hex(cborEncode(new Map([[4, 0], [1, -8]])))).toBe("a201270400");
    expect(() => cborEncode(0.5)).toThrow();
    expect(() => cborDecode(Buffer.from("a2616201616102", "hex"))).toThrow(/order/); // keys out of order
    expect(() => cborDecode(Buffer.from("1817", "hex"))).toThrow(/shortest/);
    expect(() => cborDecode(Buffer.from("9f01ff", "hex"))).toThrow(); // indefinite length
    expect(() => cborDecode(Buffer.from("0000", "hex"))).toThrow(/trailing/);
  });
});

describe("COSE_Sign1 (EdDSA)", () => {
  const payload = cborEncode({ v: 2, rid: "gen-1790000000-test", iat: 1790000000 });
  const KNOWN =
    "d2844da2012704480102030405060708a05825a3617602636961741a6ab13b80637269647367656e2d313739303030303030302d74657374" +
    "58406adcdf8097e9c445383c0f1bf370542a4e9714390ead46fa86a25c7932fae7236188a968bb30073df7a05b19475a866cf4cdfe04def3bb4f66a3a1ffb1f6cf07";

  test("known vector: RFC 8032 key, fixed claims, byte-exact output", () => {
    const key = rfcKey();
    expect(createPublicKey(key).export({ format: "jwk" }).x).toBe(Buffer.from(RFC8032_PUB, "hex").toString("base64url"));
    const cose = coseSign1(payload, Buffer.from("0102030405060708", "hex"), (m) => sign(null, m, key));
    expect(hex(cose)).toBe(KNOWN);
    // Protected header {1: -8, 4: h'0102030405060708'}, tag 18, empty unprotected map.
    const d = decodeCoseSign1(cose);
    expect(hex(d.protectedBytes)).toBe("a2012704480102030405060708");
    expect(d.alg).toBe(-8);
    expect(verifyCoseWithRawKey(cose, RFC8032_PUB)).toBe(true);
  });

  test("round trip through the independent SDK decoder; any changed byte fails", async () => {
    const cose = Buffer.from(KNOWN, "hex");
    const d = decodeReceiptV2(cose);
    expect(d.keyId).toBe("0102030405060708");
    expect(d.claims).toEqual({ v: 2, rid: "gen-1790000000-test", iat: 1790000000 });
    for (const at of [20, 40, cose.length - 5]) {
      const bad = Buffer.from(cose);
      bad[at] ^= 1;
      expect(verifyCoseWithRawKey(bad, RFC8032_PUB)).toBe(false);
    }
    expect(verifyCoseWithRawKey(cose, "00".repeat(32))).toBe(false);
  });
});

describe("token buckets", () => {
  test("power-of-two ranges, lower bound inclusive", () => {
    const cases: [number, string][] = [[0, "0"], [1, "1-2"], [2, "2-4"], [3, "2-4"], [127, "64-128"], [128, "128-256"], [511, "256-512"], [512, "512-1024"], [1023, "512-1024"], [1024, "1024-2048"], [-5, "0"]];
    for (const [n, b] of cases) expect(tokenBucket(n)).toBe(b);
  });
});

/** Parse a raw SSE transcript into data events (before the receipt) with the chain value that followed each. */
function parseStream(raw: string) {
  const events: { data: string; chain?: string }[] = [];
  let final: any = null;
  let index = 0;
  for (const block of raw.split("\n\n")) {
    const link = /^: anyroute-chain (\d+) ([0-9a-f]{64})$/.exec(block.trim());
    if (link) {
      expect(Number(link[1])).toBe(events.length);
      events[events.length - 1].chain = link[2];
      continue;
    }
    if (!block.startsWith("data: ") || block === "data: [DONE]") continue;
    const data = block.slice(6);
    const obj = JSON.parse(data);
    if (obj.receipt) final = obj;
    else events.push({ data });
    index++;
  }
  return { events, final, index };
}

describe("receipts v2 over the API", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  const chat = (auth: Record<string, string>, body: Record<string, unknown>) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: LLAMA, messages: [{ role: "user", content: "hello there, stream this" }], ...body } });

  test("a stream carries c_i after every event and the receipt signs the head; a cut stream fails", async () => {
    const k = await h.fundedKey(5n);
    const r = await chat(k.auth, { stream: true });
    const raw = await r.text();
    const { events, final } = parseStream(raw);
    expect(events.length).toBeGreaterThan(1);
    expect(final.receipt.v2).toBeDefined();
    const rid = final.receipt.id;
    expect(r.headers.get("x-receipt-id")).toBe(rid);
    const claims = final.receipt.v2.claims;
    // Every sent value is c_i, and the signed head is c_n.
    const { steps, head } = chainOf(rid, events.map((e) => e.data));
    expect(events.map((e) => e.chain)).toEqual(steps);
    expect(claims.resp.chain).toBe(head);
    expect(claims.resp.stream).toBe(true);
    const sdk = await checkChain(rid, events);
    expect(sdk).toMatchObject({ ok: true, head, firstMismatch: null });

    // The router checks the same thing.
    const keys = await (await h.request("/.well-known/anyroute-receipt-keys.json")).json();
    const ok = (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { cose: final.receipt.v2.cose, chunks: events.map((e) => e.data) } })).json()).data;
    expect(ok).toMatchObject({ version: 2, signature_valid: true, chain_valid: true, valid: true });
    // Truncation: the last event missing.
    const cut = (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { cose: final.receipt.v2.cose, chunks: events.slice(0, -1).map((e) => e.data) } })).json()).data;
    expect(cut).toMatchObject({ signature_valid: true, chain_valid: false, valid: false });
    expect((await sdkVerifyV2(final.receipt.v2.cose, { keys, chunks: events.slice(0, -1).map((e) => e.data) })).checks.find((c) => c.id === "chain")?.status).toBe("fail");
    // An altered middle event is caught at its own index.
    const altered = events.map((e, i) => (i === 1 ? { ...e, data: e.data.replace(/"content":"/, '"content":"X') } : e));
    expect((await checkChain(rid, altered)).firstMismatch).toBe(2);
    // The whole stream verifies with the SDK: signature, chain.
    const v = await sdkVerifyV2(final.receipt.v2.cose, { keys, chunks: events.map((e) => e.data) });
    expect(v.valid).toBe(true);
    expect(v.checks.map((c) => [c.id, c.status])).toEqual([["alg", "pass"], ["claims", "pass"], ["key", "pass"], ["signature", "pass"], ["hashes", "not_checked"], ["chain", "pass"], ["anchor_proof", "not_checked"]]);
  });

  test("public claims are bucketed and name no payer; the account view keeps exact usage", async () => {
    const k = await h.fundedKey(5n);
    const j = await (await chat(k.auth, {})).json();
    const pub = (await (await h.request(`/api/v1/receipts/${j.id}`)).json()).data;
    expect(pub.version).toBe(2);
    const claims = pub.v2.claims;
    expect(claims).toMatchObject({ v: 2, rid: j.id, model: { id: LLAMA }, req: { n_in_bucket: tokenBucket(j.usage.prompt_tokens) }, resp: { n_out_bucket: tokenBucket(j.usage.completion_tokens), stream: false, complete: true, finish: "stop" }, lane: expect.any(String) });
    expect(claims.req.h).toBe(`sha256:${j.receipt.payload.request_sha256}`);
    expect(claims.resp.h).toBe(`sha256:${j.receipt.payload.response_sha256}`);
    expect(claims.resp.chain).toBeUndefined(); // not streamed
    expect(claims.credit.cost_units).toBeGreaterThan(0);
    const flat = JSON.stringify(claims);
    for (const leak of ["payer", "payment_tx", "tokens", "prompt_tokens", "ip", k.secret]) expect(flat).not.toContain(`"${leak}"`);
    // The claims in the JSON view are exactly what the COSE payload signs.
    expect(decodeReceiptV2(pub.v2.cose).claims).toEqual(claims);
    // v1 fields are untouched and still verify.
    expect(pub).toMatchObject({ id: j.id, payload: j.receipt.payload, sig: j.receipt.sig, key_id: j.receipt.key_id });
    const v1 = (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: pub.payload, sig: pub.sig, key_id: pub.key_id } })).json()).data;
    expect(v1.valid).toBe(true);
    const keys = await (await h.request("/.well-known/anyroute-receipt-keys.json")).json();
    expect((await sdkVerifyReceipt(j.receipt, { keys })).valid).toBe(true); // an inline v1 envelope with a v2 field beside it
    // Hash check: what the caller holds must match.
    const hashes = (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { cose: pub.v2.cose, request_sha256: j.receipt.payload.request_sha256, response_sha256: "00".repeat(32) } })).json()).data;
    expect(hashes).toMatchObject({ signature_valid: true, hashes_valid: false, valid: false });
    // Owner-only view: exact counts.
    const g = (await (await h.request(`/api/v1/generation?id=${j.id}`, { headers: k.auth })).json()).data;
    expect(g.native_tokens_prompt).toBe(j.usage.prompt_tokens);
    expect(g.receipt_v2.cose).toBe(pub.v2.cose);
  });

  test("?format=cose returns the COSE bytes", async () => {
    const k = await h.fundedKey(5n);
    const j = await (await chat(k.auth, {})).json();
    const r = await h.request(`/api/v1/receipts/${j.id}?format=cose`);
    expect(r.headers.get("content-type")).toContain("application/cose");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(Buffer.from(bytes).toString("base64")).toBe(j.receipt.v2.cose);
    expect(await (await h.request(`/api/v1/receipts/${j.id}?format=cose&encoding=base64`)).text()).toBe(j.receipt.v2.cose);
    expect(receiptLeafV2(bytes)).toBe(j.receipt.v2.leaf);
    expect((await h.request(`/api/v1/receipts/gen-nope?format=cose`)).status).toBe(404);
  });

  test("proof: pending until rooted, then a Merkle path for the v2 leaf; anchored only when the root is on chain", async () => {
    const k = await h.fundedKey(5n);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await (await chat(k.auth, { messages: [{ role: "user", content: `p${i}` }] })).json()).id);
    const before = (await (await h.request(`/api/v1/receipts/${ids[1]}/proof`)).json()).data;
    expect(before).toMatchObject({ rid: ids[1], rooted: false, anchored: false, leaf_version: 2 });
    await runKeyRotation(h.ctx);
    await Bun.sleep(1100);
    const a = await runAnchor(h.ctx);
    expect(a.anchored).toBeGreaterThanOrEqual(3);
    const keys = await (await h.request("/.well-known/anyroute-receipt-keys.json")).json();
    for (const id of ids) {
      const p = (await (await h.request(`/api/v1/receipts/${id}/proof`)).json()).data;
      const rec = (await (await h.request(`/api/v1/receipts/${id}`)).json()).data;
      expect(p).toMatchObject({ rooted: true, leaf_version: 2, leaf: rec.v2.leaf, root: a.root });
      expect(MerkleTree.verify(p.leaf, p.proof, p.root)).toBe(true);
      // The v1 leaf is in the same tree and its path still verifies (v1 clients).
      expect(MerkleTree.verify(rec.leaf, rec.anchor.proof, rec.anchor.root)).toBe(true);
      const p1 = (await (await h.request(`/api/v1/receipts/${id}/proof?v=1`)).json()).data;
      expect(p1.leaf).toBe(rec.leaf);
      // Order: signature, hashes, chain, proof.
      const v = await sdkVerifyV2(rec.v2.cose, { keys, proof: p });
      expect(v.valid).toBe(true);
      expect(v.anchor).toBe("proof_valid");
      const server = (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { cose: rec.v2.cose, anchor: { root: p.root, proof: p.proof, index: p.anchor_index } } })).json()).data;
      expect(server).toMatchObject({ signature_valid: true, inclusion_valid: true, valid: true });
    }
    // The test chain accepted the root, so it reads as anchored. A root kept off chain (escrow mode) says so.
    expect((await (await h.request(`/api/v1/receipts/${ids[0]}/proof`)).json()).data.anchored).toBe(true);
    await h.ctx.db.update(anchors).set({ status: "local", txHash: null }).where(eq(anchors.index, a.index!));
    const local = (await (await h.request(`/api/v1/receipts/${ids[0]}/proof`)).json()).data;
    expect(local).toMatchObject({ rooted: true, anchored: false, status: "local", tx: null });
  });
});

describe("shared v2 fixture (SDK and web verifier use the same bytes)", () => {
  const fx = JSON.parse(readFileSync(new URL("../packages/client/test/fixtures/receipt-v2.json", import.meta.url), "utf8"));

  test("the router's code reproduces the fixture byte for byte", () => {
    const cose = coseSign1(encodeClaims(fx.claims), Buffer.from(fx.key_id, "hex"), (m) => sign(null, m, rfcKey()));
    expect(Buffer.from(cose).toString("base64")).toBe(fx.cose);
    expect(chainOf(fx.claims.rid, fx.chunks)).toEqual({ steps: fx.chain_steps, head: fx.claims.resp.chain });
    expect(receiptLeafV2(cose)).toBe(fx.leaf);
  });

  test("the SDK verifies it in order and flags a truncated stream", async () => {
    const ok = await sdkVerifyV2(fx.cose, { publicKeyHex: fx.public_key_hex, chunks: fx.chunks, responseSha256: fx.claims.resp.h });
    expect(ok.valid).toBe(true);
    expect(ok.leaf).toBe(fx.leaf);
    const cut = await sdkVerifyV2(fx.cose, { publicKeyHex: fx.public_key_hex, chunks: fx.chunks.slice(0, 2) });
    expect(cut.valid).toBe(false);
    expect(cut.checks.find((c) => c.id === "chain")?.status).toBe("fail");
    const wrongKey = await sdkVerifyV2(fx.cose, { publicKeyHex: "00".repeat(32) });
    expect(wrongKey.valid).toBe(false);
  });
});

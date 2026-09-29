import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { HPKE_CONTENT_TYPE, HPKE_STREAM_CONTENT_TYPE } from "../src/hpke.ts";
import { openResponse, ResponseOpener, sealRequest } from "../src/hpke-client.ts";
import { decodeReceiptHeader, verifyReceipt, type ReceiptEnvelope } from "../src/receipts.ts";
import { bindingsDigest, reportDataHex } from "../src/reportdata.ts";
import { cleanup, harness, makeModel, startClassifier, type Harness } from "./helpers.ts";

afterEach(cleanup);

const PATH = "/v1/chat/completions";
const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const sha = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const chatBody = (over: Record<string, unknown> = {}) => ({ model: "ok", messages: [{ role: "user", content: "a private question" }], ...over });
const posts = (h: Harness) => h.upstream.seen.filter((s) => s.method === "POST");

/** Encrypt `body` to the key the sidecar publishes and send it. */
async function send(h: Harness, body: unknown, o: { path?: string; now?: number; headers?: Record<string, string>; key?: string | null; raw?: Uint8Array } = {}) {
  const path = o.path ?? PATH;
  const sealed = await sealRequest(h.rt.hpke!.publicKeyHex, path, typeof body === "string" ? utf8(body) : utf8(JSON.stringify(body)), { now: o.now });
  const wire = o.raw ?? sealed.body;
  const res = await h.call(path, { method: "POST", headers: { "content-type": HPKE_CONTENT_TYPE, ...(o.headers ?? {}) }, body: wire, key: o.key });
  return { res, sealed, wire };
}

const receiptOf = (res: Response): ReceiptEnvelope => decodeReceiptHeader(res.headers.get("x-anyroute-receipt")!);

/** Split a response body into the bytes before the last frame and the frame count. */
function beforeLastFrame(wire: Uint8Array): { head: Uint8Array; frames: number } {
  let pos = 16;
  let last = 16;
  let frames = 0;
  while (pos < wire.length) {
    last = pos;
    pos += 5 + new DataView(wire.buffer, wire.byteOffset + pos + 1).getUint32(0);
    frames++;
  }
  return { head: wire.subarray(0, last), frames };
}

describe("end-to-end encrypted requests", () => {
  test("a JSON exchange: the model server gets the plaintext, the client gets an encrypted answer and a receipt over the ciphertexts", async () => {
    const h = await harness({ hpke: true });
    const { res, sealed, wire } = await send(h, chatBody(), { headers: { accept: HPKE_CONTENT_TYPE, "x-request-id": "abc123", "x-forwarded-for": "203.0.113.9" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(HPKE_CONTENT_TYPE);
    expect(res.headers.get("x-anyroute-inner-content-type")).toContain("application/json");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(text(bytes)).not.toContain("Hello"); // the answer is not on the wire in the clear
    const plain = JSON.parse(text(openResponse(sealed.opener, bytes)));
    expect(plain.choices[0].message.content).toBe("Hello");

    // What the model server saw: the plaintext request as a plain JSON call, and none of the outer headers.
    const seen = posts(h)[0];
    expect(seen.body).toBe(JSON.stringify(chatBody()));
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(seen.headers["accept"] ?? "").not.toContain("anyroute"); // the outer Accept is not passed on
    expect(seen.headers["x-request-id"]).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain("203.0.113.9");

    // The receipt covers what crossed the wire, which the client can hash too.
    const env = receiptOf(res);
    expect(verifyReceipt(env, h.rt.signer.publicKeyHex)).toBe(true);
    expect(env.payload).toMatchObject({ path: PATH, status: 200, stream: false, complete: true, e2ee: "anyroute-hpke-v1", usage: { total_tokens: 7 } });
    expect(env.payload.req_hash).toBe(sha(wire));
    expect(env.payload.resp_hash).toBe(sha(bytes));
    expect("classifier" in env.payload).toBe(false);
    expect((await h.call(`/v1/receipts/${env.payload.id}`)).status).toBe(200);
  });

  test("embeddings work the same way", async () => {
    const h = await harness({ hpke: true });
    const { res, sealed } = await send(h, { model: "ok", input: "text to embed" }, { path: "/v1/embeddings" });
    expect(res.status).toBe(200);
    expect(JSON.parse(text(openResponse(sealed.opener, new Uint8Array(await res.arrayBuffer())))).data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  test("a stream comes back as encrypted frames, readable as they arrive, ending with the receipt", async () => {
    const h = await harness({ hpke: true });
    const { res, sealed } = await send(h, chatBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(HPKE_STREAM_CONTENT_TYPE);
    expect(res.headers.get("x-anyroute-inner-content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-anyroute-receipt-id")).toMatch(/^rcpt_/);
    const reader = res.body!.getReader();
    const pieces: string[] = [];
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      for (const p of sealed.opener.feed(value)) pieces.push(text(p));
    }
    sealed.opener.end();
    expect(pieces.length).toBeGreaterThanOrEqual(3); // several upstream chunks, then the receipt frame
    const all = pieces.join("");
    expect(all).toContain('"content":"Hel"');
    expect(all).toContain("data: [DONE]");
    const wire = new Uint8Array(Buffer.concat(chunks));
    expect(text(wire)).not.toContain("Hel");
    const env: ReceiptEnvelope = JSON.parse(/event: anyroute\.receipt\ndata: (.+)\n\n$/.exec(all)![1]);
    expect(verifyReceipt(env, h.rt.signer.publicKeyHex)).toBe(true);
    expect(env.payload).toMatchObject({ stream: true, complete: true, e2ee: "anyroute-hpke-v1", usage: { total_tokens: 7 } });
    // resp_hash covers everything the client received before the last frame (the one that carries the receipt).
    const { head, frames } = beforeLastFrame(wire);
    expect(frames).toBe(pieces.length);
    expect(env.payload.resp_hash).toBe(sha(head));
    // The same receipt can be fetched afterwards.
    const again = await (await h.call(`/v1/receipts/${res.headers.get("x-anyroute-receipt-id")}`)).json();
    expect(again.leaf).toBe(env.leaf);
  });

  test("a stream cut off upstream still ends with a final frame that says it was incomplete", async () => {
    const h = await harness({ hpke: true });
    const { res, sealed } = await send(h, chatBody({ model: "truncate", stream: true }));
    const plain = text(openResponse(sealed.opener, new Uint8Array(await res.arrayBuffer())));
    const env: ReceiptEnvelope = JSON.parse(/event: anyroute\.receipt\ndata: (.+)\n\n$/.exec(plain)![1]);
    expect(env.payload.complete).toBe(false);
    expect(verifyReceipt(env, h.rt.signer.publicKeyHex)).toBe(true);
  });

  test("an error from the model server is passed through, encrypted, without a receipt", async () => {
    const h = await harness({ hpke: true });
    const { res, sealed } = await send(h, chatBody({ model: "error" }));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe(HPKE_CONTENT_TYPE);
    expect(res.headers.get("x-anyroute-receipt")).toBeNull();
    expect(JSON.parse(text(openResponse(sealed.opener, new Uint8Array(await res.arrayBuffer())))).error.message).toBe("boom");
  });

  test("plain JSON keeps working next to encrypted requests, and its receipts carry no e2ee field", async () => {
    const h = await harness({ hpke: true });
    const res = await h.chat(chatBody());
    expect(res.status).toBe(200);
    expect("e2ee" in receiptOf(res).payload).toBe(false);
    const wrong = await h.call(PATH, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(wrong.status).toBe(415);
    expect((await wrong.json()).error.message).toContain(HPKE_CONTENT_TYPE);
  });

  test("with the feature off the encrypted content type is refused as before", async () => {
    const h = await harness();
    expect(h.rt.hpke).toBeNull();
    const res = await h.call(PATH, { method: "POST", headers: { "content-type": HPKE_CONTENT_TYPE }, body: new Uint8Array(100) });
    expect(res.status).toBe(415);
    expect((await res.json()).error.message).toBe("content-type must be application/json");
    expect(posts(h)).toHaveLength(0);
  });

  test("requests that cannot be opened never reach the model server", async () => {
    const h = await harness({ hpke: true });
    const code = async (r: Response) => (await r.json()).error.code;
    const good = await send(h, chatBody());
    expect(good.res.status).toBe(200);
    expect(posts(h)).toHaveLength(1);

    const replay = await send(h, chatBody(), { raw: good.wire });
    expect(replay.res.status).toBe(400);
    expect(await code(replay.res)).toBe("request_replayed");

    const flipped = new Uint8Array((await sealRequest(h.rt.hpke!.publicKeyHex, PATH, utf8(JSON.stringify(chatBody())))).body);
    flipped[flipped.length - 2] ^= 1;
    const tampered = await send(h, chatBody(), { raw: flipped });
    expect(await code(tampered.res)).toBe("decryption_failed");

    const stale = await send(h, chatBody(), { now: Date.now() - 3_600_000 });
    expect(await code(stale.res)).toBe("request_expired");

    const short = await send(h, chatBody(), { raw: new Uint8Array(10) });
    expect(await code(short.res)).toBe("invalid_encryption");

    const otherPath = await sealRequest(h.rt.hpke!.publicKeyHex, "/v1/embeddings", utf8("{}"));
    const misdirected = await h.call(PATH, { method: "POST", headers: { "content-type": HPKE_CONTENT_TYPE }, body: otherPath.body });
    expect(await code(misdirected)).toBe("decryption_failed");

    expect(posts(h)).toHaveLength(1); // only the good one
  });

  test("what decrypts must still be a valid request: bad JSON and the wrong model are refused in the clear", async () => {
    const model = await makeModel();
    const h = await harness({ hpke: true, model, raw: { model: { path: model.dir, served_name: "only-this" } } });
    const bad = await send(h, "not json");
    expect(bad.res.status).toBe(400);
    expect((await bad.res.json()).error.code).toBe("invalid_json");
    const wrong = await send(h, chatBody());
    expect(wrong.res.status).toBe(404);
    expect((await wrong.res.json()).error.code).toBe("model_not_found");
    expect((await send(h, chatBody({ model: "only-this" }))).res.status).toBe(200);
    expect(posts(h)).toHaveLength(1);
  });

  test("authentication and quota apply before and around decryption", async () => {
    const h = await harness({ hpke: true, raw: { quota: { default: { requests_per_minute: 60, burst: 2 } } } });
    const anon = await send(h, chatBody(), { key: null });
    expect(anon.res.status).toBe(401);
    expect((await send(h, chatBody())).res.status).toBe(200);
    expect((await send(h, chatBody())).res.status).toBe(200);
    expect((await send(h, chatBody())).res.status).toBe(429);
  });

  test("the request size cap applies to the encrypted body", async () => {
    const h = await harness({ hpke: true, raw: { upstream: { max_request_bytes: 2048 } } });
    const { res } = await send(h, chatBody({ messages: [{ role: "user", content: "x".repeat(4000) }] }));
    expect(res.status).toBe(413);
  });
});

describe("the key in the attestation", () => {
  test("the public key is bound into the report data and published at /attest and in the discovery document", async () => {
    const h = await harness({ hpke: true });
    const doc = await (await h.call("/attest", { key: null })).json();
    expect(doc.bindings.hpke_pubkey).toBe(h.rt.hpke!.publicKeyHex);
    expect(h.rt.bindings.hpkePubkey).toBe(h.rt.hpke!.publicKeyHex);
    expect(doc.hpke).toMatchObject({
      enabled: true,
      public_key: h.rt.hpke!.publicKeyHex,
      key_id: h.rt.hpke!.keyId,
      suite: { kem_id: 0x20, kdf_id: 1, aead_id: 1 },
      mode: "base",
      request_content_type: HPKE_CONTENT_TYPE,
    });
    expect(doc.evidence.report_data).toBe(reportDataHex(h.rt.bindings));
    expect(doc.evidence.report_data.slice(0, 64)).toBe(Buffer.from(bindingsDigest(h.rt.bindings)).toString("hex"));
    // A different key would be a different report data: the quote vouches for this key and no other.
    const other = await harness({ hpke: true });
    expect(other.rt.hpke!.publicKeyHex).not.toBe(h.rt.hpke!.publicKeyHex);
    // A fresh quote bound to a client nonce carries it too.
    const nonce = "9d".repeat(32);
    const fresh = await (await h.call(`/attest?nonce=${nonce}`, { key: null })).json();
    expect(fresh.bindings.hpke_pubkey).toBe(h.rt.hpke!.publicKeyHex);
    expect(fresh.evidence.report_data).toBe(reportDataHex(h.rt.bindings, Buffer.from(nonce, "hex")));
    const well = await (await h.call("/.well-known/anyroute-sidecar.json", { key: null })).json();
    expect(well.hpke).toEqual({ enabled: true, public_key: h.rt.hpke!.publicKeyHex, key_id: h.rt.hpke!.keyId, content_type: HPKE_CONTENT_TYPE });
    expect((await (await h.call("/healthz", { key: null })).json()).hpke).toEqual({ enabled: true, key_id: h.rt.hpke!.keyId });
  });

  test("a client that takes the key from /attest can use it", async () => {
    const h = await harness({ hpke: true });
    const doc = await (await h.call("/attest", { key: null })).json();
    const sealed = await sealRequest(doc.hpke.public_key, PATH, utf8(JSON.stringify(chatBody())));
    const res = await h.call(PATH, { method: "POST", headers: { "content-type": HPKE_CONTENT_TYPE }, body: sealed.body });
    expect(res.status).toBe(200);
  });

  test("the key is new at every boot", async () => {
    const a = await harness({ hpke: true });
    const b = await harness({ hpke: true });
    expect(a.rt.hpke!.publicKeyHex).not.toBe(b.rt.hpke!.publicKeyHex);
    // A request sealed to the old key does not open under the new one.
    const old = await sealRequest(a.rt.hpke!.publicKeyHex, PATH, utf8("{}"));
    const res = await b.call(PATH, { method: "POST", headers: { "content-type": HPKE_CONTENT_TYPE }, body: old.body });
    expect((await res.json()).error.code).toBe("decryption_failed");
  });

  test("without the feature nothing about it appears in the bindings, so the report data is what it was before", async () => {
    const h = await harness();
    const doc = await (await h.call("/attest", { key: null })).json();
    expect(Object.keys(doc.bindings).sort()).toEqual(["compose_hash", "image_digest", "model_digest", "receipt_pubkey", "tls_pubkey"]);
    expect(doc.hpke).toEqual({ enabled: false });
    expect(h.rt.bindings.hpkePubkey).toBeUndefined();
  });

  test("classifier and encryption together bind both, and the clock-skew setting is honoured", async () => {
    const h = await harness({ hpke: { clock_skew_seconds: 60 }, classifier: { mock: startClassifier() } });
    expect(Object.keys((await (await h.call("/attest", { key: null })).json()).bindings).sort()).toEqual([
      "classifier_digest",
      "classifier_enabled",
      "classifier_policy",
      "compose_hash",
      "hpke_pubkey",
      "image_digest",
      "model_digest",
      "receipt_pubkey",
      "tls_pubkey",
    ]);
    const stale = await send(h, chatBody(), { now: Date.now() - 120_000 });
    expect((await stale.res.json()).error.code).toBe("request_expired"); // outside the 60 s window
    expect((await send(h, chatBody(), { now: Date.now() - 30_000 })).res.status).toBe(200);
  });
});

describe("encryption together with the classifier", () => {
  const TRIGGER = "[[TRIGGER:minor_sexual_content]]";

  test("the classifier reads the decrypted text; a hit is refused in the clear with the bit set and nothing forwarded", async () => {
    const mock = startClassifier();
    const h = await harness({ hpke: true, classifier: { mock } });
    const ok = await send(h, chatBody({ messages: [{ role: "user", content: "an ordinary question" }] }));
    expect(ok.res.status).toBe(200);
    expect(receiptOf(ok.res).payload).toMatchObject({ e2ee: "anyroute-hpke-v1", classifier: { enabled: true, blocked: false } });
    const seen = JSON.parse(mock.seen.find((s) => s.method === "POST")!.body).messages[1].content;
    expect(seen).toContain("an ordinary question"); // the plaintext, not the ciphertext

    const hit = await send(h, chatBody({ messages: [{ role: "user", content: `text with ${TRIGGER}` }] }));
    expect(hit.res.status).toBe(400);
    const body = await hit.res.text();
    expect(JSON.parse(body).error.code).toBe("content_policy_violation");
    expect(body).not.toContain("TRIGGER");
    expect(receiptOf(hit.res).payload).toMatchObject({ status: 400, e2ee: "anyroute-hpke-v1", classifier: { blocked: true } });
    expect(verifyReceipt(receiptOf(hit.res), h.rt.signer.publicKeyHex)).toBe(true);
    expect(posts(h)).toHaveLength(1); // only the clean one was forwarded
  });

  test("an unreachable classifier refuses encrypted requests too", async () => {
    const mock = startClassifier();
    const h = await harness({ hpke: true, classifier: { mock } });
    mock.stop();
    const res = await send(h, chatBody());
    expect(res.res.status).toBe(503);
    expect(posts(h)).toHaveLength(0);
  });

  test("with response checking a clean stream is delivered encrypted, a flagged one is withheld", async () => {
    const h = await harness({ hpke: true, classifier: { mock: startClassifier(), config: { check_response: true } } });
    const ok = await send(h, chatBody({ stream: true }));
    expect(ok.res.status).toBe(200);
    const plain = text(openResponse(ok.sealed.opener, new Uint8Array(await ok.res.arrayBuffer())));
    expect(plain).toContain("data: [DONE]");
    const env: ReceiptEnvelope = JSON.parse(/event: anyroute\.receipt\ndata: (.+)\n\n$/.exec(plain)![1]);
    expect(env.payload).toMatchObject({ stream: true, complete: true, e2ee: "anyroute-hpke-v1", classifier: { blocked: false } });
    const flagged = await send(h, chatBody({ model: "trigger-out", stream: true }));
    expect(flagged.res.status).toBe(400);
    expect(await flagged.res.text()).not.toContain("TRIGGER");
    expect(receiptOf(flagged.res).payload.classifier).toMatchObject({ blocked: true });
  });
});

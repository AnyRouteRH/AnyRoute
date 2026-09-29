import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decodeReceiptHeader, verifyReceipt, type ReceiptEnvelope } from "../src/receipts.ts";
import { sha256Hex } from "../src/util.ts";
import { API_KEY, API_KEY_2, cleanup, harness } from "./helpers.ts";

afterEach(cleanup);

const sha = (s: string | Uint8Array) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const chatBody = (over: Record<string, unknown> = {}) => JSON.stringify({ model: "ok", messages: [{ role: "user", content: "hi" }], ...over });

/** Split an SSE body into the upstream part and the sidecar's receipt event. */
function splitReceipt(text: string): { upstream: string; receipt: ReceiptEnvelope | null } {
  const marker = "event: anyroute.receipt\ndata: ";
  const at = text.indexOf(marker);
  if (at < 0) return { upstream: text, receipt: null };
  const rest = text.slice(at + marker.length);
  return { upstream: text.slice(0, at), receipt: JSON.parse(rest.slice(0, rest.indexOf("\n\n"))) };
}

describe("JSON completions", () => {
  test("proxy the exact body and return the upstream response with a signed receipt header", async () => {
    const h = await harness();
    const body = chatBody();
    const res = await h.chat(body);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).choices[0].message.content).toBe("Hello");
    // The model server received the client's bytes untouched.
    expect(h.upstream.seen.filter((s) => s.path === "/v1/chat/completions")[0].body).toBe(body);
    // The receipt.
    const env = decodeReceiptHeader(res.headers.get("x-anyroute-receipt")!);
    expect(verifyReceipt(env, h.rt.signer.publicKeyHex)).toBe(true);
    expect(res.headers.get("x-anyroute-receipt-id")).toBe(env.payload.id);
    expect(env.payload).toMatchObject({
      v: 1,
      type: "anyroute.sidecar.receipt",
      path: "/v1/chat/completions",
      status: 200,
      stream: false,
      complete: true,
      req_hash: sha(body),
      resp_hash: sha(text),
      model_digest: h.model.digest,
      attestation_ref: h.rt.attestationRef,
      nullifier: "",
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      dev: true,
    });
    expect(Math.abs(env.payload.ts - Date.now())).toBeLessThan(5000);
  });

  test("a receipt commits to the response: change one byte and the hash no longer matches", async () => {
    const h = await harness();
    const res = await h.chat(chatBody());
    const env = decodeReceiptHeader(res.headers.get("x-anyroute-receipt")!);
    const text = await res.text();
    expect(env.payload.resp_hash).toBe(sha(text));
    expect(env.payload.resp_hash).not.toBe(sha(text.replace("Hello", "Hallo")));
  });

  test("responses without usage still get a receipt, with usage null", async () => {
    const h = await harness();
    const env = decodeReceiptHeader((await h.chat(chatBody({ model: "no-usage" }))).headers.get("x-anyroute-receipt")!);
    expect(env.payload.usage).toBeNull();
  });

  test("receipts are queued for the anchor and readable by id, by their owner only", async () => {
    const h = await harness();
    const res = await h.chat(chatBody());
    const env = decodeReceiptHeader(res.headers.get("x-anyroute-receipt")!);
    expect(h.rt.queue.pull(0, 10).leaves.map((l) => l.leaf)).toEqual([env.leaf]);
    const own = await h.call(`/v1/receipts/${env.payload.id}`);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual(env);
    expect((await h.call(`/v1/receipts/${env.payload.id}`, { key: API_KEY_2 })).status).toBe(404);
    expect((await h.call(`/v1/receipts/${env.payload.id}`, { key: null })).status).toBe(401);
  });

  test("upstream errors are passed through without a receipt", async () => {
    const h = await harness();
    const res = await h.chat(chatBody({ model: "error" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toBe("boom");
    expect(res.headers.get("x-anyroute-receipt")).toBeNull();
    expect(h.rt.queue.pending).toBe(0);
  });

  test("an unreachable model server is a 502 that does not leak addresses", async () => {
    const h = await harness();
    h.upstream.stop();
    const res = await h.chat(chatBody());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("upstream_unavailable");
    expect(text).not.toContain("127.0.0.1");
    expect(h.rt.queue.pending).toBe(0);
  });

  test("oversized upstream responses are refused", async () => {
    const h = await harness({ raw: { upstream: { max_response_bytes: 10_000 } } });
    const res = await h.chat(chatBody({ model: "huge" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("upstream_response_too_large");
  });
});

describe("embeddings", () => {
  test("are proxied with a receipt carrying prompt-token usage", async () => {
    const h = await harness();
    const body = JSON.stringify({ model: "ok", input: ["hello", "world"] });
    const res = await h.call("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].embedding).toHaveLength(3);
    const env = decodeReceiptHeader(res.headers.get("x-anyroute-receipt")!);
    expect(env.payload.path).toBe("/v1/embeddings");
    expect(env.payload.usage).toEqual({ prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 });
    expect(verifyReceipt(env, h.rt.signer.publicKeyHex)).toBe(true);
  });
});

describe("streaming completions", () => {
  test("pass through byte for byte, then end with a signed receipt event", async () => {
    const h = await harness();
    const res = await h.chat(chatBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const id = res.headers.get("x-anyroute-receipt-id")!;
    const { upstream, receipt } = splitReceipt(await res.text());
    expect(upstream).toContain('"content":"Hel"');
    expect(upstream).toEndWith("data: [DONE]\n\n");
    expect(receipt).not.toBeNull();
    expect(verifyReceipt(receipt!, h.rt.signer.publicKeyHex)).toBe(true);
    expect(receipt!.payload).toMatchObject({
      id,
      stream: true,
      complete: true,
      status: 200,
      req_hash: sha(chatBody({ stream: true })),
      resp_hash: sha(upstream),
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      dev: true,
    });
    expect(h.rt.queue.pull(0, 10).leaves.map((l) => l.leaf)).toEqual([receipt!.leaf]);
    expect((await (await h.call(`/v1/receipts/${id}`)).json()).leaf).toBe(receipt!.leaf);
  });

  test("a stream cut mid-event is marked incomplete and the event is closed before the receipt", async () => {
    const h = await harness();
    const res = await h.chat(chatBody({ stream: true, model: "truncate" }));
    const text = await res.text();
    const { upstream, receipt } = splitReceipt(text);
    expect(upstream).not.toContain("[DONE]");
    expect(receipt!.payload.complete).toBe(false);
    expect(receipt!.payload.resp_hash).toBe(sha(upstream.replace(/\n\n$/, "")));
    expect(verifyReceipt(receipt!, h.rt.signer.publicKeyHex)).toBe(true);
  });

  test("a stalled upstream is cut off by the idle timeout", async () => {
    const h = await harness();
    // idle timeout has a 1 s floor in the config; lower it directly for the test
    (h.rt.cfg.upstream as { streamIdleTimeoutMs: number }).streamIdleTimeoutMs = 150;
    const res = await h.chat(chatBody({ stream: true, model: "stall" }));
    const { upstream, receipt } = splitReceipt(await res.text());
    expect(upstream).toContain('"content":"lo"');
    expect(receipt!.payload.complete).toBe(false);
    expect(verifyReceipt(receipt!, h.rt.signer.publicKeyHex)).toBe(true);
  });

  test("a client that disconnects still leaves an incomplete receipt in the queue", async () => {
    const h = await harness();
    const res = await h.chat(chatBody({ stream: true, model: "stall" }));
    const reader = res.body!.getReader();
    await reader.read(); // first chunk
    await reader.cancel();
    await Bun.sleep(20);
    const leaves = h.rt.queue.pull(0, 10).leaves;
    expect(leaves).toHaveLength(1);
    expect(leaves[0].receipt.payload.complete).toBe(false);
    expect(verifyReceipt(leaves[0].receipt, h.rt.signer.publicKeyHex)).toBe(true);
  });

  test("streams without a usage chunk still get a receipt (usage null)", async () => {
    const h = await harness();
    const { receipt } = splitReceipt(await (await h.chat(chatBody({ stream: true, model: "no-usage" }))).text());
    expect(receipt!.payload.usage).toBeNull();
    expect(receipt!.payload.complete).toBe(true);
  });
});

describe("what the model server sees", () => {
  test("no client network identifier, cookie or credential is forwarded", async () => {
    const h = await harness({ env: { SIDECAR_UPSTREAM_API_KEY: "upstream-secret" } });
    const res = await h.call("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.9, 198.51.100.4",
        "x-forwarded-host": "client.example",
        "x-forwarded-proto": "https",
        forwarded: "for=203.0.113.9;by=198.51.100.4",
        "x-real-ip": "203.0.113.9",
        "cf-connecting-ip": "203.0.113.9",
        "cf-ipcountry": "XX",
        "true-client-ip": "203.0.113.9",
        "x-client-ip": "203.0.113.9",
        via: "1.1 proxy.example",
        cookie: "session=abc",
        "x-amzn-trace-id": "Root=1-abc",
        "x-custom-secret": "hush",
      },
      body: chatBody(),
    });
    expect(res.status).toBe(200);
    const seen = h.upstream.seen.filter((s) => s.path === "/v1/chat/completions")[0];
    const names = Object.keys(seen.headers).sort();
    const allowed = ["accept", "accept-encoding", "authorization", "connection", "content-length", "content-type", "host", "user-agent"];
    expect(names.filter((n) => !allowed.includes(n))).toEqual([]);
    expect(seen.headers.authorization).toBe("Bearer upstream-secret");
    expect(seen.headers["user-agent"]).toBe("anyroute-sidecar");
    const all = JSON.stringify(seen.headers);
    for (const needle of ["203.0.113", "198.51.100", "client.example", "proxy.example", "session=abc", API_KEY, "hush", "Root=1-abc"]) expect(all).not.toContain(needle);
  });

  test("operator-listed headers are forwarded, network identifiers still are not", async () => {
    const h2 = await harness({ raw: { upstream: { forward_headers: ["X-Request-Tag"] } } });
    const up = h2.upstream;
    await h2.call("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-request-tag": "batch-7", "x-forwarded-for": "203.0.113.9" }, body: chatBody() });
    const seen = up.seen.filter((s) => s.path === "/v1/chat/completions").pop()!;
    expect(seen.headers["x-request-tag"]).toBe("batch-7");
    expect(seen.headers["x-forwarded-for"]).toBeUndefined();
  });

  test("the client sees none of the model server's own headers", async () => {
    const h = await harness();
    const res = await h.chat(chatBody());
    expect(res.headers.get("server")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-upstream-secret")).toBeNull();
    const s = await h.chat(chatBody({ stream: true }));
    expect(s.headers.get("set-cookie")).toBeNull();
    expect(s.headers.get("x-upstream-secret")).toBeNull();
    await s.text();
  });

  test("the sidecar's own logs carry no client address or key", async () => {
    const lines: string[] = [];
    const h = await harness();
    h.rt.logger = (level, msg, fields) => lines.push(JSON.stringify({ level, msg, ...fields }));
    // createHandler captured rt (same object), so the replaced logger is used
    await h.call("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: chatBody() });
    const logged = lines.join("\n");
    expect(logged).toContain('"route":"/v1/chat/completions"');
    expect(logged).not.toContain("203.0.113.9");
    expect(logged).not.toContain(API_KEY);
  });
});

describe("authentication and limits", () => {
  test("requires a configured key", async () => {
    const h = await harness();
    for (const key of [null, "wrong-key", ""]) {
      const res = await h.chat(chatBody(), key);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect((await res.json()).error.code).toBe("invalid_api_key");
    }
    expect((await h.chat(chatBody(), API_KEY_2)).status).toBe(200);
    expect(h.upstream.seen.filter((s) => s.path === "/v1/chat/completions")).toHaveLength(1);
  });

  test("anonymous mode serves everyone from one shared quota identity", async () => {
    const h = await harness({ raw: { auth: { allow_anonymous: true }, quota: { default: { requests_per_minute: 60, burst: 1 } } } });
    expect((await h.chat(chatBody(), null)).status).toBe(200);
    expect((await h.chat(chatBody(), "anything")).status).toBe(429);
  });

  test("per-key request quota returns 429 with Retry-After, and other keys are unaffected", async () => {
    const h = await harness({ raw: { quota: { default: { requests_per_minute: 60, burst: 2 } } } });
    expect((await h.chat(chatBody())).status).toBe(200);
    expect((await h.chat(chatBody())).status).toBe(200);
    const limited = await h.chat(chatBody());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await limited.json()).error.type).toBe("rate_limit_error");
    expect((await h.chat(chatBody(), API_KEY_2)).status).toBe(200);
    // The refused request never reached the model server.
    expect(h.upstream.seen.filter((s) => s.path === "/v1/chat/completions")).toHaveLength(3);
  });

  test("per-key overrides in the key list apply", async () => {
    const h = await harness({
      raw: {
        auth: { keys: [{ id: "small", sha256: sha256Hex(API_KEY), quota: { requests_per_minute: 60, burst: 1 } }, { id: "big", sha256: sha256Hex(API_KEY_2) }] },
      },
    });
    expect((await h.chat(chatBody())).status).toBe(200);
    expect((await h.chat(chatBody())).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await h.chat(chatBody(), API_KEY_2)).status).toBe(200);
  });

  test("token quota is charged with the reported usage", async () => {
    const h = await harness({ raw: { quota: { default: { tokens_per_minute: 60, token_burst: 10 } } } });
    expect((await h.chat(chatBody())).status).toBe(200); // uses 7 of 10
    expect((await h.chat(chatBody())).status).toBe(200); // 3 left, still admitted, ends at -4
    expect((await h.chat(chatBody())).status).toBe(429);
  });

  test("streams are charged too", async () => {
    const h = await harness({ raw: { quota: { default: { tokens_per_minute: 60, token_burst: 5 } } } });
    await (await h.chat(chatBody({ stream: true }))).text(); // usage 7 > 5
    expect((await h.chat(chatBody())).status).toBe(429);
  });

  test("bad requests are refused before they reach the model server", async () => {
    const h = await harness({ raw: { upstream: { max_request_bytes: 2048 } } });
    const call = (init: RequestInit) => h.call("/v1/chat/completions", init);
    expect((await call({ method: "GET" })).status).toBe(405);
    expect((await call({ method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await call({ method: "POST", headers: { "content-type": "application/json" }, body: "{not json" })).status).toBe(400);
    expect((await call({ method: "POST", headers: { "content-type": "application/json" }, body: "[1,2]" })).status).toBe(400);
    const big = await call({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ok", pad: "x".repeat(5000) }) });
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe("request_too_large");
    expect(h.rt.queue.pending).toBe(0);
  });

  test("a served model name restricts what is accepted", async () => {
    const base = await harness();
    const h2 = await harness({ upstream: base.upstream, model: base.model, raw: { model: { path: base.model.dir, served_name: "tiny" } } });
    expect((await h2.chat(chatBody({ model: "other" }))).status).toBe(404);
    expect((await h2.chat(chatBody({ model: "tiny" }))).status).toBe(200);
  });
});

describe("model list", () => {
  test("GET /v1/models passes the model server's list through, behind the API key, without a receipt", async () => {
    const h = await harness();
    const res = await h.call("/v1/models", { headers: { "x-forwarded-for": "203.0.113.9", cookie: "s=1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "list", data: [{ id: "tiny" }] });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-anyroute-attestation-ref")).toBe(h.rt.attestationRef);
    expect(res.headers.get("x-anyroute-receipt")).toBeNull();
    expect(h.rt.queue.pending).toBe(0);
    const seen = h.upstream.seen.find((s) => s.path === "/v1/models")!;
    expect(seen.method).toBe("GET");
    expect(seen.headers["x-forwarded-for"]).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined(); // the client's key is never passed on
  });

  test("needs a key, answers GET only, and reports an unreachable or failing model server", async () => {
    const h = await harness();
    expect((await h.call("/v1/models", { key: null })).status).toBe(401);
    expect((await h.call("/v1/models", { method: "POST", body: "{}" })).status).toBe(405);
    h.upstream.setMode("down");
    expect((await h.call("/v1/models")).status).toBe(503);
    h.upstream.stop();
    const res = await h.call("/v1/models");
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("upstream_unavailable");
  });
});

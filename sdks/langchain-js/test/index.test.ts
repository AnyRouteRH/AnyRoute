// Offline tests: a fake fetch plays the router, so nothing leaves the machine.
import { afterEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ANYROUTE_BASE_URL, AnyrouteEmbeddings, ChatAnyroute, receiptOf } from "../src/index";

type Seen = { url: string; headers: Headers; body: Record<string, unknown> };

const RECEIPT = {
  id: "gen-test-1",
  sig: "c2lnbmF0dXJl",
  key_id: "21fe31dfa154a261",
  alg: "Ed25519",
  payload: { rid: "gen-test-1", model: "meta-llama/llama-3.3-70b-instruct" },
  leaf: "0xabc",
};

const RESPONSE_HEADERS = {
  "content-type": "application/json",
  "x-generation-id": "gen-test-1",
  "x-receipt-id": "gen-test-1",
  "x-anyroute-lane": "attested",
  "x-anyroute-disclosure": "attested",
};

function completion(id = "gen-test-1", receipt: Record<string, unknown> | null = RECEIPT) {
  return {
    id,
    object: "chat.completion",
    created: 1_700_000_000,
    model: "meta-llama/llama-3.3-70b-instruct",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello there, friend of mine." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11, cost: 0.00001 },
    ...(receipt ? { receipt } : {}),
  };
}

function fakeRouter(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const entry = { url, headers, body };
    seen.push(entry);
    return respond(entry);
  };
  return { seen, fetch: fetch as unknown as typeof globalThis.fetch };
}

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("ChatAnyroute", () => {
  test("sends the lane as header and body, and surfaces the receipt in response_metadata", async () => {
    const router = fakeRouter(() => new Response(JSON.stringify(completion()), { headers: RESPONSE_HEADERS }));
    const llm = new ChatAnyroute({
      model: "meta-llama/llama-3.3-70b-instruct",
      apiKey: "sk-ar-v1-test",
      lane: "attested",
      disclosure: "policy",
      configuration: { fetch: router.fetch },
      maxRetries: 0,
    });
    const msg = await llm.invoke([new HumanMessage("Say hello in five words.")]);

    expect(msg.content).toBe("Hello there, friend of mine.");
    expect(msg.response_metadata.anyroute).toEqual({
      receipt_id: "gen-test-1",
      lane: "attested",
      disclosure: "attested",
      receipt: RECEIPT,
    });
    expect(receiptOf(msg)?.receipt_id).toBe("gen-test-1");

    expect(router.seen).toHaveLength(1);
    const [req] = router.seen;
    expect(req.url).toBe(`${ANYROUTE_BASE_URL}/chat/completions`);
    expect(req.headers.get("authorization")).toBe("Bearer sk-ar-v1-test");
    expect(req.headers.get("x-anyroute-lane")).toBe("attested");
    expect(req.headers.get("x-anyroute-disclosure-max")).toBe("policy");
    expect(req.body.provider).toEqual({ lane: "attested", disclosure: "policy" });
    expect(req.body.model).toBe("meta-llama/llama-3.3-70b-instruct");
  });

  test("reads the key and base URL from the environment", async () => {
    process.env.ANYROUTE_API_KEY = "sk-ar-v1-env";
    process.env.ANYROUTE_BASE_URL = "http://localhost:8787/api/v1/";
    const router = fakeRouter(() => new Response(JSON.stringify(completion()), { headers: RESPONSE_HEADERS }));
    const llm = new ChatAnyroute("meta-llama/llama-3.3-70b-instruct", { configuration: { fetch: router.fetch }, maxRetries: 0 });
    await llm.invoke("hi");
    expect(router.seen[0].url).toBe("http://localhost:8787/api/v1/chat/completions");
    expect(router.seen[0].headers.get("authorization")).toBe("Bearer sk-ar-v1-env");
    expect(router.seen[0].headers.get("x-anyroute-lane")).toBeNull();
    expect(router.seen[0].body.provider).toBeUndefined();
  });

  test("fails clearly without a key", () => {
    delete process.env.ANYROUTE_API_KEY;
    expect(() => new ChatAnyroute({ model: "x" })).toThrow(/ANYROUTE_API_KEY/);
  });

  test("never loosens a stricter lane from provider preferences", async () => {
    const router = fakeRouter(() => new Response(JSON.stringify(completion()), { headers: RESPONSE_HEADERS }));
    const llm = new ChatAnyroute({
      model: "m",
      apiKey: "k",
      lane: "public",
      provider: { lane: "attested", order: ["relay"], allow_fallbacks: false },
      configuration: { fetch: router.fetch },
      maxRetries: 0,
    });
    await llm.invoke("hi");
    expect(router.seen[0].headers.get("x-anyroute-lane")).toBe("attested");
    expect(router.seen[0].body.provider).toEqual({ lane: "attested", order: ["relay"], allow_fallbacks: false });
  });

  test("keeps concurrent calls' receipts apart", async () => {
    let n = 0;
    const router = fakeRouter(() => {
      n += 1;
      const id = `gen-${n}`;
      const body = completion(id, { ...RECEIPT, id });
      return new Response(JSON.stringify(body), { headers: { ...RESPONSE_HEADERS, "x-receipt-id": id } });
    });
    const llm = new ChatAnyroute({ model: "m", apiKey: "k", configuration: { fetch: router.fetch }, maxRetries: 0 });
    const out = await Promise.all([llm.invoke("a"), llm.invoke("b"), llm.invoke("c")]);
    const ids = out.map((m) => receiptOf(m)?.receipt_id);
    expect(new Set(ids).size).toBe(3);
    for (const m of out) expect(receiptOf(m)?.receipt_id).toBe((receiptOf(m)?.receipt as { id: string }).id);
  });

  test("a response without a receipt has no anyroute metadata", async () => {
    const router = fakeRouter(() => new Response(JSON.stringify(completion("x", null)), { headers: { "content-type": "application/json" } }));
    const llm = new ChatAnyroute({ model: "m", apiKey: "k", configuration: { fetch: router.fetch }, maxRetries: 0 });
    const msg = await llm.invoke("hi");
    expect(msg.response_metadata.anyroute).toBeUndefined();
    expect(receiptOf(msg)).toBeUndefined();
  });

  test("streaming carries the receipt event through to the final message", async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      JSON.stringify({ id: "gen-s", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
    const events = [
      chunk({ role: "assistant", content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
      JSON.stringify({ receipt: { ...RECEIPT, id: "gen-s" } }),
    ];
    const sse = events.map((e, i) => `data: ${e}\n\n: anyroute-chain ${i + 1} ${"0".repeat(64)}\n\n`).join("") + "data: [DONE]\n\n";
    const router = fakeRouter(
      () =>
        new Response(sse, {
          headers: { ...RESPONSE_HEADERS, "content-type": "text/event-stream", "x-receipt-id": "gen-s" },
        }),
    );
    const llm = new ChatAnyroute({ model: "m", apiKey: "k", lane: "attested", configuration: { fetch: router.fetch }, maxRetries: 0 });
    let final: Awaited<ReturnType<typeof llm.invoke>> | undefined;
    for await (const part of await llm.stream("hi")) final = final ? final.concat(part) : part;
    expect(final?.content).toBe("Hello");
    expect(final?.response_metadata.anyroute).toEqual({
      receipt_id: "gen-s",
      lane: "attested",
      disclosure: "attested",
      receipt: { ...RECEIPT, id: "gen-s" },
    });
    expect(router.seen[0].body.stream).toBe(true);
    expect(router.seen[0].body.provider).toEqual({ lane: "attested" });
  });
});

describe("AnyrouteEmbeddings", () => {
  test("sends lane headers, float encoding and the Anyroute URL", async () => {
    const router = fakeRouter(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            model: "qwen/qwen3-embedding-8b",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
            usage: { prompt_tokens: 2, total_tokens: 2 },
            receipt: RECEIPT,
          }),
          { headers: RESPONSE_HEADERS },
        ),
    );
    const emb = new AnyrouteEmbeddings({
      model: "qwen/qwen3-embedding-8b",
      apiKey: "sk-ar-v1-test",
      lane: "attested",
      configuration: { fetch: router.fetch },
    });
    const vec = await emb.embedQuery("hello");
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    const [req] = router.seen;
    expect(req.url).toBe(`${ANYROUTE_BASE_URL}/embeddings`);
    expect(req.headers.get("x-anyroute-lane")).toBe("attested");
    expect(req.body.encoding_format).toBe("float");
  });
});

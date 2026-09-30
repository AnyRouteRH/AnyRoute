import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { providers } from "../src/db/schema.ts";
import { createMockProvider, type MockConfig } from "../src/providers/mock.ts";
import { runRegistry } from "../src/services/registry.ts";
import { encrypt } from "../src/lib/util.ts";
import { capabilities, family, fromChat, fromEmbed, fromGenerate, imageUrl, ollamaName, parameterSize, routerName, toReply } from "../src/ollama/convert.ts";
import { NdjsonTranslator } from "../src/ollama/stream.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

// The Ollama API under /ollama: GET /api/tags, /api/version, /api/ps, POST /api/show, /api/chat, /api/generate,
// /api/embed and /api/embeddings. It converts to the router's chat completions and embeddings and back, in-process, so
// what is checked here is the conversion, the NDJSON framing, the errors and that the router's own headers survive.

const PARAMS = ["temperature", "top_p", "top_k", "min_p", "seed", "stop", "max_tokens", "repetition_penalty", "frequency_penalty", "presence_penalty", "tools", "tool_choice", "response_format"];
const LLAMA_M = { ...MODELS.llama, params: PARAMS };
const QWEN_M = { ...MODELS.qwen, params: PARAMS };
const LLAMA = MODELS.llama.slug;
const LLAMA_TAG = `${LLAMA}:latest`;
const EMBED = MODELS.embed.slug;

// ---- a provider that can be scripted -----------------------------------------------------------------------------------

const sseBody = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const chunk = (delta: Record<string, unknown>, finish?: string) => ({ id: "cmpl-s", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });
const completion = (message: Record<string, unknown>, finish: string) => ({ id: "cmpl-s", object: "chat.completion", model: "x", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });

function serveScripted(cfg: MockConfig) {
  const mock = createMockProvider(cfg);
  const seen: any[] = [];
  const app = new Hono();
  app.post("/chat/completions", async (c) => {
    const body = await c.req.json();
    seen.push(body);
    const has = (marker: string) => (body.messages ?? []).some((m: any) => typeof m.content === "string" && m.content.includes(marker));
    if (has("@@TOOLS_STREAM@@") && body.stream)
      return new Response(
        sseBody([
          chunk({ role: "assistant", content: "" }),
          chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
          { id: "cmpl-s", choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (has("@@THINK@@") && body.stream)
      return new Response(
        sseBody([chunk({ role: "assistant", reasoning: "Let me think." }), chunk({ content: "42" }), chunk({}, "stop"), { id: "cmpl-s", choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }]),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (has("@@THINK@@")) return Response.json(completion({ content: "42", reasoning: "Let me think." }, "stop"));
    if (has("@@TOOL@@") && !body.messages.some((m: any) => m.role === "tool")) return Response.json(completion({ content: null, tool_calls: [{ id: "call_x", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] }, "tool_calls"));
    if (has("@@LENGTH@@")) return Response.json(completion({ content: "cut off" }, "length"));
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    return mock.app.fetch(new Request(c.req.url, { method: "POST", headers, body: JSON.stringify(body) }));
  });
  app.all("*", (c) => mock.app.fetch(c.req.raw));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 255 });
  return { url: `http://127.0.0.1:${server.port}`, seen, mock, stop: () => server.stop(true), last: () => seen[seen.length - 1] };
}

/** An NDJSON body: one JSON object per line, every line ending in a newline. */
async function ndjson(res: Response) {
  const raw = await res.text();
  expect(raw.endsWith("\n")).toBe(true);
  const lines = raw.split("\n").filter((l) => l.length);
  return { raw, lines: lines.map((l) => JSON.parse(l)) };
}

const WEATHER = { type: "function", function: { name: "get_weather", description: "Current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };
const TIME = { type: "function", function: { name: "get_time", description: "Current time", parameters: { type: "object", properties: {} } } };

describe("the Ollama API", () => {
  let h: Harness;
  let prov: ReturnType<typeof serveScripted>;
  let secret: string;

  beforeAll(async () => {
    h = await startRouter({ providers: [] });
    prov = serveScripted({ name: "Scripted", models: [LLAMA_M, QWEN_M, MODELS.embed] });
    await h.ctx.db.insert(providers).values({ id: "scripted", name: "Scripted", baseUrl: prov.url, apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "upstream-key"), status: "live", dataPolicy: { training: false, retains_prompts: false, zdr: true } });
    await runRegistry(h.ctx);
    secret = (await h.fundedKey(20n)).secret;
  });
  afterAll(async () => {
    prov.stop();
    await h.close();
  });

  const auth = () => ({ authorization: `Bearer ${secret}` });
  const post = (path: string, json: unknown, headers: Record<string, string> = auth()) => h.request(`/ollama/api/${path}`, { method: "POST", headers, json });
  const chat = (extra: Record<string, unknown> = {}, headers?: Record<string, string>) => post("chat", { model: LLAMA_TAG, stream: false, messages: [{ role: "user", content: "hi there" }], ...extra }, headers);

  describe("discovery", () => {
    test("the root answers as Ollama does, to GET and HEAD; version and ps are there", async () => {
      for (const path of ["/ollama", "/ollama/"]) {
        const res = await h.request(path);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("Ollama is running");
      }
      expect((await h.request("/ollama/", { method: "HEAD" })).status).toBe(200);
      const v = (await (await h.request("/ollama/api/version")).json()) as any;
      expect(v.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(await (await h.request("/ollama/api/ps")).json()).toEqual({ models: [] });
    });

    test("GET /api/tags lists the live catalog in Ollama's shape", async () => {
      const res = await h.request("/ollama/api/tags");
      expect(res.status).toBe(200);
      const { models } = (await res.json()) as any;
      const names = models.map((m: any) => m.name);
      expect(names).toContain(LLAMA_TAG);
      expect(names).toContain(`${MODELS.qwen.slug}:latest`);
      expect(names).toContain(`${EMBED}:latest`);
      const llama = models.find((m: any) => m.name === LLAMA_TAG);
      expect(Object.keys(llama).sort()).toEqual(["details", "digest", "model", "modified_at", "name", "size"]);
      expect(llama.model).toBe(LLAMA_TAG);
      expect(llama.size).toBe(0);
      expect(llama.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(new Date(llama.modified_at).toISOString()).toBe(llama.modified_at);
      expect(llama.details).toEqual({ parent_model: "", format: "", family: "llama", families: ["llama"], parameter_size: "70B", quantization_level: "BF16" });
      expect(models.find((m: any) => m.name === `${MODELS.qwen.slug}:latest`).details).toMatchObject({ family: "qwen3", parameter_size: "32B" });
    });

    test("X-Anyroute-Lane filters the list; an unknown lane is an Ollama-shaped 400", async () => {
      const attested = (await (await h.request("/ollama/api/tags", { headers: { "x-anyroute-lane": "attested" } })).json()) as any;
      expect(attested.models).toEqual([]); // the scripted provider is not attested
      const bad = await h.request("/ollama/api/tags", { headers: { "x-anyroute-lane": "fast" } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as any).error).toContain("X-Anyroute-Lane");
    });

    test("POST /api/show describes a model: capabilities, context length, details", async () => {
      const res = await post("show", { model: LLAMA_TAG }, {});
      expect(res.status).toBe(200);
      const j = (await res.json()) as any;
      expect(j.capabilities).toEqual(["completion", "tools"]);
      expect(j.details.family).toBe("llama");
      expect(j.model_info["llama.context_length"]).toBe(131072);
      expect(j.model_info["general.parameter_count"]).toBe(70e9);
      expect(j.anyroute).toMatchObject({ id: LLAMA, lanes: ["public"] });
      // The legacy `name` field, a name without a tag, and an embedding model.
      expect((await post("show", { name: LLAMA }, {})).status).toBe(200);
      expect(((await (await post("show", { model: `${EMBED}:latest` }, {})).json()) as any).capabilities).toEqual(["embedding"]);
      const missing = await post("show", { model: "llama3.2" }, {});
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as any).error).toContain('model "llama3.2" not found');
    });

    test("pull of a listed model succeeds at once; local-model operations are 501s; unknown paths are 404s, all as {error}", async () => {
      const pulled = await post("pull", { model: LLAMA_TAG }, {});
      expect(pulled.headers.get("content-type")).toContain("application/x-ndjson");
      expect((await ndjson(pulled)).lines).toEqual([{ status: "success" }]);
      expect(await (await post("pull", { model: LLAMA_TAG, stream: false }, {})).json()).toEqual({ status: "success" });
      expect((await post("pull", { model: "nope" }, {})).status).toBe(404);
      const create = await post("create", { model: "x" }, {});
      expect(create.status).toBe(501);
      expect(typeof ((await create.json()) as any).error).toBe("string");
      expect((await h.request("/ollama/api/delete", { method: "DELETE", json: { model: LLAMA_TAG } })).status).toBe(501);
      const nope = await h.request("/ollama/api/nothing");
      expect(nope.status).toBe(404);
      expect(Object.keys((await nope.json()) as any)).toEqual(["error"]);
    });
  });

  describe("chat", () => {
    test("non-streaming: one object with the message, done_reason and the counts; the receipt and lane ride along", async () => {
      const res = await chat();
      expect(res.status).toBe(200);
      const j = (await res.json()) as any;
      expect(j.model).toBe(LLAMA_TAG);
      expect(j.message).toEqual({ role: "assistant", content: expect.stringContaining("hi there") });
      expect(j).toMatchObject({ done: true, done_reason: "stop", load_duration: 0 });
      for (const k of ["total_duration", "prompt_eval_count", "prompt_eval_duration", "eval_count", "eval_duration"]) expect(Number.isInteger(j[k]) && j[k] >= 0).toBe(true);
      expect(j.total_duration).toBeGreaterThan(0);
      expect(j.eval_count).toBeGreaterThan(0);
      expect(new Date(j.created_at).toISOString()).toBe(j.created_at);
      expect(res.headers.get("x-anyroute-lane")).toBe("public");
      expect(res.headers.get("x-receipt-id")).toBeTruthy();
      expect(j.anyroute).toMatchObject({ receipt_id: res.headers.get("x-receipt-id"), lane: "public", provider: "Scripted" });
      // The ":latest" tag names the model itself.
      expect(prov.last().model).toBeTruthy();
      expect((await chat({ model: LLAMA })).status).toBe(200);
    });

    test("streaming is the default: NDJSON lines with done:false, then one closing line with the stats", async () => {
      const res = await post("chat", { model: LLAMA_TAG, messages: [{ role: "user", content: "stream me" }] });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/x-ndjson");
      expect(res.headers.get("x-receipt-id")).toBeTruthy();
      const { lines } = await ndjson(res);
      expect(lines.length).toBeGreaterThan(2);
      const body = lines.slice(0, -1);
      const last = lines[lines.length - 1];
      expect(body.map((l) => l.message.content).join("")).toContain("stream me");
      for (const l of body) {
        expect(Object.keys(l).sort()).toEqual(["created_at", "done", "message", "model"]);
        expect(l.model).toBe(LLAMA_TAG);
        expect(l.done).toBe(false);
        expect(l.message.role).toBe("assistant");
        expect(typeof l.message.content).toBe("string");
      }
      expect(last).toMatchObject({ model: LLAMA_TAG, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", load_duration: 0 });
      for (const k of ["total_duration", "prompt_eval_count", "prompt_eval_duration", "eval_count", "eval_duration"]) expect(Number.isInteger(last[k])).toBe(true);
      expect(last.eval_count).toBeGreaterThan(0);
      expect(last.anyroute).toMatchObject({ lane: "public", provider: "Scripted", receipt_id: expect.any(String) });
      expect(prov.last().stream).toBe(true);
    });

    test("options map to sampling parameters; runtime options are named in X-Anyroute-Ignored; keep_alive is ignored", async () => {
      const res = await chat({ keep_alive: "5m", options: { temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.05, seed: 7, num_predict: 64, stop: ["END", ""], repeat_penalty: 1.1, presence_penalty: 0.5, frequency_penalty: 0.3, num_ctx: 8192, num_gpu: 1 } });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-anyroute-ignored")).toBe("options.num_ctx, options.num_gpu");
      expect(prov.last()).toMatchObject({ temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.05, seed: 7, max_tokens: 64, stop: ["END"], repetition_penalty: 1.1, presence_penalty: 0.5, frequency_penalty: 0.3 });
      expect(prov.last().keep_alive).toBeUndefined();
      // num_predict -1 (no limit) sets no limit; a wrong type is a 400 that names the option.
      await chat({ options: { num_predict: -1 } });
      expect(prov.last().max_tokens).toBeUndefined();
      const bad = await chat({ options: { temperature: "hot" } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as any).error).toContain("options.temperature");
    });

    test('format "json" is JSON mode; a schema is structured output', async () => {
      await chat({ format: "json" });
      expect(prov.last().response_format).toEqual({ type: "json_object" });
      const schema = { type: "object", properties: { age: { type: "integer" } }, required: ["age"] };
      await chat({ format: schema });
      expect(prov.last().response_format).toEqual({ type: "json_schema", json_schema: { name: "response", schema } });
      expect((await chat({ format: "yaml" })).status).toBe(400);
    });

    test("images become image_url parts with their media type", async () => {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
      const res = await chat({ messages: [{ role: "user", content: "What is this?", images: [png, "/9j/4AAQSkZJRg=="] }] });
      expect(res.status).toBe(200);
      const sent = prov.last().messages;
      expect(sent[sent.length - 1]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } },
        ],
      });
      expect((await chat({ messages: [{ role: "user", content: "x", images: ["not base64!"] }] })).status).toBe(400);
    });

    test("tools: the model's call comes back with object arguments, and the result goes back as a tool message", async () => {
      const first = await chat({ tools: [WEATHER], messages: [{ role: "user", content: "@@TOOL@@ weather in Oslo?" }] });
      expect(first.status).toBe(200);
      const j = (await first.json()) as any;
      expect(prov.last().tools).toEqual([WEATHER]);
      expect(j.message.tool_calls).toEqual([{ id: "call_x", function: { index: 0, name: "get_weather", arguments: { city: "Oslo" } } }]);
      expect(j.done_reason).toBe("stop");

      // The client sends the call back as it got it, and the result names the tool (Ollama's tool_name).
      const second = await chat({ tools: [WEATHER], messages: [{ role: "user", content: "@@TOOL@@ weather in Oslo?" }, j.message, { role: "tool", tool_name: "get_weather", content: "3 C and raining" }] });
      expect(second.status).toBe(200);
      const sent = prov.last().messages;
      expect(sent[1]).toEqual({ role: "assistant", content: "", tool_calls: [{ id: "call_x", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] });
      expect(sent[2]).toEqual({ role: "tool", tool_call_id: "call_x", content: "3 C and raining" });
    });

    test("tools, streamed: the calls arrive whole in one line before the closing line", async () => {
      const res = await post("chat", { model: LLAMA_TAG, tools: [WEATHER, TIME], messages: [{ role: "user", content: "@@TOOLS_STREAM@@" }] });
      const { lines } = await ndjson(res);
      const calls = lines.filter((l) => l.message?.tool_calls);
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ done: false, message: { role: "assistant", content: "" } });
      expect(calls[0].message.tool_calls).toEqual([
        { id: "call_a", function: { index: 0, name: "get_weather", arguments: { city: "Paris" } } },
        { id: "call_b", function: { index: 1, name: "get_time", arguments: {} } },
      ]);
      const last = lines[lines.length - 1];
      expect(last).toMatchObject({ done: true, done_reason: "stop", prompt_eval_count: 30, eval_count: 12 });
    });

    test("reasoning comes back as thinking, unless think is false", async () => {
      const j = (await (await chat({ messages: [{ role: "user", content: "@@THINK@@" }] })).json()) as any;
      expect(j.message).toEqual({ role: "assistant", content: "42", thinking: "Let me think." });
      const off = (await (await chat({ think: false, messages: [{ role: "user", content: "@@THINK@@" }] })).json()) as any;
      expect(off.message).toEqual({ role: "assistant", content: "42" });
      const { lines } = await ndjson(await post("chat", { model: LLAMA_TAG, messages: [{ role: "user", content: "@@THINK@@" }] }));
      expect(lines[0].message).toEqual({ role: "assistant", content: "", thinking: "Let me think." });
      expect(lines.slice(0, -1).map((l) => l.message.content).join("")).toBe("42");
    });

    test("done_reason is length when the limit cut the answer", async () => {
      expect(((await (await chat({ messages: [{ role: "user", content: "@@LENGTH@@" }] })).json()) as any).done_reason).toBe("length");
    });

    test("an empty conversation loads the model, as Ollama does, without a call", async () => {
      const before = prov.seen.length;
      const j = (await (await chat({ messages: [] })).json()) as any;
      expect(j).toMatchObject({ model: LLAMA_TAG, done: true, done_reason: "load", message: { role: "assistant", content: "" } });
      expect(((await (await chat({ messages: [], keep_alive: 0 })).json()) as any).done_reason).toBe("unload");
      expect(prov.seen.length).toBe(before);
      expect((await chat({ model: "nope", messages: [] })).status).toBe(404);
    });
  });

  describe("generate", () => {
    test("non-streaming: the prompt and system become messages, the answer is `response`", async () => {
      const res = await post("generate", { model: LLAMA_TAG, prompt: "Why is the sky blue?", system: "Be brief.", stream: false });
      expect(res.status).toBe(200);
      const j = (await res.json()) as any;
      expect(j.response).toContain("Why is the sky blue?");
      expect(j).toMatchObject({ model: LLAMA_TAG, done: true, done_reason: "stop" });
      expect(j.message).toBeUndefined();
      expect(prov.last().messages).toEqual([{ role: "system", content: "Be brief." }, { role: "user", content: "Why is the sky blue?" }]);
    });

    test("streaming: `response` pieces, then the closing line; suffix and template are named as ignored", async () => {
      const res = await post("generate", { model: LLAMA_TAG, prompt: "count", suffix: "end", template: "{{ .Prompt }}", options: { temperature: 0 } });
      expect(res.headers.get("x-anyroute-ignored")).toBe("suffix, template");
      const { lines } = await ndjson(res);
      expect(lines.slice(0, -1).map((l) => l.response).join("")).toContain("count");
      for (const l of lines.slice(0, -1)) expect([l.model, typeof l.response, l.done]).toEqual([LLAMA_TAG, "string", false]);
      expect(lines[lines.length - 1]).toMatchObject({ response: "", done: true, done_reason: "stop" });
      expect(prov.last().temperature).toBe(0);
    });

    test("an empty prompt loads the model", async () => {
      expect(await (await post("generate", { model: LLAMA_TAG })).json()).toMatchObject({ response: "", done: true, done_reason: "load" });
    });
  });

  describe("embeddings", () => {
    test("POST /api/embed takes a string or a list and returns `embeddings`", async () => {
      const res = await post("embed", { model: `${EMBED}:latest`, input: ["first", "second one"], truncate: true, keep_alive: "1m" });
      expect(res.status).toBe(200);
      const j = (await res.json()) as any;
      expect(j.model).toBe(`${EMBED}:latest`);
      expect(j.embeddings).toEqual([
        [0.05, 0.5, -0.25],
        [0.1, 0.5, -0.25],
      ]);
      expect(Number.isInteger(j.total_duration) && Number.isInteger(j.prompt_eval_count)).toBe(true);
      expect(res.headers.get("x-receipt-id")).toBeTruthy();
      expect((((await (await post("embed", { model: EMBED, input: "one" })).json()) as any).embeddings as unknown[]).length).toBe(1);
      expect((await post("embed", { model: EMBED, input: [] })).status).toBe(400);
    });

    test("the older POST /api/embeddings takes `prompt` and returns one `embedding`", async () => {
      const res = await post("embeddings", { model: EMBED, prompt: "hello" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ embedding: [0.05, 0.5, -0.25] });
    });
  });

  describe("errors and lanes", () => {
    test("every error is {error: string}: no key, an unknown key, an unknown model, a bad body", async () => {
      const none = await chat({}, {});
      expect([401, 402]).toContain(none.status);
      const nj = (await none.json()) as any;
      expect(Object.keys(nj)).toEqual(["error"]);
      expect(nj.error).toContain("Authorization: Bearer");
      const unknown = await chat({}, { authorization: "Bearer sk-ar-v1-" + "0".repeat(64) });
      expect(unknown.status).toBe(401);
      expect(typeof ((await unknown.json()) as any).error).toBe("string");
      const missing = await chat({ model: "llama3.2" });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as any).error).toContain('model "llama3.2" not found');
      const streamedMissing = await post("chat", { model: "llama3.2", messages: [{ role: "user", content: "hi" }] });
      expect(streamedMissing.status).toBe(404);
      const notJson = await h.request("/ollama/api/chat", { method: "POST", headers: auth(), body: "{nope" });
      expect(notJson.status).toBe(400);
      expect(Object.keys((await notJson.json()) as any)).toEqual(["error"]);
      expect((await chat({ messages: [{ role: "robot", content: "x" }] })).status).toBe(400);
      expect((await post("chat", { messages: [] })).status).toBe(400); // no model
    });

    test("a provider failure before the answer starts is an HTTP error, streamed or not", async () => {
      prov.mock.cfg.behaviour = "error500";
      try {
        const plain = await chat();
        expect(plain.status).toBeGreaterThanOrEqual(500);
        expect(typeof ((await plain.json()) as any).error).toBe("string");
        const streamed = await post("chat", { model: LLAMA_TAG, messages: [{ role: "user", content: "hi" }] });
        expect(streamed.status).toBeGreaterThanOrEqual(500);
        expect(typeof ((await streamed.json()) as any).error).toBe("string");
      } finally {
        prov.mock.cfg.behaviour = "ok";
      }
    });

    test("a failure mid-stream is an {error} line and nothing after it", async () => {
      prov.mock.cfg.behaviour = "midstream_error";
      try {
        const res = await post("chat", { model: LLAMA_TAG, messages: [{ role: "user", content: "a long enough answer to fail half way" }] });
        expect(res.status).toBe(200);
        const { lines } = await ndjson(res);
        expect(lines[lines.length - 1]).toEqual({ error: expect.any(String) });
        expect(lines.some((l) => l.done === true)).toBe(false);
      } finally {
        prov.mock.cfg.behaviour = "ok";
      }
    });

    test("X-Anyroute-Lane and the other routing headers pass through: an attested lane the provider cannot serve is refused", async () => {
      const refused = await chat({}, { ...auth(), "x-anyroute-lane": "attested" });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(typeof ((await refused.json()) as any).error).toBe("string");
      const streamed = await post("chat", { model: LLAMA_TAG, messages: [{ role: "user", content: "hi" }] }, { ...auth(), "x-anyroute-lane": "attested" });
      expect(streamed.status).toBeGreaterThanOrEqual(400);
      const unknown = await chat({}, { ...auth(), "x-anyroute-lane": "fast" });
      expect(unknown.status).toBe(400);
      expect(((await unknown.json()) as any).error).toContain("X-Anyroute-Lane");
      const pub = await chat({}, { ...auth(), "x-anyroute-lane": "public" });
      expect(pub.status).toBe(200);
      expect(pub.headers.get("x-anyroute-lane")).toBe("public");
      // provider.lane in the body works as well.
      expect((await chat({ provider: { lane: "attested" } })).status).toBeGreaterThanOrEqual(400);
    });
  });
});

// ---- the conversion, without a router ------------------------------------------------------------------------------------

describe("Ollama conversion", () => {
  test("names: :latest is added for the list and taken off for the router; routing suffixes stay", () => {
    expect(ollamaName("meta-llama/llama-3.3-70b-instruct")).toBe("meta-llama/llama-3.3-70b-instruct:latest");
    expect(ollamaName("a/b:free")).toBe("a/b:free");
    expect(routerName("a/b:latest")).toBe("a/b");
    expect(routerName("a/b:free")).toBe("a/b:free");
    expect(family("google/gemma-3-27b-it")).toBe("gemma");
    expect(parameterSize("mistralai/mixtral-8x7b-instruct")).toBe("8x7B");
    expect(parameterSize("qwen/qwen3-30b-a3b")).toBe("30B");
    expect(parameterSize("deepseek/deepseek-r1")).toBe("");
  });

  test("images: a data URL or http URL is kept; bare base64 gets a media type from its first bytes", () => {
    expect(imageUrl("data:image/webp;base64,AAAA", "x")).toBe("data:image/webp;base64,AAAA");
    expect(imageUrl("https://example.com/a.png", "x")).toBe("https://example.com/a.png");
    expect(imageUrl("R0lGODlh", "x")).toBe("data:image/gif;base64,R0lGODlh");
    expect(imageUrl("UklGRiQ=", "x")).toBe("data:image/webp;base64,UklGRiQ=");
  });

  test("a tool result with an id answers that call; one with no call before it is passed on as text", () => {
    const c = fromChat({
      model: "m",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ function: { name: "a", arguments: {} } }, { function: { name: "b", arguments: '{"x":1}' } }] },
        { role: "tool", tool_name: "b", content: "B" },
        { role: "tool", content: "A" },
        { role: "tool", tool_name: "c", content: "C" },
      ],
    });
    const m = c.body.messages as any[];
    expect(m[0].tool_calls.map((t: any) => [t.id, t.function.arguments])).toEqual([
      ["call_0_0", "{}"],
      ["call_0_1", '{"x":1}'],
    ]);
    expect(m[1]).toEqual({ role: "tool", tool_call_id: "call_0_1", content: "B" });
    expect(m[2]).toEqual({ role: "tool", tool_call_id: "call_0_0", content: "A" });
    expect(m[3]).toEqual({ role: "user", content: "Result of the tool c:\nC" });
    expect(c.stream).toBe(true);
  });

  test("generate and embed validate their fields", () => {
    expect(() => fromGenerate({ model: "m", prompt: 3 })).toThrow("prompt");
    expect(fromGenerate({ model: "m", prompt: "p", raw: true, context: [1, 2] }).ignored).toEqual(["raw", "context"]);
    expect(fromEmbed({ model: "m", input: "x", dimensions: 64 }).body).toEqual({ input: "x", dimensions: 64 });
    expect(() => fromEmbed({ model: "m", prompt: 1 }, true)).toThrow("prompt");
  });

  test("capabilities follow the model's modalities and parameters", () => {
    const base = { id: "a/b", created: 0, context_length: 8192, quantization: [], lanes: [] };
    expect(capabilities({ ...base, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning"] })).toEqual(["completion", "tools", "vision", "thinking"]);
    expect(capabilities({ ...base, architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] }, supported_parameters: [] })).toEqual(["embedding"]);
  });

  test("the translator keeps a tool call's pieces together and fails once", () => {
    const t = new NdjsonTranslator({ kind: "chat", model: "m", think: true, t0: 0, promptEstimate: 5, describe: () => undefined, now: () => 1 });
    t.chunk(chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a"' } }] }));
    t.chunk(chunk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }, "tool_calls"));
    const out = t.end().map((l) => JSON.parse(l));
    expect(out[0].message.tool_calls).toEqual([{ id: "c1", function: { index: 0, name: "f", arguments: { a: 1 } } }]);
    expect(out[1]).toMatchObject({ done: true, done_reason: "stop", prompt_eval_count: 5, total_duration: 1_000_000 });
    const f = new NdjsonTranslator({ kind: "generate", model: "m", think: true, t0: 0, promptEstimate: 1, describe: () => undefined });
    expect(f.end()).toEqual([JSON.stringify({ error: "The response ended before the model finished." }) + "\n"]);
    expect(f.end()).toEqual([]);
  });

  test("a reply with no choice is still a well-formed object", () => {
    const r = toReply({}, { kind: "chat", model: "m", think: true, timing: { t0: 0, firstAt: null, endAt: 2 }, promptEstimate: 3 });
    expect(r).toMatchObject({ model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 0 });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { providers } from "../src/db/schema.ts";
import { createMockProvider, type MockConfig } from "../src/providers/mock.ts";
import { runRegistry } from "../src/services/registry.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { encrypt } from "../src/lib/util.ts";
import { loadConfig } from "../src/config.ts";
import { clampMaxTokens, errorType, parseArguments, toAnthropicUsage, toChatRequest, toStop } from "../src/anthropic/convert.ts";
import { isAnthropicName, mappedModel, parseModelMap } from "../src/anthropic/models.ts";
import { StreamTranslator } from "../src/anthropic/stream.ts";
import { GW_MODEL, PLAIN, startGatewayRouter } from "./aci-mock-gateway.ts";
import { bindingsFor, sidecarDocument } from "./measurement-fixtures.ts";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";

// The Anthropic Messages endpoint: POST /v1/messages (and /api/v1/messages) and /messages/count_tokens, which the
// Anthropic SDKs and Claude Code speak. It converts to the router's chat completions and back, in-process, so what is
// checked here is the conversion, the streaming events, the errors and that the router's own headers survive.

const LLAMA = MODELS.llama.slug;
const QWEN = MODELS.qwen.slug;
const VERSION = { "anthropic-version": "2023-06-01", "anthropic-beta": "tools-2024-04-04" };

// ---- a provider that can be scripted -----------------------------------------------------------------------------------
// The harness mock answers every prompt the same way, and never streams a tool call. This wraps it: a prompt that carries
// one of the markers below gets the scripted reply, anything else goes to the mock.

const sseBody = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const chunk = (delta: Record<string, unknown>, finish?: string) => ({ id: "cmpl-s", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });
const completion = (message: Record<string, unknown>, finish: string, extra: Record<string, unknown> = {}, usage: Record<string, unknown> = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }) => ({
  id: "cmpl-s",
  object: "chat.completion",
  model: "x",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish, ...extra }],
  usage,
});

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
          chunk({ role: "assistant", content: "Let me check. " }),
          chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
          { id: "cmpl-s", choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (has("@@TOOL@@") && !body.messages.some((m: any) => m.role === "tool")) return Response.json(completion({ content: "Checking.", tool_calls: [{ id: "call_x", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] }, "tool_calls"));
    if (has("@@LENGTH@@")) return Response.json(completion({ content: "cut off" }, "length"));
    if (has("@@STOPSEQ@@")) return Response.json(completion({ content: "before" }, "stop", { stop_reason: "END" }));
    if (has("@@FILTER@@")) return Response.json(completion({ content: "" }, "content_filter"));
    if (has("@@CACHED@@")) return Response.json(completion({ content: "cached" }, "stop", {}, { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46, prompt_tokens_details: { cached_tokens: 30 } }));
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    return mock.app.fetch(new Request(c.req.url, { method: "POST", headers, body: JSON.stringify(body) }));
  });
  app.all("*", (c) => mock.app.fetch(c.req.raw));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 255 });
  return { url: `http://127.0.0.1:${server.port}`, seen, mock, stop: () => server.stop(true), last: () => seen[seen.length - 1] };
}

/** Anthropic SSE: every event has an `event:` line that names the `type` in its data. */
async function events(res: Response) {
  const raw = await res.text();
  const list = raw
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const lines = block.split("\n");
      return { event: lines.find((l) => l.startsWith("event:"))?.slice(6).trim(), data: JSON.parse(lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")) };
    });
  return { raw, list, types: list.map((e) => e.data.type as string) };
}

const WEATHER = {
  name: "get_weather",
  description: "Current weather for a city",
  input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
};
const TIME = { name: "get_time", description: "Current time", input_schema: { type: "object", properties: {} } };

// ---- the endpoint ------------------------------------------------------------------------------------------------------

describe("POST /v1/messages", () => {
  let h: Harness;
  let prov: ReturnType<typeof serveScripted>;
  let secret: string;
  let poor: string;

  beforeAll(async () => {
    h = await startRouter({ providers: [] });
    prov = serveScripted({ name: "Scripted", models: [MODELS.llama, MODELS.qwen] });
    await h.ctx.db.insert(providers).values({ id: "scripted", name: "Scripted", baseUrl: prov.url, apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "upstream-key"), status: "live", dataPolicy: { training: false, retains_prompts: false, zdr: true } });
    await runRegistry(h.ctx);
    secret = (await h.fundedKey(20n)).secret;
    poor = (await h.newKey()).secret;
  });
  afterAll(async () => {
    prov.stop();
    await h.close();
  });

  const post = (json: unknown, headers: Record<string, string> = { "x-api-key": secret }, path = "/v1/messages") => h.request(path, { method: "POST", headers: { ...VERSION, ...headers }, json });
  const ask = (extra: Record<string, unknown> = {}, headers?: Record<string, string>) => post({ model: LLAMA, max_tokens: 64, messages: [{ role: "user", content: "hi there" }], ...extra }, headers);

  describe("authentication", () => {
    test("x-api-key, Authorization: Bearer, and both together (the AnyRoute-shaped key wins) all work; anthropic-version and anthropic-beta are ignored", async () => {
      for (const headers of [{ "x-api-key": secret }, { authorization: `Bearer ${secret}` }, { "x-api-key": "placeholder", authorization: `Bearer ${secret}` }, { "x-api-key": secret, authorization: "Bearer placeholder" }]) {
        const res = await ask({}, headers);
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).type).toBe("message");
      }
      expect((await post({ model: LLAMA, max_tokens: 8, messages: [{ role: "user", content: "no version headers" }] }, { "x-api-key": secret }, "/api/v1/messages")).status).toBe(200);
    });

    test("a missing or unknown key is an authentication_error in Anthropic's error shape", async () => {
      const none = await post({ model: LLAMA, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, {});
      expect(none.status).toBe(401);
      const j = (await none.json()) as any;
      expect(j).toMatchObject({ type: "error", error: { type: "authentication_error" }, anyroute: { type: "missing_key" } });
      expect(j.error.message).toContain("x-api-key");
      expect(j.request_id).toStartWith("req_");
      expect(none.headers.get("request-id")).toBe(j.request_id);
      const bad = await ask({}, { "x-api-key": "sk-ar-v1-" + "0".repeat(64) });
      expect(bad.status).toBe(401);
      expect(((await bad.json()) as any).error.type).toBe("authentication_error");
      // Authentication comes before the body is read: a bad body with no key is still a 401.
      expect((await h.request("/v1/messages", { method: "POST", body: "{nope", headers: { "content-type": "application/json" } })).status).toBe(401);
    });

    test("a key with no balance is a billing_error (402)", async () => {
      const res = await ask({}, { "x-api-key": poor });
      expect(res.status).toBe(402);
      expect(((await res.json()) as any).error.type).toBe("billing_error");
    });
  });

  describe("a plain message", () => {
    test("returns the Anthropic message object, billed to the key, with the router's receipt on it", async () => {
      const before = Number(((await (await h.request("/api/v1/credits", { headers: { authorization: `Bearer ${secret}` } })).json()) as any).data.total_usage);
      const res = await ask({ system: "Be brief.", temperature: 0 });
      expect(res.status).toBe(200);
      const j = (await res.json()) as any;
      expect(j).toMatchObject({ type: "message", role: "assistant", model: LLAMA, stop_reason: "end_turn", stop_sequence: null });
      expect(j.id).toStartWith("gen-");
      expect(j.content).toHaveLength(1);
      expect(j.content[0]).toMatchObject({ type: "text" });
      expect(j.content[0].text).toContain("hi there");
      expect(j.usage.input_tokens).toBeGreaterThan(0);
      expect(j.usage.output_tokens).toBeGreaterThan(0);
      expect(j.usage).toMatchObject({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
      // The receipt: headers as on a chat call, and the same id in the body.
      expect(res.headers.get("x-receipt-id")).toBe(j.id);
      expect(res.headers.get("inference-id")).toBe(j.id);
      expect(res.headers.get("x-generation-id")).toBe(j.id);
      expect(res.headers.get("x-anyroute-lane")).toBe("public");
      expect(res.headers.get("request-id")).toStartWith("req_");
      expect(j.anyroute).toMatchObject({ receipt_id: j.id, lane: "public", provider: "Scripted", disclosure: expect.any(String) });
      expect(j.anyroute.cost_usd).toBeGreaterThan(0);
      expect(j.anyroute.receipt).toMatchObject({ id: j.id, alg: "Ed25519" });
      const rec = await h.request(`/api/v1/receipts/${j.id}`);
      expect(rec.status).toBe(200);
      const after = Number(((await (await h.request("/api/v1/credits", { headers: { authorization: `Bearer ${secret}` } })).json()) as any).data.total_usage);
      expect(after).toBeGreaterThan(before);
      // The system prompt went first, as a system message.
      expect(prov.last().messages[0]).toEqual({ role: "system", content: "Be brief." });
    });

    test("system blocks, sampling parameters, stop_sequences and metadata.user_id reach the provider in the router's terms", async () => {
      const res = await ask({
        system: [
          { type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } },
          { type: "text", text: "Answer in one line." },
        ],
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ["END", "STOP"],
        metadata: { user_id: "user-123" },
        max_tokens: 100,
      });
      expect(res.status).toBe(200);
      const sent = prov.last();
      expect(sent.messages[0]).toEqual({ role: "system", content: "You are terse.\n\nAnswer in one line." });
      expect(sent).toMatchObject({ temperature: 0.2, top_p: 0.9, stop: ["END", "STOP"], user: "user-123", max_tokens: 100 });
      // The mock does not list top_k among its sampling parameters, and the router drops what a provider does not list.
      expect(sent.top_k).toBeUndefined();
      expect(sent.stream).toBeUndefined();
    });

    test("max_tokens above what the model can produce is lowered to its limit instead of being sent to fail", async () => {
      expect((await ask({ max_tokens: 200_000 })).status).toBe(200);
      const sent = prov.last().max_tokens;
      expect(sent).toBeLessThanOrEqual(8192);
      expect(sent).toBeGreaterThan(0);
    });

    test("stop_reason follows finish_reason: max_tokens, stop_sequence, refusal; usage splits the cached prompt", async () => {
      const send = async (marker: string, extra: Record<string, unknown> = {}) => ((await (await ask({ messages: [{ role: "user", content: marker }], ...extra })).json()) as any);
      expect(await send("@@LENGTH@@")).toMatchObject({ stop_reason: "max_tokens", stop_sequence: null, content: [{ type: "text", text: "cut off" }] });
      expect(await send("@@STOPSEQ@@", { stop_sequences: ["END"] })).toMatchObject({ stop_reason: "stop_sequence", stop_sequence: "END" });
      // A provider that names no stop string leaves stop_reason at end_turn.
      expect(await send("@@STOPSEQ@@", { stop_sequences: ["OTHER"] })).toMatchObject({ stop_reason: "end_turn", stop_sequence: null });
      expect(await send("@@FILTER@@")).toMatchObject({ stop_reason: "refusal", content: [{ type: "text", text: "" }] });
      const cached = await send("@@CACHED@@");
      expect(cached.usage).toEqual({ input_tokens: 10, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 30 });
    });
  });

  describe("content blocks", () => {
    test("images (base64 and URL) become image_url parts; text-only turns stay plain strings", async () => {
      const res = await ask({
        messages: [
          { role: "user", content: [{ type: "text", text: "What is in these?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }, { type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } }] },
          { role: "assistant", content: [{ type: "text", text: "Two pictures." }] },
          { role: "user", content: [{ type: "text", text: "Thanks" }, { type: "text", text: "and goodbye" }] },
        ],
      });
      expect(res.status).toBe(200);
      const sent = prov.last().messages;
      expect(sent[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "What is in these?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
        ],
      });
      expect(sent[1]).toEqual({ role: "assistant", content: "Two pictures." });
      expect(sent[2]).toEqual({ role: "user", content: "Thanks\n\nand goodbye" });
    });

    test("an unusable image, an unknown block and a PDF document are 400s that name the field", async () => {
      const bad = async (content: unknown) => {
        const res = await ask({ messages: [{ role: "user", content }] });
        expect(res.status).toBe(400);
        const j = (await res.json()) as any;
        expect(j.error.type).toBe("invalid_request_error");
        return j.error.message as string;
      };
      expect(await bad([{ type: "image", source: { type: "base64", media_type: "text/plain", data: "x" } }])).toContain("messages.0.content.0.source.media_type");
      expect(await bad([{ type: "image", source: { type: "file", file_id: "f" } }])).toContain("source.type");
      expect(await bad([{ type: "mystery" }])).toContain("messages.0.content.0.type");
      expect(await bad([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }])).toContain("text source");
      // A text document is read as text.
      expect((await ask({ messages: [{ role: "user", content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "the document body" } }, { type: "text", text: "Summarise." }] }] })).status).toBe(200);
      expect(prov.last().messages[0].content).toBe("the document body\n\nSummarise.");
    });

    test("system-role entries in the conversation (Claude Code appends them) stay in place; tool_reference results become text", async () => {
      const res = await ask({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "get_weather", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: [{ type: "tool_reference", tool_name: "get_time" }] }] },
          { role: "system", content: [{ type: "text", text: "reminder", cache_control: { type: "ephemeral" } }] },
          { role: "user", content: "go on" },
        ],
      });
      expect(res.status).toBe(200);
      expect(prov.last().messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "system", "user"]);
      expect(prov.last().messages[2].content).toBe("[tool available: get_time]");
      expect(prov.last().messages[3]).toEqual({ role: "system", content: "reminder" });
    });

    test("thinking blocks in history are dropped, and a thinking request is accepted and reported as ignored", async () => {
      const res = await ask({
        thinking: { type: "enabled", budget_tokens: 2000 },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "Hello." }] },
          { role: "assistant", content: [{ type: "redacted_thinking", data: "abc" }] },
          { role: "user", content: "again" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-anyroute-ignored")).toBe("thinking");
      expect(prov.last().messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    });
  });

  describe("tools", () => {
    test("tools become function tools; tool_choice maps auto, any, tool and none; hosted tools are left out and named", async () => {
      const res = await ask({ tools: [WEATHER, TIME, { type: "web_search_20250305", name: "web_search", max_uses: 3 }], tool_choice: { type: "any", disable_parallel_tool_use: true }, messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-anyroute-ignored")).toBe("tool:web_search");
      const sent = prov.last();
      expect(sent.tools).toHaveLength(2);
      expect(sent.tools[0]).toEqual({
        type: "function",
        function: { name: "get_weather", description: "Current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } },
      });
      expect(sent.tool_choice).toBe("required");
      expect(sent.parallel_tool_calls).toBe(false);
      for (const [choice, want] of [
        [{ type: "auto" }, "auto"],
        [{ type: "none" }, "none"],
        [{ type: "tool", name: "get_time" }, { type: "function", function: { name: "get_time" } }],
      ] as const) {
        expect((await ask({ tools: [WEATHER, TIME], tool_choice: choice })).status).toBe(200);
        expect(prov.last().tool_choice).toEqual(want as never);
        expect(prov.last().parallel_tool_calls).toBeUndefined();
      }
      // With no usable tool there is no tool_choice either.
      expect((await ask({ tools: [{ type: "bash_20250124", name: "bash" }], tool_choice: { type: "auto" } })).status).toBe(200);
      expect(prov.last().tools).toBeUndefined();
      expect(prov.last().tool_choice).toBeUndefined();
      expect(((await ask({ tools: [WEATHER], tool_choice: { type: "tool" } })).status)).toBe(400);
    });

    test("a tool call comes back as a tool_use block, and the tool_result goes back as a tool message: a full round trip", async () => {
      const first = await ask({ tools: [WEATHER], messages: [{ role: "user", content: "@@TOOL@@ weather in Oslo?" }] });
      expect(first.status).toBe(200);
      const j = (await first.json()) as any;
      expect(j.stop_reason).toBe("tool_use");
      expect(j.content).toEqual([
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "call_x", name: "get_weather", input: { city: "Oslo" } },
      ]);

      const second = await ask({
        tools: [WEATHER],
        tool_choice: { type: "none" },
        messages: [
          { role: "user", content: "@@TOOL@@ weather in Oslo?" },
          { role: "assistant", content: j.content },
          {
            role: "user",
            content: [
              { type: "text", text: "(sent with the result)" },
              { type: "tool_result", tool_use_id: "call_x", content: [{ type: "text", text: "3 C and raining" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
            ],
          },
        ],
      });
      expect(second.status).toBe(200);
      const sent = prov.last().messages;
      expect(sent[1]).toEqual({ role: "assistant", content: "Checking.", tool_calls: [{ id: "call_x", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] });
      // The tool message directly follows the call; what came with it (an image the tool returned, the text) follows that.
      expect(sent[2]).toEqual({ role: "tool", tool_call_id: "call_x", content: "3 C and raining" });
      expect(sent[3]).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "(sent with the result)" }] });
      expect(((await second.json()) as any).stop_reason).toBe("end_turn");

      // A tool-only turn (no text of its own) adds just the tool message; a tool_result may be a bare string.
      expect((await ask({ tools: [WEATHER], tool_choice: { type: "none" }, messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "sunny", is_error: false }] }] })).status).toBe(200);
      expect(prov.last().messages.slice(1)).toEqual([
        { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "sunny" },
      ]);
    });

    test("the harness mock's own tool call maps too", async () => {
      const j = (await (await ask({ tools: [WEATHER] })).json()) as any;
      expect(j).toMatchObject({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { ok: true } }] });
    });
  });

  describe("streaming", () => {
    test("emits Anthropic's events in order: message_start, ping, one text block, message_delta, message_stop", async () => {
      const res = await ask({ stream: true, messages: [{ role: "user", content: "stream me a reply that is long enough to arrive in several pieces" }] });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const s = await events(res);
      // Every event names its own type on the event: line.
      for (const e of s.list) expect(e.event).toBe(e.data.type);
      expect(s.types[0]).toBe("message_start");
      expect(s.types[1]).toBe("ping");
      expect(s.types.slice(-2)).toEqual(["message_delta", "message_stop"]);
      const middle = s.types.slice(2, -2);
      expect(middle[0]).toBe("content_block_start");
      expect(middle[middle.length - 1]).toBe("content_block_stop");
      expect(middle.filter((t) => t === "content_block_delta").length).toBeGreaterThan(1);
      expect(middle.filter((t) => t === "content_block_start")).toHaveLength(1);
      expect(s.list[2]!.data).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      const text = s.list.filter((e) => e.data.type === "content_block_delta").map((e) => {
        expect(e.data.delta.type).toBe("text_delta");
        expect(e.data.index).toBe(0);
        return e.data.delta.text as string;
      });
      expect(text.join("")).toContain("stream me a reply");
      // message_start carries the id (the receipt id), the model and an estimate of the prompt; message_delta the billed figures.
      const start = s.list[0]!.data.message;
      expect(start).toMatchObject({ type: "message", role: "assistant", model: LLAMA, content: [], stop_reason: null });
      expect(start.id).toBe(res.headers.get("x-receipt-id")!);
      expect(start.id).toStartWith("gen-");
      expect(start.usage.input_tokens).toBeGreaterThan(0);
      const done = s.list[s.list.length - 2]!.data;
      expect(done.delta).toEqual({ stop_reason: "end_turn", stop_sequence: null });
      expect(done.usage.output_tokens).toBeGreaterThan(0);
      expect(done.usage.input_tokens).toBeGreaterThan(0);
      expect(done.anyroute).toMatchObject({ receipt_id: start.id, lane: "public", provider: "Scripted" });
      expect(done.anyroute.receipt.id).toBe(start.id);
      for (const h of ["x-receipt-id", "inference-id", "x-generation-id", "x-anyroute-lane"]) expect(res.headers.get(h)).toBeTruthy();
      expect(res.headers.get("x-anyroute-lane")).toBe("public");
      // The stream was billed: the receipt is on record.
      expect((await h.request(`/api/v1/receipts/${start.id}`)).status).toBe(200);
    });

    test("tool calls stream as tool_use blocks with incremental input_json_delta, after a text block", async () => {
      const res = await ask({ stream: true, tools: [WEATHER, TIME], messages: [{ role: "user", content: "@@TOOLS_STREAM@@ weather and time?" }] });
      expect(res.status).toBe(200);
      const s = await events(res);
      expect(s.types).toEqual([
        "message_start",
        "ping",
        "content_block_start", // 0 text
        "content_block_delta",
        "content_block_stop",
        "content_block_start", // 1 tool_use get_weather
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "content_block_start", // 2 tool_use get_time
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      const d = s.list.map((e) => e.data);
      expect(d[2]).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      expect(d[3]).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check. " } });
      expect(d[5]).toEqual({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_a", name: "get_weather", input: {} } });
      expect(d[6]).toEqual({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } });
      expect(d[7]).toEqual({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } });
      expect(JSON.parse(d[6].delta.partial_json + d[7].delta.partial_json)).toEqual({ city: "Paris" });
      expect(d[9]).toEqual({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_b", name: "get_time", input: {} } });
      expect(d[10].delta).toEqual({ type: "input_json_delta", partial_json: "{}" });
      expect(d[12]).toMatchObject({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 30, output_tokens: 12 } });
    });

    test("a streamed request the router refuses before any output is a real HTTP error, not a 200 with an error event", async () => {
      const unknown = await post({ model: "nobody/nothing", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get("content-type")).toContain("application/json");
      expect(((await unknown.json()) as any).error.type).toBe("not_found_error");
      const unfunded = await ask({ stream: true }, { "x-api-key": poor });
      expect(unfunded.status).toBe(402);
      expect(((await unfunded.json()) as any).error.type).toBe("billing_error");
    });
  });

  describe("model names", () => {
    test("any catalog id works as sent; an unknown id is a not_found_error", async () => {
      expect(((await (await ask({ model: QWEN })).json()) as any).model).toBe(QWEN);
      const res = await ask({ model: "nobody/nothing" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error).toMatchObject({ type: "not_found_error" });
    });

    test("an unmapped claude-* name is a 404 that says AnyRoute serves open models and how to choose one", async () => {
      const res = await ask({ model: "claude-sonnet-4-5" });
      expect(res.status).toBe(404);
      const j = (await res.json()) as any;
      expect(j.error.type).toBe("not_found_error");
      expect(j.error.message).toContain("open models");
      expect(j.error.message).toContain("ANTHROPIC_MODEL");
      expect(j.error.message).toContain("ANTHROPIC_MODEL_MAP");
      expect(j.error.message).toContain(LLAMA);
      expect(j.anyroute.type).toBe("model_not_found");
    });

    test("ANTHROPIC_MODEL_MAP maps exact names, prefixes and a catch-all to catalog models; the map applies to a stream too", async () => {
      const original = h.ctx.cfg.anthropic.modelMap;
      h.ctx.cfg.anthropic.modelMap = parseModelMap(JSON.stringify({ "claude-sonnet-4-5": LLAMA, "claude-haiku-*": QWEN, "*": QWEN, "claude-broken": "nobody/nothing" }));
      try {
        expect(((await (await ask({ model: "claude-sonnet-4-5" })).json()) as any).model).toBe(LLAMA);
        expect(((await (await ask({ model: "claude-haiku-4-5-20251001" })).json()) as any).model).toBe(QWEN);
        expect(((await (await ask({ model: "claude-opus-9" })).json()) as any).model).toBe(QWEN);
        const s = await events(await ask({ model: "claude-sonnet-4-5", stream: true }));
        expect(s.list[0]!.data.message.model).toBe(LLAMA);
        const broken = await ask({ model: "claude-broken" });
        expect(broken.status).toBe(404);
        const msg = ((await broken.json()) as any).error.message as string;
        expect(msg).toContain("ANTHROPIC_MODEL_MAP maps 'claude-broken' to 'nobody/nothing'");
        // The prompt sent to the provider names the mapped model, not the client's.
        await ask({ model: "claude-sonnet-4-5" });
        expect(prov.last().model).toBe(MODELS.llama.id);
      } finally {
        h.ctx.cfg.anthropic.modelMap = original;
      }
    });
  });

  describe("request errors", () => {
    test("malformed requests are invalid_request_error with the field named", async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ model: undefined }, "model"],
        [{ max_tokens: undefined }, "max_tokens"],
        [{ max_tokens: 0 }, "max_tokens"],
        [{ messages: [] }, "messages"],
        [{ messages: [{ role: "tool", content: "x" }] }, "messages.0.role"],
        [{ messages: [{ role: "user", content: 5 }] }, "messages.0.content"],
        [{ temperature: "hot" }, "temperature"],
        [{ stop_sequences: "END" }, "stop_sequences"],
        [{ tools: [{ input_schema: {} }] }, "tools.0.name"],
        [{ mcp_servers: [{ type: "url", url: "https://example.com/mcp", name: "x" }] }, "mcp_servers"],
        [{ provider: "attested" }, "provider"],
      ];
      for (const [patch, field] of cases) {
        const res = await post({ model: LLAMA, max_tokens: 16, messages: [{ role: "user", content: "hi" }], ...patch });
        expect(res.status).toBe(400);
        const j = (await res.json()) as any;
        expect(j.type).toBe("error");
        expect(j.error.type).toBe("invalid_request_error");
        expect(j.error.message).toContain(field);
      }
      const notJson = await h.request("/v1/messages", { method: "POST", headers: { "x-api-key": secret, "content-type": "application/json" }, body: "{nope" });
      expect(notJson.status).toBe(400);
      expect(((await notJson.json()) as any).error.type).toBe("invalid_request_error");
    });

    test("every router error status maps to Anthropic's error type", () => {
      expect(
        Object.fromEntries([400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 504, 529, 409, 422].map((s) => [s, errorType(s)])),
      ).toEqual({
        400: "invalid_request_error",
        401: "authentication_error",
        402: "billing_error",
        403: "permission_error",
        404: "not_found_error",
        413: "request_too_large",
        429: "rate_limit_error",
        500: "api_error",
        502: "api_error",
        503: "api_error",
        504: "timeout_error",
        529: "overloaded_error",
        409: "invalid_request_error",
        422: "invalid_request_error",
      });
    });

    test("the global size guard returns payload_too_large and its byte cap", async () => {
      const res = await h.request("/v1/messages", { method: "POST", headers: { "x-api-key": secret, "content-type": "application/json", "content-length": String(17 * 1024 * 1024) }, body: "{}" });
      expect(res.status).toBe(413);
      expect((await res.json()).error).toEqual({ type: "payload_too_large", message: "Request body exceeds 16777216 bytes.", max_bytes: 16 * 1024 * 1024 });
    });
  });

  describe("count_tokens", () => {
    const count = (json: unknown, headers: Record<string, string> = { "x-api-key": secret }) => post(json, headers, "/v1/messages/count_tokens");

    test("returns the router's estimate, growing with the prompt, tools and images; needs a key but no max_tokens", async () => {
      const small = (await (await count({ model: LLAMA, messages: [{ role: "user", content: "hi" }] })).json()) as any;
      expect(small.input_tokens).toBeGreaterThan(0);
      expect(Number.isInteger(small.input_tokens)).toBe(true);
      const big = (await (await count({ model: LLAMA, system: "You are careful. ".repeat(50), messages: [{ role: "user", content: "hi" }] })).json()) as any;
      expect(big.input_tokens).toBeGreaterThan(small.input_tokens);
      const withTools = (await (await count({ model: LLAMA, messages: [{ role: "user", content: "hi" }], tools: [WEATHER, TIME] })).json()) as any;
      expect(withTools.input_tokens).toBeGreaterThan(small.input_tokens);
      const withImage = (await (await count({ model: LLAMA, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }] })).json()) as any;
      expect(withImage.input_tokens).toBeGreaterThan(1_600);
      // It is the same figure the router holds against a chat call, and it costs nothing.
      const before = Number(((await (await h.request("/api/v1/credits", { headers: { authorization: `Bearer ${secret}` } })).json()) as any).data.total_usage);
      await count({ model: LLAMA, messages: [{ role: "user", content: "free?" }] });
      expect(Number(((await (await h.request("/api/v1/credits", { headers: { authorization: `Bearer ${secret}` } })).json()) as any).data.total_usage)).toBe(before);
      // An unknown or unmapped model name does not stop a count.
      expect((await count({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
      expect((await h.request("/api/v1/messages/count_tokens", { method: "POST", headers: { authorization: `Bearer ${secret}` }, json: { model: LLAMA, messages: [{ role: "user", content: "hi" }] } })).status).toBe(200);
    });

    test("errors are Anthropic-shaped", async () => {
      const none = await count({ model: LLAMA, messages: [{ role: "user", content: "hi" }] }, {});
      expect(none.status).toBe(401);
      expect(((await none.json()) as any).error.type).toBe("authentication_error");
      const bad = await count({ model: LLAMA, messages: [] });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as any).error.type).toBe("invalid_request_error");
    });
  });

  test("a browser preflight for the SDK's headers is allowed", async () => {
    const res = await h.request("/v1/messages", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "x-api-key,anthropic-version,anthropic-beta,anthropic-dangerous-direct-browser-access,content-type" } });
    expect(res.status).toBeLessThan(300);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const name of ["x-api-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access"]) expect(allowed).toContain(name);
  });
});

// ---- failures upstream -------------------------------------------------------------------------------------------------

describe("when providers fail", () => {
  let h: Harness;
  let secret: string;
  beforeAll(async () => {
    h = await startRouter();
    secret = (await h.fundedKey(20n)).secret;
  });
  afterAll(async () => h.close());

  const control = (behaviour: string) => fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour }) });
  const resetHealth = () => (h.ctx.health = new (h.ctx.health.constructor as any)(h.ctx.cfg.routing.outageWindowMs));
  const ask = (extra: Record<string, unknown> = {}) => h.request("/v1/messages", { method: "POST", headers: { "x-api-key": secret }, json: { model: QWEN, max_tokens: 200, messages: [{ role: "user", content: "a prompt long enough for a stream in pieces" }], ...extra } });

  test("a provider that rejects the request is an invalid_request_error, streamed or not", async () => {
    await control("reject400");
    resetHealth();
    for (const stream of [false, true]) {
      const res = await ask({ stream });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      const j = (await res.json()) as any;
      expect(j.error.type).toBe("invalid_request_error");
      expect(j.error.message).toContain("Provider rejected");
    }
  });

  test("when every provider is down it is an api_error (502) before the stream starts, so SDKs can retry it", async () => {
    await control("error500");
    resetHealth();
    for (const stream of [false, true]) {
      resetHealth();
      const res = await ask({ stream });
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toContain("application/json");
      const j = (await res.json()) as any;
      expect(j).toMatchObject({ type: "error", error: { type: "api_error" }, anyroute: { type: "providers_unavailable" } });
      expect(j.error.message).toContain("Nothing was charged");
    }
  });

  test("a provider that fails after output has started ends the stream with an error event and no message_stop", async () => {
    await control("midstream_error");
    resetHealth();
    const res = await ask({ stream: true });
    expect(res.status).toBe(200);
    const s = await events(res);
    expect(s.types[0]).toBe("message_start");
    expect(s.types).toContain("content_block_delta");
    expect(s.types[s.types.length - 1]).toBe("error");
    expect(s.types).not.toContain("message_stop");
    expect(s.types).not.toContain("message_delta");
    expect(s.list[s.list.length - 1]!.data).toMatchObject({ type: "error", error: { type: "api_error" } });
    await control("ok");
  });
});

// ---- lanes -------------------------------------------------------------------------------------------------------------

describe("the attested lane", () => {
  let fx: Awaited<ReturnType<typeof startGatewayRouter>>;
  let secret: string;
  beforeAll(async () => {
    fx = await startGatewayRouter();
    secret = (await fx.h.fundedKey(20n)).secret;
    expect(await fx.reset()).toMatchObject({ provider: "gw", ok: true });
  });
  afterAll(async () => fx.close());

  const ask = (model: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    fx.h.request("/v1/messages", { method: "POST", headers: { "x-api-key": secret, ...VERSION, ...headers }, json: { model, max_tokens: 32, messages: [{ role: "user", content: "keep this private" }], ...extra } });

  test("x-anyroute-lane: attested serves an attested endpoint and the reply carries the lane, the receipt and the gateway check", async () => {
    const res = await ask(GW_MODEL, { "x-anyroute-lane": "attested" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-anyroute-lane")).toBe("attested");
    const j = (await res.json()) as any;
    expect(j.content[0].text).toBe("hello from the gateway");
    expect(res.headers.get("x-receipt-id")).toBe(j.id);
    expect(j.anyroute).toMatchObject({ receipt_id: j.id, lane: "attested", disclosure: "attested", upstream_attestation: { attested: true } });
    expect(j.anyroute.receipt.payload.lane).toBe("attested");
    expect(fx.state.requests.length).toBeGreaterThan(0);
  });

  test("provider.lane in the body does the same, and the two together take the stricter", async () => {
    const res = await ask(GW_MODEL, {}, { provider: { lane: "attested" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-anyroute-lane")).toBe("attested");
    expect(((await res.json()) as any).anyroute.lane).toBe("attested");
    const both = await ask(GW_MODEL, { "x-anyroute-lane": "public" }, { provider: { lane: "attested" } });
    expect(both.headers.get("x-anyroute-lane")).toBe("attested");
  });

  test("with no lane, the public provider still answers; on the attested lane it is refused, and nothing is sent or charged", async () => {
    expect((await ask(PLAIN.slug)).status).toBe(200);
    const sentBefore = fx.state.requests.length;
    const refused = await ask(PLAIN.slug, { "x-anyroute-lane": "attested" });
    expect(refused.status).toBe(503);
    const j = (await refused.json()) as any;
    expect(j).toMatchObject({ type: "error", error: { type: "api_error" }, anyroute: { type: "no_attested_endpoint", metadata: { reason: "none_attested" } } });
    expect(j.error.message).toContain("Nothing was sent to any provider and nothing was charged");
    // The router will refuse this lane again, so an SDK is told not to retry it.
    expect(refused.headers.get("x-should-retry")).toBe("false");
    expect(fx.state.requests.length).toBe(sentBefore);
    // Streamed, it is the same refusal as an HTTP error, not a stream.
    const streamed = await ask(PLAIN.slug, { "x-anyroute-lane": "attested" }, { stream: true });
    expect(streamed.status).toBe(503);
    expect(streamed.headers.get("content-type")).toContain("application/json");
    expect(((await streamed.json()) as any).anyroute.type).toBe("no_attested_endpoint");
  });

  test("a lane the router does not run is a 501 that is not retried", async () => {
    const res = await ask(PLAIN.slug, { "x-anyroute-lane": "unlinkable" });
    expect(res.status).toBe(501);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(((await res.json()) as any).anyroute.type).toBe("lane_not_available");
  });

  test("an unrecognised lane is refused rather than treated as public", async () => {
    const res = await ask(PLAIN.slug, { "x-anyroute-lane": "fast" });
    expect(res.status).toBe(400);
    const j = (await res.json()) as any;
    expect(j.error.type).toBe("invalid_request_error");
    expect(j.error.message).toContain("X-Anyroute-Lane must be one of");
    expect((await ask(PLAIN.slug, {}, { provider: { lane: "fast" } })).status).toBe(400);
  });
});

describe("the attested lane, streamed, with a policy hash bound by the endpoint's attestation", () => {
  const POLICY = "sha256:" + "55".repeat(32);
  const CLASSIFIER = { classifier_enabled: true, classifier_digest: "sha256:" + "44".repeat(32), classifier_policy: POLICY };
  const ENCLAVE = { id: "enclave-up", slug: "anthropic/enclave-chat", prompt: "0.0000001", completion: "0.0000004" };
  let h: Harness;
  let sidecar: ReturnType<typeof Bun.serve>;
  let dcap: ReturnType<typeof Bun.serve>;
  let secret: string;

  beforeAll(async () => {
    sidecar = Bun.serve({ port: 0, fetch: (req) => Response.json(sidecarDocument(new URL(req.url).searchParams.get("nonce") ?? "", { bindings: { ...bindingsFor(), ...CLASSIFIER } })) });
    dcap = Bun.serve({ port: 0, fetch: () => Response.json({ verified: true }) });
    h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [ENCLAVE] }], env: { TDX_VERIFIER_URL: `http://127.0.0.1:${dcap.port}/verify`, MEASUREMENTS_ENABLED: "true" } });
    await h.ctx.db.update(providers).set({ teeKind: "tdx", attestationUrl: `http://127.0.0.1:${sidecar.port}/attest` }).where(eq(providers.id, "alpha"));
    const claim = { source: "https://enclave.example/terms", as_of: "2025-01-15" };
    const put = await h.request("/api/v1/disclosure/alpha", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
    expect(put.status).toBe(200);
    expect((await runAttestor(h.ctx)).results[0]).toMatchObject({ ok: true });
    await h.ctx.catalog.refresh();
    secret = (await h.fundedKey(5n)).secret;
  });
  afterAll(async () => {
    sidecar.stop(true);
    dcap.stop(true);
    await h.close();
  });

  const ask = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
    h.request("/v1/messages", { method: "POST", headers: { "x-api-key": secret, ...headers }, json: { model: ENCLAVE.slug, max_tokens: 40, messages: [{ role: "user", content: "keep this inside the enclave" }], ...extra } });

  test("the lane, policy hash and receipt headers ride on both the JSON reply and the stream, and the reply names them", async () => {
    const json = await ask({ "x-anyroute-lane": "attested" });
    expect(json.status).toBe(200);
    expect(json.headers.get("x-anyroute-lane")).toBe("attested");
    expect(json.headers.get("x-anyroute-policy-hash")).toBe(POLICY);
    const j = (await json.json()) as any;
    expect(j.anyroute).toMatchObject({ lane: "attested", policy_hash: POLICY, disclosure: "attested", receipt_id: j.id });
    expect(j.anyroute.receipt.payload.lane).toBe("attested");

    const stream = await ask({ "x-anyroute-lane": "attested" }, { stream: true });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("x-anyroute-lane")).toBe("attested");
    expect(stream.headers.get("x-anyroute-policy-hash")).toBe(POLICY);
    expect(stream.headers.get("x-receipt-id")).toStartWith("gen-");
    const s = await events(stream);
    expect(s.types[0]).toBe("message_start");
    expect(s.types.slice(-2)).toEqual(["message_delta", "message_stop"]);
    expect(s.list[0]!.data.message.id).toBe(stream.headers.get("x-receipt-id")!);
    expect(s.list[s.list.length - 2]!.data.anyroute).toMatchObject({ lane: "attested", policy_hash: POLICY, disclosure: "attested" });
    // The lane in the body works the same.
    const viaBody = await ask({}, { provider: { lane: "attested" }, stream: true });
    expect(viaBody.headers.get("x-anyroute-lane")).toBe("attested");
    expect((await events(viaBody)).types.slice(-1)).toEqual(["message_stop"]);
  });
});

// ---- pure pieces -------------------------------------------------------------------------------------------------------

describe("model map", () => {
  test("parses exact names, prefixes (longest first) and a catch-all", () => {
    const map = parseModelMap('{"claude-sonnet-4-5":"a/x","claude-haiku-*":"b/y","claude-*":"c/z","*":"d/w"}');
    expect(mappedModel(map, "claude-sonnet-4-5")).toBe("a/x");
    expect(mappedModel(map, "claude-haiku-4-5")).toBe("b/y");
    expect(mappedModel(map, "claude-opus-4")).toBe("c/z");
    expect(mappedModel(map, "gpt-x")).toBe("d/w");
    expect(mappedModel(parseModelMap('{"claude-sonnet-4-5":"a/x"}'), "meta-llama/llama-3.3-70b-instruct")).toBeNull();
    expect(mappedModel(parseModelMap(undefined), "claude-sonnet-4-5")).toBeNull();
    expect(mappedModel(parseModelMap("  "), "anything")).toBeNull();
  });

  test("rejects a map that is not a JSON object of strings", () => {
    for (const bad of ["{nope", "[]", '"x"', '{"a":1}', '{"a":""}', '{"":"a/b"}', "null"]) expect(() => parseModelMap(bad)).toThrow(/ANTHROPIC_MODEL_MAP/);
  });

  test("is read from ANTHROPIC_MODEL_MAP by the router's config, and a bad value stops it starting", () => {
    const env = { ANYROUTE_ENV: "test", APP_SECRET: "test-secret-test-secret-test-secret-1234", ADMIN_TOKEN: ADMIN };
    expect(mappedModel(loadConfig({ ...env, ANTHROPIC_MODEL_MAP: '{"claude-sonnet-4-5":"a/x"}' }).anthropic.modelMap, "claude-sonnet-4-5")).toBe("a/x");
    expect(mappedModel(loadConfig(env).anthropic.modelMap, "claude-sonnet-4-5")).toBeNull();
    expect(() => loadConfig({ ...env, ANTHROPIC_MODEL_MAP: "nope" })).toThrow(/ANTHROPIC_MODEL_MAP/);
  });

  test("recognises Anthropic model names", () => {
    for (const n of ["claude-sonnet-4-5", "claude-3-5-haiku-latest", "Claude-Opus-4", "claude"]) expect(isAnthropicName(n)).toBe(true);
    for (const n of ["meta-llama/llama-3.3-70b-instruct", "anthropic/claude-x", "claudette", "qwen/qwen3-32b"]) expect(isAnthropicName(n)).toBe(false);
  });
});

describe("conversion", () => {
  test("usage: input_tokens excludes what was read from or written to the cache, and the three add up to the prompt", () => {
    expect(toAnthropicUsage({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 } })).toEqual({ input_tokens: 30, output_tokens: 7, cache_creation_input_tokens: 10, cache_read_input_tokens: 60 });
    expect(toAnthropicUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(toAnthropicUsage({ prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 9 } }).input_tokens).toBe(0);
  });

  test("stop reasons", () => {
    expect(toStop({ finish_reason: "stop" }, [], false)).toEqual({ stop_reason: "end_turn", stop_sequence: null });
    expect(toStop({ finish_reason: "length" }, [], false).stop_reason).toBe("max_tokens");
    expect(toStop({ finish_reason: "tool_calls" }, [], true).stop_reason).toBe("tool_use");
    expect(toStop({ finish_reason: "stop" }, [], true).stop_reason).toBe("tool_use");
    expect(toStop({ finish_reason: "content_filter" }, [], false).stop_reason).toBe("refusal");
    expect(toStop({ finish_reason: "stop", stop_reason: "###" }, ["###"], false)).toEqual({ stop_reason: "stop_sequence", stop_sequence: "###" });
    expect(toStop({ finish_reason: "stop", stop_reason: 151645 }, ["###"], false).stop_reason).toBe("end_turn");
    expect(toStop({ finish_reason: "error" }, [], false).stop_reason).toBe("end_turn");
    expect(toStop(null, [], false).stop_reason).toBe("end_turn");
  });

  test("tool arguments parse to an object; anything else becomes an empty input", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments("")).toEqual({});
    expect(parseArguments("{oops")).toEqual({});
    expect(parseArguments("[1]")).toEqual({});
    expect(parseArguments({ a: 2 })).toEqual({ a: 2 });
  });

  test("max_tokens is lowered to the model's output limit and to what is left of its context", () => {
    expect(clampMaxTokens(32_000, { maxOut: 8192, ctx: 131_072 }, 1000)).toBe(8192);
    expect(clampMaxTokens(1000, { maxOut: 8192, ctx: 131_072 }, 1000)).toBe(1000);
    expect(clampMaxTokens(32_000, { maxOut: null, ctx: 10_000 }, 9_000)).toBe(1000);
    expect(clampMaxTokens(32_000, { maxOut: null, ctx: 8000 }, 9_000)).toBe(32_000); // a prompt over the context is the router's to refuse
    expect(clampMaxTokens(5, {}, 0)).toBe(5);
  });

  test("a request with tool results before text keeps the tool message next to its call", () => {
    const { body } = toChatRequest({
      model: "m",
      max_tokens: 10,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "f", input: { x: 1 } }, { type: "tool_use", id: "b", name: "g", input: {} }] },
        { role: "user", content: [{ type: "text", text: "context" }, { type: "tool_result", tool_use_id: "a", content: "ra" }, { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "rb" }] }] },
      ],
    });
    expect((body.messages as any[]).map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"]);
  });
});

describe("stream translator", () => {
  const make = (stops: string[] = []) => new StreamTranslator({ id: "gen-1", model: "m", inputTokens: 5, stops, describe: (s) => ({ receipt_id: s.receipt?.id ?? null }) });
  const run = (t: StreamTranslator, chunks: Record<string, unknown>[]) => {
    const out = [...t.start()];
    for (const c of chunks) out.push(...t.chunk(c));
    out.push(...t.end());
    return out.map((e) => JSON.parse(e.split("\ndata: ")[1]!));
  };
  const usage = { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 }, receipt: { id: "gen-1" } };

  test("providers that repeat the call id, omit indexes or send a whole call in one chunk all give the same blocks", () => {
    const events = run(make(), [
      { choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "c1", function: { arguments: ":1}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "c2", index: 0, function: { name: "g", arguments: '{"b":2}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { name: "h" } }] } }] }, // a continuation with no id and no index stays on the open call
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      usage,
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[2].content_block).toMatchObject({ id: "c1", name: "f" });
    expect(events[6].content_block).toMatchObject({ id: "c2", name: "g" });
    // finish_reason "stop" with tool calls in the message is still tool_use.
    expect(events[9].delta.stop_reason).toBe("tool_use");
    expect(events[9].usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
    expect(events[9].anyroute).toEqual({ receipt_id: "gen-1" });
  });

  test("an empty answer is one empty text block; text after a tool call opens a new block; reasoning is not relayed", () => {
    const empty = run(make(), [{ choices: [{ delta: { reasoning: "thinking..." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, usage]);
    expect(empty.map((e) => e.type)).toEqual(["message_start", "ping", "content_block_start", "content_block_stop", "message_delta", "message_stop"]);
    const mixed = run(make(), [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "" } }] } }] },
      { choices: [{ delta: { content: "after" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      usage,
    ]);
    expect(mixed.filter((e) => e.type === "content_block_start").map((e) => [e.index, e.content_block.type])).toEqual([[0, "tool_use"], [1, "text"]]);
    // A tool call that never got arguments closes with an empty object, so a client that parses the JSON gets {}.
    expect(mixed.find((e) => e.type === "content_block_delta" && e.index === 0).delta).toEqual({ type: "input_json_delta", partial_json: "{}" });
  });

  test("an error chunk ends the stream with one error event; a stream that stops short is an error, not a clean ending", () => {
    const t = make();
    const out = [...t.start(), ...t.chunk({ choices: [{ delta: { content: "par" } }] }), ...t.chunk({ error: { code: 502, message: "provider fell over", type: "provider_error" }, choices: [{ delta: { content: "" }, finish_reason: "error" }] }), ...t.chunk({ choices: [{ delta: { content: "ignored" } }] }), ...t.end()];
    const types = out.map((e) => JSON.parse(e.split("\ndata: ")[1]!).type);
    expect(types).toEqual(["message_start", "ping", "content_block_start", "content_block_delta", "error"]);
    expect(JSON.parse(out[out.length - 1]!.split("\ndata: ")[1]!)).toMatchObject({ error: { type: "api_error", message: "provider fell over" }, anyroute: { type: "provider_error" } });
    const truncated = make();
    const cut = [...truncated.start(), ...truncated.chunk({ choices: [{ delta: { content: "x" } }] }), ...truncated.end()];
    expect(JSON.parse(cut[cut.length - 1]!.split("\ndata: ")[1]!)).toMatchObject({ type: "error", error: { type: "api_error" } });
  });
});

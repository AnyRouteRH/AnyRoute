import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { balanceOf } from "../src/ledger/ledger.ts";
import { keys as keysTable, providers } from "../src/db/schema.ts";
import { chatRequestFrom, customInput, InputDecoder, messagesFromInput, responseFromChat, StreamTranslator, type Echo, type Meta } from "../src/api/responses-map.ts";
import { runRegistry } from "../src/services/registry.ts";
import { encrypt } from "../src/lib/util.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { GW_MODEL, PLAIN, startGatewayRouter } from "./aci-mock-gateway.ts";

// The OpenAI Responses endpoint (POST /v1/responses and /api/v1/responses): an adapter over the chat route, stateless.
// The routers here have real mock providers behind them; every call goes through the whole router, so billing, lanes
// and the receipt and lane headers are the chat route's own.

const balanceOfKey = async (h: Harness, keyHash: string) => {
  const [k] = await h.ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, keyHash));
  return (await balanceOf(h.ctx.db, k.accountId)).balance;
};

/** A Responses SSE body as [event name, data] pairs, checking every frame is well formed. */
const frames = async (res: Response) => {
  const raw = await res.text();
  const out: { event: string; data: any }[] = [];
  for (const block of raw.split("\n\n").map((b) => b.trim()).filter(Boolean)) {
    if (block.startsWith(":")) continue;
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    expect(event).toBeDefined();
    expect(data).toBeDefined();
    out.push({ event: event!, data: JSON.parse(data!) });
  }
  return { raw, events: out, types: out.map((e) => e.event) };
};

describe("the Responses endpoint on a public provider", () => {
  let h: Harness;
  let auth: Record<string, string>;
  let keyHash: string;
  const alpha = () => h.mocks.alpha!;
  const post = (body: Record<string, unknown>, headers: Record<string, string> = auth, path = "/v1/responses") => h.request(path, { method: "POST", headers, json: body });
  const REQUEST = { model: MODELS.llama.slug, input: "Say hello", max_output_tokens: 64 };

  beforeAll(async () => {
    h = await startRouter({
      providers: [
        {
          id: "alpha",
          name: "Alpha",
          models: [MODELS.llama],
          reply: (prompt) => (prompt.includes("as json") ? '{"city":"Paris","temp_c":18}' : undefined),
        },
      ],
    });
    const k = await h.fundedKey(20n);
    auth = k.auth;
    keyHash = k.hash;
  });
  afterAll(async () => h.close());

  describe("non-streaming", () => {
    test("returns a Response object with the answer, usage and the receipt id, on both paths", async () => {
      const before = await balanceOfKey(h, keyHash);
      for (const path of ["/v1/responses", "/api/v1/responses"]) {
        const res = await post(REQUEST, auth, path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        const j = (await res.json()) as any;
        expect(j).toMatchObject({ object: "response", status: "completed", model: MODELS.llama.slug, error: null, incomplete_details: null, store: false, previous_response_id: null, max_output_tokens: 64 });
        expect(j.id).toStartWith("resp_gen-");
        expect(j.created_at).toBeGreaterThan(1_700_000_000);
        expect(j.output).toHaveLength(1);
        expect(j.output[0]).toMatchObject({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello from Alpha. You said: Say hello", annotations: [] }] });
        expect(j.output[0].id).toStartWith("msg_");
        expect(j.usage.input_tokens).toBeGreaterThan(0);
        expect(j.usage.output_tokens).toBeGreaterThan(0);
        expect(j.usage.total_tokens).toBe(j.usage.input_tokens + j.usage.output_tokens);
        expect(j.usage.output_tokens_details).toEqual({ reasoning_tokens: 0 });
        expect(typeof j.usage.cost).toBe("number");
        // The receipt id is the chat route's: in the headers, in the id and in the metadata.
        const receipt = res.headers.get("x-receipt-id")!;
        expect(receipt).toStartWith("gen-");
        expect(res.headers.get("inference-id")).toBe(receipt);
        expect(res.headers.get("x-generation-id")).toBe(receipt);
        expect(res.headers.get("x-anyroute-lane")).toBe("public");
        expect(j.id).toBe(`resp_${receipt}`);
        expect(j.metadata).toMatchObject({ anyroute_receipt_id: receipt, anyroute_lane: "public", anyroute_disclosure: "vendor-forwarded" });
        // ... and it is a real, signed receipt, which holds no prompt or answer.
        const rc = (await (await h.request(`/api/v1/receipts/${receipt}`)).json()) as any;
        expect(rc.data.payload).toMatchObject({ id: receipt, lane: "public" });
        expect(JSON.stringify(rc)).not.toContain("Say hello");
      }
      expect(await balanceOfKey(h, keyHash)).toBeLessThan(before); // billed like any chat call
    });

    test("instructions, messages, images and the sampling options reach the provider as a chat request", async () => {
      const res = await post({
        model: MODELS.llama.slug,
        instructions: "Answer in French.",
        input: [
          { role: "developer", content: "Be brief." },
          { type: "message", role: "user", content: [{ type: "input_text", text: "What is this?" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "A cat." }] },
          { type: "reasoning", id: "rs_1", summary: [] },
          { role: "user", content: "Thanks" },
        ],
        max_output_tokens: 33,
        temperature: 0.2,
        top_p: 0.9,
        user: "end-user-7",
        metadata: { trace: "abc" },
      });
      expect(res.status).toBe(200);
      const sent = alpha().stats.lastBody;
      expect(sent.messages).toEqual([
        { role: "system", content: "Answer in French." },
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } }] },
        { role: "assistant", content: "A cat." },
        { role: "user", content: "Thanks" },
      ]);
      expect(sent).toMatchObject({ max_tokens: 33, temperature: 0.2, top_p: 0.9, user: "end-user-7" });
      expect(JSON.stringify(sent)).not.toContain("abc"); // metadata is echoed back, not sent to a provider
      const j = (await res.json()) as any;
      expect(j).toMatchObject({ instructions: "Answer in French.", temperature: 0.2, top_p: 0.9, user: "end-user-7", metadata: { trace: "abc" } });
    });

    test("text.format json_schema becomes response_format, and the answer comes back as output_text", async () => {
      const schema = { type: "object", properties: { city: { type: "string" }, temp_c: { type: "number" } }, required: ["city", "temp_c"], additionalProperties: false };
      const res = await post({
        model: MODELS.llama.slug,
        input: "Weather in Paris, as json",
        text: { format: { type: "json_schema", name: "weather", strict: true, description: "A forecast", schema } },
      });
      expect(res.status).toBe(200);
      expect(alpha().stats.lastBody.response_format).toEqual({ type: "json_schema", json_schema: { name: "weather", strict: true, description: "A forecast", schema } });
      const j = (await res.json()) as any;
      expect(JSON.parse(j.output[0].content[0].text)).toEqual({ city: "Paris", temp_c: 18 });
      expect(j.text.format).toMatchObject({ type: "json_schema", name: "weather" });
      // json_object and plain text formats.
      await post({ model: MODELS.llama.slug, input: "hi", text: { format: { type: "json_object" } } });
      expect(alpha().stats.lastBody.response_format).toEqual({ type: "json_object" });
      await post({ model: MODELS.llama.slug, input: "hi", text: { format: { type: "text" } } });
      expect(alpha().stats.lastBody.response_format).toBeUndefined();
    });

    test("a function tool round trip: the call comes back as a function_call item and its output goes back as chat tool messages", async () => {
      const tool = { type: "function", name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, strict: true };
      const first = await post({ model: MODELS.llama.slug, input: "What is the weather in Paris?", tools: [tool], tool_choice: "auto", parallel_tool_calls: false });
      expect(first.status).toBe(200);
      expect(alpha().stats.lastBody.tools).toEqual([{ type: "function", function: { name: "get_weather", description: "Weather for a city", parameters: tool.parameters, strict: true } }]);
      expect(alpha().stats.lastBody).toMatchObject({ tool_choice: "auto", parallel_tool_calls: false });
      const j = (await first.json()) as any;
      expect(j.status).toBe("completed");
      expect(j.output).toHaveLength(1);
      expect(j.output[0]).toMatchObject({ type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"ok":true}', status: "completed" });
      expect(j.output[0].id).toStartWith("fc_");
      expect(j.tools).toEqual([tool]);
      expect(j.parallel_tool_calls).toBe(false);

      // The client runs the function and sends the whole conversation back, with the call and its output.
      const second = await post({
        model: MODELS.llama.slug,
        input: [{ role: "user", content: "What is the weather in Paris?" }, ...j.output, { type: "function_call_output", call_id: "call_1", output: '{"temp_c":18}' }],
        tools: [tool],
        tool_choice: "none",
      });
      expect(second.status).toBe(200);
      expect(alpha().stats.lastBody.messages).toEqual([
        { role: "user", content: "What is the weather in Paris?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"ok":true}' } }] },
        { role: "tool", tool_call_id: "call_1", content: '{"temp_c":18}' },
      ]);
      expect(alpha().stats.lastBody.tool_choice).toBe("none");
      const done = (await second.json()) as any;
      expect(done.output[0]).toMatchObject({ type: "message", content: [{ type: "output_text" }] });

      // A forced function.
      await post({ model: MODELS.llama.slug, input: "hi", tools: [tool], tool_choice: { type: "function", name: "get_weather" } });
      expect(alpha().stats.lastBody.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
    });
  });

  describe("streaming", () => {
    test("sends the Responses events in order, with sequence numbers, and no [DONE]", async () => {
      const res = await post({ ...REQUEST, stream: true });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const receipt = res.headers.get("x-receipt-id")!;
      expect(receipt).toStartWith("gen-");
      expect(res.headers.get("inference-id")).toBe(receipt);
      expect(res.headers.get("x-anyroute-lane")).toBe("public");

      const { raw, events, types } = await frames(res);
      expect(raw).not.toContain("[DONE]");
      const deltas = events.filter((e) => e.event === "response.output_text.delta");
      expect(deltas.length).toBeGreaterThan(1);
      expect(types).toEqual([
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.content_part.added",
        ...deltas.map(() => "response.output_text.delta"),
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ]);
      // Every frame names its own type and numbers itself 0, 1, 2, ...
      events.forEach((e, i) => {
        expect(e.data.type).toBe(e.event);
        expect(e.data.sequence_number).toBe(i);
      });
      const [created, inProgress, added, part] = events.map((e) => e.data);
      expect(created.response).toMatchObject({ object: "response", status: "in_progress", output: [], id: `resp_${receipt}`, metadata: { anyroute_receipt_id: receipt } });
      expect(inProgress.response.status).toBe("in_progress");
      expect(added).toMatchObject({ output_index: 0, item: { type: "message", role: "assistant", status: "in_progress", content: [] } });
      expect(part).toMatchObject({ item_id: added.item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
      const text = deltas.map((d) => d.data.delta).join("");
      expect(text).toBe("Hello from Alpha. You said: Say hello");
      for (const d of deltas) expect(d.data).toMatchObject({ item_id: added.item.id, output_index: 0, content_index: 0 });
      expect(events.find((e) => e.event === "response.output_text.done")!.data.text).toBe(text);
      const done = events.find((e) => e.event === "response.output_item.done")!.data;
      expect(done.item).toMatchObject({ id: added.item.id, status: "completed", content: [{ type: "output_text", text }] });
      const completed = events.at(-1)!.data.response;
      expect(completed).toMatchObject({ status: "completed", id: `resp_${receipt}`, model: MODELS.llama.slug, output: [done.item], metadata: { anyroute_receipt_id: receipt, anyroute_lane: "public", anyroute_disclosure: "vendor-forwarded" } });
      expect(completed.usage.total_tokens).toBe(completed.usage.input_tokens + completed.usage.output_tokens);
      expect(completed.usage.output_tokens).toBeGreaterThan(0);
    });
  });

  describe("refusals: nothing is stored, nothing is sent, nothing is charged", () => {
    const refused = async (body: Record<string, unknown>) => {
      const before = await balanceOfKey(h, keyHash);
      const sent = alpha().stats.requests;
      const res = await post(body);
      expect(await balanceOfKey(h, keyHash)).toBe(before);
      expect(alpha().stats.requests).toBe(sent);
      return { status: res.status, e: ((await res.json()) as any).error };
    };

    test("store: true is refused; store: false and no store are accepted", async () => {
      const { status, e } = await refused({ ...REQUEST, store: true });
      expect(status).toBe(400);
      expect(e).toMatchObject({ type: "store_not_supported", param: "store", code: 400 });
      expect(e.message).toContain("stateless");
      expect(e.message).toContain("store: false");
      expect((await post({ ...REQUEST, store: false })).status).toBe(200);
    });

    test("previous_response_id is refused with the reason and what to send instead", async () => {
      const { status, e } = await refused({ ...REQUEST, previous_response_id: "resp_abc" });
      expect(status).toBe(400);
      expect(e).toMatchObject({ type: "previous_response_id_not_supported", param: "previous_response_id" });
      expect(e.message).toContain("Send the whole conversation in `input`");
      // Its stored-state relatives.
      expect((await refused({ ...REQUEST, conversation: "conv_1" })).e.type).toBe("conversation_not_supported");
      expect((await refused({ ...REQUEST, background: true })).e.type).toBe("background_not_supported");
      expect((await refused({ model: MODELS.llama.slug, prompt: { id: "pmpt_1" } })).e.type).toBe("unsupported_parameter");
      expect((await refused({ ...REQUEST, input: [{ type: "item_reference", id: "msg_1" }] })).e.type).toBe("unsupported_input");
      expect((await refused({ ...REQUEST, input: [{ role: "user", content: [{ type: "input_image", file_id: "file_1" }] }] })).e.message).toContain("stores no files");
    });

    test("hosted tools are refused by name; AnyRoute hosts none", async () => {
      for (const type of ["web_search", "web_search_preview", "file_search", "code_interpreter", "computer_use_preview", "image_generation", "mcp"]) {
        const { status, e } = await refused({ ...REQUEST, tools: [{ type: "function", name: "ok", parameters: {} }, { type }] });
        expect(status).toBe(400);
        expect(e).toMatchObject({ type: "unsupported_tool", param: "tools[1].type" });
        expect(e.message).toContain(`\`${type}\``);
        expect(e.message).toContain("does not host tools");
      }
      const other = await refused({ ...REQUEST, tools: [{ type: "local_shell" }] });
      expect(other.e).toMatchObject({ type: "unsupported_tool", param: "tools[0].type" });
      expect(other.e.message).toContain("supports `function` and `custom` tools");
      expect((await refused({ ...REQUEST, tool_choice: { type: "web_search_preview" } })).e.type).toBe("unsupported_tool");
      expect((await refused({ ...REQUEST, input: [{ type: "web_search_call", id: "ws_1", status: "completed" }] })).e.message).toContain("runs on the API provider's servers");
    });

    test("malformed requests are 400s in the OpenAI error shape", async () => {
      for (const [body, param] of [
        [{ input: "hi" }, "model"],
        [{ model: MODELS.llama.slug }, "input"],
        [{ model: MODELS.llama.slug, input: [{ role: "boss", content: "x" }] }, "input[0].role"],
        [{ model: MODELS.llama.slug, input: "x", max_output_tokens: 0 }, "max_output_tokens"],
        [{ model: MODELS.llama.slug, input: "x", temperature: 3 }, "temperature"],
        [{ model: MODELS.llama.slug, input: "x", text: { format: { type: "xml" } } }, "text.format.type"],
        [{ model: MODELS.llama.slug, input: "x", metadata: { a: 1 } }, "metadata"],
      ] as [Record<string, unknown>, string][]) {
        const { status, e } = await refused(body);
        expect(status).toBe(400);
        expect(e.param).toBe(param);
        expect(typeof e.message).toBe("string");
      }
    });

    test("nothing is stored to read back: GET, DELETE and cancel answer 404 and say why", async () => {
      for (const path of ["/v1/responses/resp_gen-1-abc", "/api/v1/responses/resp_gen-1-abc", "/v1/responses/resp_x/input_items"]) {
        for (const method of ["GET", "DELETE"]) {
          const res = await h.request(path, { method, headers: auth });
          expect(res.status).toBe(404);
          const e = ((await res.json()) as any).error;
          expect(e.type).toBe("responses_not_stored");
          expect(e.message).toContain("stateless");
          expect(e.message).toContain("/api/v1/receipts/");
        }
      }
      expect((await h.request("/v1/responses/resp_x/cancel", { method: "POST", headers: auth, json: {} })).status).toBe(404);
    });
  });

  describe("credentials and errors are the chat route's", () => {
    test("a bad key is the chat route's 401, unchanged", async () => {
      const res = await post(REQUEST, { authorization: "Bearer sk-ar-v1-" + "0".repeat(48) });
      const direct = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer sk-ar-v1-" + "0".repeat(48) }, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }] } });
      expect(res.status).toBe(direct.status);
      expect(res.status).toBe(401);
      expect(((await res.json()) as any).error.type).toBe("invalid_key");
    });

    test("no credentials gets the same answer as the chat route (a payment request), with its headers", async () => {
      const res = await post(REQUEST, {});
      const direct = await h.request("/api/v1/chat/completions", { method: "POST", json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "Say hello" }], max_tokens: 64 } });
      expect(res.status).toBe(direct.status);
      expect(res.status).toBe(402);
      expect(((await res.json()) as any).error?.type ?? "x402").toBe(((await direct.json()) as any).error?.type ?? "x402");
    });

    test("an unknown model is the chat route's 404", async () => {
      const res = await post({ model: "nobody/nothing", input: "hi" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error.type).toBe("model_not_found");
    });
  });
});

describe("streaming function calls, through a provider that streams them", () => {
  let h: Harness;
  let auth: Record<string, string>;
  let stop: () => void;
  const MODEL = "streamtools/tool-chat";
  const seen: any[] = [];
  // A patch with quotes, a backslash, accents and an emoji, as a model would send it: JSON text in the "input" argument.
  const PATCH = '*** Begin Patch\n*** Add File: hello.txt\n+h\u00e9llo "quoted" \\ back \u{1F600}\n*** End Patch';
  const PATCH_ARGS = JSON.stringify({ input: PATCH });

  beforeAll(async () => {
    const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: MODEL, choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/models") return Response.json({ data: [] });
        if (u.pathname !== "/chat/completions") return new Response("not found", { status: 404 });
        const body = (await req.json()) as any;
        seen.push(body);
        const last = body.messages.at(-1);
        // A prompt that asks for the patch gets a call to apply_patch, as JSON or as a stream cut into small pieces.
        if (last?.role === "user" && String(last.content).includes("apply the patch")) {
          const usage = { prompt_tokens: 30, completion_tokens: 25, total_tokens: 55 };
          const call = { id: "call_patch", type: "function", function: { name: "apply_patch", arguments: PATCH_ARGS } };
          if (!body.stream) return Response.json({ id: "c2", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }], usage });
          const pieces = PATCH_ARGS.match(/[\s\S]{1,5}/g)!;
          const parts = [
            chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_patch", type: "function", function: { name: "apply_patch", arguments: "" } }] }),
            ...pieces.map((arguments_) => chunk({ tool_calls: [{ index: 0, function: { arguments: arguments_ } }] })),
            chunk({}, "tool_calls"),
            chunk({}, null, usage),
            "data: [DONE]\n\n",
          ];
          return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
        }
        const parts = [
          chunk({ role: "assistant", content: "Checking. " }),
          chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
          chunk({}, null, { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 }),
          "data: [DONE]\n\n",
        ];
        return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    stop = () => server.stop(true);
    h = await startRouter({ providers: [{ id: "filler", name: "Filler", models: [MODELS.embed] }] });
    await h.ctx.db.insert(providers).values({
      id: "tools",
      name: "Tools",
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "tools-key"),
      status: "live",
      dataPolicy: { training: false, retains_prompts: false, zdr: true },
      staticModels: [{ id: MODEL, name: "Streaming tools", anyroute: { slug: MODEL }, context_length: 32768, max_completion_tokens: 4096, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["max_tokens", "temperature", "tools", "tool_choice", "response_format"] }],
    });
    await runRegistry(h.ctx);
    auth = (await h.fundedKey(5n)).auth;
  });
  afterAll(async () => {
    stop();
    await h.close();
  });

  test("text, then two function calls: one item each, arguments streamed and completed", async () => {
    const tools = [
      { type: "function", name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
      { type: "function", name: "get_time", parameters: { type: "object", properties: {} } },
    ];
    const res = await h.request("/v1/responses", { method: "POST", headers: auth, json: { model: MODEL, input: "Weather and time in Paris", tools, stream: true } });
    expect(res.status).toBe(200);
    const { types, events } = await frames(res);
    expect(seen.at(-1)).toMatchObject({ stream: true, tools: [{ type: "function", function: { name: "get_weather" } }, { type: "function", function: { name: "get_time" } }] });
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      // the message
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      // the first call
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      // the second call
      "response.output_item.added",
      "response.function_call_arguments.delta",
      // both calls closed, in order
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    events.forEach((e, i) => expect(e.data.sequence_number).toBe(i));
    const added = events.filter((e) => e.event === "response.output_item.added").map((e) => e.data);
    expect(added.map((a) => a.output_index)).toEqual([0, 1, 2]);
    expect(added[1].item).toMatchObject({ type: "function_call", call_id: "call_a", name: "get_weather", arguments: "", status: "in_progress" });
    const argDeltas = events.filter((e) => e.event === "response.function_call_arguments.delta").map((e) => e.data);
    expect(argDeltas.map((d) => [d.output_index, d.delta])).toEqual([[1, '{"city":'], [1, '"Paris"}'], [2, "{}"]]);
    const argDone = events.filter((e) => e.event === "response.function_call_arguments.done").map((e) => e.data);
    expect(argDone.map((d) => [d.item_id, d.name, d.arguments])).toEqual([
      [added[1].item.id, "get_weather", '{"city":"Paris"}'],
      [added[2].item.id, "get_time", "{}"],
    ]);
    const completed = events.at(-1)!.data.response;
    expect(completed.status).toBe("completed");
    expect(completed.output.map((o: any) => o.type)).toEqual(["message", "function_call", "function_call"]);
    expect(completed.output[0].content[0].text).toBe("Checking. ");
    expect(completed.output[1]).toMatchObject({ call_id: "call_a", name: "get_weather", arguments: '{"city":"Paris"}', status: "completed" });
    expect(completed.output[2]).toMatchObject({ call_id: "call_b", name: "get_time", arguments: "{}" });
    expect(completed.usage).toMatchObject({ input_tokens: 20, output_tokens: 15, total_tokens: 35 });
  });

  // What the Codex CLI sends: its shell and plan tools as functions, apply_patch as a freeform custom tool with a grammar.
  const GRAMMAR = 'start: begin_patch hunk+ end_patch\nbegin_patch: "*** Begin Patch" LF\nend_patch: "*** End Patch" LF?\nhunk: add_hunk | update_hunk';
  const codexTools = [
    { type: "function", name: "shell", description: "Runs a shell command and returns its output.", strict: false, parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } }, workdir: { type: "string" } }, required: ["command"], additionalProperties: false } },
    { type: "custom", name: "apply_patch", description: "Use the `apply_patch` tool to edit files.", format: { type: "grammar", syntax: "lark", definition: GRAMMAR } },
    { type: "function", name: "update_plan", description: "Updates the task plan.", strict: false, parameters: { type: "object", properties: { plan: { type: "array", items: { type: "object" } } }, required: ["plan"], additionalProperties: false } },
  ];
  const codexRequest = (extra: Record<string, unknown> = {}) => ({
    model: MODEL,
    instructions: "You are a coding agent running in the Codex CLI.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/work</cwd>\n</environment_context>" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Add hello.txt: apply the patch" }] },
    ],
    tools: codexTools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "medium", summary: "auto" },
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "0198-abc",
    text: { verbosity: "medium" },
    ...extra,
  });

  test("a Codex-shaped request: apply_patch is offered as a function with one string argument, the others unchanged", async () => {
    const res = await h.request("/v1/responses", { method: "POST", headers: auth, json: codexRequest({ stream: false }) });
    expect(res.status).toBe(200);
    const sent = seen.at(-1);
    expect(sent.tools.map((t: any) => t.function.name)).toEqual(["shell", "apply_patch", "update_plan"]);
    expect(sent.tools[0]).toEqual({ type: "function", function: { name: "shell", description: "Runs a shell command and returns its output.", parameters: codexTools[0]!.parameters, strict: false } });
    const patch = sent.tools[1].function;
    expect(patch.parameters).toEqual({ type: "object", properties: { input: { type: "string", description: expect.stringContaining("freeform input") } }, required: ["input"], additionalProperties: false });
    expect(patch.description).toStartWith("Use the `apply_patch` tool to edit files.");
    expect(patch.description).toContain('Put the complete text in the "input" argument');
    expect(patch.description).toContain("lark grammar");
    expect(patch.description).toContain("guidance only and is not enforced");
    expect(patch.description).toContain(GRAMMAR);
    expect(sent.messages.map((m: any) => m.role)).toEqual(["system", "user", "user"]);
    expect(sent).toMatchObject({ tool_choice: "auto", parallel_tool_calls: false });
    // The answer: a custom_tool_call item, not a function_call, with the patch as its input.
    const j = (await res.json()) as any;
    expect(j.status).toBe("completed");
    expect(j.output).toHaveLength(1);
    expect(j.output[0]).toMatchObject({ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: PATCH, status: "completed" });
    expect(j.output[0].id).toStartWith("ctc_");
    expect(j.output[0].arguments).toBeUndefined();
    expect(j.tools[1]).toEqual(codexTools[1]); // the custom tool is echoed as it was sent
  });

  test("streaming: the patch arrives as response.custom_tool_call_input deltas that add up to the input", async () => {
    const res = await h.request("/v1/responses", { method: "POST", headers: auth, json: codexRequest({ stream: true }) });
    expect(res.status).toBe(200);
    const { raw, events, types } = await frames(res);
    expect(raw).not.toContain("function_call_arguments");
    const deltas = events.filter((e) => e.event === "response.custom_tool_call_input.delta");
    expect(deltas.length).toBeGreaterThan(3);
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      ...deltas.map(() => "response.custom_tool_call_input.delta"),
      "response.custom_tool_call_input.done",
      "response.output_item.done",
      "response.completed",
    ]);
    events.forEach((e, i) => expect(e.data.sequence_number).toBe(i));
    const added = events[2]!.data;
    expect(added).toMatchObject({ output_index: 0, item: { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "", status: "in_progress" } });
    expect(added.item.id).toStartWith("ctc_");
    for (const d of deltas) expect(d.data).toMatchObject({ item_id: added.item.id, output_index: 0 });
    expect(deltas.map((d) => d.data.delta).join("")).toBe(PATCH);
    // No piece is a lone half of an emoji.
    for (const d of deltas) expect(d.data.delta).toBe(d.data.delta.toWellFormed());
    const done = events.find((e) => e.event === "response.custom_tool_call_input.done")!.data;
    expect(done).toMatchObject({ item_id: added.item.id, output_index: 0, input: PATCH });
    const item = events.find((e) => e.event === "response.output_item.done")!.data.item;
    expect(item).toEqual({ id: added.item.id, type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: PATCH, status: "completed" });
    const completed = events.at(-1)!.data.response;
    expect(completed.output).toEqual([item]);
    expect(completed.usage).toMatchObject({ input_tokens: 30, output_tokens: 25, total_tokens: 55 });
  });

  test("the next turn: custom_tool_call and its output go back as chat tool messages, beside a function call and reasoning that is dropped", async () => {
    const res = await h.request("/v1/responses", {
      method: "POST",
      headers: auth,
      json: codexRequest({
        stream: true,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Add hello.txt: apply the patch" }] },
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
          { type: "custom_tool_call", id: "ctc_1", call_id: "call_patch", name: "apply_patch", input: PATCH },
          { type: "function_call", id: "fc_1", call_id: "call_ls", name: "shell", arguments: '{"command":["ls"]}' },
          { type: "custom_tool_call_output", call_id: "call_patch", output: "Success. Updated the following files:\nA hello.txt" },
          { type: "function_call_output", call_id: "call_ls", output: "hello.txt" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    await frames(res);
    expect(seen.at(-1).messages).toEqual([
      { role: "system", content: "You are a coding agent running in the Codex CLI." },
      { role: "user", content: "Add hello.txt: apply the patch" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_patch", type: "function", function: { name: "apply_patch", arguments: PATCH_ARGS } },
          { id: "call_ls", type: "function", function: { name: "shell", arguments: '{"command":["ls"]}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_patch", content: "Success. Updated the following files:\nA hello.txt" },
      { role: "tool", tool_call_id: "call_ls", content: "hello.txt" },
    ]);
  });

  test("tool_choice can force a custom tool, and a custom tool cannot share a name with a function", async () => {
    const forced = await h.request("/v1/responses", { method: "POST", headers: auth, json: codexRequest({ stream: false, tool_choice: { type: "custom", name: "apply_patch" } }) });
    expect(forced.status).toBe(200);
    expect(seen.at(-1).tool_choice).toEqual({ type: "function", function: { name: "apply_patch" } });
    await forced.text();
    const dup = await h.request("/v1/responses", { method: "POST", headers: auth, json: codexRequest({ tools: [codexTools[1], { type: "function", name: "apply_patch", parameters: {} }] }) });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as any).error).toMatchObject({ type: "invalid_request", param: "tools[1].name" });
  });
});

describe("the attested lane", () => {
  let fx: Awaited<ReturnType<typeof startGatewayRouter>>;
  let auth: Record<string, string>;
  let keyHash: string;
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) => fx.h.request("/v1/responses", { method: "POST", headers: { ...auth, ...headers }, json: body });
  const ATTESTED = { "x-anyroute-lane": "attested" };

  beforeAll(async () => {
    fx = await startGatewayRouter();
    const k = await fx.h.fundedKey(20n);
    auth = k.auth;
    keyHash = k.hash;
  });
  afterAll(async () => fx.close());
  const fresh = async () => expect(await fx.reset()).toMatchObject({ provider: "gw", ok: true });

  test("X-Anyroute-Lane: attested serves only the attested provider, and the answer reports its lane, disclosure and receipt", async () => {
    await fresh();
    const before = await balanceOfKey(fx.h, keyHash);
    const res = await post({ model: GW_MODEL, input: "hello, privately", max_output_tokens: 16 }, ATTESTED);
    expect(res.status).toBe(200);
    const receipt = res.headers.get("x-receipt-id")!;
    expect(receipt).toStartWith("gen-");
    expect(res.headers.get("inference-id")).toBe(receipt);
    expect(res.headers.get("x-anyroute-lane")).toBe("attested");
    const j = (await res.json()) as any;
    expect(j.output[0].content[0].text).toBe("hello from the gateway");
    expect(j.metadata).toMatchObject({ anyroute_receipt_id: receipt, anyroute_lane: "attested", anyroute_disclosure: "attested" });
    // The gateway was asked for attested, zero-retention serving, as for a chat call on this lane.
    expect(fx.state.requests.at(-1)!.body.provider).toEqual({ aci_verified: true, zdr: true });
    // The signed receipt agrees.
    const rc = ((await (await fx.h.request(`/api/v1/receipts/${receipt}`)).json()) as any).data;
    expect(rc.payload).toMatchObject({ lane: "attested", disclosure: "attested", upstream_attestation: { attested: true } });
    expect(await balanceOfKey(fx.h, keyHash)).toBeLessThan(before);
  });

  test("provider.lane in the body is the same request, and the stricter of body and header wins", async () => {
    await fresh();
    const viaBody = await post({ model: GW_MODEL, input: "hi", provider: { lane: "attested" } });
    expect(viaBody.status).toBe(200);
    expect(viaBody.headers.get("x-anyroute-lane")).toBe("attested");
    expect(((await viaBody.json()) as any).metadata.anyroute_lane).toBe("attested");
    const both = await post({ model: GW_MODEL, input: "hi", provider: { lane: "public" } }, ATTESTED);
    expect(both.headers.get("x-anyroute-lane")).toBe("attested");
    // disclosure none is the same test as the attested lane.
    const none = await post({ model: PLAIN.slug, input: "hi", provider: { disclosure: "none" } });
    expect(none.status).toBe(409);
    expect(((await none.json()) as any).error.type).toBe("disclosure_unavailable");
  });

  test("a model with no attested provider is refused: nothing is sent, nothing is charged, and the chat route's error comes through", async () => {
    await fresh();
    const before = await balanceOfKey(fx.h, keyHash);
    const sent = fx.state.requests.length;
    const res = await post({ model: PLAIN.slug, input: "keep this private" }, ATTESTED);
    expect(res.status).toBe(409);
    const e = ((await res.json()) as any).error;
    expect(e).toMatchObject({ code: 409, type: "lane_unavailable" });
    expect(e.message).toContain("Nothing was sent to any provider and nothing was charged");
    expect(await balanceOfKey(fx.h, keyHash)).toBe(before);
    expect(fx.state.requests.length).toBe(sent);
    // A stream request is refused the same way, before any event.
    const streamed = await post({ model: PLAIN.slug, input: "keep this private", stream: true }, ATTESTED);
    expect(streamed.status).toBe(409);
    expect(streamed.headers.get("content-type")).toContain("application/json");
  });

  test("a lapsed attestation refuses the call rather than falling back to a public provider", async () => {
    await fresh();
    await fx.makeStale();
    const before = await balanceOfKey(fx.h, keyHash);
    const res = await post({ model: GW_MODEL, input: "hi" }, ATTESTED);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.type).toBe("lane_unavailable");
    expect(await balanceOfKey(fx.h, keyHash)).toBe(before);
  });

  test("an answer whose receipt does not show an attested upstream is withheld, and the error names the billed receipt", async () => {
    await fresh();
    fx.state.upstream = "routed";
    const res = await post({ model: GW_MODEL, input: "hi" }, ATTESTED);
    expect(res.status).toBe(502);
    expect(res.headers.get("x-receipt-id")).toStartWith("gen-");
    const text = await res.text();
    expect(text).not.toContain("hello from the gateway");
    expect(JSON.parse(text).error.type).toBe("upstream_not_attested");
  });

  test("a public call to the same model needs no lane, and says it was served public", async () => {
    await fresh();
    const res = await post({ model: PLAIN.slug, input: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-anyroute-lane")).toBe("public");
    expect(((await res.json()) as any).metadata).toMatchObject({ anyroute_lane: "public", anyroute_disclosure: "vendor-forwarded" });
  });
});

describe("per-address limits count the caller, not the adapter", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama] }], env: { UNAUTH_RPM: "2", TRUST_PROXY: "true" } });
  });
  afterAll(async () => h.close());

  test("calls without a key are limited per client address, as on the chat route", async () => {
    const call = (ip: string) => h.request("/v1/responses", { method: "POST", headers: { "x-forwarded-for": ip }, json: { model: MODELS.llama.slug, input: "hi" } });
    expect((await call("203.0.113.1")).status).toBe(402);
    expect((await call("203.0.113.1")).status).toBe(402);
    const limited = await call("203.0.113.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // Another address has its own allowance.
    expect((await call("203.0.113.2")).status).toBe(402);
  });
});

describe("request mapping", () => {
  test("input items become chat messages: calls merge into the assistant turn, developer is system, reasoning is dropped", () => {
    expect(
      messagesFromInput("Be terse.", [
        { role: "developer", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] },
        { role: "user", content: "hi" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me look." }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: '{"x":1}' },
        { type: "function_call", call_id: "c2", name: "g", arguments: {} },
        { type: "reasoning", id: "rs", summary: [], encrypted_content: "zzz" },
        { type: "function_call_output", call_id: "c1", output: "one" },
        { type: "function_call_output", call_id: "c2", output: [{ type: "input_text", text: "two" }] },
      ]),
    ).toEqual([
      { role: "system", content: "Be terse." },
      { role: "system", content: "a\nb" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "Let me look.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: '{"x":1}' } },
          { id: "c2", type: "function", function: { name: "g", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "one" },
      { role: "tool", tool_call_id: "c2", content: "two" },
    ]);
  });

  test("only what a chat request can carry is forwarded; unknown Responses options are ignored", () => {
    const { chat, echo, stream } = chatRequestFrom({
      model: "m/x",
      input: "hi",
      include: ["reasoning.encrypted_content"],
      truncation: "auto",
      service_tier: "auto",
      prompt_cache_key: "k",
      reasoning: { effort: "high", summary: "auto" },
      provider: { lane: "attested", order: ["gw"] },
      stream: true,
    });
    expect(chat).toEqual({ model: "m/x", messages: [{ role: "user", content: "hi" }], reasoning: { effort: "high" }, provider: { lane: "attested", order: ["gw"] }, stream: true });
    expect(stream).toBe(true);
    expect(echo).toMatchObject({ instructions: null, temperature: null, toolChoice: "auto", tools: [], text: { format: { type: "text" } }, parallelToolCalls: true, reasoning: { effort: "high", summary: null } });
  });

  test("a tool without parameters gets an empty object schema", () => {
    const { chat } = chatRequestFrom({ model: "m/x", input: "hi", tools: [{ type: "function", name: "ping" }] });
    expect(chat.tools).toEqual([{ type: "function", function: { name: "ping", parameters: { type: "object", properties: {} } } }]);
  });
});

describe("custom tools", () => {
  const PATCH = '*** Begin Patch\n+h\u00e9llo "q" \\ \u{1F600} \u{1D11E}\t\n*** End Patch';
  const ASCII = (json: string) => json.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const decode = (pieces: string[]) => {
    const d = new InputDecoder();
    return pieces.map((p) => d.push(p)).join("");
  };

  test("the decoder reads the input string however the JSON is cut up, escapes and surrogate pairs included", () => {
    for (const json of [JSON.stringify({ input: PATCH }), ASCII(JSON.stringify({ input: PATCH })), ` {\n "input" : ${JSON.stringify(PATCH)} }`]) {
      for (let i = 0; i <= json.length; i++) expect(decode([json.slice(0, i), json.slice(i)])).toBe(PATCH);
      for (const size of [1, 2, 3, 5, 7]) expect(decode(json.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!)).toBe(PATCH);
    }
    // Text after the closing quote is not part of it.
    expect(decode(['{"input":"a"', ',"x":"b"}'])).toBe("a");
  });

  test("a piece never ends in half of a surrogate pair", () => {
    const d = new InputDecoder();
    const pieces = ASCII(JSON.stringify({ input: "x\u{1F600}y" })).match(/[\s\S]{1,4}/g)!.map((p) => d.push(p));
    for (const p of pieces) expect(p).toBe(p.toWellFormed());
    expect(pieces.join("")).toBe("x\u{1F600}y");
  });

  test("customInput: the input key when the JSON is whole, what has arrived when it is cut short, the raw text when it is not that shape", () => {
    expect(customInput(JSON.stringify({ input: PATCH }))).toBe(PATCH);
    expect(customInput('{"input":"abc\\ndef')).toBe("abc\ndef");
    expect(customInput("*** Begin Patch\n*** End Patch")).toBe("*** Begin Patch\n*** End Patch");
    expect(customInput('{"patch":"x"}')).toBe('{"patch":"x"}');
    expect(customInput("")).toBe("");
  });

  test("a custom tool becomes a function with one string argument; its grammar is description text only", () => {
    const { chat, echo } = chatRequestFrom({
      model: "m/x",
      input: "hi",
      tools: [
        { type: "custom", name: "run_sql", description: "Runs SQL.", format: { type: "text" } },
        { type: "custom", name: "patch", format: { type: "grammar", syntax: "regex", definition: "^x+$" } },
      ],
    });
    const [sql, patch] = (chat.tools as any[]).map((t) => t.function);
    expect(sql.description).toBe('Runs SQL.\n\nThis tool takes freeform text, not JSON fields. Put the complete text in the "input" argument, exactly in the format described for this tool.');
    expect(sql.parameters.required).toEqual(["input"]);
    expect(patch.description).toStartWith("This tool takes freeform text");
    expect(patch.description).toContain("regex grammar");
    expect(patch.description).toContain("not enforced");
    expect(patch.description).toContain("^x+$");
    expect(JSON.stringify(chat)).not.toContain('"format"'); // nothing in the request claims the grammar is enforced upstream
    expect([...echo.customTools]).toEqual(["run_sql", "patch"]);
  });

  test("custom_tool_call and custom_tool_call_output items become an assistant tool call and a tool result", () => {
    expect(
      messagesFromInput(null, [
        { role: "user", content: "go" },
        { type: "custom_tool_call", call_id: "c1", name: "patch", input: "*** Begin Patch" },
        { type: "custom_tool_call", call_id: "c2", name: "patch" },
        { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "ok" }] },
        { type: "custom_tool_call_output", call_id: "c2", output: "failed" },
      ]),
    ).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "patch", arguments: '{"input":"*** Begin Patch"}' } },
          { id: "c2", type: "function", function: { name: "patch", arguments: '{"input":""}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "tool", tool_call_id: "c2", content: "failed" },
    ]);
  });

  const echo: Echo = { model: "m/x", instructions: null, maxOutputTokens: null, temperature: null, topP: null, parallelToolCalls: true, toolChoice: "auto", tools: [], text: { format: { type: "text" } }, reasoning: { effort: null, summary: null }, metadata: {}, user: null, customTools: new Set(["patch"]) };
  const meta: Meta = { receiptId: "gen-2-def", lane: "public", disclosure: null, policyHash: null };

  test("a call to a custom tool comes back as a custom_tool_call; a call to a function of the same turn stays a function_call", () => {
    const r = responseFromChat(
      {
        choices: [
          {
            message: {
              content: "Patching.",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "patch", arguments: JSON.stringify({ input: PATCH }) } },
                { id: "c2", type: "function", function: { name: "shell", arguments: '{"command":["ls"]}' } },
                { id: "c3", type: "function", function: { name: "patch", arguments: "raw patch text" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      echo,
      meta,
      1,
    ) as any;
    expect(r.output.map((o: any) => o.type)).toEqual(["message", "custom_tool_call", "function_call", "custom_tool_call"]);
    expect(r.output[1]).toMatchObject({ id: "ctc_2-def_1", call_id: "c1", name: "patch", input: PATCH, status: "completed" });
    expect(r.output[2]).toMatchObject({ call_id: "c2", name: "shell", arguments: '{"command":["ls"]}' });
    expect(r.output[3]).toMatchObject({ call_id: "c3", input: "raw patch text" });
  });

  test("the stream: item added, input deltas, input done with the whole text, item done, completed", () => {
    const out: { event: string; data: any }[] = [];
    const tr = new StreamTranslator(echo, meta, 1, (frame) => {
      const [e, d] = frame.trim().split("\n");
      out.push({ event: e!.slice(7), data: JSON.parse(d!.slice(6)) });
    });
    tr.begin();
    const args = JSON.stringify({ input: PATCH });
    tr.chat({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "patch", arguments: "" } }] } }] });
    for (const piece of args.match(/[\s\S]{1,6}/g)!) tr.chat({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] });
    tr.chat({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    tr.end(true);
    const types = out.map((e) => e.event);
    expect(types.slice(0, 3)).toEqual(["response.created", "response.in_progress", "response.output_item.added"]);
    expect(types.slice(-3)).toEqual(["response.custom_tool_call_input.done", "response.output_item.done", "response.completed"]);
    expect(out.filter((e) => e.event === "response.custom_tool_call_input.delta").map((e) => e.data.delta).join("")).toBe(PATCH);
    expect(out.at(-1)!.data.response.output).toEqual([{ id: "ctc_2-def_0", type: "custom_tool_call", call_id: "c1", name: "patch", input: PATCH, status: "completed" }]);
  });

  test("a provider that streams the patch as plain text instead of JSON still gets its input, in one delta at the end", () => {
    const out: { event: string; data: any }[] = [];
    const tr = new StreamTranslator(echo, meta, 1, (frame) => {
      const [e, d] = frame.trim().split("\n");
      out.push({ event: e!.slice(7), data: JSON.parse(d!.slice(6)) });
    });
    tr.begin();
    tr.chat({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "patch", arguments: "*** Begin " } }] } }] });
    tr.chat({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "Patch" } }] } }] });
    tr.end(true);
    expect(out.filter((e) => e.event === "response.custom_tool_call_input.delta").map((e) => e.data.delta)).toEqual(["*** Begin Patch"]);
    expect(out.find((e) => e.event === "response.custom_tool_call_input.done")!.data.input).toBe("*** Begin Patch");
  });
});

describe("the non-streaming translator", () => {
  const echo: Echo = { model: "m/x", instructions: null, maxOutputTokens: 5, temperature: null, topP: null, parallelToolCalls: true, toolChoice: "auto", tools: [], text: { format: { type: "text" } }, reasoning: { effort: null, summary: null }, metadata: { a: "b" }, user: null, customTools: new Set() };
  const meta: Meta = { receiptId: "gen-9-zzz", lane: "attested", disclosure: null, policyHash: "sha256:" + "ab".repeat(32) };

  test("a length finish is an incomplete response; the policy hash and user metadata ride along", () => {
    const r = responseFromChat({ id: "gen-9-zzz", model: "m/y", created: 5, choices: [{ message: { role: "assistant", content: "cut" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 5 } }, echo, meta, 99) as any;
    expect(r).toMatchObject({ id: "resp_gen-9-zzz", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, model: "m/y", created_at: 5, max_output_tokens: 5 });
    expect(r.usage.total_tokens).toBe(6);
    expect(r.metadata).toEqual({ a: "b", anyroute_receipt_id: "gen-9-zzz", anyroute_lane: "attested", anyroute_policy_hash: "sha256:" + "ab".repeat(32) });
  });

  test("tool calls without an id get one, object arguments are serialised, and an empty answer is one empty message", () => {
    const r = responseFromChat({ choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "f", arguments: { a: 1 } } }] }, finish_reason: "tool_calls" }] }, echo, { ...meta, receiptId: null }, 7) as any;
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ type: "function_call", name: "f", arguments: '{"a":1}' });
    expect(r.output[0].call_id).toStartWith("call_");
    expect(r.created_at).toBe(7);
    const empty = responseFromChat({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }, echo, meta, 7) as any;
    expect(empty.output).toEqual([expect.objectContaining({ type: "message", content: [{ type: "output_text", text: "", annotations: [] }] })]);
  });
});

describe("the stream translator", () => {
  const echo: Echo = { model: "m/x", instructions: null, maxOutputTokens: null, temperature: null, topP: null, parallelToolCalls: true, toolChoice: "auto", tools: [], text: { format: { type: "text" } }, reasoning: { effort: null, summary: null }, metadata: {}, user: null, customTools: new Set() };
  const meta: Meta = { receiptId: "gen-1-abc", lane: "public", disclosure: null, policyHash: null };
  const run = (events: unknown[], sawDone = true, m: Meta = meta) => {
    const out: { event: string; data: any }[] = [];
    const tr = new StreamTranslator(echo, m, 1_700_000_000, (frame) => {
      const [e, d] = frame.trim().split("\n");
      out.push({ event: e!.slice(7), data: JSON.parse(d!.slice(6)) });
    });
    tr.begin();
    for (const ev of events) tr.chat(ev);
    tr.end(sawDone);
    return out;
  };
  const delta = (content: string) => ({ id: "gen-1-abc", model: "m/x", choices: [{ index: 0, delta: { content } }] });
  const finish = (reason: string) => ({ id: "gen-1-abc", model: "m/x", choices: [{ index: 0, delta: {}, finish_reason: reason }] });
  const usage = { choices: [], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, cost: 0.5, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 2 } }, receipt: { id: "gen-1-abc", payload: { disclosure: "attested" } } };

  test("a length finish is response.incomplete with the reason", () => {
    const out = run([delta("cut"), finish("length"), usage]);
    const last = out.at(-1)!;
    expect(last.event).toBe("response.incomplete");
    expect(last.data.response).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ text: "cut" }] }] });
    expect(last.data.response.usage).toEqual({ input_tokens: 4, input_tokens_details: { cached_tokens: 1 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 10, cost: 0.5 });
    expect(last.data.response.metadata).toMatchObject({ anyroute_receipt_id: "gen-1-abc", anyroute_lane: "public", anyroute_disclosure: "attested" });
    expect(out.map((e) => e.event)).not.toContain("response.completed");
  });

  test("an empty answer is still one empty message item", () => {
    const out = run([finish("stop"), usage]);
    expect(out.map((e) => e.event)).toEqual(["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
    expect(out.at(-1)!.data.response.output[0].content[0].text).toBe("");
  });

  test("a provider error mid-stream ends with error then response.failed, never response.completed", () => {
    const out = run([delta("par"), { id: "gen-1-abc", error: { code: 502, message: "Provider stream was interrupted.", type: "provider_interrupted" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }, usage]);
    const types = out.map((e) => e.event);
    expect(types.slice(-2)).toEqual(["error", "response.failed"]);
    expect(types).not.toContain("response.completed");
    expect(out.at(-2)!.data).toMatchObject({ type: "error", code: "provider_interrupted", message: "Provider stream was interrupted.", param: null });
    expect(out.at(-1)!.data.response).toMatchObject({ status: "failed", error: { code: "provider_interrupted", message: "Provider stream was interrupted." }, output: [] });
    expect(out.at(-1)!.data.response.usage.total_tokens).toBe(10); // the failed call was billed and says so
  });

  test("an error event with no chunks before it (every provider failed) fails the response", () => {
    const out = run([{ error: { code: 502, message: "All providers failed.", type: "upstream_error" } }]);
    expect(out.map((e) => e.event)).toEqual(["response.created", "response.in_progress", "error", "response.failed"]);
  });

  test("a stream that stops without [DONE] or a finish reason is an interrupted stream, and one that finished is complete", () => {
    expect(run([delta("x")], false).at(-1)!.event).toBe("response.failed");
    expect(run([delta("x"), finish("stop")], false).at(-1)!.event).toBe("response.completed");
    expect(run([delta("x")], true).at(-1)!.event).toBe("response.completed");
  });

  test("text that follows a tool call opens a new message item", () => {
    const call = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "f", arguments: "{}" } }] } }] };
    const out = run([delta("a"), call, delta("b"), finish("tool_calls"), usage]);
    expect(out.at(-1)!.data.response.output.map((o: any) => o.type)).toEqual(["message", "function_call", "message"]);
    expect(out.at(-1)!.data.response.output.map((o: any) => o.content?.[0]?.text)).toEqual(["a", undefined, "b"]);
  });
});

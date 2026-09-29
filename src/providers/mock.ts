import { Hono } from "hono";
import { randomBytes } from "node:crypto";

// A configurable OpenAI-compatible provider used by tests, the local demo and canary development.
// It speaks the provider spec (/models with pricing/quantization/features), chat/completions
// (JSON + SSE), legacy completions, embeddings, logprobs, and a TEE-style attestation endpoint.
// Behaviours can be switched at runtime through POST /_control.

export type MockBehaviour = "ok" | "empty200" | "error500" | "rate429" | "slow" | "hang" | "reject400" | "midstream_error" | "no_usage" | "auth401";
export type MockModel = { id: string; slug?: string; prompt: string; completion: string; ctx?: number; quant?: string; features?: string[]; params?: string[]; creator?: string; output?: string[]; hf?: string };
export type MockConfig = {
  name: string;
  models: MockModel[];
  behaviour?: MockBehaviour;
  quantNoise?: number; // perturbs logprobs to imitate lower precision
  delayMs?: number;
  tee?: "dev" | null;
  /** What a development attestation reports about the in-enclave classifier (absent = says nothing). */
  classifier?: boolean;
  wrongAnswers?: boolean; // degrade the canary benchmark
  /** Test hook: the reply for a prompt, or undefined to fall back to the built-in answers. Not settable through /_control. */
  reply?: (prompt: string, body: any) => string | undefined;
  /** Test hook: token counts to report instead of the measured ones. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** Test hook: awaited before a stream sends content part `part` (0-based), so a test can hold a stream half-way. */
  holdStream?: (part: number) => Promise<void> | void;
};

const WORDS = "the quick brown fox jumps over the lazy dog and keeps running far away".split(" ");
const ANSWERS: Record<string, string> = {
  "17 * 23": "391",
  "capital of australia": "Canberra",
  "'router' backwards": "retuor",
  "2 to the power of 10": "1024",
  "closest to the sun": "Mercury",
  "hexagon": "6",
  "symbol for gold": "Au",
  "144 divided by 12": "12",
};

function answerFor(prompt: string, cfg: MockConfig) {
  const lower = prompt.toLowerCase();
  for (const [k, v] of Object.entries(ANSWERS)) if (lower.includes(k.toLowerCase())) return cfg.wrongAnswers ? "I am not sure" : v;
  if (lower.includes("next ten words")) return WORDS.slice(0, 10).join(" ");
  return `Hello from ${cfg.name}. You said: ${prompt.slice(0, 200)}`;
}

function logprobsFor(text: string, noise: number) {
  const toks = text.split(/(?=\s)/).slice(0, 12);
  return {
    content: toks.map((tok, i) => {
      const base = -0.05 - i * 0.02;
      const jitter = noise ? Math.sin(i * 7.3 + tok.length) * noise : 0;
      return {
        token: tok,
        logprob: base + jitter,
        top_logprobs: [
          { token: tok, logprob: base + jitter },
          { token: " alt" + i, logprob: -3 - i * 0.1 - jitter },
          { token: " other" + i, logprob: -4.5 - i * 0.05 + jitter / 2 },
        ],
      };
    }),
  };
}

export function createMockProvider(initial: MockConfig) {
  const cfg: MockConfig = { behaviour: "ok", quantNoise: 0, delayMs: 0, tee: null, ...initial };
  const stats = { requests: 0, lastBody: null as any, lastAuth: null as string | null };
  const app = new Hono();

  app.post("/_control", async (c) => {
    Object.assign(cfg, await c.req.json());
    return c.json({ ok: true, cfg });
  });
  app.get("/_stats", (c) => c.json(stats));

  app.get("/models", (c) =>
    c.json({
      data: cfg.models.map((m) => ({
        id: m.id,
        name: m.slug ?? m.id,
        created: 1_780_000_000,
        anyroute: m.slug ? { slug: m.slug } : undefined,
        hugging_face_id: m.hf,
        input_modalities: ["text"],
        output_modalities: m.output ?? ["text"],
        quantization: m.quant ?? "bf16",
        context_length: m.ctx ?? 131072,
        max_output_length: 8192,
        pricing: { prompt: m.prompt, completion: m.completion, request: "0", image: "0" },
        supported_sampling_parameters: m.params ?? ["temperature", "top_p", "stop", "seed", "max_tokens", "logprobs", "top_logprobs"],
        supported_features: m.features ?? ["tools", "json_mode"],
      })),
    }),
  );

  app.get("/attestation", (c) => {
    if (cfg.tee !== "dev") return c.json({ error: "no tee" }, 404);
    return c.json({ kind: "dev", nonce: c.req.query("nonce"), measurement: "mock-measurement-v1", ...(cfg.classifier != null ? { classifier: { enabled: cfg.classifier } } : {}) });
  });

  const gate = async () => {
    stats.requests++;
    const b = cfg.behaviour;
    if (cfg.delayMs) await new Promise((r) => setTimeout(r, cfg.delayMs));
    if (b === "error500") return new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500 });
    if (b === "rate429") return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
    if (b === "reject400") return new Response(JSON.stringify({ error: { message: "bad parameter foo" } }), { status: 400 });
    if (b === "auth401") return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    if (b === "hang") await new Promise((r) => setTimeout(r, 600_000));
    return null;
  };

  app.post("/chat/completions", async (c) => {
    const body = await c.req.json();
    stats.lastBody = body;
    stats.lastAuth = c.req.header("authorization") ?? null;
    const early = await gate();
    if (early) return early;
    const last = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user");
    const prompt = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((p: any) => p.text ?? "").join(" ");
    const empty = cfg.behaviour === "empty200";
    const wantsTool = Array.isArray(body.tools) && body.tools.length && body.tool_choice !== "none";
    const text = empty ? "" : (cfg.reply?.(prompt, body) ?? answerFor(prompt, cfg)).slice(0, Math.max(1, (body.max_tokens ?? 4096) * 4));
    const promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
    const completionTokens = empty ? 0 : Math.max(1, Math.ceil(text.length / 4));
    const reportedIn = cfg.usage?.prompt_tokens ?? promptTokens;
    const reportedOut = cfg.usage?.completion_tokens ?? completionTokens;
    const usage = cfg.behaviour === "no_usage" ? undefined : { prompt_tokens: reportedIn, completion_tokens: reportedOut, total_tokens: reportedIn + reportedOut };
    const id = "cmpl-" + randomBytes(6).toString("hex");
    const toolCalls = wantsTool && !empty ? [{ id: "call_1", type: "function", function: { name: body.tools[0].function?.name ?? "fn", arguments: '{"ok":true}' } }] : undefined;
    if (!body.stream) {
      return c.json({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: toolCalls ? null : empty ? "" : text, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop", ...(body.logprobs ? { logprobs: logprobsFor(text, cfg.quantNoise ?? 0) } : {}) }],
        usage,
      });
    }
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctl) {
        const send = (o: unknown) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        ctl.enqueue(enc.encode(": keep-alive\n\n"));
        send({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
        const parts = empty ? [] : text.match(/.{1,6}/gs) ?? [];
        for (const [i, p] of parts.entries()) {
          if (cfg.behaviour === "midstream_error" && i === 2) {
            send({ id, error: { message: "provider fell over mid-stream" } });
            ctl.close();
            return;
          }
          if (cfg.behaviour === "slow") await new Promise((r) => setTimeout(r, 20));
          await cfg.holdStream?.(i);
          send({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: p } }] });
        }
        send({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        if (usage && body.stream_options?.include_usage) send({ id, object: "chat.completion.chunk", model: body.model, choices: [], usage });
        ctl.enqueue(enc.encode("data: [DONE]\n\n"));
        ctl.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });

  app.post("/completions", async (c) => {
    const body = await c.req.json();
    const early = await gate();
    if (early) return early;
    const text = cfg.behaviour === "empty200" ? "" : ` continuation of ${String(body.prompt).slice(0, 40)}`;
    return c.json({ id: "cmpl-x", object: "text_completion", model: body.model, choices: [{ index: 0, text, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
  });

  app.post("/embeddings", async (c) => {
    const body = await c.req.json();
    const early = await gate();
    if (early) return early;
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return c.json({ object: "list", model: body.model, data: inputs.map((s: string, i: number) => ({ object: "embedding", index: i, embedding: [s.length / 100, 0.5, -0.25] })), usage: { prompt_tokens: inputs.join(" ").length / 4, total_tokens: inputs.join(" ").length / 4 } });
  });

  return { app, cfg, stats };
}

/** Serve a mock provider on an ephemeral port. */
export function serveMockProvider(cfg: MockConfig, port = 0) {
  const m = createMockProvider(cfg);
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: m.app.fetch, idleTimeout: 255 });
  return { ...m, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

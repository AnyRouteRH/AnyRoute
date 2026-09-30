import { fail } from "../lib/errors.ts";
import { sha256 } from "../lib/util.ts";
import { parseArguments } from "../anthropic/convert.ts";

// The Ollama API <-> the router's own chat-completions and embeddings shapes. Pure functions: the routes
// (src/api/ollama.ts) send the converted request through /api/v1/chat/completions or /api/v1/embeddings in-process, so
// keys, balances, limits, lanes, disclosure ceilings, receipts and the response headers are exactly those of a chat call.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const bad = (message: string): never => fail(400, message, "invalid_request");

/** The Ollama API version this endpoint speaks. Clients read it to decide which features (tools, structured outputs, thinking, /api/embed) they may use. */
export const OLLAMA_VERSION = "0.12.6";

/** Ollama names carry a tag, and ":latest" is the tag a bare name gets. A catalog id that already has a suffix keeps it. */
export const ollamaName = (id: string) => (id.includes(":") ? id : `${id}:latest`);
/** The name the router resolves: ":latest" names the model itself. Any other suffix (":free", ":nitro", ":private") is the router's own. */
export const routerName = (name: string) => name.trim().replace(/:latest$/, "");

const safeName = (s: unknown) => String(s ?? "").replace(/[^A-Za-z0-9_.:/-]/g, "").slice(0, 64);

// ---- options ---------------------------------------------------------------------------------------------------------

/** Ollama options that mean the same thing in a chat completion. */
const SAMPLING: Record<string, string> = {
  temperature: "temperature",
  top_p: "top_p",
  top_k: "top_k",
  min_p: "min_p",
  seed: "seed",
  frequency_penalty: "frequency_penalty",
  presence_penalty: "presence_penalty",
  repeat_penalty: "repetition_penalty",
};

/** options -> sampling parameters. Options that tune a local runtime (num_ctx, num_gpu, num_thread, mirostat ...) mean nothing for a hosted model and are reported in X-Anyroute-Ignored. */
function applyOptions(options: unknown, out: Json, ignored: Set<string>) {
  if (options == null) return;
  if (!isObj(options)) bad("options: Input should be an object.");
  for (const [k, v] of Object.entries(options as Json)) {
    if (v == null) continue;
    if (k in SAMPLING) {
      if (typeof v !== "number" || !Number.isFinite(v)) bad(`options.${k}: Input should be a number.`);
      if (k === "seed" && !Number.isInteger(v)) bad("options.seed: Input should be an integer.");
      out[SAMPLING[k]] = v;
    } else if (k === "num_predict") {
      if (typeof v !== "number" || !Number.isInteger(v)) bad("options.num_predict: Input should be an integer.");
      // -1 (no limit) and -2 (fill the context) leave the limit to the model.
      if ((v as number) > 0) out.max_tokens = v;
    } else if (k === "stop") {
      const stops = typeof v === "string" ? [v] : Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : bad("options.stop: Input should be a string or a list of strings.");
      const kept = stops.filter((s) => s.length);
      if (kept.length) out.stop = kept;
    } else ignored.add(`options.${safeName(k)}`);
  }
}

/** format: "json" -> JSON mode; a JSON schema -> structured output with that schema. */
function applyFormat(format: unknown, out: Json) {
  if (format == null || format === "") return;
  if (format === "json") out.response_format = { type: "json_object" };
  else if (isObj(format)) {
    const schema = { ...format };
    delete schema.$schema;
    out.response_format = { type: "json_schema", json_schema: { name: "response", schema } };
  } else bad("format: Input should be \"json\" or a JSON schema object.");
}

function convertTools(tools: unknown): Json[] {
  if (tools == null) return [];
  if (!Array.isArray(tools)) return bad("tools: Input should be a list.");
  return tools.map((raw, i) => {
    if (!isObj(raw)) bad(`tools.${i}: Input should be an object.`);
    const t = raw as Json;
    if (t.type != null && t.type !== "function") bad(`tools.${i}.type: Input should be 'function'.`);
    const fn = isObj(t.function) ? t.function : bad(`tools.${i}.function: Field required.`);
    if (typeof fn.name !== "string" || !fn.name) bad(`tools.${i}.function.name: Field required.`);
    const parameters: Json = isObj(fn.parameters) ? { ...fn.parameters } : { type: "object", properties: {} };
    delete parameters.$schema;
    return { type: "function", function: { name: fn.name, ...(typeof fn.description === "string" && fn.description ? { description: fn.description } : {}), parameters } };
  });
}

// ---- images ----------------------------------------------------------------------------------------------------------

/** Ollama sends images as bare base64. The media type is read from the first bytes; a data: URL or an http(s) URL is used as is. */
export function imageUrl(image: unknown, where: string): string {
  if (typeof image !== "string" || !image.trim()) return bad(`${where}: Input should be a base64-encoded image.`);
  const s = image.trim();
  if (/^data:image\/[\w.+-]+;base64,/i.test(s) || /^https?:\/\//i.test(s)) return s;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s.replace(/\s+/g, ""))) bad(`${where}: Input should be a base64-encoded image.`);
  const type = s.startsWith("/9j/") ? "image/jpeg" : s.startsWith("R0lGOD") ? "image/gif" : s.startsWith("UklGR") ? "image/webp" : "image/png";
  return `data:${type};base64,${s.replace(/\s+/g, "")}`;
}

function userContent(text: string, images: unknown, where: string): string | Json[] {
  if (images == null) return text;
  if (!Array.isArray(images)) return bad(`${where}.images: Input should be a list of base64-encoded images.`);
  if (!images.length) return text;
  return [...(text ? [{ type: "text", text }] : []), ...images.map((img, k) => ({ type: "image_url", image_url: { url: imageUrl(img, `${where}.images.${k}`) } }))];
}

// ---- requests --------------------------------------------------------------------------------------------------------

export type Converted = {
  /** The chat-completions request (model is set by the route once the name is resolved). */
  body: Json;
  /** What the request asked for that this endpoint accepts and does not act on, reported in X-Anyroute-Ignored. */
  ignored: string[];
  /** Ollama streams unless told not to. */
  stream: boolean;
  /** Whether the reply may carry the model's reasoning as `thinking` (Ollama's think; on unless set to false). */
  think: boolean;
  /** A request with nothing to answer (no messages, no prompt): Ollama loads (or unloads) the model and says so. */
  load: "load" | "unload" | null;
};

function common(body: Json, out: Json, ignored: Set<string>) {
  if (typeof body.model !== "string" || !body.model.trim()) bad("model: Field required.");
  if (body.stream != null && typeof body.stream !== "boolean") bad("stream: Input should be true or false.");
  applyOptions(body.options, out, ignored);
  applyFormat(body.format, out);
  if (body.provider != null) {
    if (!isObj(body.provider)) bad("provider: Input should be an object such as {\"lane\":\"attested\"}.");
    out.provider = body.provider;
  }
  if (body.think != null && typeof body.think !== "boolean" && !["low", "medium", "high"].includes(body.think as string)) bad("think: Input should be true, false, 'low', 'medium' or 'high'.");
  // keep_alive and truncate govern a local runtime: nothing to keep loaded here.
}

const unloadAsked = (keepAlive: unknown) => keepAlive === 0 || keepAlive === "0" || keepAlive === "0s";

/** POST /api/chat -> chat completions. Throws a 400 (invalid_request) that names the offending field. */
export function fromChat(body: Json): Converted {
  const ignored = new Set<string>();
  const out: Json = {};
  common(body, out, ignored);
  if (body.messages != null && !Array.isArray(body.messages)) bad("messages: Input should be a list.");
  const list = (body.messages ?? []) as unknown[];
  const messages: Json[] = [];
  // Ollama tool results name the tool, not the call; they answer the calls of the assistant turn before them in order.
  let pending: { id: string; name: string }[] = [];
  for (const [i, raw] of list.entries()) {
    const at = `messages.${i}`;
    if (!isObj(raw)) bad(`${at}: Input should be an object.`);
    const m = raw as Json;
    if (m.content != null && typeof m.content !== "string") bad(`${at}.content: Input should be a string.`);
    const content = (m.content as string | undefined) ?? "";
    switch (m.role) {
      case "system":
        messages.push({ role: "system", content });
        break;
      case "user":
        messages.push({ role: "user", content: userContent(content, m.images, at) });
        break;
      case "assistant": {
        const calls: Json[] = [];
        if (m.tool_calls != null) {
          if (!Array.isArray(m.tool_calls)) bad(`${at}.tool_calls: Input should be a list.`);
          for (const [j, tc] of (m.tool_calls as unknown[]).entries()) {
            const fn = isObj(tc) && isObj(tc.function) ? tc.function : bad(`${at}.tool_calls.${j}.function: Field required.`);
            if (typeof fn.name !== "string" || !fn.name) bad(`${at}.tool_calls.${j}.function.name: Field required.`);
            const id = isObj(tc) && typeof tc.id === "string" && tc.id ? tc.id : `call_${i}_${j}`;
            const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
            calls.push({ id, type: "function", function: { name: fn.name, arguments: args } });
          }
        }
        pending = calls.map((c) => ({ id: c.id as string, name: (c.function as Json).name as string }));
        // Thinking from an earlier turn is not sent back: the provider produced it and does not read it.
        if (content || calls.length) messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) });
        break;
      }
      case "tool": {
        const name = typeof m.tool_name === "string" ? m.tool_name : typeof m.name === "string" ? m.name : "";
        let id = typeof m.tool_call_id === "string" && m.tool_call_id ? m.tool_call_id : null;
        if (id) pending = pending.filter((p) => p.id !== id);
        else {
          const k = Math.max(0, pending.findIndex((p) => p.name === name));
          id = pending[k]?.id ?? null;
          if (id) pending.splice(k, 1);
        }
        // A result with no call before it cannot be a tool message; it is passed on as what it is.
        if (id) messages.push({ role: "tool", tool_call_id: id, content });
        else messages.push({ role: "user", content: `Result of the tool ${name || "call"}:\n${content}` });
        break;
      }
      default:
        bad(`${at}.role: Input should be 'system', 'user', 'assistant' or 'tool'.`);
    }
  }
  const tools = convertTools(body.tools);
  if (tools.length) out.tools = tools;
  out.messages = messages;
  const load = messages.length ? null : unloadAsked(body.keep_alive) ? "unload" : "load";
  return { body: out, ignored: [...ignored], stream: body.stream !== false, think: body.think !== false, load };
}

/** POST /api/generate -> chat completions: the prompt is one user message, `system` a system message before it. */
export function fromGenerate(body: Json): Converted {
  const ignored = new Set<string>();
  const out: Json = {};
  common(body, out, ignored);
  if (body.prompt != null && typeof body.prompt !== "string") bad("prompt: Input should be a string.");
  if (body.system != null && typeof body.system !== "string") bad("system: Input should be a string.");
  const prompt = (body.prompt as string | undefined) ?? "";
  const hasImages = Array.isArray(body.images) && body.images.length > 0;
  // A suffix asks for fill-in-the-middle, and a template or raw prompt for the model's own prompt format; the provider
  // applies its own chat template, so these are accepted and not acted on. The deprecated context array is too.
  if (typeof body.suffix === "string" && body.suffix) ignored.add("suffix");
  if (typeof body.template === "string" && body.template) ignored.add("template");
  if (body.raw === true) ignored.add("raw");
  if (Array.isArray(body.context) && body.context.length) ignored.add("context");
  const messages: Json[] = [];
  if (body.system) messages.push({ role: "system", content: body.system });
  if (prompt || hasImages) messages.push({ role: "user", content: userContent(prompt, body.images, "body") });
  out.messages = messages;
  const load = prompt || hasImages ? null : unloadAsked(body.keep_alive) ? "unload" : "load";
  return { body: out, ignored: [...ignored], stream: body.stream !== false, think: body.think !== false, load };
}

/** POST /api/embed (input: a string or a list) and the older /api/embeddings (prompt: a string) -> embeddings. */
export function fromEmbed(body: Json, legacy = false): { body: Json; ignored: string[] } {
  if (typeof body.model !== "string" || !body.model.trim()) bad("model: Field required.");
  const ignored = new Set<string>();
  let input: unknown;
  if (legacy) {
    if (typeof body.prompt !== "string") bad("prompt: Field required.");
    input = body.prompt;
  } else {
    input = body.input;
    if (!(typeof input === "string" || (Array.isArray(input) && input.length && input.every((s) => typeof s === "string")))) bad("input: Input should be a string or a non-empty list of strings.");
  }
  const out: Json = { input };
  if (body.dimensions != null) {
    if (typeof body.dimensions !== "number" || !Number.isInteger(body.dimensions) || body.dimensions < 1) bad("dimensions: Input should be a positive integer.");
    out.dimensions = body.dimensions;
  }
  if (isObj(body.options)) for (const k of Object.keys(body.options)) ignored.add(`options.${safeName(k)}`);
  if (body.provider != null) {
    if (!isObj(body.provider)) bad("provider: Input should be an object such as {\"lane\":\"attested\"}.");
    out.provider = body.provider;
  }
  return { body: out, ignored: [...ignored] };
}

// ---- responses -------------------------------------------------------------------------------------------------------

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const ns = (ms: number) => Math.max(0, Math.round(ms * 1e6));

export type Timing = { t0: number; firstAt: number | null; endAt: number };

/** Ollama's closing statistics. Durations are in nanoseconds; there is no model to load, so load_duration is 0. */
export function stats(t: Timing, usage: unknown, fallback: { prompt: number; output: number }) {
  const u = isObj(usage) ? usage : {};
  const first = t.firstAt ?? t.endAt;
  return {
    total_duration: ns(t.endAt - t.t0),
    load_duration: 0,
    prompt_eval_count: count(u.prompt_tokens) ?? fallback.prompt,
    prompt_eval_duration: ns(first - t.t0),
    eval_count: count(u.completion_tokens) ?? fallback.output,
    eval_duration: ns(t.endAt - first),
  };
}

/** finish_reason -> done_reason. Ollama ends a turn that called tools with "stop" too. */
export const doneReason = (finish: unknown) => (finish === "length" ? "length" : "stop");

/** Chat tool calls -> Ollama's, whose arguments are an object. */
export function toolCalls(calls: unknown): Json[] {
  if (!Array.isArray(calls)) return [];
  return calls.filter(isObj).map((tc, index) => {
    const fn = isObj(tc.function) ? tc.function : {};
    return { ...(typeof tc.id === "string" && tc.id ? { id: tc.id } : {}), function: { index, name: typeof fn.name === "string" ? fn.name : "", arguments: parseArguments(fn.arguments) } };
  });
}

const textOf = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("") : "");
export const reasoningOf = (m: Json) => (typeof m.reasoning === "string" ? m.reasoning : typeof m.reasoning_content === "string" ? m.reasoning_content : "");

export type ReplyOptions = { kind: "chat" | "generate"; model: string; think: boolean; timing: Timing; promptEstimate: number; anyroute?: Json };

/** A chat completion -> the one object a non-streaming /api/chat or /api/generate returns. */
export function toReply(oa: Json, o: ReplyOptions): Json {
  const choice = Array.isArray(oa.choices) && isObj(oa.choices[0]) ? (oa.choices[0] as Json) : {};
  const message = isObj(choice.message) ? choice.message : {};
  const text = textOf(message.content);
  const thinking = o.think ? reasoningOf(message) : "";
  const calls = toolCalls(message.tool_calls);
  const head = { model: o.model, created_at: new Date().toISOString() };
  const tail = { done: true, done_reason: doneReason(choice.finish_reason), ...stats(o.timing, oa.usage, { prompt: o.promptEstimate, output: Math.ceil(text.length / 4) }), ...(o.anyroute ? { anyroute: o.anyroute } : {}) };
  if (o.kind === "generate") return { ...head, response: text, ...(thinking ? { thinking } : {}), ...tail };
  return { ...head, message: { role: "assistant", content: text, ...(thinking ? { thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, ...tail };
}

/** What Ollama answers to a request with nothing to answer: the model is ready (or was let go). */
export function loadReply(kind: "chat" | "generate", model: string, reason: "load" | "unload"): Json {
  const head = { model, created_at: new Date().toISOString() };
  return kind === "chat" ? { ...head, message: { role: "assistant", content: "" }, done_reason: reason, done: true } : { ...head, response: "", done: true, done_reason: reason };
}

// ---- the model list --------------------------------------------------------------------------------------------------

/** The part of a model object (GET /api/v1/models) this endpoint reads. */
export type ModelInfo = {
  id: string;
  created: number;
  context_length: number;
  architecture: { input_modalities: unknown; output_modalities: unknown };
  supported_parameters: string[];
  quantization: string[];
  lanes: string[];
};

/** The family an Ollama client groups a model under: the first word of its name, as in llama, qwen3, gemma. */
export function family(id: string) {
  const slug = id.split("/").pop() ?? id;
  return (slug.split(/[-_.:]/)[0] || slug).toLowerCase();
}

/** "70B", "8x7B", "1.5B" from the name; empty when it does not say. */
export function parameterSize(id: string) {
  const m = /(?:^|[-_/])((?:\d+x)?\d+(?:\.\d+)?)([bm])(?=$|[-_:.])/i.exec(id);
  return m ? `${m[1]}${m[2].toUpperCase()}` : "";
}

/** The precision the live endpoints serve, as "BF16" or "FP8, BF16"; empty when none says. */
const quantLevel = (q: string[]) => [...new Set(q.filter((x) => x && x !== "unknown").map((x) => x.toUpperCase()))].join(", ");

export function details(m: ModelInfo): Json {
  const fam = family(m.id);
  return { parent_model: "", format: "", family: fam, families: [fam], parameter_size: parameterSize(m.id), quantization_level: quantLevel(m.quantization) };
}

const has = (v: unknown, x: string) => Array.isArray(v) && v.includes(x);

/** A GET /api/tags entry. Nothing is stored locally, so size is 0; the digest is the SHA-256 of the catalog id. */
export function tagEntry(m: ModelInfo): Json {
  const name = ollamaName(m.id);
  return { name, model: name, modified_at: new Date(m.created * 1000).toISOString(), size: 0, digest: sha256(m.id), details: details(m) };
}

/** What the model can do, in Ollama's words: completion or embedding, and tools, vision and thinking where it has them. */
export function capabilities(m: ModelInfo): string[] {
  if (has(m.architecture.output_modalities, "embeddings") && !has(m.architecture.output_modalities, "text")) return ["embedding"];
  return [
    "completion",
    ...(m.supported_parameters.includes("tools") ? ["tools"] : []),
    ...(has(m.architecture.input_modalities, "image") ? ["vision"] : []),
    ...(m.supported_parameters.includes("reasoning") || m.supported_parameters.includes("include_reasoning") ? ["thinking"] : []),
  ];
}

/** POST /api/show. */
export function showEntry(m: ModelInfo, extra: Json = {}): Json {
  const d = details(m);
  const fam = d.family as string;
  const size = parameterSize(m.id);
  const scale = size && !size.includes("x") ? Number(size.slice(0, -1)) * (size.endsWith("B") ? 1e9 : 1e6) : null;
  return {
    license: "",
    modelfile: `# Served by Anyroute on a hosted provider: there are no local weights.\nFROM ${m.id}\nPARAMETER num_ctx ${m.context_length}\n`,
    parameters: `num_ctx ${m.context_length}`,
    template: "{{ .Prompt }}",
    details: d,
    model_info: { "general.architecture": fam, "general.basename": m.id.split("/").pop(), ...(scale ? { "general.parameter_count": Math.round(scale) } : {}), [`${fam}.context_length`]: m.context_length },
    capabilities: capabilities(m),
    modified_at: new Date(m.created * 1000).toISOString(),
    ...extra,
  };
}

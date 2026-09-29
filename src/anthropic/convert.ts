import { fail } from "../lib/errors.ts";

// Anthropic Messages API <-> the router's own chat-completions shape. Pure functions: the route (src/api/anthropic.ts)
// sends the converted request through /api/v1/chat/completions in-process, so billing, lanes, receipts and the response
// headers are exactly those of a chat call.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const bad = (message: string): never => fail(400, message, "invalid_request");

export type ConvertOptions = {
  /** count_tokens takes no max_tokens and no sampling parameters. */
  countOnly?: boolean;
};

export type Converted = {
  /** The chat-completions request (model is set by the caller once the name is resolved). */
  body: Json;
  /** Things the request asked for that this endpoint accepts and does not act on, reported in X-Anyroute-Ignored. */
  ignored: string[];
  stops: string[];
};

// Client-side (custom) tools are function tools. Anthropic-hosted tools (web search, code execution, computer use,
// text editor, bash ...) carry a versioned `type` and run on Anthropic's side or in the client's harness; a model behind
// AnyRoute cannot call them, so they are left out and named in X-Anyroute-Ignored.
const isCustomTool = (t: Json) => t.type === undefined || t.type === null || t.type === "custom";

const safeName = (s: unknown) => String(s ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);

function textOf(blocks: unknown[], where: string): string {
  const parts: string[] = [];
  for (const [i, b] of blocks.entries()) {
    if (!isObj(b) || b.type !== "text" || typeof b.text !== "string") bad(`${where}.${i}: expected a text block.`);
    parts.push((b as Json).text as string);
  }
  return parts.join("\n\n");
}

function systemText(system: unknown): string {
  if (system == null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return textOf(system, "system");
  return bad("system: Input should be a string or a list of text blocks.");
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

function imagePart(b: Json, where: string): Part {
  const s = b.source;
  if (!isObj(s)) return bad(`${where}.source: Field required.`);
  if (s.type === "base64") {
    if (typeof s.media_type !== "string" || !/^image\/[\w.+-]+$/.test(s.media_type)) bad(`${where}.source.media_type: Input should be an image type such as image/png.`);
    if (typeof s.data !== "string" || !s.data) bad(`${where}.source.data: Field required.`);
    return { type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } };
  }
  if (s.type === "url") {
    if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) bad(`${where}.source.url: Input should be an http(s) URL.`);
    return { type: "image_url", image_url: { url: s.url as string } };
  }
  return bad(`${where}.source.type: Input should be 'base64' or 'url'.`);
}

/** A document block whose source is text can be read by any model; a PDF or file reference cannot, so it is refused rather than dropped. */
function documentPart(b: Json, where: string): Part {
  const s = b.source;
  if (isObj(s) && s.type === "text" && typeof s.data === "string") return { type: "text", text: s.data };
  if (isObj(s) && s.type === "content" && Array.isArray(s.content) && s.content.every((x) => isObj(x) && x.type === "text")) return { type: "text", text: textOf(s.content, `${where}.source.content`) };
  return bad(`${where}: document blocks are supported only with a text source. Extract the text of a PDF before sending it.`);
}

const asContent = (parts: Part[]): string | Part[] => (parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts);

function convertMessages(system: unknown, messages: unknown): Json[] {
  if (!Array.isArray(messages) || messages.length === 0) bad("messages: Field required. Send at least one message.");
  const out: Json[] = [];
  const sys = systemText(system);
  if (sys) out.push({ role: "system", content: sys });
  for (const [i, m] of (messages as unknown[]).entries()) {
    const at = `messages.${i}`;
    if (!isObj(m) || (m.role !== "user" && m.role !== "assistant" && m.role !== "system")) bad(`${at}.role: Input should be 'user' or 'assistant'.`);
    const msg = m as Json;
    const blocks: unknown[] = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : bad(`${at}.content: Input should be a string or a list of content blocks.`);

    if (msg.role === "system") {
      // Claude Code appends system-role entries mid-conversation; they stay where they are.
      out.push({ role: "system", content: textOf(blocks, `${at}.content`) });
    } else if (msg.role === "user") {
      const parts: Part[] = [];
      const tools: Json[] = [];
      const fromTools: Part[] = []; // images a tool returned: a tool message carries text only
      for (const [j, raw] of blocks.entries()) {
        const where = `${at}.content.${j}`;
        if (!isObj(raw)) bad(`${where}: Input should be an object.`);
        const b = raw as Json;
        switch (b.type) {
          case "text":
            if (typeof b.text !== "string") bad(`${where}.text: Field required.`);
            if ((b.text as string).length) parts.push({ type: "text", text: b.text as string });
            break;
          case "image":
            parts.push(imagePart(b, where));
            break;
          case "document":
            parts.push(documentPart(b, where));
            break;
          case "tool_result": {
            if (typeof b.tool_use_id !== "string" || !b.tool_use_id) bad(`${where}.tool_use_id: Field required.`);
            const inner: unknown[] = typeof b.content === "string" ? [{ type: "text", text: b.content }] : Array.isArray(b.content) ? b.content : b.content == null ? [] : bad(`${where}.content: Input should be a string or a list of blocks.`);
            const texts: string[] = [];
            for (const [k, ib] of inner.entries()) {
              if (isObj(ib) && ib.type === "text" && typeof ib.text === "string") texts.push(ib.text);
              else if (isObj(ib) && ib.type === "image") fromTools.push(imagePart(ib, `${where}.content.${k}`));
              else if (isObj(ib) && ib.type === "tool_reference" && typeof ib.tool_name === "string") texts.push(`[tool available: ${ib.tool_name}]`); // tool search: every tool is already sent in full
              else bad(`${where}.content.${k}: a tool result may contain text and image blocks.`);
            }
            tools.push({ role: "tool", tool_call_id: b.tool_use_id, content: texts.join("\n") });
            break;
          }
          case "thinking":
          case "redacted_thinking":
            break;
          default:
            bad(`${where}.type: '${safeName(b.type)}' blocks are not supported in a user message.`);
        }
      }
      // A tool message has to follow the assistant message that called the tool, so tool results come first.
      out.push(...tools);
      const all = [...fromTools, ...parts];
      if (all.length) out.push({ role: "user", content: asContent(all) });
      else if (!tools.length) out.push({ role: "user", content: "" });
    } else {
      const texts: string[] = [];
      const calls: Json[] = [];
      for (const [j, raw] of blocks.entries()) {
        const where = `${at}.content.${j}`;
        if (!isObj(raw)) bad(`${where}: Input should be an object.`);
        const b = raw as Json;
        switch (b.type) {
          case "text":
            if (typeof b.text !== "string") bad(`${where}.text: Field required.`);
            texts.push(b.text as string);
            break;
          case "tool_use":
            if (typeof b.id !== "string" || !b.id) bad(`${where}.id: Field required.`);
            if (typeof b.name !== "string" || !b.name) bad(`${where}.name: Field required.`);
            calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
            break;
          case "thinking":
          case "redacted_thinking": // signed by the model that produced it; nothing behind AnyRoute can read it back
            break;
          default:
            bad(`${where}.type: '${safeName(b.type)}' blocks are not supported in an assistant message.`);
        }
      }
      const text = texts.join("");
      // An assistant turn that held only thinking has nothing left to send.
      if (text || calls.length) out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

function convertTools(tools: unknown, ignored: Set<string>): Json[] {
  if (tools == null) return [];
  if (!Array.isArray(tools)) return bad("tools: Input should be a list.");
  const out: Json[] = [];
  for (const [i, raw] of tools.entries()) {
    if (!isObj(raw)) bad(`tools.${i}: Input should be an object.`);
    const t = raw as Json;
    if (!isCustomTool(t)) {
      ignored.add(`tool:${safeName(t.name ?? t.type)}`);
      continue;
    }
    if (typeof t.name !== "string" || !t.name) bad(`tools.${i}.name: Field required.`);
    const schema: Json = isObj(t.input_schema) ? { ...t.input_schema } : { type: "object", properties: {} };
    delete schema.$schema; // draft markers trip several providers' schema checks and change nothing about the tool
    out.push({ type: "function", function: { name: t.name, ...(typeof t.description === "string" && t.description ? { description: t.description } : {}), parameters: schema } });
  }
  return out;
}

function convertToolChoice(choice: unknown, out: Json) {
  if (choice == null) return;
  if (!isObj(choice)) return bad("tool_choice: Input should be an object.");
  switch (choice.type) {
    case "auto":
      out.tool_choice = "auto";
      break;
    case "any":
      out.tool_choice = "required";
      break;
    case "none":
      out.tool_choice = "none";
      break;
    case "tool":
      if (typeof choice.name !== "string" || !choice.name) bad("tool_choice.name: Field required when type is 'tool'.");
      out.tool_choice = { type: "function", function: { name: choice.name } };
      break;
    default:
      bad("tool_choice.type: Input should be 'auto', 'any', 'tool' or 'none'.");
  }
  if (choice.disable_parallel_tool_use === true && out.tool_choice !== "none") out.parallel_tool_calls = false;
}

const optionalNumber = (body: Json, key: string, min?: number, max?: number) => {
  const v = body[key];
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) bad(`${key}: Input should be a number${min !== undefined ? ` from ${min}` : ""}${max !== undefined ? ` to ${max}` : ""}.`);
  return v as number;
};

/** Anthropic Messages request -> chat-completions request. Throws a 400 (invalid_request) that names the offending field. */
export function toChatRequest(body: Json, opts: ConvertOptions = {}): Converted {
  if (typeof body.model !== "string" || !body.model.trim()) bad("model: Field required.");
  const ignored = new Set<string>();
  const out: Json = { messages: convertMessages(body.system, body.messages) };

  if (!opts.countOnly) {
    const max = body.max_tokens;
    if (max === undefined || max === null) bad("max_tokens: Field required.");
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1) bad("max_tokens: Input should be a positive integer.");
    out.max_tokens = max;
    const temperature = optionalNumber(body, "temperature", 0, 2);
    if (temperature !== undefined) out.temperature = temperature;
    const topP = optionalNumber(body, "top_p", 0, 1);
    if (topP !== undefined) out.top_p = topP;
    const topK = optionalNumber(body, "top_k", 0);
    if (topK !== undefined) out.top_k = topK; // the router drops it for a provider that does not list it
    if (body.stop_sequences != null) {
      if (!Array.isArray(body.stop_sequences) || body.stop_sequences.some((s) => typeof s !== "string")) bad("stop_sequences: Input should be a list of strings.");
      const stops = (body.stop_sequences as string[]).filter((s) => s.length);
      if (stops.length) out.stop = stops;
    }
    if (body.metadata != null) {
      if (!isObj(body.metadata)) bad("metadata: Input should be an object.");
      const uid = (body.metadata as Json).user_id;
      if (typeof uid === "string" && uid) out.user = uid.slice(0, 256);
    }
    if (body.stream != null && typeof body.stream !== "boolean") bad("stream: Input should be true or false.");
    if (body.stream === true) out.stream = true;
  }

  const tools = convertTools(body.tools, ignored);
  if (tools.length) {
    out.tools = tools;
    convertToolChoice(body.tool_choice, out);
  } else if (body.tool_choice != null) {
    convertToolChoice(body.tool_choice, {}); // still validated
  }

  if (body.mcp_servers != null && (!Array.isArray(body.mcp_servers) || body.mcp_servers.length)) bad("mcp_servers: connecting a model to MCP servers is not supported here. Connect the client to AnyRoute's MCP server instead, or pass tools.");
  if (body.container != null) bad("container: the code-execution container is not supported.");
  const thinking = body.thinking;
  if (isObj(thinking) && thinking.type && thinking.type !== "disabled") ignored.add("thinking");
  if (body.provider != null) {
    if (!isObj(body.provider)) bad("provider: Input should be an object such as {\"lane\":\"attested\"}.");
    out.provider = body.provider;
  }
  if (typeof body.service_tier === "string" && body.service_tier !== "auto") ignored.add("service_tier");
  return { body: out, ignored: [...ignored], stops: Array.isArray(out.stop) ? (out.stop as string[]) : [] };
}

/** The most output a model can be asked for: its advertised limit and what is left of its context after the prompt. */
export function clampMaxTokens(asked: number, model: { maxOut?: number | null; ctx?: number | null }, promptTokens: number): number {
  let n = asked;
  if (model.maxOut && model.maxOut > 0) n = Math.min(n, model.maxOut);
  if (model.ctx && model.ctx > promptTokens) n = Math.min(n, model.ctx - promptTokens);
  return Math.max(1, n);
}

// ---- response --------------------------------------------------------------------------------------------------------

export type AnthropicUsage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };

/**
 * Chat usage -> Anthropic usage. Chat counts cached prompt tokens inside prompt_tokens; Anthropic reports them apart, so
 * input_tokens is what is left after the cache read and write, and the three add up to the prompt.
 */
export function toAnthropicUsage(u: unknown): AnthropicUsage {
  const x = isObj(u) ? u : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const details = isObj(x.prompt_tokens_details) ? x.prompt_tokens_details : {};
  const read = num(details.cached_tokens);
  const write = num(details.cache_write_tokens);
  return {
    input_tokens: Math.max(0, num(x.prompt_tokens) - read - write),
    output_tokens: num(x.completion_tokens),
    cache_creation_input_tokens: write,
    cache_read_input_tokens: read,
  };
}

export type Stop = { stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal"; stop_sequence: string | null };

/**
 * finish_reason -> stop_reason. A provider that names the stop string that ended the answer (vLLM-style `stop_reason`,
 * or `native_finish_reason: "stop_sequence"` with the string beside it) gives stop_sequence; chat completions alone do
 * not say which stop string matched, so without that an answer that stopped on one is reported as end_turn.
 */
export function toStop(choice: unknown, requestedStops: string[], hasToolCalls: boolean): Stop {
  const c = isObj(choice) ? choice : {};
  const finish = typeof c.finish_reason === "string" ? c.finish_reason : "";
  if (finish === "length") return { stop_reason: "max_tokens", stop_sequence: null };
  if (finish === "tool_calls" || finish === "function_call" || hasToolCalls) return { stop_reason: "tool_use", stop_sequence: null };
  if (finish === "content_filter") return { stop_reason: "refusal", stop_sequence: null };
  const named = typeof c.stop_reason === "string" ? c.stop_reason : typeof c.stop_sequence === "string" ? c.stop_sequence : null;
  if (named !== null && requestedStops.includes(named)) return { stop_reason: "stop_sequence", stop_sequence: named };
  return { stop_reason: "end_turn", stop_sequence: null };
}

/** Tool-call arguments arrive as a JSON string; a tool_use block carries the parsed object. Unparseable arguments become an empty input. */
export function parseArguments(args: unknown): Json {
  if (isObj(args)) return args;
  if (typeof args !== "string" || !args.trim()) return {};
  try {
    const v = JSON.parse(args);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

/** Provider ids are used as is; a call with none gets an Anthropic-shaped one. */
export const toolUseId = (id: unknown, n: number) => (typeof id === "string" && id ? id : `toolu_${Date.now().toString(36)}${n.toString(36)}${Math.random().toString(36).slice(2, 8)}`);

export type AnyRouteInfo = Record<string, unknown>;

/** Chat completion -> Anthropic message. */
export function toMessage(oa: Json, o: { model: string; stops: string[]; id?: string; anyroute?: AnyRouteInfo }): Json {
  const choice = Array.isArray(oa.choices) && isObj(oa.choices[0]) ? (oa.choices[0] as Json) : {};
  const message = isObj(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? (message.content as unknown[]).map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("") : "";
  if (text) content.push({ type: "text", text });
  const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];
  for (const [n, tc] of calls.entries()) {
    if (!isObj(tc)) continue;
    const fn = isObj(tc.function) ? tc.function : {};
    content.push({ type: "tool_use", id: toolUseId(tc.id, n), name: typeof fn.name === "string" ? fn.name : "", input: parseArguments(fn.arguments) });
  }
  // A reply with nothing in it still has one block, so clients that read content[0].text do not fail.
  if (!content.length) content.push({ type: "text", text: "" });
  const stop = toStop(choice, o.stops, calls.length > 0);
  return {
    id: typeof oa.id === "string" && oa.id ? oa.id : (o.id ?? ""),
    type: "message",
    role: "assistant",
    model: typeof oa.model === "string" && oa.model ? oa.model : o.model,
    content,
    ...stop,
    usage: toAnthropicUsage(oa.usage),
    ...(o.anyroute ? { anyroute: o.anyroute } : {}),
  };
}

// ---- errors ----------------------------------------------------------------------------------------------------------

/** Anthropic's error types by HTTP status. A status Anthropic does not define keeps its own status and takes the nearest type. */
export function errorType(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 504:
      return "timeout_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

export function errorBody(status: number, message: string, requestId: string, anyroute?: Json): Json {
  return { type: "error", error: { type: errorType(status), message }, request_id: requestId, ...(anyroute && Object.keys(anyroute).length ? { anyroute } : {}) };
}

/** What the caller should know about the router's own error beyond the Anthropic type: its stable type and metadata, and the receipt of a billed refusal. */
export function routerErrorInfo(router: { type?: unknown; metadata?: unknown }, receiptId?: unknown): Json {
  return {
    ...(typeof router.type === "string" ? { type: router.type } : {}),
    ...(typeof receiptId === "string" ? { receipt_id: receiptId } : {}),
    ...(isObj(router.metadata) && Object.keys(router.metadata).length ? { metadata: router.metadata } : {}),
  };
}

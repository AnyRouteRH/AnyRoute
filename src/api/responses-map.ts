import { randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "../lib/errors.ts";

// The OpenAI Responses API as an adapter over /api/v1/chat/completions. Everything here is a pure translation:
// a Responses request becomes a chat request, and the chat answer (JSON or SSE) becomes a Response (JSON or the
// Responses event stream). Nothing is stored: the chat route bills, routes and signs the receipt exactly as for a
// direct chat call, and this module only changes the shape of what goes in and comes out.

export type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** A 400 in the shape OpenAI clients read (error.message, error.type, error.param) next to the router's numeric code. */
export const refuse = (message: string, type: string, param: string | null = null, status = 400) =>
  new ApiError(status, message, type, undefined, undefined, { error: { code: status, message, type, param } });

/** Tool types that run on the API provider's servers. AnyRoute hosts no tools, so it cannot run them. */
const HOSTED_TOOL = /^(web_search|file_search|code_interpreter|computer|image_generation|mcp)/;
const ROLES: Record<string, string> = { user: "user", assistant: "assistant", system: "system", developer: "system" };

// ---- request -----------------------------------------------------------------------------------------------------

export type Echo = {
  /** The model as requested; the response carries the id the router resolved it to. */
  model: string;
  instructions: string | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  topP: number | null;
  parallelToolCalls: boolean;
  toolChoice: unknown;
  tools: unknown[];
  text: unknown;
  reasoning: { effort: string | null; summary: null };
  metadata: Record<string, string>;
  user: string | null;
};

const HOSTED_NOTE = "AnyRoute does not host tools. Send it as a `function` tool and run it in your own code.";

function contentToChat(role: string, content: unknown, where: string): string | Json[] {
  if (content == null) return "";
  if (isStr(content)) return content;
  if (!Array.isArray(content)) throw refuse(`\`${where}\` must be a string or an array of content parts.`, "invalid_request", where);
  const parts: Json[] = [];
  let images = false;
  content.forEach((p, i) => {
    const at = `${where}[${i}]`;
    if (!isObj(p)) throw refuse(`\`${at}\` must be an object.`, "invalid_request", at);
    switch (p.type) {
      case "input_text":
      case "output_text":
      case "text":
        if (!isStr(p.text)) throw refuse(`\`${at}.text\` must be a string.`, "invalid_request", `${at}.text`);
        parts.push({ type: "text", text: p.text });
        return;
      case "refusal":
        parts.push({ type: "text", text: isStr(p.refusal) ? p.refusal : "" });
        return;
      case "input_image": {
        if (role !== "user") throw refuse(`\`${at}\`: images are accepted only in user messages.`, "invalid_request", at);
        if (!isStr(p.image_url) || !p.image_url)
          throw refuse(
            p.file_id != null
              ? `\`${at}.file_id\` names a file stored by the API provider, and AnyRoute stores no files. Send \`image_url\` as an https URL or a data: URL.`
              : `\`${at}\` needs \`image_url\` (an https URL or a data: URL).`,
            "invalid_request",
            `${at}.image_url`,
          );
        parts.push({ type: "image_url", image_url: { url: p.image_url, ...(isStr(p.detail) && p.detail !== "auto" ? { detail: p.detail } : {}) } });
        images = true;
        return;
      }
      default:
        throw refuse(`Content part type ${JSON.stringify(p.type)} at \`${at}\` is not supported. AnyRoute accepts input_text and input_image (and output_text or refusal in earlier assistant messages).`, "unsupported_input", at);
    }
  });
  return images ? parts : parts.map((p) => String(p.text)).join("\n");
}

function outputToChat(output: unknown, where: string): string {
  if (isStr(output)) return output;
  if (Array.isArray(output)) {
    return output
      .map((p, i) => {
        if (isObj(p) && (p.type === "input_text" || p.type === "output_text" || p.type === "text") && isStr(p.text)) return p.text;
        throw refuse(`\`${where}[${i}]\`: a function_call_output accepts text only.`, "unsupported_input", `${where}[${i}]`);
      })
      .join("\n");
  }
  if (output == null) return "";
  return JSON.stringify(output);
}

/** `instructions` and `input` as chat messages. Reasoning items are dropped; items that refer to stored state are refused. */
export function messagesFromInput(instructions: unknown, input: unknown): Json[] {
  const out: Json[] = [];
  if (instructions != null && !isStr(instructions)) throw refuse("`instructions` must be a string.", "invalid_request", "instructions");
  if (instructions) out.push({ role: "system", content: instructions });
  if (isStr(input)) {
    out.push({ role: "user", content: input });
    return out;
  }
  if (!Array.isArray(input)) throw refuse("`input` is required: a string, or an array of input items.", "invalid_request", "input");
  input.forEach((item, i) => {
    const at = `input[${i}]`;
    if (!isObj(item)) throw refuse(`\`${at}\` must be an object.`, "invalid_request", at);
    const type = isStr(item.type) ? item.type : item.role !== undefined ? "message" : undefined;
    switch (type) {
      case "message": {
        const role = isStr(item.role) ? ROLES[item.role] : undefined;
        if (!role) throw refuse(`\`${at}.role\` must be user, assistant, system or developer.`, "invalid_request", `${at}.role`);
        out.push({ role, content: contentToChat(role, item.content, `${at}.content`) });
        return;
      }
      case "function_call": {
        if (!isStr(item.call_id) || !item.call_id) throw refuse(`\`${at}.call_id\` is required.`, "invalid_request", `${at}.call_id`);
        if (!isStr(item.name) || !item.name) throw refuse(`\`${at}.name\` is required.`, "invalid_request", `${at}.name`);
        const args = isStr(item.arguments) ? item.arguments : item.arguments == null ? "{}" : JSON.stringify(item.arguments);
        const call = { id: item.call_id, type: "function", function: { name: item.name, arguments: args } };
        // Calls that follow an assistant message (or each other) are one assistant turn in chat form.
        const prev = out[out.length - 1];
        if (prev && prev.role === "assistant") prev.tool_calls = [...(Array.isArray(prev.tool_calls) ? prev.tool_calls : []), call];
        else out.push({ role: "assistant", content: null, tool_calls: [call] });
        return;
      }
      case "function_call_output":
        if (!isStr(item.call_id) || !item.call_id) throw refuse(`\`${at}.call_id\` is required.`, "invalid_request", `${at}.call_id`);
        out.push({ role: "tool", tool_call_id: item.call_id, content: outputToChat(item.output, `${at}.output`) });
        return;
      case "reasoning":
        return; // a reasoning item echoed from an earlier turn; AnyRoute returns none and a provider needs none
      case "item_reference":
        throw refuse(`\`${at}\` refers to an item stored by the API provider. AnyRoute stores nothing: send the item itself.`, "unsupported_input", at);
      default:
        throw refuse(
          HOSTED_TOOL.test(String(type).replace(/_call(_output)?$/, ""))
            ? `Input item type ${JSON.stringify(type)} at \`${at}\` belongs to a tool that runs on the API provider's servers. ${HOSTED_NOTE}`
            : `Input item type ${JSON.stringify(type)} at \`${at}\` is not supported. AnyRoute accepts message, function_call and function_call_output items.`,
          "unsupported_input",
          at,
        );
    }
  });
  if (!out.length) throw refuse("`input` is required: a string, or an array of input items.", "invalid_request", "input");
  return out;
}

function toolsToChat(tools: unknown): Json[] | undefined {
  if (tools == null) return undefined;
  if (!Array.isArray(tools)) throw refuse("`tools` must be an array.", "invalid_request", "tools");
  const out: Json[] = [];
  tools.forEach((t, i) => {
    const at = `tools[${i}]`;
    if (!isObj(t)) throw refuse(`\`${at}\` must be an object.`, "invalid_request", at);
    if (t.type !== "function") {
      const type = String(t.type);
      throw refuse(
        HOSTED_TOOL.test(type) ? `The \`${type}\` tool runs on the API provider's servers. ${HOSTED_NOTE}` : `Tool type ${JSON.stringify(t.type)} at \`${at}\` is not supported. AnyRoute supports \`function\` tools.`,
        "unsupported_tool",
        `${at}.type`,
      );
    }
    if (!isStr(t.name) || !t.name) throw refuse(`\`${at}.name\` is required.`, "invalid_request", `${at}.name`);
    out.push({
      type: "function",
      function: {
        name: t.name,
        ...(isStr(t.description) ? { description: t.description } : {}),
        parameters: isObj(t.parameters) ? t.parameters : { type: "object", properties: {} },
        ...(typeof t.strict === "boolean" ? { strict: t.strict } : {}),
      },
    });
  });
  return out;
}

function toolChoiceToChat(choice: unknown): unknown {
  if (choice == null) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isObj(choice) && choice.type === "function") {
    const name = isStr(choice.name) ? choice.name : isObj(choice.function) && isStr(choice.function.name) ? choice.function.name : "";
    if (name) return { type: "function", function: { name } };
    throw refuse("`tool_choice` of type function needs a `name`.", "invalid_request", "tool_choice");
  }
  if (isObj(choice) && isStr(choice.type) && HOSTED_TOOL.test(choice.type)) throw refuse(`\`tool_choice\` names the \`${choice.type}\` tool. ${HOSTED_NOTE}`, "unsupported_tool", "tool_choice");
  throw refuse('`tool_choice` must be "auto", "none", "required" or {"type":"function","name":"…"}.', "invalid_request", "tool_choice");
}

function responseFormatToChat(text: unknown): Json | undefined {
  if (text == null) return undefined;
  if (!isObj(text)) throw refuse("`text` must be an object.", "invalid_request", "text");
  const f = text.format;
  if (f == null || (isObj(f) && f.type === "text")) return undefined;
  if (!isObj(f)) throw refuse("`text.format` must be an object.", "invalid_request", "text.format");
  if (f.type === "json_object") return { type: "json_object" };
  if (f.type === "json_schema") {
    if (!isStr(f.name) || !f.name) throw refuse("`text.format.name` is required for json_schema.", "invalid_request", "text.format.name");
    if (!isObj(f.schema)) throw refuse("`text.format.schema` must be a JSON Schema object.", "invalid_request", "text.format.schema");
    return { type: "json_schema", json_schema: { name: f.name, schema: f.schema, ...(typeof f.strict === "boolean" ? { strict: f.strict } : {}), ...(isStr(f.description) ? { description: f.description } : {}) } };
  }
  throw refuse(`\`text.format.type\` ${JSON.stringify(f.type)} is not supported. Use text, json_object or json_schema.`, "unsupported_parameter", "text.format.type");
}

/**
 * The chat request for a Responses request, plus what the Response echoes back. Everything AnyRoute cannot do is refused
 * here with a 400 before anything is routed, priced or sent: stored state (store, previous_response_id, conversation,
 * background, stored prompts, item and file references) and every tool that is not a function tool.
 */
export function chatRequestFrom(body: Json): { chat: Json; echo: Echo; stream: boolean } {
  if (body.store != null && body.store !== false)
    throw refuse("`store` must be false. AnyRoute is stateless: it keeps no responses or conversations, so a response cannot be stored. Leave `store` unset, or send `store: false`.", "store_not_supported", "store");
  if (body.previous_response_id != null)
    throw refuse(
      "`previous_response_id` is not supported. AnyRoute stores no responses, so there is no earlier turn to continue from. Send the whole conversation in `input` on every request: earlier messages, and any function_call and function_call_output items.",
      "previous_response_id_not_supported",
      "previous_response_id",
    );
  if (body.conversation != null) throw refuse("`conversation` is not supported: AnyRoute keeps no conversation state. Send the whole conversation in `input` on every request.", "conversation_not_supported", "conversation");
  if (body.background === true) throw refuse("`background` is not supported: a background response has to be stored until it is fetched, and AnyRoute stores none.", "background_not_supported", "background");
  if (body.prompt != null) throw refuse("`prompt` refers to a prompt template stored by the API provider. AnyRoute stores none: send `instructions` and `input`.", "unsupported_parameter", "prompt");
  if (!isStr(body.model) || !body.model) throw refuse('`model` is required (for example "meta-llama/llama-3.3-70b-instruct"). See GET /api/v1/models.', "invalid_request", "model");
  if (body.stream != null && typeof body.stream !== "boolean") throw refuse("`stream` must be a boolean.", "invalid_request", "stream");

  const num = (name: string, v: unknown, min: number, max: number) => {
    if (v == null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw refuse(`\`${name}\` must be a number from ${min} to ${max}.`, "invalid_request", name);
    return v;
  };
  const temperature = num("temperature", body.temperature, 0, 2);
  const topP = num("top_p", body.top_p, 0, 1);
  if (body.max_output_tokens != null && (!Number.isInteger(body.max_output_tokens) || (body.max_output_tokens as number) < 1)) throw refuse("`max_output_tokens` must be a positive integer.", "invalid_request", "max_output_tokens");
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== "boolean") throw refuse("`parallel_tool_calls` must be a boolean.", "invalid_request", "parallel_tool_calls");
  if (body.user != null && !isStr(body.user)) throw refuse("`user` must be a string.", "invalid_request", "user");
  if (body.provider != null && !isObj(body.provider)) throw refuse("`provider` must be an object (for example {\"lane\":\"attested\"}).", "invalid_request", "provider");
  if (body.reasoning != null && !isObj(body.reasoning)) throw refuse("`reasoning` must be an object.", "invalid_request", "reasoning");
  let metadata: Record<string, string> = {};
  if (body.metadata != null) {
    if (!isObj(body.metadata) || Object.values(body.metadata).some((v) => !isStr(v))) throw refuse("`metadata` must be an object of string values.", "invalid_request", "metadata");
    metadata = { ...(body.metadata as Record<string, string>) };
  }

  const messages = messagesFromInput(body.instructions, body.input);
  const tools = toolsToChat(body.tools);
  const toolChoice = toolChoiceToChat(body.tool_choice);
  const responseFormat = responseFormatToChat(body.text);
  const effort = isObj(body.reasoning) && isStr(body.reasoning.effort) ? body.reasoning.effort : null;
  const stream = body.stream === true;

  const chat: Json = {
    model: body.model,
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(body.max_output_tokens != null ? { max_tokens: body.max_output_tokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(typeof body.parallel_tool_calls === "boolean" && tools?.length ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(isStr(body.user) ? { user: body.user } : {}),
    ...(isObj(body.provider) ? { provider: body.provider } : {}),
    stream,
  };
  const echo: Echo = {
    model: body.model,
    instructions: isStr(body.instructions) ? body.instructions : null,
    maxOutputTokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : null,
    temperature: temperature ?? null,
    topP: topP ?? null,
    parallelToolCalls: body.parallel_tool_calls !== false,
    toolChoice: body.tool_choice ?? "auto",
    // Function tools are echoed with every field a Response client reads, as the request gave them or null.
    tools: Array.isArray(body.tools) ? body.tools.map((t) => (isObj(t) && t.type === "function" ? { description: null, parameters: null, strict: null, ...t } : t)) : [],
    text: isObj(body.text) && isObj(body.text.format) ? body.text : { format: { type: "text" } },
    reasoning: { effort, summary: null },
    metadata,
    user: isStr(body.user) ? body.user : null,
  };
  return { chat, echo, stream };
}

// ---- response ----------------------------------------------------------------------------------------------------

/** What the router said about the call, read from its response headers and (when it has one) the signed receipt. */
export type Meta = { receiptId: string | null; lane: string | null; disclosure: string | null; policyHash: string | null };

type Status = "in_progress" | "completed" | "incomplete" | "failed";

function metadataOf(echo: Echo, meta: Meta, receipt: Json | null): Record<string, string> {
  const payload = receipt && isObj(receipt.payload) ? receipt.payload : null;
  const disclosure = payload && isStr(payload.disclosure) ? payload.disclosure : meta.disclosure;
  return {
    ...echo.metadata,
    ...(meta.receiptId ? { anyroute_receipt_id: meta.receiptId } : {}),
    ...(meta.lane ? { anyroute_lane: meta.lane } : {}),
    ...(disclosure ? { anyroute_disclosure: disclosure } : {}),
    ...(meta.policyHash ? { anyroute_policy_hash: meta.policyHash } : {}),
  };
}

export function usageFromChat(u: unknown): Json | null {
  if (!isObj(u)) return null;
  const input = count(u.prompt_tokens);
  const output = count(u.completion_tokens);
  const details = (k: string, f: string) => (isObj(u[k]) ? count((u[k] as Json)[f]) : 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: details("prompt_tokens_details", "cached_tokens") },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: details("completion_tokens_details", "reasoning_tokens") },
    total_tokens: count(u.total_tokens) || input + output,
    ...(typeof u.cost === "number" ? { cost: u.cost } : {}),
  };
}

function responseObject(
  echo: Echo,
  r: { id: string; createdAt: number; model: string; status: Status; output: Json[]; usage: Json | null; metadata: Record<string, string>; error?: Json | null; incomplete?: string | null },
): Json {
  return {
    id: r.id,
    object: "response",
    created_at: r.createdAt,
    status: r.status,
    background: false,
    error: r.error ?? null,
    incomplete_details: r.incomplete ? { reason: r.incomplete } : null,
    instructions: echo.instructions,
    max_output_tokens: echo.maxOutputTokens,
    model: r.model,
    output: r.output,
    parallel_tool_calls: echo.parallelToolCalls,
    previous_response_id: null,
    reasoning: echo.reasoning,
    store: false,
    temperature: echo.temperature ?? 1,
    text: echo.text,
    tool_choice: echo.toolChoice,
    tools: echo.tools,
    top_p: echo.topP ?? 1,
    truncation: "disabled",
    usage: r.usage,
    user: echo.user,
    metadata: r.metadata,
  };
}

const suffixOf = (receiptId: string | null) => (receiptId ?? randomUUID().replace(/-/g, "")).replace(/^gen-/, "");
const itemId = (prefix: "msg" | "fc", suffix: string, index: number) => `${prefix}_${suffix}_${index}`;
const messageItem = (id: string, text: string, refusal: string, status: "in_progress" | "completed"): Json => ({
  id,
  type: "message",
  status,
  role: "assistant",
  content: [...(refusal ? [{ type: "refusal", refusal }] : []), ...(text || !refusal ? [{ type: "output_text", text, annotations: [] }] : [])],
});
const callItem = (id: string, callId: string, name: string, args: string, status: "in_progress" | "completed"): Json => ({ id, type: "function_call", call_id: callId, name, arguments: args, status });
const newCallId = () => `call_${randomBytes(9).toString("hex")}`;
const incompleteReason = (finish: unknown) => (finish === "length" ? "max_output_tokens" : finish === "content_filter" ? "content_filter" : null);

/** A non-streaming chat answer as a Response. */
export function responseFromChat(chat: Json, echo: Echo, meta: Meta, createdAt: number): Json {
  const choice = Array.isArray(chat.choices) && isObj(chat.choices[0]) ? chat.choices[0] : {};
  const message = isObj(choice.message) ? choice.message : {};
  const receipt = isObj(chat.receipt) ? chat.receipt : null;
  const receiptId = meta.receiptId ?? (isStr(chat.id) ? chat.id : null);
  const suffix = suffixOf(receiptId);
  const text = isStr(message.content) ? message.content : Array.isArray(message.content) ? message.content.map((p) => (isObj(p) && isStr(p.text) ? p.text : "")).join("") : "";
  const refusal = isStr(message.refusal) ? message.refusal : "";
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObj) : [];
  const output: Json[] = [];
  if (text || refusal || !calls.length) output.push(messageItem(itemId("msg", suffix, output.length), text, refusal, "completed"));
  for (const tc of calls) {
    const fn = isObj(tc.function) ? tc.function : {};
    const args = isStr(fn.arguments) ? fn.arguments : fn.arguments == null ? "{}" : JSON.stringify(fn.arguments);
    output.push(callItem(itemId("fc", suffix, output.length), isStr(tc.id) && tc.id ? tc.id : newCallId(), isStr(fn.name) ? fn.name : "", args, "completed"));
  }
  const incomplete = incompleteReason(choice.finish_reason);
  return responseObject(echo, {
    id: `resp_${receiptId ?? suffix}`,
    createdAt: typeof chat.created === "number" ? chat.created : createdAt,
    model: isStr(chat.model) ? chat.model : echo.model,
    status: incomplete ? "incomplete" : "completed",
    output,
    usage: usageFromChat(chat.usage),
    metadata: metadataOf(echo, meta, receipt),
    incomplete,
  });
}

// ---- streaming ---------------------------------------------------------------------------------------------------

type OutItem = { kind: "message" | "call"; index: number; id: string; text: string; callId: string; name: string; args: string; open: boolean };

/**
 * Turns the chat completion events of one stream into the Responses event stream. Feed it every parsed chat event with
 * `chat()` and finish with `end()`; it writes complete SSE frames through `send`. One item is streamed at a time: a
 * message is closed when a tool call starts, and tool calls are closed at the end. Text after a tool call opens a new
 * message item.
 */
export class StreamTranslator {
  private seq = 0;
  private items: OutItem[] = [];
  private message: OutItem | null = null;
  private calls = new Map<number, OutItem>();
  private model: string;
  private usage: Json | null = null;
  private receipt: Json | null = null;
  private finish: string | null = null;
  private failure: { code: string; message: string } | null = null;
  private readonly suffix: string;
  private readonly id: string;

  constructor(
    private echo: Echo,
    private meta: Meta,
    private createdAt: number,
    private send: (frame: string) => void,
  ) {
    this.model = echo.model;
    this.suffix = suffixOf(meta.receiptId);
    this.id = `resp_${meta.receiptId ?? this.suffix}`;
  }

  private emit(type: string, data: Json = {}) {
    this.send(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...data })}\n\n`);
  }

  private response(status: Status, output: Json[], extra: { error?: Json; incomplete?: string | null } = {}) {
    return responseObject(this.echo, {
      id: this.id,
      createdAt: this.createdAt,
      model: this.model,
      status,
      output,
      usage: status === "in_progress" ? null : usageFromChat(this.usage),
      metadata: metadataOf(this.echo, this.meta, this.receipt),
      ...extra,
    });
  }

  private itemJson(it: OutItem, status: "in_progress" | "completed"): Json {
    return it.kind === "message" ? messageItem(it.id, it.text, "", status) : callItem(it.id, it.callId, it.name, it.args, status);
  }

  /** response.created and response.in_progress, sent before the first chat event. */
  begin() {
    const r = this.response("in_progress", []);
    this.emit("response.created", { response: r });
    this.emit("response.in_progress", { response: r });
  }

  private startMessage(): OutItem {
    const it: OutItem = { kind: "message", index: this.items.length, id: itemId("msg", this.suffix, this.items.length), text: "", callId: "", name: "", args: "", open: true };
    this.items.push(it);
    this.message = it;
    this.emit("response.output_item.added", { output_index: it.index, item: { id: it.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
    this.emit("response.content_part.added", { item_id: it.id, output_index: it.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    return it;
  }

  private closeMessage() {
    const it = this.message;
    if (!it) return;
    this.message = null;
    it.open = false;
    this.emit("response.output_text.done", { item_id: it.id, output_index: it.index, content_index: 0, text: it.text, logprobs: [] });
    this.emit("response.content_part.done", { item_id: it.id, output_index: it.index, content_index: 0, part: { type: "output_text", text: it.text, annotations: [] } });
    this.emit("response.output_item.done", { output_index: it.index, item: this.itemJson(it, "completed") });
  }

  private closeCall(it: OutItem) {
    it.open = false;
    it.args = it.args || "{}";
    this.emit("response.function_call_arguments.done", { item_id: it.id, output_index: it.index, name: it.name, arguments: it.args });
    this.emit("response.output_item.done", { output_index: it.index, item: this.itemJson(it, "completed") });
  }

  private text(delta: string) {
    if (!delta) return;
    const it = this.message ?? this.startMessage();
    it.text += delta;
    this.emit("response.output_text.delta", { item_id: it.id, output_index: it.index, content_index: 0, delta, logprobs: [] });
  }

  private toolCall(tc: unknown) {
    if (!isObj(tc)) return;
    const fn = isObj(tc.function) ? tc.function : {};
    // Chat streams number a call's fragments; a provider that omits the number sends whole calls, one per id.
    const index = typeof tc.index === "number" ? tc.index : isStr(tc.id) && tc.id ? this.calls.size : Math.max(0, this.calls.size - 1);
    let it = this.calls.get(index);
    if (!it) {
      this.closeMessage();
      it = { kind: "call", index: this.items.length, id: itemId("fc", this.suffix, this.items.length), text: "", callId: isStr(tc.id) && tc.id ? tc.id : newCallId(), name: isStr(fn.name) ? fn.name : "", args: "", open: true };
      this.items.push(it);
      this.calls.set(index, it);
      this.emit("response.output_item.added", { output_index: it.index, item: this.itemJson(it, "in_progress") });
    } else if (!it.name && isStr(fn.name)) it.name = fn.name;
    if (isStr(fn.arguments) && fn.arguments) {
      it.args += fn.arguments;
      this.emit("response.function_call_arguments.delta", { item_id: it.id, output_index: it.index, delta: fn.arguments });
    }
  }

  /** One parsed chat completion event (a chunk, a usage-and-receipt event, or an error). */
  chat(ev: unknown) {
    if (!isObj(ev)) return;
    if (isStr(ev.model) && ev.model) this.model = ev.model;
    if (isObj(ev.usage)) this.usage = ev.usage;
    if (isObj(ev.receipt)) this.receipt = ev.receipt;
    if (isObj(ev.error)) this.failure ??= { code: isStr(ev.error.type) && ev.error.type ? ev.error.type : "server_error", message: isStr(ev.error.message) && ev.error.message ? ev.error.message : "The provider failed." };
    for (const ch of Array.isArray(ev.choices) ? ev.choices : []) {
      if (!isObj(ch)) continue;
      const d = isObj(ch.delta) ? ch.delta : {};
      if (isStr(d.content)) this.text(d.content);
      if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) this.toolCall(tc);
      if (isStr(ch.finish_reason)) this.finish = ch.finish_reason;
    }
  }

  /** The chat stream is over (`sawDone`: it ended with [DONE]). Closes what is open and sends the last event. */
  end(sawDone: boolean) {
    if (!this.failure && (this.finish === "error" || this.finish === "cancelled")) this.failure = { code: "server_error", message: this.finish === "cancelled" ? "The request was cancelled." : "The provider failed." };
    if (!this.failure && !sawDone && !this.finish) this.failure = { code: "upstream_interrupted", message: "The provider's stream ended before it finished." };
    if (this.failure) {
      const { code, message } = this.failure;
      this.emit("error", { code, message, param: null });
      this.emit("response.failed", { response: this.response("failed", [], { error: { code, message } }) });
      return;
    }
    this.closeMessage();
    if (!this.items.length) {
      this.startMessage();
      this.closeMessage();
    }
    for (const it of this.items) if (it.kind === "call" && it.open) this.closeCall(it);
    const incomplete = incompleteReason(this.finish);
    this.emit(incomplete ? "response.incomplete" : "response.completed", {
      response: this.response(
        incomplete ? "incomplete" : "completed",
        this.items.map((it) => this.itemJson(it, "completed")),
        { incomplete },
      ),
    });
  }
}

/** The chat SSE body as the Responses SSE body. Comment lines (keep-alives) pass through; there is no [DONE]. */
export function translateChatStream(source: ReadableStream<Uint8Array>, echo: Echo, meta: Meta, createdAt: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reader = source.getReader();
  let closed = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      const tr = new StreamTranslator(echo, meta, createdAt, send);
      tr.begin();
      let sawDone = false;
      const frame = (raw: string) => {
        const data: string[] = [];
        let comment = false;
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith(":")) comment = true;
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) {
          if (comment) send(": ANYROUTE PROCESSING\n\n");
          return;
        }
        const payload = data.join("\n");
        if (payload.trim() === "[DONE]") {
          sawDone = true;
          return;
        }
        try {
          tr.chat(JSON.parse(payload));
        } catch {
          /* a malformed event is skipped */
        }
      };
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (let m = /\r?\n\r?\n/.exec(buf); m; m = /\r?\n\r?\n/.exec(buf)) {
            const raw = buf.slice(0, m.index);
            buf = buf.slice(m.index + m[0].length);
            frame(raw);
          }
        }
        if (buf.trim()) frame(buf);
      } catch {
        /* the read failed: end() reports an interrupted stream unless the provider had finished */
      }
      tr.end(sawDone);
      closed = true;
      try {
        controller.close();
      } catch {
        /* the client is gone */
      }
    },
    async cancel() {
      closed = true;
      await reader.cancel().catch(() => undefined);
    },
  });
}

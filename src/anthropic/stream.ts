import { errorType, toAnthropicUsage, toStop, toolUseId, type AnyRouteInfo } from "./convert.ts";

// The router's chat-completions SSE stream -> Anthropic Messages SSE. Event order is the API's own:
//   message_start, ping, (content_block_start, content_block_delta*, content_block_stop)*, message_delta, message_stop
// with an `error` event in place of the ending when the stream fails. Tool-call arguments are relayed as they arrive, as
// input_json_delta events, so a client sees the same incremental JSON it would from Anthropic.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export type StreamSummary = { receipt: Json | null; provider: string | null };

export type TranslatorOptions = {
  id: string;
  model: string;
  /** message_start states the router's estimate of the prompt; message_delta carries the billed figure. */
  inputTokens: number;
  stops: string[];
  /** What to add to message_delta under `anyroute` once the receipt is known. */
  describe: (s: StreamSummary) => AnyRouteInfo | undefined;
};

export class StreamTranslator {
  private index = -1;
  private open: { kind: "text" } | { kind: "tool"; id: string; key: string; args: boolean } | null = null;
  private choice: Json = {};
  private hadTools = false;
  private finished = false;
  private usage: unknown = null;
  private receipt: Json | null = null;
  private provider: string | null = null;
  failed = false;

  constructor(private o: TranslatorOptions) {}

  start(): string[] {
    return [
      sse("message_start", {
        type: "message_start",
        message: {
          id: this.o.id,
          type: "message",
          role: "assistant",
          model: this.o.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.o.inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          anyroute: { receipt_id: this.o.id },
        },
      }),
      ...this.ping(),
    ];
  }

  ping(): string[] {
    return this.failed ? [] : [sse("ping", { type: "ping" })];
  }

  /** The stream failed: the API's error event, and nothing after it. */
  fail(status: number, message: string, router: Json = {}): string[] {
    if (this.failed) return [];
    this.failed = true;
    return [sse("error", { type: "error", error: { type: errorType(status), message }, ...(Object.keys(router).length ? { anyroute: router } : {}) })];
  }

  private closeBlock(out: string[]) {
    if (!this.open) return;
    if (this.open.kind === "tool" && !this.open.args) out.push(sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: "{}" } }));
    out.push(sse("content_block_stop", { type: "content_block_stop", index: this.index }));
    this.open = null;
  }

  private openText(out: string[]) {
    if (this.open?.kind === "text") return;
    this.closeBlock(out);
    this.index++;
    this.open = { kind: "text" };
    out.push(sse("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } }));
  }

  private toolCall(tc: Json, out: string[]) {
    const fn = isObj(tc.function) ? tc.function : {};
    const id = typeof tc.id === "string" && tc.id ? tc.id : null;
    const key = typeof tc.index === "number" ? String(tc.index) : "";
    const cur = this.open?.kind === "tool" ? this.open : null;
    // A chunk continues the open call unless it names a different call (another id, or another index when it names none).
    const isNew = !cur || (id !== null ? id !== cur.id : key !== "" && cur.key !== "" && key !== cur.key);
    if (isNew) {
      this.closeBlock(out);
      this.index++;
      const use = toolUseId(id, this.index);
      this.open = { kind: "tool", id: use, key, args: false };
      this.hadTools = true;
      out.push(sse("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "tool_use", id: use, name: typeof fn.name === "string" ? fn.name : "", input: {} } }));
    }
    const args = typeof fn.arguments === "string" ? fn.arguments : isObj(fn.arguments) ? JSON.stringify(fn.arguments) : "";
    if (args && this.open?.kind === "tool") {
      this.open.args = true;
      out.push(sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: args } }));
    }
  }

  /** One chat-completions chunk. */
  chunk(ev: Json): string[] {
    if (this.failed) return [];
    const out: string[] = [];
    if (isObj(ev.error)) {
      const e = ev.error;
      return this.fail(typeof e.code === "number" ? e.code : 502, typeof e.message === "string" ? e.message : "The provider failed.", {
        ...(typeof e.type === "string" ? { type: e.type } : {}),
        ...(typeof ev.id === "string" ? { receipt_id: ev.id } : {}),
        ...(isObj(e.metadata) ? { metadata: e.metadata } : {}),
      });
    }
    if (ev.usage) this.usage = ev.usage;
    if (isObj(ev.receipt)) this.receipt = ev.receipt;
    if (typeof ev.provider === "string") this.provider = ev.provider;
    const choices = Array.isArray(ev.choices) ? ev.choices : [];
    for (const ch of choices) {
      if (!isObj(ch)) continue;
      const d = isObj(ch.delta) ? ch.delta : {};
      if (typeof d.content === "string" && d.content) {
        this.openText(out);
        out.push(sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: d.content } }));
      }
      if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) if (isObj(tc)) this.toolCall(tc, out);
      if (ch.finish_reason) {
        this.finished = true;
        this.choice = ch;
      }
    }
    return out;
  }

  /** The provider's stream is over: close the block that is open and state why the message ended. */
  end(): string[] {
    if (this.failed) return [];
    if (!this.finished && !this.usage) return this.fail(502, "The response ended before the model finished.", { type: "provider_interrupted" });
    const out: string[] = [];
    this.closeBlock(out);
    if (this.index < 0) {
      // An empty answer still has one (empty) text block.
      this.openText(out);
      this.closeBlock(out);
    }
    const stop = toStop(this.choice, this.o.stops, this.hadTools);
    const info = this.o.describe({ receipt: this.receipt, provider: this.provider });
    out.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: stop.stop_reason, stop_sequence: stop.stop_sequence }, usage: toAnthropicUsage(this.usage), ...(info ? { anyroute: info } : {}) }));
    out.push(sse("message_stop", { type: "message_stop" }));
    return out;
  }
}

// ---- reading the router's SSE ------------------------------------------------------------------------------------------

export type Item = { kind: "comment" } | { kind: "data"; data: Json };

function* parseBlock(block: string): Generator<Item> {
  const lines = block.split(/\r?\n/);
  const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
  if (!data.length) {
    // A keep-alive becomes a ping. A receipt v2 chain value (": anyroute-chain i hex") covers the router's own events,
    // which are re-encoded here, so it is dropped rather than passed on.
    if (lines.some((l) => l.startsWith(":") && !l.startsWith(": anyroute-chain "))) yield { kind: "comment" };
    return;
  }
  const text = data.join("\n");
  if (text.trim() === "[DONE]") return;
  try {
    const v = JSON.parse(text);
    if (isObj(v)) yield { kind: "data", data: v };
  } catch {
    /* a malformed event is skipped */
  }
}

export async function* readEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Item> {
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      if (!m) break;
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      yield* parseBlock(block);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield* parseBlock(buf);
}


// ---- the streaming response --------------------------------------------------------------------------------------------

const TIMED_OUT = Symbol("timed out");
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return Promise.race([p, Promise.resolve(TIMED_OUT as typeof TIMED_OUT)]);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMED_OUT), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export type StreamOptions = {
  requestId: string;
  /** The model the client asked for, for message_start when the router has not named one yet. */
  model: string;
  inputTokens: number;
  stops: string[];
  /** How long to hold the response back to see whether the router refuses the request outright (then it is a real HTTP error, which SDKs can retry). */
  peekMs: number;
  headers: Record<string, string>;
  describe: (s: StreamSummary, routerHeaders: Headers) => AnyRouteInfo | undefined;
  /** An Anthropic-shaped error response. */
  refuse: (status: number, message: string, router: Json) => Response;
};

/**
 * Turn the router's streaming response into an Anthropic Messages stream. The router opens its stream before it has
 * chosen a provider, so a request every provider fails arrives as an error event inside a 200. The first events are read
 * before answering: an error among them becomes the HTTP error it stands for. Once the answer is under way (or a provider
 * is slow to start), later failures are `error` events, as they are from Anthropic.
 */
export async function streamMessages(inner: Response, o: StreamOptions): Promise<Response> {
  if (!inner.body) return o.refuse(502, "The router returned no stream.", {});
  const reader = inner.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const events = readEvents(reader)[Symbol.asyncIterator]();
  let pending = events.next();
  let first: Json | null = null;
  const deadline = Date.now() + o.peekMs;
  try {
    for (;;) {
      const r = await withTimeout(pending, deadline - Date.now());
      if (r === TIMED_OUT) break;
      if (r.done) {
        await reader.cancel().catch(() => undefined);
        return o.refuse(502, "The router's stream ended before any output.", { type: "providers_unavailable" });
      }
      if (r.value.kind === "comment") {
        pending = events.next();
        continue;
      }
      first = r.value.data;
      break;
    }
  } catch {
    /* an unreadable stream is reported below, from the event loop */
  }
  if (first && isObj(first.error)) {
    await reader.cancel().catch(() => undefined);
    const e = first.error;
    return o.refuse(typeof e.code === "number" && e.code >= 400 ? e.code : 502, typeof e.message === "string" ? e.message : "The provider failed.", {
      ...(typeof e.type === "string" ? { type: e.type } : {}),
      ...(typeof first.id === "string" ? { receipt_id: first.id } : {}),
      ...(isObj(e.metadata) ? { metadata: e.metadata } : {}),
    });
  }

  const translator = new StreamTranslator({
    id: inner.headers.get("x-receipt-id") ?? (typeof first?.id === "string" ? first.id : o.requestId),
    model: typeof first?.model === "string" && first.model ? first.model : o.model,
    inputTokens: o.inputTokens,
    stops: o.stops,
    describe: (s) => o.describe(s, inner.headers),
  });
  const enc = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (chunks: string[]) => {
        if (cancelled) return;
        for (const c of chunks) controller.enqueue(enc.encode(c));
      };
      push(translator.start());
      try {
        if (first) push(translator.chunk(first));
        let next = first ? events.next() : pending;
        for (;;) {
          const r = await next;
          if (r.done) break;
          push(r.value.kind === "comment" ? translator.ping() : translator.chunk(r.value.data));
          next = events.next();
        }
        push(translator.end());
      } catch {
        if (!cancelled) push(translator.fail(502, "The router's stream was interrupted.", { type: "provider_interrupted" }));
      }
      try {
        controller.close();
      } catch {
        /* the client is gone */
      }
    },
    cancel() {
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", ...o.headers } });
}

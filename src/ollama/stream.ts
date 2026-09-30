import { readEvents } from "../anthropic/stream.ts";
import { doneReason, reasoningOf, stats, type Timing } from "./convert.ts";
import { parseArguments } from "../anthropic/convert.ts";

// The router's chat-completions SSE stream -> Ollama's NDJSON stream: one JSON object per line, each a piece of the
// answer with "done": false, then one closing object with "done": true, done_reason and the counts and durations.
// Tool calls are sent whole, in one object before the closing one, as Ollama sends them. A failure is an {"error"} line.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const line = (o: unknown) => JSON.stringify(o) + "\n";

export type StreamSummary = { receipt: Json | null; provider: string | null };

export type TranslatorOptions = {
  kind: "chat" | "generate";
  /** The name the client asked for, echoed on every line as Ollama does. */
  model: string;
  think: boolean;
  t0: number;
  promptEstimate: number;
  /** What to add to the closing line under `anyroute` once the receipt is known. */
  describe: (s: StreamSummary) => Json | undefined;
  now?: () => number;
};

export class NdjsonTranslator {
  private calls = new Map<string, { id: string; name: string; args: string }>();
  private lastCall: string | null = null;
  private finish: unknown = null;
  private finished = false;
  private usage: unknown = null;
  private receipt: Json | null = null;
  private provider: string | null = null;
  private firstAt: number | null = null;
  private chars = 0;
  failed = false;

  constructor(private o: TranslatorOptions) {}

  private now() {
    return (this.o.now ?? performance.now.bind(performance))();
  }

  private piece(content: string, thinking = ""): string {
    const created_at = new Date().toISOString();
    if (this.o.kind === "generate") return line({ model: this.o.model, created_at, response: content, ...(thinking ? { thinking } : {}), done: false });
    return line({ model: this.o.model, created_at, message: { role: "assistant", content, ...(thinking ? { thinking } : {}) }, done: false });
  }

  /** The stream failed: Ollama's error line, and nothing after it. */
  fail(message: string): string[] {
    if (this.failed) return [];
    this.failed = true;
    return [line({ error: message })];
  }

  private toolCall(tc: Json) {
    const fn = isObj(tc.function) ? tc.function : {};
    const id = typeof tc.id === "string" && tc.id ? tc.id : null;
    // A chunk continues a call it names by index (or by id); a chunk that names neither continues the last one.
    const key = typeof tc.index === "number" ? `i${tc.index}` : id ? `id${id}` : this.lastCall ?? "i0";
    let call = this.calls.get(key);
    if (!call) {
      call = { id: id ?? "", name: "", args: "" };
      this.calls.set(key, call);
    }
    if (id && !call.id) call.id = id;
    if (typeof fn.name === "string" && fn.name) call.name = fn.name;
    if (typeof fn.arguments === "string") call.args += fn.arguments;
    else if (isObj(fn.arguments)) call.args = JSON.stringify(fn.arguments);
    this.lastCall = key;
  }

  /** One chat-completions chunk. */
  chunk(ev: Json): string[] {
    if (this.failed) return [];
    if (isObj(ev.error)) return this.fail(typeof ev.error.message === "string" ? ev.error.message : "The provider failed.");
    if (ev.usage) this.usage = ev.usage;
    if (isObj(ev.receipt)) this.receipt = ev.receipt;
    if (typeof ev.provider === "string") this.provider = ev.provider;
    const out: string[] = [];
    const choices = Array.isArray(ev.choices) ? ev.choices : [];
    for (const ch of choices) {
      if (!isObj(ch)) continue;
      const d = isObj(ch.delta) ? ch.delta : {};
      const content = typeof d.content === "string" ? d.content : "";
      const thinking = this.o.think ? reasoningOf(d) : "";
      if (content || thinking) {
        this.firstAt ??= this.now();
        this.chars += content.length;
        out.push(this.piece(content, thinking));
      }
      if (Array.isArray(d.tool_calls) && this.o.kind === "chat") {
        this.firstAt ??= this.now();
        for (const tc of d.tool_calls) if (isObj(tc)) this.toolCall(tc);
      }
      if (ch.finish_reason) {
        this.finished = true;
        this.finish = ch.finish_reason;
      }
    }
    return out;
  }

  /** The provider's stream is over: the tool calls, if any, then the closing line. */
  end(): string[] {
    if (this.failed) return [];
    if (!this.finished && !this.usage) return this.fail("The response ended before the model finished.");
    const out: string[] = [];
    const created_at = () => new Date().toISOString();
    if (this.calls.size) {
      const tool_calls = [...this.calls.values()].map((c, index) => ({ ...(c.id ? { id: c.id } : {}), function: { index, name: c.name, arguments: parseArguments(c.args) } }));
      out.push(line({ model: this.o.model, created_at: created_at(), message: { role: "assistant", content: "", tool_calls }, done: false }));
    }
    const endAt = this.now();
    const timing: Timing = { t0: this.o.t0, firstAt: this.firstAt, endAt };
    const info = this.o.describe({ receipt: this.receipt, provider: this.provider });
    const counts = stats(timing, this.usage, { prompt: this.o.promptEstimate, output: Math.ceil(this.chars / 4) });
    const head = this.o.kind === "generate" ? { model: this.o.model, created_at: created_at(), response: "" } : { model: this.o.model, created_at: created_at(), message: { role: "assistant", content: "" } };
    out.push(line({ ...head, done: true, done_reason: doneReason(this.finish), ...counts, ...(info ? { anyroute: info } : {}) }));
    return out;
  }
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

export type StreamOptions = Omit<TranslatorOptions, "describe"> & {
  /** How long to hold the response back to see whether the router refuses the request (then it is a real HTTP error). */
  peekMs: number;
  headers: Record<string, string>;
  describe: (s: StreamSummary, routerHeaders: Headers) => Json | undefined;
  /** An Ollama-shaped error response. */
  refuse: (status: number, message: string) => Response;
};

/**
 * Turn the router's streaming response into an Ollama NDJSON stream. The router opens its stream before it has chosen a
 * provider, so a request every provider fails arrives as an error event inside a 200: the first events are read before
 * answering, and an error among them becomes the HTTP error it stands for. Later failures are {"error"} lines.
 */
export async function streamNdjson(inner: Response, o: StreamOptions): Promise<Response> {
  if (!inner.body) return o.refuse(502, "The router returned no stream.");
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
        return o.refuse(502, "The router's stream ended before any output.");
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
    return o.refuse(typeof e.code === "number" && e.code >= 400 ? e.code : 502, typeof e.message === "string" ? e.message : "The provider failed.");
  }

  const translator = new NdjsonTranslator({ ...o, describe: (s) => o.describe(s, inner.headers) });
  const enc = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (lines: string[]) => {
        if (cancelled) return;
        for (const l of lines) controller.enqueue(enc.encode(l));
      };
      try {
        if (first) push(translator.chunk(first));
        let next = first ? events.next() : pending;
        for (;;) {
          const r = await next;
          if (r.done) break;
          if (r.value.kind === "data") push(translator.chunk(r.value.data));
          next = events.next();
        }
        push(translator.end());
      } catch {
        if (!cancelled) push(translator.fail("The router's stream was interrupted."));
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
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache", "x-accel-buffering": "no", ...o.headers } });
}

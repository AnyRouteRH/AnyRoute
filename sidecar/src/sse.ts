// Side-channel reader for a server-sent-events stream. The proxy forwards the upstream bytes untouched; this
// only watches them to learn whether the upstream finished (`data: [DONE]`) and what usage it reported.

const MAX_PENDING = 4 * 1024 * 1024;

export class SseScanner {
  private buf = "";
  private dec = new TextDecoder();
  /** The upstream sent its `[DONE]` terminator. */
  done = false;
  /** Last non-null `usage` object seen in a JSON event. */
  usage: unknown = null;
  /** JSON events that carried choices: a rough token count when the upstream reports no usage. */
  chunks = 0;
  /** The upstream sent an `error` event. */
  sawError = false;
  private tail = "";
  /** Parsed JSON events, kept only when asked (to examine a whole stream before releasing it). */
  readonly events: unknown[] = [];
  /** An event too large to keep was discarded: what was kept is not the whole stream. */
  overflow = false;

  constructor(private readonly keepEvents = false) {}

  feed(chunk: Uint8Array) {
    this.tail = (this.tail + Buffer.from(chunk.subarray(Math.max(0, chunk.length - 4))).toString("latin1")).slice(-4);
    this.buf += this.dec.decode(chunk, { stream: true });
    for (;;) {
      const m = /\r\n\r\n|\n\n|\r\r/.exec(this.buf);
      if (!m) break;
      const event = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.event(event);
    }
    if (this.buf.length > MAX_PENDING) {
      this.buf = ""; // a single event this large is not a completion chunk
      this.overflow = true;
    }
  }

  /** Call once at the end of a stream: a last event with no blank line after it is parsed too. */
  flush() {
    const rest = this.buf;
    this.buf = "";
    if (rest.trim()) this.event(rest);
  }

  /** True when the bytes seen so far end exactly on an event boundary (or nothing was sent). */
  get endsOnBoundary(): boolean {
    return this.tail === "" || /(\n\n|\r\n\r\n|\r\r)$/.test(this.tail);
  }

  private event(text: string) {
    const data: string[] = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    const payload = data.join("\n");
    if (payload.trim() === "[DONE]") {
      this.done = true;
      return;
    }
    if (!payload.startsWith("{")) {
      if (this.keepEvents) this.events.push(payload); // not JSON: kept as text so it can still be examined
      return;
    }
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      if (this.keepEvents) this.events.push(obj);
      if (obj.error) this.sawError = true;
      if (obj.usage && typeof obj.usage === "object") this.usage = obj.usage;
      if (Array.isArray(obj.choices) && obj.choices.length) this.chunks++;
    } catch {
      if (this.keepEvents) this.events.push(payload);
    }
  }
}

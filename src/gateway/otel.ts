import { randomBytes } from "node:crypto";
import { log } from "../lib/util.ts";

// Minimal OTLP/HTTP (JSON) trace exporter with GenAI semantic-convention attributes.
// Spans never carry prompt or completion content.

type Attr = string | number | boolean;
type Span = { name: string; traceId: string; spanId: string; start: bigint; end: bigint; attrs: Record<string, Attr>; error?: string };

const toAttr = (k: string, v: Attr) => ({
  key: k,
  value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
});

export class Telemetry {
  private buffer: Span[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  exported = 0;

  constructor(private endpoint: string | undefined, private serviceName: string) {
    if (endpoint) {
      this.timer = setInterval(() => void this.flush(), 5_000);
      this.timer.unref?.();
    }
  }

  get enabled() {
    return !!this.endpoint;
  }

  span(name: string, startMs: number, endMs: number, attrs: Record<string, Attr | null | undefined>, error?: string, traceId?: string) {
    if (!this.endpoint) return;
    const clean: Record<string, Attr> = {};
    for (const [k, v] of Object.entries(attrs)) if (v != null) clean[k] = v;
    this.buffer.push({
      name,
      traceId: traceId && /^[0-9a-f]{32}$/.test(traceId) ? traceId : randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      start: BigInt(Math.round(startMs)) * 1_000_000n,
      end: BigInt(Math.round(endMs)) * 1_000_000n,
      attrs: clean,
      error,
    });
    if (this.buffer.length >= 512) void this.flush();
  }

  async flush() {
    if (!this.endpoint || !this.buffer.length) return;
    const spans = this.buffer.splice(0, this.buffer.length);
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [toAttr("service.name", this.serviceName)] },
          scopeSpans: [
            {
              scope: { name: "anyroute", version: "0.1.0" },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                name: s.name,
                kind: 3, // CLIENT
                startTimeUnixNano: s.start.toString(),
                endTimeUnixNano: s.end.toString(),
                attributes: Object.entries(s.attrs).map(([k, v]) => toAttr(k, v)),
                status: s.error ? { code: 2, message: s.error } : { code: 1 },
              })),
            },
          ],
        },
      ],
    };
    try {
      const res = await fetch(this.endpoint.replace(/\/$/, "") + "/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.exported += spans.length;
    } catch (e) {
      log.warn("otel export failed", { error: (e as Error).message, dropped: spans.length });
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

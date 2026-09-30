import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { fail } from "../lib/errors.ts";
import { decrypt, encrypt, log, sleep } from "../lib/util.ts";
import { providerFetch } from "../providers/network.ts";
import { maskWebhookUrl, webhookUrlProblem, type Resolve } from "./spend-watch.ts";

// Customer tracing export: a key's owner can send one span per call made with that key to their own OpenTelemetry
// collector (OTLP/HTTP JSON), to Langfuse (public ingestion API) or to Helicone (custom log API).
//
// Only public-lane calls are ever exported. A call on the attested or unlinkable lane is private by contract: its
// model, timing, token counts and cost must not leave the router tied to a key, so no destination is looked up and
// nothing is queued for it (see shouldExportTrace and test/tracing.test.ts). The unlinkable lane is paid with blind
// tokens and has no key at all; the attested lane may carry a key, and it is excluded anyway.
//
// Prompt and completion text is exported only when the owner set include_content: true. The destination URL and every
// credential are sealed with APP_SECRET (AES-256-GCM, the same helper as BYOK keys) and never returned by the API.
//
// Export never touches the request path: enqueue() is synchronous and cannot throw, the queue is bounded (overflow is
// dropped and counted), a failing send is retried with exponential backoff, and a destination that keeps failing is
// switched off for a cooldown (circuit breaker) while its new spans are dropped and counted.

export const TRACING_TYPES = ["otlp", "langfuse", "helicone"] as const;
export type TracingType = (typeof TRACING_TYPES)[number];

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "accept-encoding", "user-agent"]);

const secretText = (max: number) => z.string().min(1).max(max).refine((v) => !/[\r\n]/.test(v), "must be a single line");

/** What PATCH /api/v1/keys/:hash accepts under `tracing`. A secret left out keeps the stored one when the type is unchanged. */
export const tracingInput = z
  .object({
    type: z.enum(TRACING_TYPES),
    endpoint: z.string().max(2048).optional(), // otlp: collector base URL (/v1/traces is appended unless present)
    headers: z.record(z.string(), secretText(4096)).optional(), // otlp: auth headers, e.g. x-honeycomb-team
    host: z.string().max(2048).optional(), // langfuse / helicone: API host
    public_key: secretText(200).optional(), // langfuse
    secret_key: secretText(500).optional(), // langfuse
    api_key: secretText(500).optional(), // helicone
    include_content: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type TracingInput = z.infer<typeof tracingInput>;

/** Sealed inside keys.tracing.sealed: the destination URL, its headers and the credentials they were built from. */
type Secrets = { base: string; url: string; headers: Record<string, string>; public_key?: string; secret_key?: string; api_key?: string };

/** keys.tracing as stored. Everything outside `sealed` is safe to return. */
export type StoredTracing = {
  v: 1;
  type: TracingType;
  enabled: boolean;
  include_content: boolean;
  target: string; // masked: scheme and host only
  header_names: string[];
  public_key_hint: string | null;
  sealed: string;
  updated_at: string;
};

const DEFAULT_HOST: Record<Exclude<TracingType, "otlp">, string> = { langfuse: "https://cloud.langfuse.com", helicone: "https://api.worker.helicone.ai" };
const hint = (v: string) => (v.length > 10 ? `${v.slice(0, 6)}…${v.slice(-4)}` : "…");

function checkUrl(raw: string, field: string) {
  const problem = webhookUrlProblem(raw);
  if (problem) fail(400, problem.replace("webhook_url", field), "invalid_tracing_destination");
  const u = new URL(raw.trim());
  if (u.search) fail(400, `${field} cannot contain a query string; put credentials in headers.`, "invalid_tracing_destination");
  return u.toString().replace(/\/+$/, "");
}

/** The URL each destination type posts to. */
export function exportUrl(type: TracingType, base: string) {
  if (type === "otlp") return /\/v1\/traces$/.test(base) ? base : base + "/v1/traces";
  if (type === "langfuse") return base + "/api/public/ingestion";
  return base + "/custom/v1/log";
}

function previousSecrets(secret: string, prev: StoredTracing | null, type: TracingType): Secrets | null {
  if (!prev || prev.type !== type) return null;
  try {
    return JSON.parse(decrypt(secret, prev.sealed)) as Secrets;
  } catch {
    return null;
  }
}

/** Validate a `tracing` object and seal it. `prev` supplies secrets the caller left out (same type only). */
export function sealTracing(appSecret: string, input: TracingInput, prev: StoredTracing | null, now = new Date()): StoredTracing {
  const old = previousSecrets(appSecret, prev, input.type);
  let secrets: Secrets;
  if (input.type === "otlp") {
    const endpoint = input.endpoint ?? old?.base;
    if (!endpoint) fail(400, "tracing.endpoint is required for an OTLP destination.", "invalid_tracing_destination");
    const headers = input.headers ?? old?.headers ?? {};
    const names = Object.keys(headers);
    if (names.length > 16) fail(400, "tracing.headers may hold at most 16 headers.", "invalid_tracing_destination");
    for (const n of names) {
      if (!HEADER_NAME.test(n)) fail(400, `tracing.headers has an invalid header name: ${n.slice(0, 40)}.`, "invalid_tracing_destination");
      if (RESERVED_HEADERS.has(n.toLowerCase())) fail(400, `tracing.headers cannot set ${n}.`, "invalid_tracing_destination");
    }
    const base = checkUrl(endpoint, "tracing.endpoint");
    secrets = { base, url: exportUrl("otlp", base), headers: Object.fromEntries(names.map((n) => [n.toLowerCase(), headers[n]])) };
  } else if (input.type === "langfuse") {
    const pk = input.public_key ?? old?.public_key;
    const sk = input.secret_key ?? old?.secret_key;
    if (!pk || !sk) fail(400, "tracing.public_key and tracing.secret_key are required for a Langfuse destination.", "invalid_tracing_destination");
    const base = checkUrl(input.host ?? old?.base ?? DEFAULT_HOST.langfuse, "tracing.host");
    secrets = { base, url: exportUrl("langfuse", base), headers: { authorization: "Basic " + Buffer.from(`${pk}:${sk}`).toString("base64") }, public_key: pk, secret_key: sk };
  } else {
    const key = input.api_key ?? old?.api_key;
    if (!key) fail(400, "tracing.api_key is required for a Helicone destination.", "invalid_tracing_destination");
    const base = checkUrl(input.host ?? old?.base ?? DEFAULT_HOST.helicone, "tracing.host");
    secrets = { base, url: exportUrl("helicone", base), headers: { authorization: "Bearer " + key }, api_key: key };
  }
  return {
    v: 1,
    type: input.type,
    enabled: input.enabled ?? prev?.enabled ?? true,
    include_content: input.include_content ?? (prev?.type === input.type ? prev.include_content : false),
    target: maskWebhookUrl(secrets.url),
    header_names: Object.keys(secrets.headers),
    public_key_hint: secrets.public_key ? hint(secrets.public_key) : null,
    sealed: encrypt(appSecret, JSON.stringify(secrets)),
    updated_at: now.toISOString(),
  };
}

export function parseStoredTracing(v: unknown): StoredTracing | null {
  const t = v as StoredTracing | null;
  return t && t.v === 1 && TRACING_TYPES.includes(t.type) && typeof t.sealed === "string" ? t : null;
}

/** The API view: no URL path, no header value, no secret. */
export function tracingJson(v: unknown, status?: DestinationStats | null) {
  const t = parseStoredTracing(v);
  if (!t) return null;
  return {
    type: t.type,
    enabled: t.enabled,
    include_content: t.include_content,
    target: t.target,
    header_names: t.header_names,
    ...(t.type === "langfuse" ? { public_key_hint: t.public_key_hint } : {}),
    secrets_set: true,
    updated_at: t.updated_at,
    ...(status !== undefined ? { status } : {}),
  };
}

// ---------- the span ----------

/** One call, as exported. Built only for public-lane calls. */
export type TraceRecord = {
  generationId: string;
  startMs: number;
  endMs: number;
  /** From the caller's W3C traceparent, so the span joins the caller's own trace. */
  traceId?: string;
  parentSpanId?: string;
  operation: "chat" | "text_completion";
  provider: string;
  requestModel: string;
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  finishReasons: string[];
  costUsd: number;
  timeToFirstTokenMs?: number;
  mode: string;
  streamed: boolean;
  attempts: number;
  error?: string;
  /** Present only when the destination has include_content: true. */
  input?: unknown;
  output?: string;
};

/** The privacy gate: only a public-lane call may be exported, whatever the key says. */
export function shouldExportTrace(o: { lane: string; privateLaneRequest: boolean; privateRoute: boolean }) {
  return o.lane === "public" && !o.privateLaneRequest && !o.privateRoute;
}

export function parseTraceparent(h: string | null | undefined) {
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec((h ?? "").trim());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return {};
  return { traceId: m[1], parentSpanId: m[2] };
}

type Attr = string | number | boolean | string[];
const otlpValue = (v: Attr): Record<string, unknown> =>
  Array.isArray(v) ? { arrayValue: { values: v.map((s) => ({ stringValue: s })) } } : typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

/** OpenTelemetry GenAI semantic-convention attributes for one call. */
export function genAiAttributes(r: TraceRecord): Record<string, Attr> {
  const a: Record<string, Attr | undefined> = {
    "gen_ai.system": r.provider,
    "gen_ai.operation.name": r.operation,
    "gen_ai.request.model": r.requestModel,
    "gen_ai.response.model": r.responseModel,
    "gen_ai.response.id": r.generationId,
    "gen_ai.usage.input_tokens": r.inputTokens,
    "gen_ai.usage.output_tokens": r.outputTokens,
    "gen_ai.request.temperature": r.temperature,
    "gen_ai.request.top_p": r.topP,
    "gen_ai.request.max_tokens": r.maxTokens,
    "gen_ai.response.finish_reasons": r.finishReasons,
    "server.address": "anyroute",
    "anyroute.cost_usd": r.costUsd,
    "anyroute.receipt_id": r.generationId,
    "anyroute.lane": "public",
    "anyroute.provider": r.provider,
    "anyroute.mode": r.mode,
    "anyroute.streamed": r.streamed,
    "anyroute.attempts": r.attempts,
    "anyroute.server_latency_ms": Math.max(0, Math.round(r.endMs - r.startMs)),
    "anyroute.time_to_first_token_ms": r.timeToFirstTokenMs != null ? Math.round(r.timeToFirstTokenMs) : undefined,
    "gen_ai.input.messages": r.input !== undefined ? JSON.stringify(r.input) : undefined,
    "gen_ai.output.messages": r.output !== undefined ? JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: r.output }], finish_reason: r.finishReasons[0] ?? null }]) : undefined,
  };
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== null)) as Record<string, Attr>;
}

export function otlpBody(records: TraceRecord[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "anyroute" } }] },
        scopeSpans: [
          {
            scope: { name: "anyroute.tracing", version: "1" },
            spans: records.map((r) => ({
              traceId: r.traceId ?? randomBytes(16).toString("hex"),
              spanId: randomBytes(8).toString("hex"),
              ...(r.parentSpanId ? { parentSpanId: r.parentSpanId } : {}),
              name: `${r.operation} ${r.requestModel}`,
              kind: 3, // CLIENT
              startTimeUnixNano: nanos(r.startMs),
              endTimeUnixNano: nanos(r.endMs),
              attributes: Object.entries(genAiAttributes(r)).map(([key, v]) => ({ key, value: otlpValue(v) })),
              status: r.error ? { code: 2, message: r.error } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

/** Langfuse public ingestion API: a trace and its generation per call. */
export function langfuseBody(records: TraceRecord[]) {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    batch: records.flatMap((r) => {
      const traceId = r.traceId ?? r.generationId;
      const metadata = { receipt_id: r.generationId, lane: "public", provider: r.provider, mode: r.mode, streamed: r.streamed, attempts: r.attempts, finish_reasons: r.finishReasons, server_latency_ms: Math.round(r.endMs - r.startMs) };
      const content = { ...(r.input !== undefined ? { input: r.input } : {}), ...(r.output !== undefined ? { output: r.output } : {}) };
      const params = Object.fromEntries(Object.entries({ temperature: r.temperature, top_p: r.topP, max_tokens: r.maxTokens }).filter(([, v]) => v != null));
      return [
        { id: randomUUID(), timestamp: iso(r.endMs), type: "trace-create", body: { id: traceId, timestamp: iso(r.startMs), name: `${r.operation} ${r.requestModel}`, tags: ["anyroute"], metadata, ...content } },
        {
          id: randomUUID(),
          timestamp: iso(r.endMs),
          type: "generation-create",
          body: {
            id: r.generationId,
            traceId,
            name: `${r.operation} ${r.requestModel}`,
            startTime: iso(r.startMs),
            endTime: iso(r.endMs),
            ...(r.timeToFirstTokenMs != null ? { completionStartTime: iso(r.startMs + r.timeToFirstTokenMs) } : {}),
            model: r.responseModel,
            modelParameters: params,
            usageDetails: { input: r.inputTokens, output: r.outputTokens, total: r.inputTokens + r.outputTokens },
            costDetails: { total: r.costUsd },
            metadata,
            level: r.error ? "ERROR" : "DEFAULT",
            ...(r.error ? { statusMessage: r.error } : {}),
            ...content,
          },
        },
      ];
    }),
  };
}

/** Helicone custom-model log API: one request/response pair per call. */
export function heliconeBody(r: TraceRecord) {
  const t = (ms: number) => ({ seconds: Math.floor(ms / 1000), milliseconds: Math.round(ms % 1000) });
  return {
    providerRequest: {
      url: "anyroute",
      json: { model: r.requestModel, ...(r.temperature != null ? { temperature: r.temperature } : {}), ...(r.maxTokens != null ? { max_tokens: r.maxTokens } : {}), ...(r.input !== undefined ? { messages: r.input } : {}) },
      meta: { "Helicone-Property-Anyroute-Receipt": r.generationId, "Helicone-Property-Anyroute-Provider": r.provider, "Helicone-Property-Anyroute-Lane": "public" },
    },
    providerResponse: {
      json: {
        id: r.generationId,
        model: r.responseModel,
        usage: { prompt_tokens: r.inputTokens, completion_tokens: r.outputTokens, total_tokens: r.inputTokens + r.outputTokens, cost: r.costUsd },
        choices: [{ index: 0, finish_reason: r.finishReasons[0] ?? null, ...(r.output !== undefined ? { message: { role: "assistant", content: r.output } } : {}) }],
      },
      status: r.error ? 500 : 200,
      headers: {},
    },
    timing: { startTime: t(r.startMs), endTime: t(r.endMs) },
  };
}

// ---------- the exporter ----------

export type DestinationStats = {
  queued: number;
  exported: number;
  dropped: number;
  failed: number;
  retries: number;
  circuit: "closed" | "open" | "half_open";
  last_error: string | null;
  last_success_at: string | null;
};

export type TracingOptions = {
  /** Spans held in memory across all destinations; more are dropped and counted. */
  queueMax?: number;
  batchMax?: number;
  flushMs?: number;
  /** Retries after the first attempt of a batch. */
  retries?: number;
  backoffMs?: number;
  /** Consecutive failed batches that open the circuit, and how long it stays open. */
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  timeoutMs?: number;
  now?: () => number;
  resolve?: Resolve;
  /** Replaces the network transport (tests). The URL is still checked first. */
  send?: (url: string, init: RequestInit) => Promise<Response>;
};

type Destination = { type: TracingType; url: string; headers: Record<string, string> };
type Lane = { dest: Destination; items: TraceRecord[]; inflight: Promise<void> | null; stats: DestinationStats; failures: number; openUntil: number };

const RETRYABLE = (status: number) => status === 408 || status === 429 || status >= 500;

export class TracingExporter {
  private lanes = new Map<string, Lane>();
  private queued = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private opened = new Map<string, Destination>(); // sealed -> decrypted, so a busy key decrypts once
  readonly totals = { enqueued: 0, exported: 0, dropped: 0, failed: 0 };
  private o: Required<Omit<TracingOptions, "resolve" | "send">> & Pick<TracingOptions, "resolve" | "send">;

  constructor(private appSecret: string, opts: TracingOptions = {}) {
    this.o = {
      queueMax: opts.queueMax ?? 2_000,
      batchMax: opts.batchMax ?? 50,
      flushMs: opts.flushMs ?? 1_000,
      retries: opts.retries ?? 3,
      backoffMs: opts.backoffMs ?? 500,
      breakerThreshold: opts.breakerThreshold ?? 5,
      breakerCooldownMs: opts.breakerCooldownMs ?? 60_000,
      timeoutMs: opts.timeoutMs ?? 5_000,
      now: opts.now ?? Date.now,
      resolve: opts.resolve,
      send: opts.send,
    };
  }

  /** Test hook: change options in place (transport, backoff, clock). */
  configure(opts: TracingOptions) {
    Object.assign(this.o, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)));
  }

  private lane(id: string, dest: Destination) {
    let l = this.lanes.get(id);
    if (!l) {
      l = { dest, items: [], inflight: null, stats: { queued: 0, exported: 0, dropped: 0, failed: 0, retries: 0, circuit: "closed", last_error: null, last_success_at: null }, failures: 0, openUntil: 0 };
      this.lanes.set(id, l);
    }
    l.dest = dest;
    return l;
  }

  private open(stored: StoredTracing): Destination | null {
    const hit = this.opened.get(stored.sealed);
    if (hit) return hit;
    try {
      const s = JSON.parse(decrypt(this.appSecret, stored.sealed)) as Secrets;
      const d = { type: stored.type, url: s.url, headers: s.headers };
      if (this.opened.size > 1_000) this.opened.clear();
      this.opened.set(stored.sealed, d);
      return d;
    } catch {
      return null;
    }
  }

  /** Queue one call for export. Synchronous, never throws, never waits: returns whether it was queued. */
  enqueue(id: string, tracing: unknown, record: TraceRecord): boolean {
    try {
      const stored = parseStoredTracing(tracing);
      if (!stored || !stored.enabled) return false;
      const dest = this.open(stored);
      if (!dest) return false;
      const l = this.lane(id, dest);
      if (!stored.include_content) {
        delete record.input;
        delete record.output;
      }
      this.totals.enqueued++;
      if (this.circuit(l) === "open" || this.queued >= this.o.queueMax) {
        l.stats.dropped++;
        this.totals.dropped++;
        return false;
      }
      l.items.push(record);
      l.stats.queued = l.items.length;
      this.queued++;
      this.start();
      if (l.items.length >= this.o.batchMax) this.pump(l);
      return true;
    } catch {
      return false;
    }
  }

  private circuit(l: Lane): DestinationStats["circuit"] {
    if (l.failures < this.o.breakerThreshold) return "closed";
    return this.o.now() < l.openUntil ? "open" : "half_open";
  }

  stats(id: string): DestinationStats | null {
    const l = this.lanes.get(id);
    if (!l) return null;
    return { ...l.stats, queued: l.items.length, circuit: this.circuit(l) };
  }

  private start() {
    if (this.timer || this.o.flushMs <= 0) return;
    this.timer = setInterval(() => this.tick(), this.o.flushMs);
    this.timer.unref?.();
  }

  private tick() {
    for (const l of this.lanes.values()) if (l.items.length) this.pump(l);
  }

  private pump(l: Lane) {
    if (l.inflight) return;
    l.inflight = (async () => {
      try {
        while (l.items.length) {
          if (this.circuit(l) === "open") {
            // The destination is switched off: what is queued for it is dropped and counted.
            l.stats.dropped += l.items.length;
            this.totals.dropped += l.items.length;
            this.queued -= l.items.length;
            l.items = [];
            break;
          }
          const batch = l.items.splice(0, this.o.batchMax);
          this.queued -= batch.length;
          const ok = await this.deliver(l, batch);
          if (ok) {
            l.failures = 0;
            l.stats.exported += batch.length;
            this.totals.exported += batch.length;
            l.stats.last_success_at = new Date(this.o.now()).toISOString();
          } else {
            l.failures++;
            if (l.failures >= this.o.breakerThreshold) l.openUntil = this.o.now() + this.o.breakerCooldownMs;
            l.stats.failed += batch.length;
            this.totals.failed += batch.length;
          }
        }
      } finally {
        l.stats.queued = l.items.length;
        l.inflight = null;
      }
    })();
  }

  /** Send a batch with retries and exponential backoff. A half-open circuit gets one attempt. */
  private async deliver(l: Lane, batch: TraceRecord[]): Promise<boolean> {
    const attempts = this.circuit(l) === "half_open" ? 1 : 1 + this.o.retries;
    const bodies: unknown[] = l.dest.type === "otlp" ? [otlpBody(batch)] : l.dest.type === "langfuse" ? [langfuseBody(batch)] : batch.map(heliconeBody);
    let pending = bodies;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        l.stats.retries++;
        await sleep(this.o.backoffMs * 2 ** (i - 1));
      }
      const left: unknown[] = [];
      let retry = false;
      for (const body of pending) {
        const r = await this.post(l.dest, body);
        if (r.ok) continue;
        l.stats.last_error = r.error;
        if (!r.retryable) return false;
        retry = true;
        left.push(body);
      }
      if (!retry) return true;
      pending = left;
    }
    return false;
  }

  private async post(dest: Destination, body: unknown): Promise<{ ok: boolean; retryable: boolean; error: string }> {
    if (webhookUrlProblem(dest.url)) return { ok: false, retryable: false, error: "destination_blocked" };
    const init: RequestInit = {
      method: "POST",
      headers: { ...dest.headers, "content-type": "application/json", "user-agent": "Anyroute-Tracing/1" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.o.timeoutMs),
    };
    try {
      const res = this.o.send ? await this.o.send(dest.url, init) : await providerFetch(dest.url, init, { production: true, resolve: this.o.resolve });
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return { ok: true, retryable: false, error: "" };
      return { ok: false, retryable: RETRYABLE(res.status), error: `http_${res.status}` };
    } catch (e) {
      const name = (e as Error)?.name;
      const message = String((e as Error)?.message ?? "");
      if (/non-public address|must use HTTPS|redirects are disabled/.test(message)) return { ok: false, retryable: false, error: "destination_blocked" };
      return { ok: false, retryable: true, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    }
  }

  /** Send everything queued now and wait for it (tests, shutdown). */
  async drain() {
    for (let guard = 0; guard < 1_000; guard++) {
      this.tick();
      const busy = [...this.lanes.values()].map((l) => l.inflight).filter(Boolean);
      if (!busy.length) return;
      await Promise.all(busy);
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drain().catch((e) => log.warn("tracing drain failed", { error: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
}

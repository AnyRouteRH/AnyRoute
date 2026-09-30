// A fake router behind `fetch`: scripted replies, streamed as server-sent events, with a gate to hold the stream
// open (for Stop) and the abort signal honoured the way a browser does.

import type { FetchLike } from "../src";

export type Reply =
  | { kind: "stream"; chunks: unknown[]; hold?: boolean; headers?: Record<string, string> }
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> };

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export const sse = (ev: unknown) => `data: ${JSON.stringify(ev)}\n\n`;

export const textChunks = (text: string, receiptId = "rcpt_1", model = "vendor/model-a") => [
  ...text.split(/(?<= )/).map((part) => ({ model, provider: "relay", choices: [{ index: 0, delta: { content: part } }] })),
  { model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.0001 }, receipt: { id: receiptId, payload: { disclosure: "none" }, v2: { claims: { lane: "attested" } } } },
];

export function fakeFetch(routes: Record<string, Reply[] | ((call: Call) => Reply)>) {
  const calls: Call[] = [];
  const gates: (() => void)[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const fetch: FetchLike = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const call: Call = { url, method: init.method ?? "GET", headers, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const key = [...queues.keys()].find((k) => new URL(url, "http://localhost").pathname === k);
    if (!key) return new Response(JSON.stringify({ error: { code: 404, message: "Not found" } }), { status: 404 });
    const q = queues.get(key)!;
    const reply = typeof q === "function" ? q(call) : q.shift();
    if (!reply) throw new Error(`no scripted reply left for ${key}`);
    if (reply.kind === "json") return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json", ...(reply.headers ?? {}) } });
    const signal = init.signal;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const abort = () => {
          try {
            ctrl.error(new DOMException("The operation was aborted.", "AbortError"));
          } catch {
            /* already closed */
          }
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort);
        const [first, ...rest] = reply.chunks;
        if (first !== undefined) ctrl.enqueue(enc.encode(sse(first)));
        if (reply.hold) await new Promise<void>((resolve) => gates.push(resolve));
        if (signal?.aborted) return;
        for (const c of rest) ctrl.enqueue(enc.encode(sse(c)));
        ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
        ctrl.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-anyroute-lane": "attested", "x-receipt-id": "rcpt_1", ...(reply.headers ?? {}) } });
  }) as FetchLike;
  return { fetch, calls, release: () => gates.splice(0).forEach((g) => g()) };
}

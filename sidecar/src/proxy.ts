import { createHash } from "node:crypto";
import type { Runtime } from "./boot.ts";
import { buildUpstreamHeaders, pickResponseHeaders } from "./headers.ts";
import { encodeReceiptHeader, newReceiptId, normalizeUsage, type ReceiptEnvelope, type ReceiptPayload, type Usage } from "./receipts.ts";
import { baseHeaders, errorResponse } from "./respond.ts";
import { SseScanner } from "./sse.ts";

// The inference proxy for /v1/chat/completions and /v1/embeddings.
//
// The client's request body is forwarded byte for byte, so req_hash in the receipt is the hash of exactly what
// the client sent and exactly what the model server received. Request headers are forwarded by allow-list (see
// headers.ts): no client address, forwarding header, cookie or client credential reaches the model server, and
// the sidecar never reads the peer address of the connection at all.

export type Caller = { keyId: string };

const sha = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** Read an upstream body up to a cap; null when it is larger. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

type Ctx = {
  rt: Runtime;
  caller: Caller;
  path: string;
  id: string;
  reqHash: string;
};

function makeReceipt(c: Ctx, o: { status: number; stream: boolean; complete: boolean; respHash: string; usage: Usage | null }): ReceiptEnvelope {
  const payload: ReceiptPayload = {
    v: 1,
    type: "anyroute.sidecar.receipt",
    id: c.id,
    ts: Date.now(),
    path: c.path,
    status: o.status,
    stream: o.stream,
    complete: o.complete,
    req_hash: c.reqHash,
    resp_hash: o.respHash,
    model_digest: c.rt.model.digest,
    attestation_ref: c.rt.attestationRef,
    nullifier: "",
    usage: o.usage,
    dev: c.rt.dev,
  };
  const env = c.rt.signer.sign(payload);
  c.rt.queue.push(env);
  c.rt.receiptIndex.add(c.caller.keyId, env);
  return env;
}

export async function handleInference(rt: Runtime, req: Request, path: string, caller: Caller): Promise<Response> {
  if (req.method !== "POST") return errorResponse(rt, 405, "method_not_allowed", "use POST", { allow: "POST" });
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(ctype)) return errorResponse(rt, 415, "unsupported_media_type", "content-type must be application/json");

  const admission = rt.quota.admit(caller.keyId);
  if (!admission.ok) {
    return errorResponse(rt, 429, "rate_limit_exceeded", "quota exceeded for this key", { "retry-after": String(admission.retryAfterSec) });
  }

  const body = await readBodyCapped(req, rt.cfg.upstream.maxRequestBytes);
  if (!body) return errorResponse(rt, 413, "request_too_large", `request body exceeds ${rt.cfg.upstream.maxRequestBytes} bytes`);
  let parsed: Record<string, unknown>;
  try {
    const v = JSON.parse(Buffer.from(body).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    parsed = v as Record<string, unknown>;
  } catch {
    return errorResponse(rt, 400, "invalid_json", "request body must be a JSON object");
  }
  const served = rt.cfg.model.servedName;
  if (served && parsed.model !== served) return errorResponse(rt, 404, "model_not_found", `this endpoint serves "${served}" only`);

  const ctx: Ctx = { rt, caller, path, id: newReceiptId(), reqHash: sha(body) };
  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  req.signal.addEventListener("abort", onClientAbort, { once: true });
  const cleanup = () => req.signal.removeEventListener("abort", onClientAbort);
  const timer = setTimeout(() => ac.abort(), rt.cfg.upstream.timeoutMs);

  let up: Response;
  try {
    up = await rt.fetchImpl(`${rt.cfg.upstream.baseUrl}${path}`, {
      method: "POST",
      headers: buildUpstreamHeaders(req.headers, { forwardHeaders: rt.cfg.upstream.forwardHeaders, upstreamApiKey: rt.upstreamApiKey }),
      body,
      redirect: "error",
      signal: ac.signal,
    });
  } catch {
    clearTimeout(timer);
    cleanup();
    return errorResponse(rt, 502, "upstream_unavailable", "the model server did not respond");
  }

  const upType = (up.headers.get("content-type") ?? "").toLowerCase();
  if (up.ok && upType.startsWith("text/event-stream") && up.body) {
    clearTimeout(timer); // streams are bounded by the idle timeout and the response size cap instead
    return streamResponse(ctx, up, ac, cleanup);
  }

  // Buffered response (JSON, or an upstream error).
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(up.body, rt.cfg.upstream.maxResponseBytes);
  } catch {
    clearTimeout(timer);
    cleanup();
    return errorResponse(rt, 502, "upstream_unavailable", "the model server closed the connection early");
  }
  clearTimeout(timer);
  cleanup();
  if (!bytes) return errorResponse(rt, 502, "upstream_response_too_large", `the model server's response exceeds ${rt.cfg.upstream.maxResponseBytes} bytes`);

  const headers = baseHeaders(rt);
  for (const [k, v] of pickResponseHeaders(up.headers)) headers.set(k, v);
  if (!up.ok) return new Response(bytes, { status: up.status, headers }); // errors are passed through, without a receipt

  let usage: Usage | null = null;
  if (upType.includes("json")) {
    try {
      usage = normalizeUsage((JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>).usage);
    } catch {
      usage = null;
    }
  }
  const env = makeReceipt(ctx, { status: up.status, stream: false, complete: true, respHash: sha(bytes), usage });
  if (usage) rt.quota.charge(caller.keyId, usage.total_tokens);
  headers.set("x-anyroute-receipt-id", ctx.id);
  headers.set("x-anyroute-receipt", encodeReceiptHeader(env));
  return new Response(bytes, { status: up.status, headers });
}

/**
 * GET /v1/models: the model server's own list, passed through so a router can discover and health-check the
 * endpoint. Nothing is generated, so there is no receipt and no quota charge; the same header allow-lists and
 * response size cap apply as for inference.
 */
export async function handleModels(rt: Runtime, req: Request): Promise<Response> {
  let up: Response;
  try {
    up = await rt.fetchImpl(`${rt.cfg.upstream.baseUrl}/v1/models`, {
      method: "GET",
      headers: buildUpstreamHeaders(req.headers, { forwardHeaders: rt.cfg.upstream.forwardHeaders, upstreamApiKey: rt.upstreamApiKey }),
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(rt.cfg.upstream.timeoutMs, 30_000)),
    });
  } catch {
    return errorResponse(rt, 502, "upstream_unavailable", "the model server did not respond");
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(up.body, rt.cfg.upstream.maxResponseBytes);
  } catch {
    return errorResponse(rt, 502, "upstream_unavailable", "the model server closed the connection early");
  }
  if (!bytes) return errorResponse(rt, 502, "upstream_response_too_large", `the model server's response exceeds ${rt.cfg.upstream.maxResponseBytes} bytes`);
  const headers = baseHeaders(rt);
  for (const [k, v] of pickResponseHeaders(up.headers)) headers.set(k, v);
  return new Response(bytes, { status: up.status, headers });
}

/** Everything after the `[DONE]` line is ours: one named event with the signed receipt. */
export const RECEIPT_EVENT = "anyroute.receipt";
const receiptEvent = (env: ReceiptEnvelope, prefixBoundary: boolean) =>
  new TextEncoder().encode(`${prefixBoundary ? "\n\n" : ""}event: ${RECEIPT_EVENT}\ndata: ${JSON.stringify(env)}\n\n`);

function streamResponse(c: Ctx, up: Response, ac: AbortController, cleanup: () => void): Response {
  const { rt } = c;
  const reader = up.body!.getReader();
  const hash = createHash("sha256");
  const scan = new SseScanner();
  const idleMs = rt.cfg.upstream.streamIdleTimeoutMs;
  const maxBytes = rt.cfg.upstream.maxResponseBytes;
  let total = 0;
  let finished = false;

  const finish = (complete: boolean): ReceiptEnvelope => {
    finished = true;
    cleanup();
    const usage = normalizeUsage(scan.usage);
    const env = makeReceipt(c, { status: up.status, stream: true, complete, respHash: `sha256:${hash.digest("hex")}`, usage });
    // Token accounting: the reported usage, else a rough count of completion chunks so a stream cannot dodge the token quota.
    rt.quota.charge(c.caller.keyId, usage?.total_tokens ?? scan.chunks);
    return env;
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let complete = false;
      try {
        const r = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("idle")), idleMs);
          }),
        ]);
        clearTimeout(timer);
        if (!r.done) {
          total += r.value.length;
          if (total <= maxBytes) {
            hash.update(r.value);
            scan.feed(r.value);
            controller.enqueue(r.value);
            return;
          }
          ac.abort(); // over the size cap: end the stream as incomplete
        } else {
          complete = scan.done && !scan.sawError;
        }
      } catch {
        clearTimeout(timer);
        ac.abort();
      }
      const env = finish(complete);
      controller.enqueue(receiptEvent(env, !scan.endsOnBoundary));
      controller.close();
    },
    cancel() {
      ac.abort();
      if (!finished) finish(false); // the client went away: still record what was served
    },
  });

  const headers = baseHeaders(rt);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-store");
  headers.set("x-accel-buffering", "no");
  headers.set("x-anyroute-receipt-id", c.id);
  return new Response(body, { status: up.status, headers });
}

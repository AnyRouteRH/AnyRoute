import { createHash } from "node:crypto";
import type { Runtime } from "./boot.ts";
import type { Verdict } from "./classifier.ts";
import { buildUpstreamHeaders, pickResponseHeaders } from "./headers.ts";
import { HPKE_CONTENT_TYPE, HPKE_STREAM_CONTENT_TYPE, HpkeError, type HpkeResponder } from "./hpke.ts";
import { encodeReceiptHeader, newReceiptId, normalizeUsage, type ReceiptEnvelope, type ReceiptPayload, type Usage } from "./receipts.ts";
import { baseHeaders, errorResponse, markRefusal } from "./respond.ts";
import { SseScanner } from "./sse.ts";
import type { Tally } from "./stats.ts";

// The inference proxy for /v1/chat/completions and /v1/embeddings.
//
// The client's request body is forwarded byte for byte, so req_hash in the receipt is the hash of exactly what
// the client sent and exactly what the model server received. Request headers are forwarded by allow-list (see
// headers.ts): no client address, forwarding header, cookie or client credential reaches the model server, and
// the sidecar never reads the peer address of the connection at all.
//
// Two optional layers wrap that path, both off unless configured:
//   * end-to-end encryption (hpke.ts): a request with content-type application/anyroute-hpke is opened inside
//     this process, and whatever the model server returns is encrypted back to the caller. In that mode req_hash
//     and resp_hash are hashes of the encrypted bytes, and no client header is forwarded.
//   * the hard-block classifier (classifier.ts): the request text is checked before anything is forwarded, and
//     optionally the response text before anything is returned. A hit refuses the exchange with a generic error and
//     a receipt carrying one bit; an unusable answer refuses it too.

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
  /** Set when the request arrived encrypted: the response goes back encrypted with it. */
  responder: HpkeResponder | null;
  /** This request's contribution to the private counters. */
  tally?: Tally;
};

function makeReceipt(c: Ctx, o: { status: number; stream: boolean; complete: boolean; respHash: string; usage: Usage | null; blocked?: boolean }): ReceiptEnvelope {
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
    ...(c.rt.classifier ? { classifier: { enabled: true as const, digest: c.rt.classifier.digest, blocked: o.blocked ?? false } } : {}),
    ...(c.responder ? { e2ee: "anyroute-hpke-v1" as const } : {}),
  };
  const env = c.rt.signer.sign(payload);
  c.rt.queue.push(env);
  c.rt.receiptIndex.add(c.caller.keyId, env);
  return env;
}

const REFUSAL_MESSAGE = { request: "the request was declined by this endpoint's content policy", response: "the response was withheld by this endpoint's content policy" };

/** Sidecar-made error with a signed receipt carrying the classifier bit. The body names no category. */
function blockedResponse(c: Ctx, phase: "request" | "response", usage: Usage | null): Response {
  const bytes = new TextEncoder().encode(JSON.stringify({ error: { message: REFUSAL_MESSAGE[phase], type: "invalid_request_error", code: "content_policy_violation" } }));
  const env = makeReceipt(c, { status: 400, stream: false, complete: true, respHash: sha(bytes), usage, blocked: true });
  const headers = baseHeaders(c.rt);
  headers.set("content-type", "application/json");
  headers.set("x-anyroute-receipt-id", c.id);
  headers.set("x-anyroute-receipt", encodeReceiptHeader(env));
  return markRefusal(new Response(bytes, { status: 400, headers }), `content_${phase}`);
}

/** The classifier gave no usable answer: nothing is forwarded and nothing is released. */
const checkUnavailable = (rt: Runtime, phase: "request" | "response") =>
  errorResponse(rt, 503, "content_check_unavailable", `the content check is unavailable; the ${phase} was not ${phase === "request" ? "processed" : "released"}`, { "retry-after": "5" });

/** Turn a non-allow verdict into the response that ends the exchange, or null for allow. */
function verdictResponse(c: Ctx, v: Verdict, phase: "request" | "response", usage: Usage | null): Response | null {
  switch (v) {
    case "allow":
      return null;
    case "blocked":
      return blockedResponse(c, phase, usage);
    case "unsupported":
      return errorResponse(c.rt, 400, "unsupported_input", "this endpoint cannot check non-text input, so it does not accept it");
    case "too_large":
      return errorResponse(c.rt, 413, "content_too_large", "there is more text than the content check will examine");
  }
}

const HPKE_ERRORS: Record<HpkeError["reason"], { status: number; code: string }> = {
  malformed: { status: 400, code: "invalid_encryption" },
  expired: { status: 400, code: "request_expired" },
  replayed: { status: 400, code: "request_replayed" },
  decryption_failed: { status: 400, code: "decryption_failed" },
};

export async function handleInference(rt: Runtime, req: Request, path: string, caller: Caller, tally?: Tally): Promise<Response> {
  if (req.method !== "POST") return errorResponse(rt, 405, "method_not_allowed", "use POST", { allow: "POST" });
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  const encrypted = rt.hpke !== null && /^application\/anyroute-hpke\s*(;|$)/.test(ctype);
  if (!encrypted && !/^application\/json\s*(;|$)/.test(ctype)) {
    return errorResponse(rt, 415, "unsupported_media_type", rt.hpke ? `content-type must be application/json or ${HPKE_CONTENT_TYPE}` : "content-type must be application/json");
  }

  const admission = rt.quota.admit(caller.keyId);
  if (!admission.ok) {
    return errorResponse(rt, 429, "rate_limit_exceeded", "quota exceeded for this key", { "retry-after": String(admission.retryAfterSec) });
  }

  const wire = await readBodyCapped(req, rt.cfg.upstream.maxRequestBytes);
  if (!wire) return errorResponse(rt, 413, "request_too_large", `request body exceeds ${rt.cfg.upstream.maxRequestBytes} bytes`);
  // What the client sent: the body itself, or (encrypted) the encrypted body, which the client can hash too.
  const reqHash = sha(wire);
  let body: Uint8Array = wire;
  let responder: HpkeResponder | null = null;
  if (encrypted) {
    try {
      const opened = await rt.hpke!.open(wire, path);
      body = opened.plaintext;
      responder = opened.responder;
    } catch (e) {
      if (!(e instanceof HpkeError)) throw e;
      const { status, code } = HPKE_ERRORS[e.reason];
      return errorResponse(rt, status, code, e.message);
    }
  }
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

  const ctx: Ctx = { rt, caller, path, id: newReceiptId(), reqHash, responder, tally };

  if (rt.classifier) {
    let verdict: Verdict;
    try {
      verdict = await rt.classifier.checkRequest(parsed);
    } catch {
      return checkUnavailable(rt, "request"); // fail closed: nothing has been forwarded
    }
    const refusal = verdictResponse(ctx, verdict, "request", null);
    if (refusal) return refusal;
  }

  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  req.signal.addEventListener("abort", onClientAbort, { once: true });
  const cleanup = () => req.signal.removeEventListener("abort", onClientAbort);
  const timer = setTimeout(() => ac.abort(), rt.cfg.upstream.timeoutMs);

  let up: Response;
  try {
    up = await rt.fetchImpl(`${rt.cfg.upstream.baseUrl}${path}`, {
      method: "POST",
      // Encrypted: the outer headers are not covered by the encryption, so none of them is passed on.
      headers: buildUpstreamHeaders(encrypted ? new Headers() : req.headers, { forwardHeaders: rt.cfg.upstream.forwardHeaders, upstreamApiKey: rt.upstreamApiKey }),
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
    if (rt.classifier?.checkResponses && path === "/v1/chat/completions") return checkedStream(ctx, up, ac, cleanup);
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
  if (encrypted) {
    // Everything that came from the model server, errors included, goes back encrypted.
    if (upType) headers.set("x-anyroute-inner-content-type", upType);
    headers.set("content-type", HPKE_CONTENT_TYPE);
  }
  if (!up.ok) return new Response(encrypted ? responder!.sealOnce(bytes) : bytes, { status: up.status, headers }); // errors are passed through, without a receipt

  let usage: Usage | null = null;
  let json: unknown = null;
  if (upType.includes("json")) {
    try {
      json = JSON.parse(Buffer.from(bytes).toString("utf8"));
      usage = normalizeUsage((json as Record<string, unknown>).usage);
    } catch {
      usage = null;
    }
  }
  if (rt.classifier?.checkResponses && path === "/v1/chat/completions") {
    // Examined in the clear, before anything is sent. The model server already ran, so its usage is charged.
    let verdict: Verdict;
    try {
      verdict = await rt.classifier.checkResponse(json ?? Buffer.from(bytes).toString("utf8"));
    } catch {
      return checkUnavailable(rt, "response");
    }
    if (verdict !== "allow" && usage) rt.quota.charge(caller.keyId, usage.total_tokens);
    if (verdict !== "allow") tally?.tokens(usage?.total_tokens);
    const refusal = verdictResponse(ctx, verdict, "response", usage);
    if (refusal) return refusal;
  }
  const out = encrypted ? responder!.sealOnce(bytes) : bytes;
  const env = makeReceipt(ctx, { status: up.status, stream: false, complete: true, respHash: sha(out), usage });
  if (usage) rt.quota.charge(caller.keyId, usage.total_tokens);
  tally?.tokens(usage?.total_tokens);
  headers.set("x-anyroute-receipt-id", ctx.id);
  headers.set("x-anyroute-receipt", encodeReceiptHeader(env));
  return new Response(out, { status: up.status, headers });
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

/**
 * With response checking on, a stream cannot be released as it is generated: text that has been sent cannot be
 * taken back. The whole stream is read first, examined, and only then delivered (or replaced by the refusal), so
 * such a deployment trades time to first token for that guarantee.
 */
async function checkedStream(c: Ctx, up: Response, ac: AbortController, cleanup: () => void): Promise<Response> {
  const { rt } = c;
  const reader = up.body!.getReader();
  const parts: Uint8Array[] = [];
  const scan = new SseScanner(true);
  const idleMs = rt.cfg.upstream.streamIdleTimeoutMs;
  const max = rt.cfg.upstream.maxResponseBytes;
  let total = 0;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("idle")), idleMs);
        }),
      ]);
      clearTimeout(timer);
      if (r.done) break;
      total += r.value.length;
      if (total > max) throw new Error("too large");
      parts.push(r.value);
      scan.feed(r.value);
    }
  } catch {
    ac.abort();
    cleanup();
    return errorResponse(rt, 502, "upstream_unavailable", "the model server did not finish the stream");
  }
  scan.flush();
  const usage = normalizeUsage(scan.usage);
  let verdict: Verdict;
  try {
    verdict = scan.overflow ? "too_large" : await rt.classifier!.checkResponse(scan.events);
  } catch {
    cleanup();
    return checkUnavailable(rt, "response");
  }
  if (verdict !== "allow") {
    cleanup();
    rt.quota.charge(c.caller.keyId, usage?.total_tokens ?? scan.chunks);
    c.tally?.tokens(usage?.total_tokens ?? scan.chunks);
    return verdictResponse(c, verdict, "response", usage)!;
  }
  // Released: deliver the bytes as one piece through the ordinary stream path (hash, receipt event, framing).
  const released = new Response(new Uint8Array(Buffer.concat(parts)), { status: up.status, headers: up.headers });
  return streamResponse(c, released, ac, cleanup);
}

function streamResponse(c: Ctx, up: Response, ac: AbortController, cleanup: () => void): Response {
  const { rt } = c;
  const responder = c.responder;
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
    c.tally?.tokens(usage?.total_tokens ?? scan.chunks);
    c.tally?.finish(); // a stream records itself when it ends; the handler returned long before
    return env;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (responder) {
        hash.update(responder.prefix); // encrypted: the hash covers the bytes the client receives
        controller.enqueue(responder.prefix);
      }
    },
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
            scan.feed(r.value);
            const out = responder ? responder.frame(r.value, false) : r.value;
            hash.update(out);
            controller.enqueue(out);
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
      const tail = receiptEvent(env, !scan.endsOnBoundary);
      controller.enqueue(responder ? responder.frame(tail, true) : tail); // encrypted: the receipt is the last frame
      controller.close();
    },
    cancel() {
      ac.abort();
      if (!finished) finish(false); // the client went away: still record what was served
    },
  });

  const headers = baseHeaders(rt);
  headers.set("content-type", responder ? HPKE_STREAM_CONTENT_TYPE : "text/event-stream; charset=utf-8");
  if (responder) headers.set("x-anyroute-inner-content-type", "text/event-stream");
  headers.set("cache-control", "no-cache, no-store");
  headers.set("x-accel-buffering", "no");
  headers.set("x-anyroute-receipt-id", c.id);
  if (c.tally) c.tally.deferred = true;
  return new Response(body, { status: up.status, headers });
}

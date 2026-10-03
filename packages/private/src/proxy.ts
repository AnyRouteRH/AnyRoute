import { countMessageTokens, messageBudget } from "./messages.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Lease, TokenStore } from "./store.ts";
import type { TorFetch } from "./tor.ts";

// A local OpenAI-compatible server. Every call an app makes to it is rebuilt from scratch and sent to AnyRoute's onion
// service through the Tor client, on the unlinkable lane, paid with blind tokens.
//
//   - It listens on 127.0.0.1 only, and refuses a request whose Host or Origin says it came from a web page or from a
//     rebound name (so a page in your browser cannot spend your tokens).
//   - What is sent upstream is a fixed set of headers written here. Nothing the app sent is copied: not its API key
//     (an OpenAI key in OPENAI_API_KEY is discarded), user agent, cookies, referrer, SDK or tracing headers, or a
//     forwarded address. The body is passed on as it came, except that the OpenAI `user` field, which names an end
//     user, is removed.
//   - The token goes in `Authorization: PrivateToken token=...`, the lane in `X-Anyroute-Lane: unlinkable`. Each call
//     spends one token for OpenAI calls, or a budget-covering set for Messages (store.ts); with none left the call fails, and nothing is sent.
//   - There is no route to the router but Tor. A failure to reach it is an error to the app, never a retry elsewhere.
//
// What this does not hide: the router reads the prompt (it terminates the connection on this lane) and the provider
// gets what is in the request. What is hidden is who sent it and who paid.

export type ProxyOptions = {
  port: number;
  /** The router's onion hostname (56 characters and .onion). */
  onion: string;
  /** Reaches the onion service through Tor. */
  fetch: TorFetch;
  store: TokenStore;
  /** If set, the app must send it as its API key (Authorization: Bearer); it is never forwarded. */
  localKey?: string;
  /** Calls in flight at once; more get 429 with Retry-After. */
  maxConcurrent?: number;
  maxTokensPerRequest?: number;
  /** A call with no bytes from the router for this long is cut off. */
  idleTimeoutMs?: number;
  maxBodyBytes?: number;
  log?: (line: string) => void;
};
export type RunningProxy = { port: number; close(): Promise<void> };

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
/** The routes that spend a token, and where they go. */
const CALLS: Record<string, string> = { "/chat/completions": "/api/v1/chat/completions", "/embeddings": "/api/v1/embeddings", "/messages": "/v1/messages" };
/** Response headers passed to the app. Everything else the router sent stays here. */
const PASSED = /^(content-type|cache-control|retry-after|request-id|x-should-retry|www-authenticate|x-payment-response|x-generation-id|x-receipt-id|inference-id|x-request-id|x-ratelimit-[a-z-]+|x-anyroute-[a-z-]+)$/;
/** The router's answers (401, error.type) that mean this token is no good, whatever the request was. */
const DEAD_TOKEN = new Set(["token_spent", "invalid_token", "unknown_token_key", "token_key_revoked", "token_epoch_expired"]);
const MAX_TOKEN_TRIES = 3;

const digest = (s: string) => createHash("sha256").update(s).digest();

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return void res.destroy();
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

const failure = (res: http.ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  send(res, status, { error: { message, type: code, code } }, headers);

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) throw new HttpFailure(413, "request_too_large", `The request is larger than ${Math.floor(max / 1048576)} MiB.`);
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

/** Write a chunk, waiting if the app is slow to read; false once the app has gone. */
function write(res: http.ServerResponse, chunk: Uint8Array): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const drained = () => (res.off("close", closed), resolve(true));
    const closed = () => (res.off("drain", drained), resolve(false));
    res.once("drain", drained);
    res.once("close", closed);
  });
}

/** Up to `max` bytes of a body: enough for an error message, never a whole answer. */
async function readSmall(body: ReadableStream<Uint8Array> | null, max = 262_144): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts).subarray(0, max);
}

function errorType(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    const t = parsed.anyroute?.type ?? parsed.error?.type;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

function passedHeaders(from: Headers, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...extra };
  from.forEach((value, name) => {
    if (PASSED.test(name.toLowerCase())) out[name.toLowerCase()] = value;
  });
  return out;
}

/** An abort signal that fires when nothing has happened for `ms`, or when `stop` is called. */
function idleGuard(ms: number) {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new Error(`Nothing arrived from the router for ${Math.round(ms / 1000)} seconds.`)), ms);
  };
  poke();
  return { signal: ac.signal, poke, abort: (why: Error) => ac.abort(why), stop: () => clearTimeout(timer) };
}

export async function startProxy(o: ProxyOptions): Promise<RunningProxy> {
  const log = o.log ?? (() => undefined);
  const maxConcurrent = o.maxConcurrent ?? 8;
  const idleMs = o.idleTimeoutMs ?? 600_000;
  const maxBody = o.maxBodyBytes ?? 32 * 1048576;
  const localKey = o.localKey ? digest(o.localKey) : null;
  const estimateBudget = messageBudget(o.fetch, o.onion);
  let active = 0;
  let port = o.port;

  /** Relay the router's answer to the app, as it arrives. */
  async function pipe(res: http.ServerResponse, up: Response, guard: ReturnType<typeof idleGuard>, extra: Record<string, string> = {}) {
    const reader = up.body?.getReader();
    res.writeHead(up.status, passedHeaders(up.headers, extra));
    res.flushHeaders();
    if (!reader) return void res.end();
    res.once("close", () => void reader.cancel().catch(() => undefined));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        guard.poke();
        if (!(await write(res, value))) return;
      }
      res.end();
    } catch {
      // The connection to the router broke part-way: end the app's connection abruptly so it sees an error, not a short answer.
      res.destroy();
    }
  }

  async function models(res: http.ServerResponse, guard: ReturnType<typeof idleGuard>) {
    let up: Response;
    try {
      up = await o.fetch(`http://${o.onion}/api/v1/models?lane=unlinkable`, { headers: { accept: "application/json" }, signal: guard.signal, stream: true });
    } catch (e) {
      throw new HttpFailure(502, "onion_unreachable", `The router's onion service could not be reached through Tor: ${(e as Error).message}. Nothing was sent anywhere else.`);
    }
    await pipe(res, up, guard);
  }

  async function call(req: http.IncomingMessage, res: http.ServerResponse, upstreamPath: string, guard: ReturnType<typeof idleGuard>) {
    let raw = await readBody(req, maxBody);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    } catch {
      throw new HttpFailure(400, "invalid_json", "The request body must be a JSON object. No token was used.");
    }
    // `user` names an end user; it is not needed to get an answer.
    if ("user" in parsed) {
      delete parsed.user;
      raw = Buffer.from(JSON.stringify(parsed));
    }

    const messages = upstreamPath === "/v1/messages";
    if (messages && "metadata" in parsed) { delete parsed.metadata; raw = Buffer.from(JSON.stringify(parsed)); }
    let budget: bigint | null = null;
    if (messages) {
      try { budget = await estimateBudget(parsed, guard.signal); }
      catch (e) { throw new HttpFailure((e as { status?: number }).status ?? 400, "messages_budget_unavailable", (e as Error).message); }
    }
    for (let attempt = 1; ; attempt++) {
      const single = budget === null ? await o.store.lease() : null;
      const leases: Lease[] | null = budget === null ? (single ? [single] : null) : await o.store.leaseBudget(budget, o.maxTokensPerRequest ?? 16);
      if (!leases)
        throw new HttpFailure(
          402,
          "no_tokens",
          attempt > 1
            ? "The router refused the tokens that were tried, and there are no more. Buy more with: anyroute-private buy --key <your API key> --count 20. Nothing was sent without a token."
            : "There are no blind tokens covering this request within the token cap. Buy more with: anyroute-private buy --key <your API key> --count 20. Nothing was sent, and nothing will be sent without a token.",
        );
      let sent = false;
      let up: Response;
      try {
        up = await o.fetch(`http://${o.onion}${upstreamPath}`, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization: `PrivateToken ${leases.map((l) => `token=${l.token.token}`).join(", ")}`,
            "x-anyroute-lane": "unlinkable",
          },
          body: raw,
          signal: guard.signal,
          stream: true,
          onSent: () => (sent = true),
        });
      } catch (e) {
        if (!sent) {
          await o.store.settleMany(leases, "returned");
          throw new HttpFailure(502, "onion_unreachable", `The router's onion service could not be reached through Tor: ${(e as Error).message}. The token was not used, and nothing was sent anywhere else.`);
        }
        throw new HttpFailure(502, "connection_lost", `The connection through Tor failed after the request was sent: ${(e as Error).message}. The token may have been used; it will not be used again.`);
      }

      if (up.ok) {
        await o.store.settleMany(leases, "consumed");
        if (up.headers.get("x-anyroute-lane") !== "unlinkable") log(`warning: the router did not confirm lane "unlinkable" in its answer to ${upstreamPath}`);
        const left = (await o.store.summary()).usable;
        log(`${upstreamPath} -> ${up.status} (${left} tokens left)`);
        return pipe(res, up, guard, { "x-anyroute-private-tokens-left": String(left) });
      }

      const body = await readSmall(up.body);
      if (up.status === 401 && DEAD_TOKEN.has(errorType(body) ?? "")) {
        await o.store.settleMany(leases, "consumed");
        log(`${upstreamPath} -> ${up.status} the router refused a token as ${errorType(body)}; trying another`);
        if (attempt < MAX_TOKEN_TRIES) continue;
        throw new HttpFailure(502, "tokens_rejected", `The router refused ${MAX_TOKEN_TRIES} tokens in a row as spent or invalid. Check the tokens with: anyroute-private status`);
      }
      // Any other refusal means the router did not take the token.
      await o.store.settleMany(leases, "returned");
      log(`${upstreamPath} -> ${up.status} (token kept)`);
      res.writeHead(up.status, passedHeaders(up.headers, { "content-length": String(body.length) }));
      return void res.end(body);
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const guard = idleGuard(idleMs);
      let counted = false;
      res.once("close", () => {
        guard.stop();
        if (!res.writableEnded) guard.abort(new Error("The app closed the connection."));
        if (counted) active--;
      });
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        // A page in a browser, or a name that was rebound to this address, must not be able to use the proxy.
        const host = LOOPBACK_HOST.exec(req.headers.host ?? "");
        if (!host || host[2] !== String(port)) throw new HttpFailure(403, "forbidden_host", "This proxy answers only requests addressed to 127.0.0.1 or localhost.");
        const origin = req.headers.origin;
        if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) throw new HttpFailure(403, "forbidden_origin", "This proxy does not answer requests from web pages.");
        if (localKey) {
          const given = /^Bearer[ \t]+(\S.*)$/i.exec(req.headers.authorization ?? "")?.[1] ?? (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "");
          if (!timingSafeEqual(digest(given), localKey)) throw new HttpFailure(401, "invalid_local_key", "This proxy was started with --local-key: send it as the API key (Authorization: Bearer).");
        }

        const route = url.pathname.replace(/^\/v1(?=\/|$)/, "").replace(/\/+$/, "") || "/";
        if (route === "/health" || route === "/") return send(res, 200, { ok: true, service: "anyroute-private", tokens_left: (await o.store.summary()).usable });
        if (route === "/messages/count_tokens") {
          if (req.method !== "POST") throw new HttpFailure(405, "method_not_allowed", "Use POST.", { allow: "POST" });
          try { return send(res, 200, { input_tokens: countMessageTokens(JSON.parse((await readBody(req, maxBody)).toString("utf8"))) }); }
          catch (e) { if (e instanceof HttpFailure) throw e; throw new HttpFailure(400, "invalid_request", "Invalid Messages count request."); }
        }
        const upstream = CALLS[route];
        const isModels = route === "/models";
        if (!upstream && !isModels) throw new HttpFailure(404, "unsupported_endpoint", "This proxy serves POST /v1/chat/completions, POST /v1/embeddings, POST /v1/messages, POST /v1/messages/count_tokens and GET /v1/models.");
        if (isModels ? req.method !== "GET" : req.method !== "POST") throw new HttpFailure(405, "method_not_allowed", isModels ? "Use GET." : "Use POST.", { allow: isModels ? "GET" : "POST" });

        if (active >= maxConcurrent) throw new HttpFailure(429, "too_many_calls", `${maxConcurrent} calls are already in flight; try again in a moment.`, { "retry-after": "2" });
        active++;
        counted = true;
        if (isModels) await models(res, guard);
        else await call(req, res, upstream, guard);
      } catch (e) {
        if (e instanceof HttpFailure) failure(res, e.status, e.code, e.message, e.headers);
        else if (!res.headersSent) failure(res, 500, "internal_error", `The proxy failed: ${(e as Error).message}`);
        else res.destroy();
      }
    })();
  });
  server.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "EADDRINUSE" ? new Error(`Port ${o.port} is already in use. Pick another with --port.`) : e),
    );
    server.listen(o.port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

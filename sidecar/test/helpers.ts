import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHandler } from "../src/app.ts";
import { DevAttestationProvider } from "../src/attestation/dev.ts";
import { DstackAttestationProvider } from "../src/attestation/dstack.ts";
import type { AttestationProvider } from "../src/attestation/types.ts";
import { boot, type Runtime } from "../src/boot.ts";
import { parseConfig, type SidecarConfig } from "../src/config.ts";
import { hashModelPath } from "../src/digest.ts";
import { sha256Hex, silentLogger } from "../src/util.ts";

export const API_KEY = "sk-test-key-1";
export const API_KEY_2 = "sk-test-key-2";
export const DEV_ENV = { SIDECAR_DEV_ATTESTATION: "true" };

const cleanups: (() => void)[] = [];
export const cleanup = () => {
  while (cleanups.length) cleanups.pop()!();
};

export function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sidecar-test-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

export async function makeModel(files: Record<string, string> = { "config.json": '{"arch":"tiny"}', "weights.safetensors": "0123456789abcdef".repeat(64) }) {
  const dir = tmpDir();
  writeFiles(dir, files);
  const h = await hashModelPath(dir);
  return { dir, digest: h.digest };
}

/** A structurally valid TDX v4 quote (header + report body) carrying the given 64-byte report data. */
export function fakeTdxQuote(reportDataHex: string, opts: { version?: number; teeType?: number } = {}): Buffer {
  const q = Buffer.alloc(48 + 584 + 16);
  q.writeUInt16LE(opts.version ?? 4, 0);
  q.writeUInt32LE(opts.teeType ?? 0x81, 4);
  Buffer.from(reportDataHex, "hex").copy(q, 48 + 520);
  Buffer.alloc(48, 0xa1).copy(q, 48 + 136); // MRTD
  return q;
}

// ---- mock model server ---------------------------------------------------------------------------

export type Seen = { method: string; path: string; headers: Record<string, string>; body: string };

const sseEvent = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (text: string) => sseEvent({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] });

export type Upstream = { url: string; seen: Seen[]; stop: () => void; setMode: (m: string) => void };

/**
 * Behaves like a small vLLM: chat completions (JSON or SSE), embeddings, /v1/models. The request's "model" field
 * selects a failure mode so tests need no shared state: "ok", "truncate" (stream ends without [DONE]),
 * "stall" (stream stops sending), "error" (HTTP 500), "huge" (large JSON), "no-usage".
 */
export function startUpstream(): Upstream {
  const seen: Seen[] = [];
  let modelsOk = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      seen.push({ method: req.method, path: url.pathname, headers, body });
      if (url.pathname === "/v1/models") return modelsOk ? Response.json({ object: "list", data: [{ id: "tiny" }] }) : new Response("down", { status: 503 });
      if (req.method !== "POST") return new Response("nope", { status: 404 });
      const parsed = JSON.parse(body || "{}");
      const mode = String(parsed.model ?? "ok");
      if (mode === "error") return Response.json({ error: { message: "boom", type: "server_error" } }, { status: 500 });
      if (url.pathname === "/v1/embeddings") {
        return Response.json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }], model: "tiny", usage: { prompt_tokens: 7, total_tokens: 7 } });
      }
      if (url.pathname !== "/v1/chat/completions") return new Response("nope", { status: 404 });
      if (mode === "huge") return Response.json({ blob: "x".repeat(200_000) });
      if (parsed.stream) {
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(enc.encode(chunk("Hel")));
            await Bun.sleep(5);
            c.enqueue(enc.encode(chunk("lo")));
            if (mode === "stall") return; // never finishes
            await Bun.sleep(5);
            if (mode === "truncate") {
              c.enqueue(enc.encode('data: {"id":"c1","choices":[{"del')); // cut mid-event
              c.close();
              return;
            }
            if (mode !== "no-usage") {
              c.enqueue(enc.encode(sseEvent({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })));
            }
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", server: "mock-vllm", "set-cookie": "a=b", "x-upstream-secret": "leak" } });
      }
      return Response.json(
        {
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "tiny",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
          ...(mode === "no-usage" ? {} : { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
        },
        { headers: { server: "mock-vllm", "set-cookie": "a=b", "x-upstream-secret": "leak" } },
      );
    },
  });
  const up: Upstream = {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => void server.stop(true),
    setMode: (m) => {
      modelsOk = m !== "down";
    },
  };
  cleanups.push(up.stop);
  return up;
}

// ---- a booted sidecar ----------------------------------------------------------------------------

export type Harness = {
  rt: Runtime;
  cfg: SidecarConfig;
  handler: (req: Request) => Promise<Response>;
  upstream: Upstream;
  model: { dir: string; digest: string };
  call: (path: string, init?: RequestInit & { key?: string | null }) => Promise<Response>;
  chat: (body: unknown, key?: string | null) => Promise<Response>;
};

export async function harness(
  o: {
    raw?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
    provider?: AttestationProvider;
    upstream?: Upstream;
    model?: { dir: string; digest: string };
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Harness> {
  const upstream = o.upstream ?? startUpstream();
  const model = o.model ?? (await makeModel());
  const env = { ...DEV_ENV, ...(o.env ?? {}) };
  const raw = {
    model: { path: model.dir },
    allowlist: { model_digests: [model.digest] },
    server: { hostnames: ["127.0.0.1", "localhost"] },
    attestation: { provider: "dev" },
    auth: { keys: [{ id: "k1", sha256: sha256Hex(API_KEY) }, { id: "k2", sha256: sha256Hex(API_KEY_2) }] },
    ...(o.raw ?? {}),
    upstream: { base_url: upstream.url, ...((o.raw?.upstream as Record<string, unknown> | undefined) ?? {}) },
  };
  const cfg = parseConfig(raw, env);
  const rt = await boot(cfg, { env, logger: silentLogger, provider: o.provider ?? new DevAttestationProvider(), fetchImpl: o.fetchImpl });
  const handler = createHandler(rt);
  const call = (path: string, init: RequestInit & { key?: string | null } = {}) => {
    const { key, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (key !== null && !headers.has("authorization")) headers.set("authorization", `Bearer ${key ?? API_KEY}`);
    return handler(new Request(`http://sidecar.test${path}`, { ...rest, headers }));
  };
  const chat = (body: unknown, key?: string | null) =>
    call("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), key });
  return { rt, cfg, handler, upstream, model, call, chat };
}

/** A dstack guest agent double that produces structurally valid TDX quotes for whatever report data it is given. */
export function mockDstackFetch(opts: { composeHash?: string; tappd?: boolean; badReportData?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname + new URL(url).search;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const legacy = opts.tappd === true;
    if (legacy && (path === "/Info" || path === "/GetQuote")) return new Response("not found", { status: 404 });
    if (path === "/Info" || path === "/prpc/Tappd.Info?json") {
      return Response.json({ app_id: "app123", instance_id: "inst456", tcb_info: JSON.stringify({ compose_hash: opts.composeHash?.replace("sha256:", "") }) });
    }
    if (path === "/GetQuote" || path === "/prpc/Tappd.TdxQuote?json") {
      const rd = opts.badReportData ? "00".repeat(64) : String(body.report_data);
      return Response.json({ quote: fakeTdxQuote(rd).toString("hex"), event_log: JSON.stringify([{ imr: 3, event: "compose-hash" }]) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export const dstackProvider = (opts: Parameters<typeof mockDstackFetch>[0] = {}) =>
  new DstackAttestationProvider({ endpoint: "http://dstack.test", fetchImpl: mockDstackFetch(opts) });

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { loadConfig, type RelayConfig } from "../src/config.ts";
import { createRelay } from "../src/relay.ts";

// Chunked Oblivious HTTP through the relay: off unless RELAY_CHUNKED_ENABLED, and then the request is forwarded under
// the same rules as a whole one while the response is passed on as the gateway sends it. A mock gateway on a real
// socket records what reaches it and can hold its response half-way.

type Seen = { path: string; headers: Record<string, string>; body: Uint8Array };
const seen: Seen[] = [];
const CHUNKED_REQ = { "content-type": "message/ohttp-chunked-req" };
let mode: "stream" | "hold" | "huge" | "whole" | "refused" = "stream";
let gate: Promise<void> | null = null;
let cancelled = 0;
const PIECES = [new Uint8Array(16).fill(1), new Uint8Array(40).fill(2), new Uint8Array(3).fill(3)];

let gateway: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  gateway = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: new Uint8Array(await req.arrayBuffer()) });
      if (mode === "whole") return new Response(new Uint8Array(8), { headers: { "content-type": "message/ohttp-res" } });
      if (mode === "refused") return new Response("{}", { status: 422, headers: { "content-type": "application/problem+json", "set-cookie": "a=b" } });
      let i = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(ctl) {
            if (mode === "huge") {
              // 256 KiB, well past the limit, a piece at a time.
              await Bun.sleep(1);
              if (i++ < 8) ctl.enqueue(new Uint8Array(32 * 1024));
              else ctl.close();
              return;
            }
            if (mode === "hold" && i === 1 && gate) await gate;
            if (i < PIECES.length) ctl.enqueue(PIECES[i++]);
            else ctl.close();
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { headers: { "content-type": "message/ohttp-chunked-res", "set-cookie": "s=1", "x-anything": "dropped", server: "gateway-mark" } });
    },
  });
});
afterAll(() => gateway.stop(true));
afterEach(() => {
  mode = "stream";
  gate = null;
  seen.length = 0;
  cancelled = 0;
});

const gw = () => `http://127.0.0.1:${gateway.port}/api/v1/ohttp/gateway`;
function cfg(over: Partial<RelayConfig> = {}, env: Record<string, string> = { RELAY_CHUNKED_ENABLED: "true" }): RelayConfig {
  return { ...loadConfig({ RELAY_GATEWAYS: JSON.stringify([{ name: "main", url: gw(), credential: "relay-1:s3cret-value" }]), ...env }), ...over };
}
async function serveRelay(over: Partial<RelayConfig> = {}, env?: Record<string, string>) {
  const relay = createRelay(cfg(over, env));
  const server = Bun.serve({ port: 0, fetch: relay.handle, idleTimeout: 30 });
  return { relay, server, url: `http://127.0.0.1:${server.port}` };
}
const BODY = () => crypto.getRandomValues(new Uint8Array(300));
const cat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(5);
};

describe("chunked Oblivious HTTP through the relay", () => {
  test("off by default: a chunked request is refused as an unknown media type and nothing is forwarded", async () => {
    const { server, url, relay } = await serveRelay({}, {});
    try {
      expect(relay.counters.requests).toBe(0);
      const res = await fetch(`${url}/relay`, { method: "POST", headers: CHUNKED_REQ, body: BODY() });
      expect(res.status).toBe(415);
      expect((await res.json()).error.message).toBe("Expected content-type message/ohttp-req.");
      expect(seen).toHaveLength(0);
      expect(relay.counters.rejected.media_type).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("the request is forwarded byte for byte with only the relay's own headers; the response is rebuilt around the gateway's bytes", async () => {
    const { server, url, relay } = await serveRelay();
    try {
      const body = BODY();
      const marks = ["203.0.113.77", "sess=abc123", "client-ua-mark", "https://app.example", "bearer-client-mark", "trace-mark-99"];
      const res = await fetch(`${url}/relay?gateway=main&who=client-mark`, {
        method: "POST",
        headers: { ...CHUNKED_REQ, "x-forwarded-for": "203.0.113.77", forwarded: "for=203.0.113.77", cookie: "sess=abc123", "user-agent": "client-ua-mark", origin: "https://app.example", authorization: "Bearer bearer-client-mark", traceparent: "00-trace-mark-99-01", incremental: "?1" },
        body,
      });
      expect(res.status).toBe(200);
      expect(Object.fromEntries(res.headers)).toMatchObject({ "content-type": "message/ohttp-chunked-res", "cache-control": "no-store", incremental: "?1" });
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("x-anything")).toBeNull();
      expect(res.headers.get("server")).not.toBe("gateway-mark");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(cat(PIECES));

      expect(seen).toHaveLength(1);
      const s = seen[0];
      expect(s.path).toBe("/api/v1/ohttp/gateway");
      expect(s.body).toEqual(body);
      expect(s.headers).toMatchObject({ "content-type": "message/ohttp-chunked-req", accept: "message/ohttp-chunked-res", incremental: "?1", authorization: "Bearer relay-1:s3cret-value" });
      expect(s.headers["user-agent"]).toMatch(/^anyroute-ohttp-relay\//);
      const allowed = new Set(["content-type", "accept", "incremental", "user-agent", "authorization", "host", "content-length", "connection", "accept-encoding"]);
      expect(Object.keys(s.headers).filter((h) => !allowed.has(h))).toEqual([]);
      const everything = JSON.stringify(s.headers) + s.path;
      for (const m of [...marks, "client-mark"]) expect(everything).not.toContain(m);
      const total = PIECES.reduce((n, p) => n + p.length, 0);
      expect(relay.counters).toMatchObject({ requests: 1, forwarded: 1, gateway: { ok: 1, error: 0 }, bytesIn: body.length, bytesOut: total, inflight: 0 });
    } finally {
      server.stop(true);
    }
  });

  test("the response is passed on as it arrives: the first bytes reach the client while the gateway is still holding the rest", async () => {
    const { server, url, relay } = await serveRelay();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    mode = "hold";
    try {
      const res = await fetch(`${url}/relay`, { method: "POST", headers: CHUNKED_REQ, body: BODY() });
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.value).toEqual(PIECES[0]);
      expect(relay.counters.inflight).toBe(1); // the stream still holds its slot
      release();
      const rest: Uint8Array[] = [];
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        rest.push(r.value);
      }
      expect(cat(rest)).toEqual(cat(PIECES.slice(1)));
      await until(() => relay.counters.inflight === 0);
      expect(relay.counters).toMatchObject({ inflight: 0, gateway: { ok: 1 } });
    } finally {
      release();
      server.stop(true);
    }
  });

  test("a response past the size limit is cut off, not carried; a gateway that fails mid-stream is cut off too", async () => {
    const { server, url, relay } = await serveRelay({ maxBodyBytes: 4096 });
    try {
      // Cut off means the stream stops short (the client then finds no final chunk), with nothing past the limit.
      mode = "huge";
      const res = await fetch(`${url}/relay`, { method: "POST", headers: CHUNKED_REQ, body: BODY() });
      expect(res.status).toBe(200);
      const got = (await res.arrayBuffer()).byteLength;
      expect(got).toBeLessThanOrEqual(4096 + 64 * 1024);
      await until(() => relay.counters.inflight === 0);
      expect(relay.counters).toMatchObject({ inflight: 0, bytesOut: got, gateway: { ok: 0, error: 1 } });

      // A gateway whose connection breaks after the first chunk.
      const broken = net.createServer((socket) => {
        socket.on("error", () => undefined);
        socket.once("data", () => {
          socket.write("HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-chunked-res\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n" + "a".repeat(16) + "\r\n");
          setTimeout(() => socket.destroy(), 50);
        });
      });
      await new Promise<void>((r) => broken.listen(0, "127.0.0.1", r));
      const other = createRelay(cfg({ gateways: [{ name: "main", url: `http://127.0.0.1:${(broken.address() as net.AddressInfo).port}/g` }] }));
      const otherServer = Bun.serve({ port: 0, fetch: other.handle });
      try {
        const failing = await fetch(`http://127.0.0.1:${otherServer.port}/relay`, { method: "POST", headers: CHUNKED_REQ, body: BODY() });
        expect(new TextDecoder().decode(await failing.arrayBuffer())).toBe("a".repeat(16));
        await until(() => other.counters.gateway.error === 1);
        expect(other.counters).toMatchObject({ inflight: 0, gateway: { ok: 0, error: 1 } });
      } finally {
        otherServer.stop(true);
        broken.close();
      }
    } finally {
      server.stop(true);
    }
  });

  test("a client that goes away cancels the gateway's stream and frees its slot", async () => {
    const { server, url, relay } = await serveRelay();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    mode = "hold";
    try {
      const ac = new AbortController();
      const res = await fetch(`${url}/relay`, { method: "POST", headers: CHUNKED_REQ, body: BODY(), signal: ac.signal });
      const reader = res.body!.getReader();
      await reader.read();
      ac.abort();
      await until(() => relay.counters.inflight === 0);
      expect(relay.counters.inflight).toBe(0);
      await until(() => cancelled === 1);
      expect(cancelled).toBe(1);
      release();
      expect(relay.counters.gateway.ok).toBe(0);
    } finally {
      release();
      server.stop(true);
    }
  });

  test("the answer must match the request: a whole response to a chunked request is a 502; refusals pass on as a status only", async () => {
    const { server, url, relay } = await serveRelay();
    try {
      mode = "whole";
      expect((await fetch(`${url}/relay`, { method: "POST", headers: CHUNKED_REQ, body: BODY() })).status).toBe(502);
      mode = "stream";
      expect((await fetch(`${url}/relay`, { method: "POST", headers: { "content-type": "message/ohttp-req" }, body: BODY() })).status).toBe(502); // and the other way round
      mode = "refused";
      const refused = await fetch(`${url}/relay`, { method: "POST", headers: CHUNKED_REQ, body: BODY() });
      expect(refused.status).toBe(422);
      expect(refused.headers.get("set-cookie")).toBeNull();
      expect((await refused.json()).error.type).toBe("gateway_refused");
      expect(relay.counters.gateway).toMatchObject({ ok: 0, refused: 1, error: 2 });
      // Browsers may send the Incremental header: the preflight allows it.
      const pre = await fetch(`${url}/relay`, { method: "OPTIONS" });
      expect(pre.headers.get("access-control-allow-headers")).toContain("incremental");
    } finally {
      server.stop(true);
    }
  });
});

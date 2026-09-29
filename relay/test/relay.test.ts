import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { loadConfig, type RelayConfig } from "../src/config.ts";
import { createRelay } from "../src/relay.ts";

// A mock gateway on a real socket records exactly what reaches it; the relay is served on another socket, so the
// client's request goes over real HTTP with the identifying headers a real client would carry.

type Seen = { method: string; path: string; headers: Record<string, string>; body: Uint8Array };
const seen: Seen[] = [];
let mode: "ok" | "error500" | "unauthorized" | "refused422" | "limited" | "redirect" | "slow" | "huge" | "plain200" = "ok";
const RESPONSE = new Uint8Array([0xc7, 0x89, 0xe7, 0x15, 1, 2, 3, 4, 5, 6, 7, 8]);

let gateway: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
const otherSeen: Seen[] = [];

const record = async (req: Request, into: Seen[]) => {
  const url = new URL(req.url);
  into.push({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: new Uint8Array(await req.arrayBuffer()) });
};

beforeAll(() => {
  gateway = Bun.serve({
    port: 0,
    fetch: async (req) => {
      await record(req, seen);
      switch (mode) {
        case "error500":
          return new Response("boom", { status: 500 });
        case "unauthorized":
          return new Response("no", { status: 401 });
        case "refused422":
          return new Response(JSON.stringify({ type: "x", title: "key identifier unknown" }), { status: 422, headers: { "content-type": "application/problem+json", "set-cookie": "a=b", "x-secret": "1" } });
        case "limited":
          return new Response("slow down", { status: 429, headers: { "retry-after": "7" } });
        case "redirect":
          return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } });
        case "slow":
          await new Promise((r) => setTimeout(r, 800));
          return new Response(RESPONSE, { headers: { "content-type": "message/ohttp-res" } });
        case "huge":
          return new Response(new Uint8Array(70_000), { headers: { "content-type": "message/ohttp-res" } });
        case "plain200":
          return new Response("hello", { headers: { "content-type": "text/plain" } });
        default:
          return new Response(RESPONSE, { headers: { "content-type": "message/ohttp-res", "x-anything": "dropped", "set-cookie": "s=1" } });
      }
    },
  });
  other = Bun.serve({ port: 0, fetch: async (req) => (await record(req, otherSeen), new Response(RESPONSE, { headers: { "content-type": "message/ohttp-res" } })) });
});
afterAll(() => {
  gateway.stop(true);
  other.stop(true);
});
afterEach(() => {
  mode = "ok";
  seen.length = 0;
  otherSeen.length = 0;
});

const gw = () => `http://127.0.0.1:${gateway.port}/api/v1/ohttp/gateway`;
const gw2 = () => `http://127.0.0.1:${other.port}/gateway`;

function cfg(over: Partial<RelayConfig> = {}): RelayConfig {
  return { ...loadConfig({ RELAY_GATEWAYS: JSON.stringify([{ name: "main", url: gw(), credential: "relay-1:s3cret-value" }]) }), ...over };
}

async function serveRelay(over: Partial<RelayConfig> = {}) {
  const config = cfg(over);
  const relay = createRelay(config);
  const server = Bun.serve({ port: 0, fetch: relay.handle });
  return { relay, server, config, url: `http://127.0.0.1:${server.port}` };
}

const BODY = () => crypto.getRandomValues(new Uint8Array(200));
const REQ = { "content-type": "message/ohttp-req" };

describe("forwarding", () => {
  test("the encapsulated request reaches the gateway byte for byte and the encapsulated response comes back untouched", async () => {
    const { server, url, relay } = await serveRelay();
    try {
      const body = BODY();
      const res = await fetch(`${url}/relay`, { method: "POST", headers: REQ, body });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("message/ohttp-res");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(RESPONSE);
      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe("POST");
      expect(seen[0].path).toBe("/api/v1/ohttp/gateway");
      expect(seen[0].body).toEqual(body);
      expect(seen[0].headers["content-type"]).toBe("message/ohttp-req");
      expect(seen[0].headers.authorization).toBe("Bearer relay-1:s3cret-value"); // the relay's own credential, for the gateway
      expect(relay.counters).toMatchObject({ requests: 1, forwarded: 1, gateway: { ok: 1 }, bytesIn: 200, bytesOut: RESPONSE.length });
    } finally {
      server.stop(true);
    }
  });

  test("nothing that identifies the client is forwarded: not a header, not the address, not the query", async () => {
    const { server, url } = await serveRelay();
    try {
      const marks = ["client-mark-7f3a", "203.0.113.77", "sess=abc123", "https://app.example/page", "Mozilla/5.0 client-ua-mark", "en-GB-mark", "bearer-client-mark", "trace-mark-99"];
      const headers = {
        ...REQ,
        "x-forwarded-for": "203.0.113.77, 198.51.100.4",
        "x-real-ip": "203.0.113.77",
        forwarded: "for=203.0.113.77;proto=https",
        via: "1.1 client-proxy-mark",
        cookie: "sess=abc123",
        referer: "https://app.example/page",
        origin: "https://app.example",
        "user-agent": "Mozilla/5.0 client-ua-mark",
        "accept-language": "en-GB-mark",
        authorization: "Bearer bearer-client-mark",
        traceparent: "00-trace-mark-99-01",
        "x-custom-client-header": "client-mark-7f3a",
        "cf-connecting-ip": "203.0.113.77",
        "true-client-ip": "203.0.113.77",
        "proxy-authorization": "Basic client-mark-7f3a",
      };
      const res = await fetch(`${url}/relay?gateway=main`, { method: "POST", headers, body: BODY() });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      const s = seen[0];
      // Only the request line, the framing headers the HTTP client adds itself, and the four the relay sets.
      const allowed = new Set(["content-type", "accept", "user-agent", "authorization", "host", "content-length", "connection", "accept-encoding"]);
      expect(Object.keys(s.headers).filter((h) => !allowed.has(h))).toEqual([]);
      expect(s.headers["user-agent"]).toMatch(/^anyroute-ohttp-relay\//);
      expect(s.path).toBe("/api/v1/ohttp/gateway"); // ?gateway=main was the relay's business and is not forwarded
      const everything = JSON.stringify(s.headers) + s.path;
      for (const m of marks) expect(everything).not.toContain(m);
      expect(everything).not.toContain("127.0.0.1:" + server.port);
    } finally {
      server.stop(true);
    }
  });

  test("the response is rebuilt: the gateway's other headers and cookies never reach the client", async () => {
    const { server, url } = await serveRelay();
    try {
      const res = await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() });
      expect(res.headers.get("x-anything")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("a gateway without a credential is sent no Authorization header", async () => {
    const { server, url } = await serveRelay({ gateways: [{ name: "main", url: gw() }] });
    try {
      await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() });
      expect(seen[0].headers.authorization).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});

describe("gateway allow-list", () => {
  test("only configured gateways are contacted: by name, by exact URL, or the single default", async () => {
    const { server, url } = await serveRelay({ gateways: [{ name: "main", url: gw() }, { name: "second", url: gw2() }] });
    try {
      const post = (q: string) => fetch(`${url}/relay${q}`, { method: "POST", headers: REQ, body: BODY() });
      expect((await post("?gateway=main")).status).toBe(200);
      expect(seen).toHaveLength(1);
      expect((await post(`?gateway=${encodeURIComponent(gw2())}`)).status).toBe(200);
      expect(otherSeen).toHaveLength(1);
      // Anything else is refused before a connection is made.
      for (const q of ["?gateway=evil", `?gateway=${encodeURIComponent("http://127.0.0.1:1/x")}`, `?gateway=${encodeURIComponent(gw() + "/../x")}`, "?gateway=MAIN", "?gateway=main%00"]) {
        const r = await post(q);
        expect(r.status).toBe(403);
        expect((await r.json()).error.type).toBe("gateway_not_allowed");
      }
      // Several gateways and none named: the client has to choose.
      const ambiguous = await post("");
      expect(ambiguous.status).toBe(400);
      expect(seen).toHaveLength(1);
      expect(otherSeen).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("a redirect from the gateway is never followed", async () => {
    const { server, url } = await serveRelay();
    try {
      mode = "redirect";
      const res = await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() });
      expect(res.status).toBe(502);
      expect(res.headers.get("location")).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("configuration refuses gateways that are not https (except on this machine), duplicates and unknown fields", () => {
    const load = (g: unknown) => () => loadConfig({ RELAY_GATEWAYS: JSON.stringify(g) });
    expect(load([{ name: "a", url: "https://gw.example/ohttp" }])).not.toThrow();
    expect(load([{ name: "a", url: "http://127.0.0.1:9/ohttp" }])).not.toThrow();
    expect(load([{ name: "a", url: "http://gw.example/ohttp" }])).toThrow(/https/);
    expect(load([{ name: "a", url: "https://u:p@gw.example/ohttp" }])).toThrow(/credentials/);
    expect(load([{ name: "a", url: "https://gw.example/ohttp?x=1" }])).toThrow(/query/);
    expect(load([{ name: "a", url: "https://gw.example/a" }, { name: "a", url: "https://gw.example/b" }])).toThrow(/unique/);
    expect(load([{ name: "a", url: "https://gw.example/a" }, { name: "b", url: "https://gw.example/a" }])).toThrow(/unique/);
    expect(load([{ name: "a b", url: "https://gw.example/a" }])).toThrow(/name/);
    expect(load([{ name: "a", url: "https://gw.example/a", extra: 1 }])).toThrow(/unknown fields/);
    expect(load([{ name: "a", url: "https://gw.example/a", credential: "just-a-secret" }])).toThrow(/credential/);
    expect(load([{ name: "a", url: "https://gw.example/a", credential: "key-1:with space" }])).toThrow(/credential/);
    expect(load([{ name: "a", url: "https://gw.example/a", credential: "key-1:secret" }])).not.toThrow();
    expect(load([])).toThrow(/1 to 20/);
    expect(() => loadConfig({})).toThrow(/RELAY_GATEWAYS/);
    expect(() => loadConfig({ RELAY_GATEWAYS: "not json" })).toThrow(/JSON/);
    expect(() => loadConfig({ RELAY_GATEWAYS: JSON.stringify([{ name: "a", url: "https://gw.example/a" }]), RELAY_PATH: "relay" })).toThrow(/RELAY_PATH/);
    expect(() => loadConfig({ RELAY_GATEWAYS: JSON.stringify([{ name: "a", url: "https://gw.example/a" }]), RELAY_TLS_CERT_FILE: "/x" })).toThrow(/go together/);
  });
});

describe("what the relay refuses", () => {
  test("wrong method, media type, empty and oversized bodies, unknown paths", async () => {
    const { server, url, relay } = await serveRelay({ maxBodyBytes: 1024 });
    try {
      expect((await fetch(`${url}/relay`)).status).toBe(405);
      expect((await fetch(`${url}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(415);
      expect((await fetch(`${url}/relay`, { method: "POST", headers: REQ })).status).toBe(400);
      expect((await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: new Uint8Array(1025) })).status).toBe(413);
      expect((await fetch(`${url}/somewhere`, { method: "POST", headers: REQ, body: BODY() })).status).toBe(404);
      expect(seen).toHaveLength(0);
      expect(relay.counters.rejected).toMatchObject({ method: 1, media_type: 1, empty_body: 1, body_too_large: 1 });
      // The media type parameter form is fine.
      expect((await fetch(`${url}/relay`, { method: "POST", headers: { "content-type": "Message/OHTTP-Req; charset=binary" }, body: BODY() })).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("a stream longer than it declared is cut off at the limit", async () => {
    const { server, url } = await serveRelay({ maxBodyBytes: 1024 });
    try {
      const chunked = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(800));
          c.enqueue(new Uint8Array(800));
          c.close();
        },
      });
      const res = await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: chunked, duplex: "half" } as RequestInit);
      expect(res.status).toBe(413);
      expect(seen).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("at capacity it answers 503 instead of queueing", async () => {
    const { server, url, relay } = await serveRelay({ maxInflight: 1 });
    try {
      mode = "slow";
      const first = fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() });
      for (let i = 0; i < 100 && relay.counters.inflight < 1; i++) await Bun.sleep(10); // until the first request is being forwarded
      expect(relay.counters.inflight).toBe(1);
      expect((await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() })).status).toBe(503);
      expect((await first).status).toBe(200);
      expect(relay.counters.inflight).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});

describe("gateway trouble", () => {
  test("unencapsulated refusals are passed on as a status only; a bad credential or a server error becomes a 502", async () => {
    const { server, url, relay } = await serveRelay();
    try {
      mode = "refused422";
      const r422 = await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() });
      expect(r422.status).toBe(422);
      expect(r422.headers.get("x-secret")).toBeNull();
      expect(r422.headers.get("set-cookie")).toBeNull();
      mode = "limited";
      const r429 = await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() });
      expect(r429.status).toBe(429);
      expect(r429.headers.get("retry-after")).toBe("7");
      mode = "unauthorized";
      const r401 = await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() });
      expect(r401.status).toBe(502);
      expect(relay.counters.credentialRejected).toBe(1);
      mode = "error500";
      expect((await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() })).status).toBe(502);
      mode = "plain200";
      expect((await fetch(`${url}/relay`, { method: "POST", headers: REQ, body: BODY() })).status).toBe(502); // a 200 that is not message/ohttp-res
      expect(relay.counters.gateway).toMatchObject({ ok: 0, refused: 2, error: 3 });
    } finally {
      server.stop(true);
    }
  });

  test("a gateway that is too slow is a 504, one that is down a 502, and an oversized response is not carried", async () => {
    const slow = await serveRelay({ timeoutMs: 100 });
    try {
      mode = "slow";
      expect((await fetch(`${slow.url}/relay`, { method: "POST", headers: REQ, body: BODY() })).status).toBe(504);
      expect(slow.relay.counters.unreachable.timeout).toBe(1);
    } finally {
      slow.server.stop(true);
    }
    const down = await serveRelay({ gateways: [{ name: "main", url: "http://127.0.0.1:1/gateway" }] });
    try {
      expect((await fetch(`${down.url}/relay`, { method: "POST", headers: REQ, body: BODY() })).status).toBe(502);
      expect(down.relay.counters.unreachable.network).toBe(1);
    } finally {
      down.server.stop(true);
    }
    const small = await serveRelay({ maxBodyBytes: 1024 });
    try {
      mode = "huge";
      expect((await fetch(`${small.url}/relay`, { method: "POST", headers: REQ, body: BODY() })).status).toBe(502);
    } finally {
      small.server.stop(true);
    }
  });
});

describe("no logging, only counters", () => {
  test("handling requests writes nothing to the console or the process streams, and the counters carry no client detail", async () => {
    const spies = [spyOn(console, "log"), spyOn(console, "info"), spyOn(console, "warn"), spyOn(console, "error"), spyOn(console, "debug")];
    const out = spyOn(process.stdout, "write");
    const err = spyOn(process.stderr, "write");
    const { server, url, relay } = await serveRelay();
    try {
      const body = BODY();
      await fetch(`${url}/relay`, { method: "POST", headers: { ...REQ, "x-forwarded-for": "203.0.113.9", "user-agent": "log-check-agent" }, body });
      await fetch(`${url}/relay`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
      await fetch(`${url}/relay?gateway=nope`, { method: "POST", headers: REQ, body });
      mode = "error500";
      await fetch(`${url}/relay`, { method: "POST", headers: REQ, body });
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      const metrics = await (await fetch(`${url}/metrics`)).text();
      expect(metrics).toContain("relay_requests_total 4");
      expect(metrics).toContain('relay_rejected_total{reason="media_type"} 1');
      expect(metrics).not.toMatch(/203\.0\.113\.9|log-check-agent|nope/);
      // Every label value is from a fixed list.
      const labels = [...metrics.matchAll(/="([^"]*)"/g)].map((m) => m[1]);
      expect(labels.every((l) => /^[a-z_]+$/.test(l))).toBe(true);
      expect(relay.counters.render()).toBe(metrics);
    } finally {
      server.stop(true);
      for (const s of [...spies, out, err]) s.mockRestore();
    }
  });

  test("the source never logs a request: no console, no logger, no request object in any write", async () => {
    const src = await Bun.file(new URL("../src/relay.ts", import.meta.url)).text();
    expect(src).not.toMatch(/console\.|process\.std(out|err)|\blog\(|logger/i);
    const main = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
    // The one line main writes lists configuration, not requests.
    expect(main.match(/process\.std(out|err)\.write/g)!.length).toBeLessThanOrEqual(5);
    expect(main).not.toMatch(/requestIP|remoteAddress|x-forwarded/i);
    expect(src).not.toMatch(/requestIP|remoteAddress|x-forwarded/i);
  });

  test("health and metrics: /healthz answers, /metrics can be switched off, other paths are 404", async () => {
    const { server, url } = await serveRelay({ metrics: false });
    try {
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
      expect((await fetch(`${url}/metrics`)).status).toBe(404);
      expect((await fetch(`${url}/`)).status).toBe(404);
      const pre = await fetch(`${url}/relay`, { method: "OPTIONS" });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      server.stop(true);
    }
  });
});

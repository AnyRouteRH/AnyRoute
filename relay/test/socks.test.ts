import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createRelay } from "../src/relay.ts";
import { SocksError, createSocksFetch } from "../src/socks.ts";

// A mock SOCKS5 proxy on a real socket stands in for a Tor client. It records what the relay asks of it (in particular
// that the onion name arrives as a name, address type 3, and is not resolved by the relay), then either connects the
// tunnel to a local target or fails in one of the ways a proxy can.

const ONION = "a2w2k7bgvjopikpj6lakthr6jjbnv3gul7cmsvoxye4zvnbcplunvlyd.onion";
const OTHER_ONION = "4dxvnvxlma6z77uh45gcrobbbmhksobz4lve7nspd7bmm3uv4oizxwid.onion";

type Asked = { methods: number[]; username?: string; password?: string; cmd: number; atyp: number; host: string; port: number };
type Behaviour = { kind: "tunnel" } | { kind: "reply"; code: number } | { kind: "no-method" } | { kind: "bad-credentials" } | { kind: "not-socks" } | { kind: "hang" } | { kind: "drop" };

const asked: Asked[] = [];
let behaviour: Behaviour = { kind: "tunnel" };
/** The port on 127.0.0.1 that a successful tunnel connects to, whatever name was asked for. */
let targetPort = 0;
let proxy: net.Server;
let proxyPort = 0;
const open = new Set<net.Socket>();

/** Read exactly n bytes from a socket, holding back anything after them. */
function pull(socket: net.Socket) {
  let buf = Buffer.alloc(0);
  let waiter: (() => void) | null = null;
  socket.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    waiter?.();
  });
  socket.on("close", () => waiter?.());
  return {
    async take(n: number) {
      while (buf.length < n) {
        if (socket.destroyed) throw new Error("closed");
        await new Promise<void>((r) => (waiter = r));
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    rest: () => buf,
    stop: () => socket.removeAllListeners("data"),
  };
}

beforeAll(async () => {
  proxy = net.createServer(async (client) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => undefined);
    const io = pull(client);
    try {
      const head = await io.take(2);
      const methods = [...(await io.take(head[1]))];
      const record: Asked = { methods, cmd: 0, atyp: 0, host: "", port: 0 };
      if (behaviour.kind === "not-socks") return void client.end(Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"));
      if (behaviour.kind === "hang") return;
      if (behaviour.kind === "drop") return void client.destroy();
      if (behaviour.kind === "no-method") return void client.end(Buffer.from([5, 0xff]));
      if (methods.includes(2)) {
        client.write(Buffer.from([5, 2]));
        const ver = await io.take(2);
        record.username = (await io.take(ver[1])).toString();
        const plen = (await io.take(1))[0];
        record.password = (await io.take(plen)).toString();
        client.write(Buffer.from([1, behaviour.kind === "bad-credentials" ? 1 : 0]));
        if (behaviour.kind === "bad-credentials") return void client.end();
      } else client.write(Buffer.from([5, 0]));

      const req = await io.take(4);
      record.cmd = req[1];
      record.atyp = req[3];
      if (req[3] === 3) {
        const len = (await io.take(1))[0];
        record.host = (await io.take(len)).toString();
      } else record.host = [...(await io.take(req[3] === 1 ? 4 : 16))].join(".");
      const p = await io.take(2);
      record.port = (p[0] << 8) | p[1];
      asked.push(record);

      if (behaviour.kind === "reply") return void client.end(Buffer.from([5, behaviour.code, 0, 1, 0, 0, 0, 0, 0, 0]));
      const upstream = net.connect({ host: "127.0.0.1", port: targetPort });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.end());
      upstream.on("connect", () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        const early = io.rest();
        io.stop();
        if (early.length) upstream.write(early);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch {
      client.destroy();
    }
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as net.AddressInfo).port;
});

afterAll(() => {
  proxy.close();
  for (const s of open) s.destroy();
});

afterEach(() => {
  behaviour = { kind: "tunnel" };
  asked.length = 0;
});

/** A target that speaks whatever bytes it is told to, after reading the whole request head. */
function rawTarget(respond: (request: Buffer, socket: net.Socket) => void) {
  const requests: Buffer[] = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const at = buf.indexOf("\r\n\r\n");
      if (at < 0) return;
      const length = Number(/content-length: (\d+)/i.exec(buf.subarray(0, at).toString())?.[1] ?? 0);
      if (buf.length < at + 4 + length) return;
      requests.push(buf);
      buf = Buffer.alloc(0);
      respond(requests.at(-1)!, socket);
    });
  });
  return new Promise<{ port: number; requests: Buffer[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, requests, close: () => server.close() })),
  );
}

const via = (over: { username?: string; password?: string } = {}, maxResponseBytes = 1 << 20) => createSocksFetch({ host: "127.0.0.1", port: proxyPort, ...over }, { maxResponseBytes });
const REQ_BODY = Uint8Array.from({ length: 300 }, (_, i) => i % 251);

describe("the SOCKS5 client", () => {
  test("hands the onion name to the proxy as a name, and carries the request and response through the tunnel", async () => {
    const t = await rawTarget((_req, s) => s.end("HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\nContent-Length: 5\r\nSet-Cookie: a=b\r\n\r\nhello"));
    targetPort = t.port;
    try {
      const res = await via()(`http://${ONION}/api/v1/ohttp/gateway`, { method: "POST", headers: { "content-type": "message/ohttp-req", authorization: "Bearer k:s" }, body: REQ_BODY });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("message/ohttp-res");
      expect(await res.text()).toBe("hello");
      // The proxy was asked to CONNECT to a domain name, on port 80. The relay never looked it up itself.
      expect(asked).toEqual([{ methods: [0], cmd: 1, atyp: 3, host: ONION, port: 80 }]);
      // The request on the wire: exactly the request line, Host, the caller's headers and the framing the client adds.
      const raw = t.requests[0];
      const head = raw.subarray(0, raw.indexOf("\r\n\r\n")).toString();
      expect(head.split("\r\n")).toEqual([
        "POST /api/v1/ohttp/gateway HTTP/1.1",
        `Host: ${ONION}`,
        "content-type: message/ohttp-req",
        "authorization: Bearer k:s",
        "Content-Length: 300",
        "Connection: close",
      ]);
      expect(raw.subarray(raw.indexOf("\r\n\r\n") + 4)).toEqual(Buffer.from(REQ_BODY));
    } finally {
      t.close();
    }
  });

  test("uses the port from the URL, and offers username/password when the proxy has credentials (Tor uses them to keep circuits apart)", async () => {
    const t = await rawTarget((_r, s) => s.end("HTTP/1.1 204 No Content\r\n\r\n"));
    targetPort = t.port;
    try {
      const res = await via({ username: "relay-a", password: "p:ss" })(`http://${ONION}:8080/x?y=1`, { method: "POST", body: new Uint8Array(1) });
      expect(res.status).toBe(204);
      expect(asked[0]).toMatchObject({ methods: [0, 2], username: "relay-a", password: "p:ss", atyp: 3, host: ONION, port: 8080 });
      expect(t.requests[0].toString().split("\r\n")[0]).toBe("POST /x?y=1 HTTP/1.1");
      expect(t.requests[0].toString()).toContain(`Host: ${ONION}:8080`);
    } finally {
      t.close();
    }
  });

  test("reads a chunked response, a response that ends when the connection closes, and skips an interim 100", async () => {
    const chunked = await rawTarget((_r, s) => s.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: message/ohttp-res\r\n\r\n5\r\nhello\r\n7;ext=1\r\n, world\r\n0\r\nX-Trailer: 1\r\n\r\n"));
    const untilClose = await rawTarget((_r, s) => s.end("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\n\r\nno length given"));
    try {
      targetPort = chunked.port;
      const a = await via()(`http://${ONION}/g`, { method: "POST", body: REQ_BODY });
      expect(await a.text()).toBe("hello, world");
      expect(a.headers.get("transfer-encoding")).toBeNull();
      targetPort = untilClose.port;
      const b = await via()(`http://${ONION}/g`, { method: "POST", body: REQ_BODY });
      expect(b.status).toBe(200);
      expect(await b.text()).toBe("no length given");
    } finally {
      chunked.close();
      untilClose.close();
    }
  });

  test("returns a redirect as it came, and never follows it", async () => {
    const t = await rawTarget((_r, s) => s.end("HTTP/1.1 302 Found\r\nLocation: http://elsewhere.invalid/\r\nContent-Length: 0\r\n\r\n"));
    targetPort = t.port;
    try {
      const res = await via()(`http://${ONION}/g`, { method: "POST", body: REQ_BODY });
      expect(res.status).toBe(302);
      expect(asked).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  test("refuses a response that is larger than allowed, malformed, or lies about its length", async () => {
    const cases: [string, string | ((s: net.Socket) => void)][] = [
      ["length over the limit", "HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\nx"],
      ["conflicting lengths", "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab"],
      ["not a number", "HTTP/1.1 200 OK\r\nContent-Length: 1e3\r\n\r\nab"],
      ["truncated body", "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"],
      ["not http", "SSH-2.0-OpenSSH_9.6\r\n\r\n"],
      ["header too large", "HTTP/1.1 200 OK\r\nX-Big: " + "a".repeat(20_000) + "\r\n\r\nx"],
      ["bad chunk", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nabc\r\n0\r\n\r\n"],
      ["chunks over the limit", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n800\r\n" + "a".repeat(2048) + "\r\n0\r\n\r\n"],
    ];
    for (const [name, wire] of cases) {
      const t = await rawTarget((_r, s) => s.end(wire as string));
      targetPort = t.port;
      try {
        await expect(via({}, 1000)(`http://${ONION}/g`, { method: "POST", body: REQ_BODY }), name).rejects.toThrow();
      } finally {
        t.close();
      }
    }
  });

  test("a response that streams past the limit without declaring a length is cut off", async () => {
    const t = await rawTarget((_r, s) => {
      s.write("HTTP/1.1 200 OK\r\n\r\n");
      const spam = setInterval(() => s.write("x".repeat(4096)), 1);
      s.on("close", () => clearInterval(spam));
    });
    targetPort = t.port;
    try {
      await expect(via({}, 10_000)(`http://${ONION}/g`, { method: "POST", body: REQ_BODY })).rejects.toThrow(/larger than allowed/);
    } finally {
      t.close();
    }
  });

  test("proxy failures are SocksErrors that say what went wrong, including Tor's onion replies", async () => {
    const send = () => via()(`http://${ONION}/g`, { method: "POST", body: REQ_BODY });
    for (const [code, text] of [[0xf0, /descriptor not found/], [0xf2, /introduction failed/], [0xf7, /introduction timed out/], [5, /connection refused/], [0x42, /reply code 66/]] as const) {
      behaviour = { kind: "reply", code };
      await expect(send()).rejects.toBeInstanceOf(SocksError);
      await expect(send()).rejects.toThrow(text);
    }
    behaviour = { kind: "no-method" };
    await expect(send()).rejects.toThrow(/none of the offered authentication methods/);
    behaviour = { kind: "not-socks" };
    await expect(send()).rejects.toBeInstanceOf(SocksError);
    behaviour = { kind: "drop" };
    await expect(send()).rejects.toBeInstanceOf(SocksError);
    behaviour = { kind: "bad-credentials" };
    await expect(via({ username: "u", password: "p" })(`http://${ONION}/g`, { method: "POST", body: REQ_BODY })).rejects.toThrow(/refused the credentials/);
  });

  test("a proxy that is not there is a SocksError too", async () => {
    const dead = createSocksFetch({ host: "127.0.0.1", port: 1 }, { maxResponseBytes: 1000 });
    await expect(dead(`http://${ONION}/g`, { method: "POST", body: REQ_BODY })).rejects.toBeInstanceOf(SocksError);
  });

  test("only http targets, and nothing that could split the message", async () => {
    await expect(via()(`https://${ONION}/g`, { method: "POST" })).rejects.toThrow(/Only http/);
    await expect(via()(`http://${ONION}/g`, { method: "POST", headers: { "x-a": "b\r\nx-injected: 1" } })).rejects.toThrow(/not valid/);
    await expect(via()(`http://${ONION}/g`, { method: "POST", headers: { "bad name": "b" } })).rejects.toThrow(/not valid/);
    expect(asked).toHaveLength(0); // neither reached the proxy
  });

  test("aborting the signal closes the tunnel and throws the signal's reason, whether the proxy or the target is slow", async () => {
    behaviour = { kind: "hang" };
    await expect(via()(`http://${ONION}/g`, { method: "POST", body: REQ_BODY, signal: AbortSignal.timeout(150) })).rejects.toMatchObject({ name: "TimeoutError" });
    behaviour = { kind: "tunnel" };
    const silent = await rawTarget(() => undefined);
    targetPort = silent.port;
    try {
      await expect(via()(`http://${ONION}/g`, { method: "POST", body: REQ_BODY, signal: AbortSignal.timeout(150) })).rejects.toMatchObject({ name: "TimeoutError" });
      const already = AbortSignal.abort();
      await expect(via()(`http://${ONION}/g`, { method: "POST", body: REQ_BODY, signal: already })).rejects.toBe(already.reason);
    } finally {
      silent.close();
    }
  });
});

describe("configuration", () => {
  const gws = (url: string) => JSON.stringify([{ name: "hidden", url, credential: "relay-1:s3cret-value" }]);
  const onionUrl = `http://${ONION}/api/v1/ohttp/gateway`;

  test("an onion gateway needs a proxy, and must be http", () => {
    expect(() => loadConfig({ RELAY_GATEWAYS: gws(onionUrl) })).toThrow(/set RELAY_SOCKS5_PROXY/);
    expect(() => loadConfig({ RELAY_GATEWAYS: gws(onionUrl.replace("http:", "https:")), RELAY_SOCKS5_PROXY: "socks5h://127.0.0.1:9050" })).toThrow(/must be http:\/\/ for an onion service/);
    const cfg = loadConfig({ RELAY_GATEWAYS: gws(onionUrl), RELAY_SOCKS5_PROXY: "socks5h://127.0.0.1:9050" });
    expect(cfg.socks5).toEqual({ host: "127.0.0.1", port: 9050 });
    expect(cfg.gateways[0].url).toBe(onionUrl);
  });

  test("only version 3 onion names, with no subdomain; other hosts keep the https rule", () => {
    const env = { RELAY_SOCKS5_PROXY: "socks5h://127.0.0.1:9050" };
    for (const bad of ["http://expyuzz4wqqyqhjn.onion/g", `http://www.${ONION}/g`, `http://${ONION.toUpperCase().replace("HTTP", "http")}x/g`]) expect(() => loadConfig({ ...env, RELAY_GATEWAYS: gws(bad) })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, RELAY_GATEWAYS: gws("http://gateway.example/g") })).toThrow(/must be https/);
    expect(() => loadConfig({ ...env, RELAY_GATEWAYS: gws(`http://${ONION}/g?x=1`) })).toThrow(/query/);
    // A clearnet gateway is still reached directly, with or without a proxy configured.
    expect(loadConfig({ ...env, RELAY_GATEWAYS: gws("https://gateway.example/g") }).gateways[0].url).toBe("https://gateway.example/g");
  });

  test("the proxy URL: socks5h or socks5, host and port, optional credentials, nothing else", () => {
    const at = (proxy: string) => loadConfig({ RELAY_GATEWAYS: gws(onionUrl), RELAY_SOCKS5_PROXY: proxy }).socks5;
    expect(at("socks5://tor.internal:9150")).toEqual({ host: "tor.internal", port: 9150 });
    expect(at("socks5h://[::1]:9050")).toEqual({ host: "::1", port: 9050 });
    expect(at("socks5h://relay%40a:p%3Ass@127.0.0.1:9050/")).toEqual({ host: "127.0.0.1", port: 9050, username: "relay@a", password: "p:ss" });
    for (const bad of ["127.0.0.1:9050", "http://127.0.0.1:9050", "socks4://127.0.0.1:9050", "socks5h://127.0.0.1", "socks5h://:9050", "socks5h://127.0.0.1:9050/path", "socks5h://127.0.0.1:9050?x=1", "socks5h://:pw@127.0.0.1:9050", "socks5h://127.0.0.1:99999", "nonsense"]) {
      expect(() => at(bad), bad).toThrow(ConfigError);
    }
  });
});

describe("the relay with an onion gateway", () => {
  const seen: { method: string; path: string; headers: Record<string, string>; body: Uint8Array }[] = [];
  const RESPONSE = new Uint8Array([0xc7, 0x89, 0xe7, 0x15, 1, 2, 3, 4, 5, 6, 7, 8]);
  let gateway: ReturnType<typeof Bun.serve>;
  let direct: ReturnType<typeof Bun.serve>;
  let mode: "ok" | "refused" | "slow" = "ok";
  const directSeen: number[] = [];

  beforeAll(() => {
    gateway = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: new Uint8Array(await req.arrayBuffer()) });
        if (mode === "slow") await new Promise((r) => setTimeout(r, 1500));
        if (mode === "refused") return new Response("slow down", { status: 429, headers: { "retry-after": "7" } });
        return new Response(RESPONSE, { headers: { "content-type": "message/ohttp-res", "set-cookie": "s=1" } });
      },
    });
    direct = Bun.serve({ port: 0, fetch: () => (directSeen.push(1), new Response(RESPONSE, { headers: { "content-type": "message/ohttp-res" } })) });
  });
  afterAll(() => {
    gateway.stop(true);
    direct.stop(true);
  });
  afterEach(() => {
    seen.length = 0;
    directSeen.length = 0;
    mode = "ok";
  });

  async function serve(env: Record<string, string> = {}) {
    const config = loadConfig({
      RELAY_GATEWAYS: JSON.stringify([
        { name: "hidden", url: `http://${ONION}/api/v1/ohttp/gateway`, credential: "relay-1:s3cret-value" },
        { name: "clear", url: `http://127.0.0.1:${direct.port}/gateway` },
      ]),
      RELAY_SOCKS5_PROXY: `socks5h://127.0.0.1:${proxyPort}`,
      ...env,
    });
    const relay = createRelay(config);
    const server = Bun.serve({ port: 0, fetch: relay.handle });
    return { relay, server, url: `http://127.0.0.1:${server.port}` };
  }
  const REQ = { "content-type": "message/ohttp-req" };

  test("forwards to the onion gateway through the proxy, byte for byte, with nothing that identifies the client", async () => {
    targetPort = gateway.port!;
    const { server, url, relay } = await serve();
    try {
      const body = crypto.getRandomValues(new Uint8Array(200));
      const res = await fetch(`${url}/relay?gateway=hidden`, {
        method: "POST",
        headers: { ...REQ, "x-forwarded-for": "203.0.113.77", cookie: "sess=abc123", "user-agent": "client-ua-mark", origin: "https://app.example" },
        body,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("message/ohttp-res");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(RESPONSE);

      expect(asked).toEqual([{ methods: [0], cmd: 1, atyp: 3, host: ONION, port: 80 }]);
      expect(seen).toHaveLength(1);
      expect(seen[0].path).toBe("/api/v1/ohttp/gateway");
      expect(seen[0].body).toEqual(body);
      expect(seen[0].headers.authorization).toBe("Bearer relay-1:s3cret-value");
      expect(seen[0].headers.host).toBe(ONION);
      const allowed = new Set(["content-type", "accept", "user-agent", "authorization", "host", "content-length", "connection"]);
      expect(Object.keys(seen[0].headers).filter((h) => !allowed.has(h))).toEqual([]);
      expect(seen[0].headers["user-agent"]).toMatch(/^anyroute-ohttp-relay\//);
      expect(JSON.stringify(seen[0].headers)).not.toMatch(/203\.0\.113\.77|sess=abc123|client-ua-mark|app\.example/);
      expect(relay.counters).toMatchObject({ requests: 1, forwarded: 1, gateway: { ok: 1 }, bytesIn: 200, bytesOut: RESPONSE.length });
    } finally {
      server.stop(true);
    }
  });

  test("passes a gateway refusal on as a status only; a clearnet gateway is not sent through the proxy", async () => {
    targetPort = gateway.port!;
    const { server, url, relay } = await serve();
    try {
      mode = "refused";
      const refused = await fetch(`${url}/relay?gateway=hidden`, { method: "POST", headers: REQ, body: crypto.getRandomValues(new Uint8Array(50)) });
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("7");
      expect(relay.counters.gateway.refused).toBe(1);

      asked.length = 0;
      const clear = await fetch(`${url}/relay?gateway=clear`, { method: "POST", headers: REQ, body: crypto.getRandomValues(new Uint8Array(50)) });
      expect(clear.status).toBe(200);
      expect(directSeen).toHaveLength(1);
      expect(asked).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("a proxy that cannot reach the onion service is a 502 counted as a proxy failure, not a crash", async () => {
    const { server, url, relay } = await serve();
    try {
      behaviour = { kind: "reply", code: 0xf0 };
      const res = await fetch(`${url}/relay?gateway=hidden`, { method: "POST", headers: REQ, body: crypto.getRandomValues(new Uint8Array(50)) });
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text).error.type).toBe("gateway_unreachable");
      expect(text).not.toMatch(/descriptor|onion|proxy/i); // what the proxy said stays with the operator
      expect(relay.counters.unreachable).toEqual({ timeout: 0, network: 0, proxy: 1 });
      expect(relay.counters.render()).toContain('relay_gateway_unreachable_total{kind="proxy"} 1');
    } finally {
      server.stop(true);
    }
  });

  test("a gateway that takes too long is a 504 through the proxy as well", async () => {
    targetPort = gateway.port!;
    mode = "slow";
    const { server, url, relay } = await serve({ RELAY_TIMEOUT_MS: "1000" });
    try {
      const res = await fetch(`${url}/relay?gateway=hidden`, { method: "POST", headers: REQ, body: crypto.getRandomValues(new Uint8Array(50)) });
      expect(res.status).toBe(504);
      expect(relay.counters.unreachable.timeout).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

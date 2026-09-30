import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs, UsageError } from "../packages/private/src/args.ts";
import { runCli } from "../packages/private/src/cli.ts";
import { parseOnionAddress } from "../packages/private/src/onion.ts";
import { startProxy, type RunningProxy } from "../packages/private/src/proxy.ts";
import { purchase } from "../packages/private/src/purchase.ts";
import { stateDir, StoreError, TokenStore } from "../packages/private/src/store.ts";
import { chooseOnion, detectTor, probeSocks, torFetch, TorUnavailable } from "../packages/private/src/tor.ts";
import { API_KEY, canConnect, capture, freePort, ONION, selfSigned, startNotSocks, startRouter, startTlsServer, startTor, tempDir, type StandInRouter, type StandInTor } from "./private-fixtures.ts";

setDefaultTimeout(60_000);

/** The runtime's fetch, taken before any test replaces it: what a local app would use to call the proxy. */
const appFetch = globalThis.fetch;

// anyroute-private against stand-ins for its two peers: a SOCKS5 server in the place of the Tor client, and an HTTP
// server in the place of the router that checks blind tokens with the router's own verification code. The stand-in Tor
// client records what it is asked to connect to, which is how these tests see where the program tries to go.

let router: StandInRouter;
let tor: StandInTor;
const posix = process.platform !== "win32";
const dirs: { remove(): void }[] = [];

beforeAll(async () => {
  router = await startRouter();
  tor = await startTor({ [ONION]: router.port });
});
afterAll(async () => {
  await tor.close();
  await router.close();
  dirs.forEach((d) => d.remove());
});
afterEach(() => {
  tor.mode = "tunnel";
  router.intercept = null;
  router.gate = Promise.resolve();
  router.laneAvailable = true;
});

const scratch = () => {
  const t = tempDir();
  dirs.push(t);
  return t.dir;
};
const torProxy = () => ({ host: "127.0.0.1", port: tor.port, label: "stand-in" });
const chatCalls = () => router.seen.filter((s) => s.path === "/api/v1/chat/completions");

/** Tokens bought from the stand-in router, straight into a store (the buy command itself is tested separately). */
async function seed(dir: string, count: number, denomination = 10_000) {
  const store = new TokenStore(dir);
  await purchase({ fetch: (input, init) => fetch(input, init), baseUrl: `http://127.0.0.1:${router.port}`, apiKey: API_KEY, denomination, count, store });
  return store;
}

const running: RunningProxy[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.close();
});
async function proxyFor(dir: string, o: Partial<Parameters<typeof startProxy>[0]> = {}) {
  const store = new TokenStore(dir);
  const p = await startProxy({ port: 0, onion: ONION, fetch: torFetch(torProxy()), store, ...o });
  running.push(p);
  return { store, port: p.port, url: `http://127.0.0.1:${p.port}` };
}
const chat = (url: string, body: Record<string, unknown> = { model: "stand-in/model-a", messages: [{ role: "user", content: "hi" }] }, headers: Record<string, string> = {}) =>
  fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { type: string; message: string } }).error;
const env = (dir: string, extra: Record<string, string> = {}) => ({ ANYROUTE_HOME: dir, ANYROUTE_ONION: ONION, ...extra });

// ---- buying ------------------------------------------------------------------------------------------------------

describe("buy", () => {
  test("buys over Tor, in batches, and stores the tokens in a file only you can read", async () => {
    const dir = scratch();
    const askedBefore = tor.asked.length;
    const run = capture(env(dir, { ANYROUTE_API_KEY: API_KEY }));
    const code = await runCli(["buy", "--count", "6", "--socks", `127.0.0.1:${tor.port}`], run.io);
    expect(code).toBe(0);
    expect(run.out()).toContain("Bought 6 tokens of 10000 units");

    // Everything went to the Tor client, and asked for the onion service by name (address type 3), never an address.
    const asked = tor.asked.slice(askedBefore);
    expect(asked.length).toBeGreaterThanOrEqual(3); // the key directory, then a purchase per batch of four
    for (const a of asked) expect([a.host, a.port, a.atyp]).toEqual([ONION, 80, 3]);
    expect(new Set(asked.map((a) => a.username)).size).toBe(asked.length); // each request had its own circuit
    expect(router.seen.filter((s) => s.path === "/api/v1/blind/purchase").every((s) => s.headers.authorization === `Bearer ${API_KEY}`)).toBe(true);

    const store = new TokenStore(dir);
    expect((await store.summary()).usable).toBe(6);
    if (posix) {
      expect(statSync(store.file).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    // No token and no key on the terminal.
    const saved = JSON.parse(readFileSync(store.file, "utf8")) as { tokens: { token: string }[] };
    for (const t of saved.tokens) expect(run.out() + run.err()).not.toContain(t.token);
    expect(run.out() + run.err()).not.toContain(API_KEY);
  });

  test("the tokens it buys are real: the router's verifier takes each once", async () => {
    const dir = scratch();
    await seed(dir, 2);
    const { url } = await proxyFor(dir);
    expect((await chat(url)).status).toBe(200);
    expect((await chat(url)).status).toBe(200);
    expect(router.spent.size).toBeGreaterThanOrEqual(2);
  });

  test("refuses without a key, with a malformed key, and without a count", async () => {
    const dir = scratch();
    for (const [argv, extra] of [
      [["buy", "--count", "3"], {}],
      [["buy", "--count", "3", "--key", "sk-not-a-key"], {}],
      [["buy"], { ANYROUTE_API_KEY: API_KEY }],
      [["buy", "--count", "0"], { ANYROUTE_API_KEY: API_KEY }],
      [["buy", "--count", "3", "--denomination", "5"], { ANYROUTE_API_KEY: API_KEY }],
    ] as const) {
      const run = capture(env(dir, extra));
      expect(await runCli([...argv, "--socks", `127.0.0.1:${tor.port}`], run.io)).toBe(2);
    }
  });

  test("without Tor it sends nothing", async () => {
    const dir = scratch();
    const dead = await freePort();
    const before = router.seen.length;
    const run = capture(env(dir, { ANYROUTE_API_KEY: API_KEY }));
    expect(await runCli(["buy", "--count", "2", "--socks", `127.0.0.1:${dead}`], run.io)).toBe(1);
    expect(run.err()).toContain("Nothing that speaks SOCKS5 answers");
    expect(router.seen.length).toBe(before);
  });

  test("--clearnet is the only way to buy without Tor, and it is asked for by name", async () => {
    const dir = scratch();
    const connections = tor.connections;
    const run = capture(env(dir, { ANYROUTE_API_KEY: API_KEY }), { directFetch: fetch });
    expect(await runCli(["buy", "--count", "1", "--clearnet", "--router", `http://127.0.0.1:${router.port}`], run.io)).toBe(0);
    expect(tor.connections).toBe(connections);
    expect(run.err()).toContain("Buying without Tor");
    expect((await new TokenStore(dir).summary()).usable).toBe(1);
    // Without the flag there is no such path, even if a fetch is available.
    const refused = capture(env(dir, { ANYROUTE_API_KEY: API_KEY }), { directFetch: fetch });
    expect(await runCli(["buy", "--count", "1", "--socks", `127.0.0.1:${await freePort()}`], refused.io)).toBe(1);
  });
});

// ---- spending ----------------------------------------------------------------------------------------------------

describe("a call through the proxy", () => {
  test("attaches one unspent token, names the lane, and spends the token once", async () => {
    const dir = scratch();
    const store = await seed(dir, 3);
    const { url } = await proxyFor(dir);
    const spentBefore = router.spent.size;
    const callsBefore = chatCalls().length;

    const res = await chat(url);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe("hello");
    const seen = chatCalls().at(-1)!;
    expect(seen.headers.authorization).toMatch(/^PrivateToken token=[A-Za-z0-9_-]{400,}$/);
    expect(seen.headers["x-anyroute-lane"]).toBe("unlinkable");
    expect(router.spent.size).toBe(spentBefore + 1);
    expect((await store.summary()).usable).toBe(2);
    expect(res.headers.get("x-anyroute-private-tokens-left")).toBe("2");

    // The next call uses a different token; the first is not offered again.
    await chat(url);
    expect(chatCalls().length).toBe(callsBefore + 2);
    const [a, b] = chatCalls().slice(-2).map((s) => s.headers.authorization);
    expect(a).not.toBe(b);
    expect(router.spent.size).toBe(spentBefore + 2);
    expect((await store.summary()).usable).toBe(1);
    // A token is gone from the file once used: neither list keeps it.
    expect(readFileSync(store.file, "utf8")).not.toContain(a.replace("PrivateToken token=", ""));
    expect(readFileSync(store.file, "utf8")).not.toContain(b.replace("PrivateToken token=", ""));
  });

  test("strips every identifying header: the router receives a fixed set, and never the app's own key", async () => {
    const dir = scratch();
    await seed(dir, 1);
    const { url } = await proxyFor(dir);
    const res = await chat(
      url,
      { model: "stand-in/model-a", user: "alice@example.com", messages: [{ role: "user", content: "hi" }], temperature: 0.2 },
      {
        authorization: "Bearer sk-app-key-0123456",
        "user-agent": "OpenAI/JS 5.1.0",
        cookie: "session=abc",
        referer: "https://app.example/page",
        "http-referer": "https://app.example",
        "x-title": "My App",
        "x-forwarded-for": "203.0.113.9",
        forwarded: "for=203.0.113.9",
        "x-real-ip": "203.0.113.9",
        "accept-language": "en-GB",
        "x-stainless-os": "MacOS",
        "x-stainless-runtime-version": "v22.1.0",
        "openai-organization": "org-123",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        "idempotency-key": "abc",
        "x-anyroute-lane": "public",
        "x-anyroute-onion": "guess",
      },
    );
    expect(res.status).toBe(200);
    const seen = chatCalls().at(-1)!;
    expect([...new Set(seen.rawHeaderNames)].sort()).toEqual(["accept", "authorization", "connection", "content-length", "content-type", "host", "x-anyroute-lane"]);
    expect(seen.headers.host).toBe(ONION);
    expect(seen.headers["x-anyroute-lane"]).toBe("unlinkable");
    expect(seen.headers.authorization).toStartWith("PrivateToken ");
    expect(JSON.stringify(seen)).not.toContain("sk-app-key");
    expect(JSON.stringify(seen)).not.toContain("alice@example.com");
    expect(JSON.parse(seen.body)).toEqual({ model: "stand-in/model-a", messages: [{ role: "user", content: "hi" }], temperature: 0.2 });
  });

  test("passes on the answer's receipt and lane headers, and nothing else the router sent", async () => {
    const dir = scratch();
    await seed(dir, 1);
    const { url } = await proxyFor(dir);
    const res = await chat(url);
    expect(res.headers.get("x-anyroute-lane")).toBe("unlinkable");
    expect(res.headers.get("x-receipt-id")).toMatch(/^rcpt_/);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-internal-detail")).toBeNull();
  });

  test("streams: the first event reaches the app before the router has sent the last", async () => {
    const dir = scratch();
    await seed(dir, 1);
    const { url } = await proxyFor(dir);
    let release!: () => void;
    router.gate = new Promise<void>((r) => (release = r));
    const res = await chat(url, { model: "stand-in/model-a", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"n":1'); // arrived while the router is still holding back the rest
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('"n":2');
    expect(rest).toContain("[DONE]");
  });

  test("the app closing a streamed call closes the tunnel; the token is spent", async () => {
    const dir = scratch();
    const store = await seed(dir, 2);
    const { url } = await proxyFor(dir);
    let release!: () => void;
    router.gate = new Promise<void>((r) => (release = r));
    const res = await chat(url, { model: "stand-in/model-a", stream: true, messages: [] });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    release();
    await Bun.sleep(100);
    expect((await store.summary()).usable).toBe(1);
    expect((await store.summary()).unconfirmed).toBe(0);
  });

  test("embeddings are paid the same way", async () => {
    const dir = scratch();
    await seed(dir, 1);
    const { url } = await proxyFor(dir);
    const res = await fetch(`${url}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "stand-in/model-a", input: "hi" }) });
    expect(res.status).toBe(200);
    expect(router.seen.at(-1)!.path).toBe("/api/v1/embeddings");
    expect(router.seen.at(-1)!.headers.authorization).toStartWith("PrivateToken ");
  });

  test("lists the models of the unlinkable lane, with no credential at all", async () => {
    const dir = scratch();
    const { url } = await proxyFor(dir);
    const res = await fetch(`${url}/v1/models`, { headers: { authorization: "Bearer sk-app-key-0123456" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(["stand-in/model-a", "stand-in/model-b"]);
    const seen = router.seen.at(-1)!;
    expect(seen.path).toBe("/api/v1/models?lane=unlinkable");
    expect(seen.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("sk-app-key");
  });

  test("when the tokens run out it fails clearly and sends nothing", async () => {
    const dir = scratch();
    await seed(dir, 1);
    const { url } = await proxyFor(dir);
    expect((await chat(url)).status).toBe(200);
    const routerBefore = router.seen.length;
    const torBefore = tor.asked.length;
    const res = await chat(url);
    expect(res.status).toBe(402);
    const error = await errorOf(res);
    expect(error.type).toBe("no_tokens");
    expect(error.message).toContain("anyroute-private buy");
    expect(router.seen.length).toBe(routerBefore);
    expect(tor.asked.length).toBe(torBefore);
  });

  test("a body that is not JSON is refused before a token is taken", async () => {
    const dir = scratch();
    const store = await seed(dir, 1);
    const { url } = await proxyFor(dir);
    const res = await fetch(`${url}/v1/chat/completions`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).type).toBe("invalid_json");
    expect((await store.summary()).usable).toBe(1);
  });

  test("invalid Messages requests and unsupported endpoints fail before payment", async () => {
    const dir = scratch();
    const store = await seed(dir, 1);
    const { url } = await proxyFor(dir);
    const before = router.seen.length;
    const messages = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "x-api-key": "k" }, body: "{}" });
    expect(messages.status).toBe(400);
    expect((await errorOf(messages)).type).toBe("messages_budget_unavailable");
    expect((await fetch(`${url}/v1/responses`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${url}/v1/chat/completions`)).status).toBe(405);
    expect(router.seen.length).toBe(before);
    expect((await store.summary()).usable).toBe(1);
  });

  test("more calls than --max-concurrent are asked to wait", async () => {
    const dir = scratch();
    await seed(dir, 3);
    const { url } = await proxyFor(dir, { maxConcurrent: 1 });
    let release!: () => void;
    router.gate = new Promise<void>((r) => (release = r));
    const first = await chat(url, { model: "stand-in/model-a", stream: true, messages: [] });
    const second = await chat(url);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("2");
    release();
    await first.arrayBuffer();
  });
});

// ---- what happens to a token when a call goes wrong ----------------------------------------------------------------

describe("token accounting", () => {
  test("a token the router calls spent or invalid is dropped, and the call is tried with the next one", async () => {
    const dir = scratch();
    const store = await seed(dir, 3);
    const { url } = await proxyFor(dir);
    let first = true;
    router.intercept = (_req, res, seen) => {
      if (seen.path !== "/api/v1/chat/completions" || !first) return false;
      first = false;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "This token was already spent.", type: "token_spent" } }));
      return true;
    };
    const res = await chat(url);
    expect(res.status).toBe(200);
    const summary = await store.summary();
    expect(summary.usable).toBe(1); // one dropped, one spent
    expect(summary.unconfirmed).toBe(0);
  });

  test("a refusal that is not about the token leaves the token where it was", async () => {
    const dir = scratch();
    const store = await seed(dir, 2);
    const { url } = await proxyFor(dir);
    for (const [status, type] of [[402, "token_value_too_low"], [503, "no_attested_endpoint"], [429, "rate_limited"]] as const) {
      router.intercept = (_req, res, seen) => {
        if (seen.path !== "/api/v1/chat/completions") return false;
        res.writeHead(status, { "content-type": "application/json", "retry-after": "3" });
        res.end(JSON.stringify({ error: { message: "no", type } }));
        return true;
      };
      const res = await chat(url);
      expect(res.status).toBe(status);
      expect((await errorOf(res)).type).toBe(type);
      if (status === 429) expect(res.headers.get("retry-after")).toBe("3");
      expect((await store.summary()).usable).toBe(2);
    }
  });

  test("if Tor cannot connect, nothing was sent and the token is kept", async () => {
    const dir = scratch();
    const store = await seed(dir, 1);
    const { url } = await proxyFor(dir);
    tor.mode = "refuse";
    const before = router.seen.length;
    const res = await chat(url);
    expect(res.status).toBe(502);
    expect((await errorOf(res)).type).toBe("onion_unreachable");
    expect(router.seen.length).toBe(before);
    expect((await store.summary()).usable).toBe(1);
    tor.mode = "tunnel";
    expect((await chat(url)).status).toBe(200);
  });

  test("a call sent and then lost is not retried with its token: it is recorded as unconfirmed", async () => {
    const dir = scratch();
    const store = await seed(dir, 2);
    const { url } = await proxyFor(dir);
    tor.mode = "drop-after-request";
    const res = await chat(url);
    expect(res.status).toBe(502);
    expect((await errorOf(res)).type).toBe("connection_lost");
    const summary = await store.summary();
    expect([summary.usable, summary.unconfirmed]).toEqual([1, 1]);
    tor.mode = "tunnel";
    expect((await chat(url)).status).toBe(200);
    const [lost, next] = chatCalls().slice(-2).map((s) => s.headers.authorization);
    expect(lost).not.toBe(next);
    expect((await store.summary()).unconfirmed).toBe(1); // it stays on record and is never offered again
  });
});

// ---- Tor, and nothing but Tor --------------------------------------------------------------------------------------

describe("Tor", () => {
  test("start refuses when Tor is not reachable, and nothing is served or sent", async () => {
    const dir = scratch();
    const dead = await freePort();
    const notSocks = await startNotSocks();
    const port = await freePort();
    const routerBefore = router.seen.length;
    const torBefore = tor.asked.length;
    for (const argv of [["--socks", `127.0.0.1:${dead}`], ["--socks", `127.0.0.1:${notSocks.port}`], []]) {
      const run = capture(env(dir));
      const code = await runCli(["start", "--port", String(port), ...argv], run.io, { torCandidates: [{ host: "127.0.0.1", port: dead, label: "Tor daemon" }, { host: "127.0.0.1", port: notSocks.port, label: "Tor Browser" }] });
      expect(code).toBe(1);
      expect(run.err()).toMatch(/Tor is not running|Nothing that speaks SOCKS5/);
      expect(run.out()).toBe("");
    }
    await notSocks.close();
    expect(await canConnect("127.0.0.1", port)).toBe(false);
    expect(router.seen.length).toBe(routerBefore);
    expect(tor.asked.length).toBe(torBefore);
  });

  test("it finds Tor on the default ports, and takes the first that answers", async () => {
    const dead = await freePort();
    const found = await detectTor({ candidates: [{ host: "127.0.0.1", port: dead, label: "Tor daemon" }, { host: "127.0.0.1", port: tor.port, label: "Tor Browser" }] });
    expect([found.port, found.label]).toEqual([tor.port, "Tor Browser"]);
    await expect(detectTor({ candidates: [{ host: "127.0.0.1", port: dead, label: "Tor daemon" }] })).rejects.toThrow(TorUnavailable);
    expect(await probeSocks("127.0.0.1", tor.port)).toBe(true);
    expect(await probeSocks("127.0.0.1", dead)).toBe(false);
  });

  test("a SOCKS proxy on another machine is refused unless allowed, because the request reaches it unencrypted", async () => {
    await expect(detectTor({ explicit: "192.0.2.10:9050" })).rejects.toThrow(/not on this machine/);
    await expect(detectTor({ explicit: "tor.example.invalid:9050" })).rejects.toThrow(/not on this machine/);
  });

  test("it never touches the network any other way: every connection is to the SOCKS port, and only the onion name is asked for", async () => {
    const dir = scratch();
    const connects: { host?: string; port?: number }[] = [];
    const original = net.connect;
    const netSpy = spyOn(net, "connect").mockImplementation(((...a: unknown[]) => {
      connects.push(a[0] as { host?: string; port?: number });
      return (original as (...args: unknown[]) => net.Socket)(...a);
    }) as typeof net.connect);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("the clearnet was used (fetch)");
    }) as unknown as typeof fetch);
    const httpSpy = spyOn(http, "request").mockImplementation((() => {
      throw new Error("the clearnet was used (http.request)");
    }) as unknown as typeof http.request);
    const httpsSpy = spyOn(https, "request").mockImplementation((() => {
      throw new Error("the clearnet was used (https.request)");
    }) as unknown as typeof https.request);
    const askedBefore = tor.asked.length;
    try {
      const bought = capture(env(dir, { ANYROUTE_API_KEY: API_KEY }));
      expect(await runCli(["buy", "--count", "2", "--socks", `127.0.0.1:${tor.port}`], bought.io)).toBe(0);
      const p = await proxyFor(dir);
      const app = (input: string, init?: RequestInit) => appFetch(input, init);
      const answered = await app(`${p.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "stand-in/model-a", messages: [] }) });
      expect(answered.status).toBe(200);
      expect((await app(`${p.url}/v1/models`)).status).toBe(200);
      // With Tor gone, the call fails; it does not go looking for another way.
      tor.mode = "refuse";
      expect((await app(`${p.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "stand-in/model-a", messages: [] }) })).status).toBe(502);
    } finally {
      netSpy.mockRestore();
      fetchSpy.mockRestore();
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
    }
    expect(connects.length).toBeGreaterThan(0);
    for (const c of connects) expect([c.host, c.port]).toEqual(["127.0.0.1", tor.port]);
    for (const a of tor.asked.slice(askedBefore)) expect([a.host, a.atyp]).toEqual([ONION, 3]);
  });

  test("a SOCKS port that is not listening is an error for the app, not a reason to go around it", async () => {
    const dir = scratch();
    const store = await seed(dir, 1);
    const dead = await freePort();
    const { url } = await proxyFor(dir, { fetch: torFetch({ host: "127.0.0.1", port: dead, label: "none" }) });
    const before = router.seen.length;
    const res = await chat(url);
    expect(res.status).toBe(502);
    expect(router.seen.length).toBe(before);
    expect((await store.summary()).usable).toBe(1);
  });

  test("each call gets its own Tor circuit unless one is asked for", async () => {
    const dir = scratch();
    await seed(dir, 3);
    const separate = await proxyFor(dir);
    const before = tor.asked.length;
    await chat(separate.url);
    await chat(separate.url);
    const users = tor.asked.slice(before).map((a) => a.username);
    expect(users.length).toBe(2);
    expect(users[0]).not.toBe(users[1]);
    expect(users.every((u) => /^ar-[0-9a-f]{18}$/.test(u ?? ""))).toBe(true);

    const shared = await proxyFor(dir, { fetch: torFetch(torProxy(), { isolate: false }) });
    await seed(dir, 2);
    const mark = tor.asked.length;
    await chat(shared.url);
    await chat(shared.url);
    const sharedUsers = tor.asked.slice(mark).map((a) => a.username);
    expect(sharedUsers).toHaveLength(2);
    expect(sharedUsers[0]).toMatch(/^ar-[0-9a-f]{18}$/);
    expect(sharedUsers[1]).toBe(sharedUsers[0]);
  });

  test("the onion address is asked from the router over Tor at its public name, checked and saved; the saved one is used only if the router cannot be asked", async () => {
    const certDir = scratch();
    const pem = selfSigned("router.example.test", certDir);
    if (!pem) return; // openssl is not installed here
    const publicRouter = await startTlsServer(pem, (p) => (p === "/api/v1/status" ? { data: { onion: { address: ONION }, lanes: { unlinkable: { available: true, via: ["onion"] } } } } : {}));
    const front = await startTor({ "router.example.test": publicRouter.port, [ONION]: router.port });
    try {
      const dir = scratch();
      const f = torFetch({ host: "127.0.0.1", port: front.port, label: "stand-in" }, { tls: { ca: pem.cert } });
      const chosen = await chooseOnion({ router: "https://router.example.test", f, dir });
      expect([chosen.onion, chosen.source]).toEqual([ONION, "router"]);
      expect(front.asked.at(-1)).toMatchObject({ host: "router.example.test", port: 443, atyp: 3 });
      if (posix) expect(statSync(path.join(dir, "router.json")).mode & 0o777).toBe(0o600);

      // A certificate the system does not trust ends the conversation; the saved address is used, with a warning.
      const strict = torFetch({ host: "127.0.0.1", port: front.port, label: "stand-in" });
      const saved = await chooseOnion({ router: "https://router.example.test", f: strict, dir });
      expect([saved.onion, saved.source]).toEqual([ONION, "saved"]);
      expect(saved.note).toContain("using the one saved");
      // With nothing saved, the error says how to pass one.
      await expect(chooseOnion({ router: "https://router.example.test", f: strict, dir: scratch() })).rejects.toThrow(/--onion/);
      // An address the user passes wins, and must be a valid one.
      expect((await chooseOnion({ given: `http://${ONION}/`, router: "https://router.example.test", f: strict, dir: scratch() })).source).toBe("option");
      await expect(chooseOnion({ given: "example.com", router: "https://router.example.test", f: strict, dir: scratch() })).rejects.toThrow();
    } finally {
      await front.close();
      await publicRouter.close();
    }
  });
});

// ---- the local server --------------------------------------------------------------------------------------------

describe("who may use the proxy", () => {
  /** A request with a Host and Origin of its choosing (fetch does not allow setting Host). */
  const raw = (port: number, headers: Record<string, string>, pathName = "/health") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: pathName, headers }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  test("it answers only on 127.0.0.1 and to requests addressed to it", async () => {
    const dir = scratch();
    const { port } = await proxyFor(dir);
    expect((await raw(port, { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await raw(port, { host: `localhost:${port}` })).status).toBe(200);
    // A name rebound to this address, or a request for another host or port.
    expect((await raw(port, { host: `evil.example:${port}` })).status).toBe(403);
    expect((await raw(port, { host: `127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await raw(port, { host: "127.0.0.1" })).status).toBe(403);
    // Not on other interfaces.
    const others = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === "IPv4");
    for (const i of others.slice(0, 1)) expect(await canConnect(i!.address, port)).toBe(false);
  });

  test("a web page cannot use it: a request with an Origin that is not this machine is refused", async () => {
    const dir = scratch();
    await seed(dir, 1);
    const { port, store } = await proxyFor(dir);
    const before = router.seen.length;
    expect((await raw(port, { host: `127.0.0.1:${port}`, origin: "https://evil.example" }, "/v1/models")).status).toBe(403);
    expect((await raw(port, { host: `127.0.0.1:${port}`, origin: "null" }, "/v1/models")).status).toBe(403);
    expect((await raw(port, { host: `127.0.0.1:${port}`, origin: "http://localhost:3000" }, "/health")).status).toBe(200);
    expect(router.seen.length).toBe(before);
    expect((await store.summary()).usable).toBe(1);
  });

  test("with --local-key the app must present it, and it is never forwarded", async () => {
    const dir = scratch();
    await seed(dir, 1);
    const { url } = await proxyFor(dir, { localKey: "local-secret-value" });
    expect((await chat(url)).status).toBe(401);
    expect((await chat(url, undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await chat(url, undefined, { authorization: "Bearer local-secret-value" })).status).toBe(200);
    expect(JSON.stringify(chatCalls().at(-1))).not.toContain("local-secret-value");
  });

  test("a port that is taken is reported, not skipped", async () => {
    const dir = scratch();
    const { port } = await proxyFor(dir);
    await expect(startProxy({ port, onion: ONION, fetch: torFetch(torProxy()), store: new TokenStore(dir) })).rejects.toThrow(/already in use/);
  });
});

// ---- commands ----------------------------------------------------------------------------------------------------

describe("status and start", () => {
  test("status reports Tor, the onion service, the lane and the tokens, and its exit code says whether all is ready", async () => {
    const dir = scratch();
    await seed(dir, 2);
    const run = capture(env(dir));
    expect(await runCli(["status", "--json", "--socks", `127.0.0.1:${tor.port}`], run.io)).toBe(0);
    const report = JSON.parse(run.out());
    expect(report.tor).toMatchObject({ reachable: true, socks: `127.0.0.1:${tor.port}` });
    expect(report.onion).toMatchObject({ address: ONION, reachable: true });
    expect(report.unlinkable_lane).toMatchObject({ available: true, via: ["onion"] });
    expect(report.tokens).toMatchObject({ usable: 2, expired: 0, unconfirmed: 0 });
    expect(report.ready).toBe(true);
    expect(run.out()).not.toMatch(/[A-Za-z0-9_-]{300,}/); // no token

    router.laneAvailable = false;
    const down = capture(env(dir));
    expect(await runCli(["status", "--json", "--socks", `127.0.0.1:${tor.port}`], down.io)).toBe(1);
    expect(JSON.parse(down.out()).unlinkable_lane.available).toBe(false);

    const noTor = capture(env(dir));
    expect(await runCli(["status", "--socks", `127.0.0.1:${await freePort()}`], noTor.io)).toBe(1);
    expect(noTor.out()).toContain("NOT reachable");

    const text = capture(env(dir));
    router.laneAvailable = true;
    expect(await runCli(["status", "--socks", `127.0.0.1:${tor.port}`], text.io)).toBe(0);
    expect(text.out()).toMatch(/Tor:\s+reachable/);
    expect(text.out()).toMatch(/Blind tokens:\s+2 usable/);
  });

  test("status with no tokens says how to buy them, and reads without creating anything", async () => {
    const dir = path.join(scratch(), "not-yet");
    const run = capture(env(dir));
    expect(await runCli(["status", "--socks", `127.0.0.1:${tor.port}`], run.io)).toBe(1);
    expect(run.out()).toContain("anyroute-private buy");
    expect(existsSync(dir)).toBe(false);
  });

  test("start serves, prints how to point apps at it, and stops when told to", async () => {
    const dir = scratch();
    await seed(dir, 1);
    const run = capture(env(dir));
    const stop = new AbortController();
    const port = await new Promise<number>((resolve) => {
      void runCli(["start", "--port", "0", "--socks", `127.0.0.1:${tor.port}`, "--quiet"], run.io, { stop: stop.signal, onStarted: resolve });
    });
    const out = run.out();
    expect(out).toContain(`OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`);
    expect(out).toContain("OPENAI_API_KEY=");
    expect(out).toContain("Cursor");
    expect(out).toContain("The router reads each prompt");
    expect(out).toContain(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
    expect(out).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL=");
    const res = await chat(`http://127.0.0.1:${port}`);
    expect(res.status).toBe(200);
    stop.abort();
    await Bun.sleep(100);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  test("start does not begin when the router does not serve the lane over Tor", async () => {
    const dir = scratch();
    router.laneAvailable = false;
    const run = capture(env(dir));
    const stop = AbortSignal.timeout(8000); // if it wrongly starts, end it rather than wait
    expect(await runCli(["start", "--port", "0", "--socks", `127.0.0.1:${tor.port}`], run.io, { stop })).toBe(1);
    expect(run.err()).toContain("does not serve the unlinkable lane");
    expect(run.out()).toBe("");
  });

  test("unknown commands and options are usage errors", async () => {
    const dir = scratch();
    for (const argv of [["frobnicate"], ["start", "--nope"], ["start", "--port"], ["start", "--port", "70000"], ["start", "extra"], ["--socks", "x"]]) {
      const run = capture(env(dir));
      expect(await runCli(argv, run.io)).toBe(2);
    }
    const help = capture(env(dir));
    expect(await runCli(["--help"], help.io)).toBe(0);
    expect(help.out()).toContain("Never uses the clearnet");
  });
});

// ---- the token file ----------------------------------------------------------------------------------------------

describe("the token file", () => {
  test.skipIf(!posix)("is mode 0600 in a 0700 directory after every write, and a file that was left wider is tightened", async () => {
    const dir = path.join(scratch(), "state");
    const store = await seed(dir, 2);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const lease = await store.lease();
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    await store.settle(lease!, "returned");
    expect(statSync(store.file).mode & 0o777).toBe(0o600);

    chmodSync(store.file, 0o644);
    const warnings: string[] = [];
    await new TokenStore(dir, (m) => warnings.push(m)).summary();
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(warnings.join()).toContain("mode 0600");
    // No temporary or lock file is left behind holding a token.
    expect([...new Bun.Glob("*").scanSync({ cwd: dir, dot: true })].sort()).toEqual(["tokens.json"]);
  });

  test("concurrent users of one file never receive the same token", async () => {
    const dir = scratch();
    await seed(dir, 12);
    const a = new TokenStore(dir);
    const b = new TokenStore(dir);
    const leases = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).lease()));
    const tokens = leases.map((l) => l!.token.token);
    expect(new Set(tokens).size).toBe(12);
    expect(await a.lease()).toBeNull();
    expect((await a.summary()).unconfirmed).toBe(12);
  });

  test("tokens are used soonest-expiring first; expired ones are never offered and are dropped on the next purchase", async () => {
    const dir = scratch();
    const store = await seed(dir, 3);
    const file = JSON.parse(readFileSync(store.file, "utf8"));
    const day = 86_400_000;
    file.tokens[0].redeem_until = new Date(Date.now() + 5 * day).toISOString();
    file.tokens[1].redeem_until = new Date(Date.now() - day).toISOString();
    file.tokens[2].redeem_until = new Date(Date.now() + 2 * day).toISOString();
    writeFileSync(store.file, JSON.stringify(file), { mode: 0o600 });
    const summary = await store.summary();
    expect([summary.usable, summary.expired]).toEqual([2, 1]);
    expect((await store.lease())!.token.token).toBe(file.tokens[2].token);
    expect((await store.lease())!.token.token).toBe(file.tokens[0].token);
    expect(await store.lease()).toBeNull();
    await seed(dir, 1);
    expect(JSON.parse(readFileSync(store.file, "utf8")).tokens.length).toBe(1);
  });

  test("a damaged file is reported and left alone", async () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "tokens.json");
    writeFileSync(file, "{ not json", { mode: 0o600 });
    const store = new TokenStore(dir);
    await expect(store.lease()).rejects.toThrow(StoreError);
    await expect(store.add([])).rejects.toThrow(StoreError);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  test("the state directory is ANYROUTE_HOME, else ~/.anyroute", () => {
    expect(stateDir({ ANYROUTE_HOME: "/somewhere" })).toBe("/somewhere");
    expect(stateDir({})).toBe(path.join(os.homedir(), ".anyroute"));
  });
});

// ---- small pieces ------------------------------------------------------------------------------------------------

describe("parsing", () => {
  test("onion addresses: version 3, with the checksum checked", () => {
    expect(parseOnionAddress(ONION)).toBe(ONION);
    expect(parseOnionAddress(`http://${ONION.toUpperCase()}/`)).toBe(ONION);
    expect(() => parseOnionAddress(ONION.replace(/^./, "b"))).toThrow(/checksum|version/);
    expect(() => parseOnionAddress("example.com")).toThrow();
    expect(() => parseOnionAddress(`${ONION}:8080`)).toThrow();
    expect(() => parseOnionAddress(`${ONION}/api`)).toThrow();
  });

  test("arguments: --name value, --name=value, flags, and clear errors", () => {
    const spec = { values: ["port", "key"], flags: ["quiet"] };
    const a = parseArgs(["--port", "9", "--key=abc", "--quiet"], spec);
    expect([a.options.get("port"), a.options.get("key"), a.flags.has("quiet")]).toEqual(["9", "abc", true]);
    expect(() => parseArgs(["--port"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["--port", "--quiet"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["--quiet=1"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["--port", "1", "--port", "2"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["--other"], spec)).toThrow(/Unknown option/);
  });
});

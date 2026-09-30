import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { challengeDigest, decodeToken, hex, b64url, nullifierOf, parsePrivateToken, signedPart, tokenChallenge } from "../src/blind/privacy-token.ts";
import { generateIssuerKey, importIssuerPublicKey, Signer } from "../src/blind/rsa.ts";

// Stand-ins for the two things anyroute-private talks to: a Tor client (a SOCKS5 server) and the router (an HTTP
// server that checks blind tokens with the router's own verification code). Both listen on 127.0.0.1 on a free port.

export const ONION = "a2w2k7bgvjopikpj6lakthr6jjbnv3gul7cmsvoxye4zvnbcplunvlyd.onion";
export const API_KEY = "sk-ar-v1-" + "ab".repeat(32);
export const DENOMINATIONS = [1000, 10_000, 100_000] as const;

export const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "anyroute-private-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
};

/** True if a TCP connection to host:port succeeds within two seconds. */
export const canConnect = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => (socket.destroy(), resolve(ok));
    socket.setTimeout(2000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

// ---- the router ------------------------------------------------------------------------------------------------

export type Seen = { method: string; path: string; headers: Record<string, string>; rawHeaderNames: string[]; body: string };
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => boolean | Promise<boolean>;

export async function startRouter() {
  const challenge = tokenChallenge("stand-in-router.invalid");
  const digest = challengeDigest(challenge);
  const keys = await Promise.all(
    DENOMINATIONS.map(async (denomination) => {
      const material = await generateIssuerKey();
      return { denomination, ...material, signer: new Signer(material.pkcs8), verifier: await importIssuerPublicKey(material.spki) };
    }),
  );
  const suite = RSABSSA.SHA384.PSS.Deterministic();
  const redeemUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const seen: Seen[] = [];
  const spent = new Set<string>();
  const state = {
    seen,
    spent,
    purchases: 0,
    /** Hooks a test can set to take over a request before the normal handling. */
    intercept: null as Handler | null,
    /** For streamed answers: chunk two is sent when this resolves. */
    gate: Promise.resolve() as Promise<void>,
    laneAvailable: true,
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
    const entry: Seen = { method: req.method ?? "", path: req.url ?? "", headers, rawHeaderNames: req.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()), body: Buffer.concat(chunks).toString("utf8") };
    seen.push(entry);
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(body));
    };
    if (state.intercept && (await state.intercept(req, res, entry))) return;

    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/api/v1/status")
      return json(200, { data: { onion: { address: ONION, url: `http://${ONION}` }, lanes: { unlinkable: { available: state.laneAvailable, models: 2, via: state.laneAvailable ? ["onion"] : [] } } } });
    if (req.method === "GET" && url.pathname === "/api/v1/models") return json(200, { data: [{ id: "stand-in/model-a" }, { id: "stand-in/model-b" }] });
    if (req.method === "GET" && url.pathname === "/api/v1/blind/keys")
      return json(200, {
        data: {
          challenge_digest: hex(digest),
          unit_price_usd: "0.000002",
          max_batch: 4,
          epoch: 1,
          keys: keys.map((k) => ({
            token_key_id: k.keyId,
            token_key: b64url(k.spki),
            epoch: 1,
            denomination: k.denomination,
            status: "issuing",
            value_usd: (k.denomination * 0.000002).toFixed(6),
            issue_until: redeemUntil,
            redeem_until: redeemUntil,
          })),
        },
      });
    if (req.method === "POST" && url.pathname === "/api/v1/blind/purchase") {
      if (headers.authorization !== `Bearer ${API_KEY}`) return json(401, { error: { message: "Unknown API key.", type: "invalid_key" } });
      const body = JSON.parse(entry.body) as { token_key_id: string; blinded_msgs: string[] };
      const key = keys.find((k) => k.keyId === body.token_key_id);
      if (!key) return json(400, { error: { message: "Unknown key.", type: "invalid_request" } });
      state.purchases++;
      return json(200, {
        data: {
          token_key_id: key.keyId,
          epoch: 1,
          denomination: key.denomination,
          count: body.blinded_msgs.length,
          cost_usd: (body.blinded_msgs.length * key.denomination * 0.000002).toFixed(6),
          signatures: body.blinded_msgs.map((m) => b64url(key.signer.blindSign(new Uint8Array(Buffer.from(m, "base64url"))))),
        },
      });
    }

    if (req.method === "POST" && (url.pathname === "/api/v1/chat/completions" || url.pathname === "/api/v1/embeddings")) {
      // The router's checks, in its order: the lane, then the credential (a real blind-RSA verification), then a one-time claim.
      const bytes = parsePrivateToken(headers.authorization);
      if (bytes === undefined || bytes === null) return json(401, { error: { message: "This lane is paid with a blind token only.", type: "unlinkable_requires_token" } });
      const token = decodeToken(bytes);
      const key = token && keys.find((k) => k.keyId === hex(token.keyId));
      if (!token || !key || !(await suite.verify(key.verifier, token.authenticator, signedPart(bytes)))) return json(401, { error: { message: "Token signature is invalid.", type: "invalid_token" } });
      if (headers["x-anyroute-lane"] !== "unlinkable") return json(403, { error: { message: "Send this on lane unlinkable.", type: "lane_mismatch" } });
      const nullifier = nullifierOf(bytes);
      if (spent.has(nullifier)) return json(401, { error: { message: "This token was already spent.", type: "token_spent" } });
      const value = key.denomination * 0.000002;
      const cost = Number(headers["x-stand-in-cost"] ?? 0.001);
      if (cost > value) return json(402, { error: { message: `This request may cost up to $${cost} but the token is worth $${value}.`, type: "token_value_too_low" } });
      spent.add(nullifier);
      const body = JSON.parse(entry.body) as { stream?: boolean };
      const lane = { "x-anyroute-lane": "unlinkable", "x-receipt-id": "rcpt_" + nullifier.slice(0, 8), "set-cookie": "router=1", "x-internal-detail": "not for apps" };
      if (!body.stream) return json(200, { id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "hello" } }] }, lane);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...lane });
      res.write('data: {"n":1}\n\n');
      await state.gate;
      res.write('data: {"n":2}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }
    json(404, { error: { message: "Not found.", type: "not_found" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // The state object itself is returned (not a copy), so a test that sets `gate`, `intercept` or `laneAvailable` changes what the server sees.
  return Object.assign(state, {
    port: (server.address() as net.AddressInfo).port,
    keys,
    close: () => (server.closeAllConnections(), new Promise<void>((r) => server.close(() => r()))),
  });
}
export type StandInRouter = Awaited<ReturnType<typeof startRouter>>;

// ---- Tor ---------------------------------------------------------------------------------------------------------

export type Asked = { methods: number[]; username?: string; atyp: number; host: string; port: number };
export type TorMode = "tunnel" | "refuse" | "drop-after-request";

/**
 * A SOCKS5 server standing in for a Tor client. A request for the onion name is connected to `routerPort`; a request for
 * any other name is refused (as Tor would refuse an unknown onion), and every request is recorded.
 */
export async function startTor(routes: Record<string, number>) {
  const asked: Asked[] = [];
  const sockets = new Set<net.Socket>();
  const state = { mode: "tunnel" as TorMode, asked, connections: 0 };
  const server = net.createServer((client) => {
    state.connections++;
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    let stage: "greeting" | "auth" | "request" | "tunnel" = "greeting";
    let record: Asked = { methods: [], atyp: 0, host: "", port: 0 };
    client.on("data", (d: Buffer) => {
      if (stage === "tunnel") return;
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === "greeting") {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          record.methods = [...buf.subarray(2, 2 + buf[1])];
          buf = buf.subarray(2 + buf[1]);
          const method = record.methods.includes(2) ? 2 : 0;
          client.write(Buffer.from([5, method]));
          stage = method === 2 ? "auth" : "request";
        } else if (stage === "auth") {
          if (buf.length < 2 || buf.length < 3 + buf[1] || buf.length < 3 + buf[1] + buf[2 + buf[1]]) return;
          record.username = buf.subarray(2, 2 + buf[1]).toString();
          buf = buf.subarray(3 + buf[1] + buf[2 + buf[1]]);
          client.write(Buffer.from([1, 0]));
          stage = "request";
        } else if (stage === "request") {
          if (buf.length < 5 || buf.length < 7 + buf[4]) return;
          record = { ...record, atyp: buf[3], host: buf.subarray(5, 5 + buf[4]).toString(), port: (buf[5 + buf[4]] << 8) | buf[6 + buf[4]] };
          const rest = buf.subarray(7 + buf[4]);
          asked.push(record);
          const target = routes[record.host];
          if (state.mode === "refuse" || target === undefined) return void client.end(Buffer.from([5, target === undefined ? 4 : 5, 0, 1, 0, 0, 0, 0, 0, 0]));
          stage = "tunnel";
          const upstream = net.createConnection({ host: "127.0.0.1", port: target }); // createConnection, so a test that watches net.connect sees only the program under test
          upstream.on("error", () => client.destroy());
          client.on("close", () => upstream.destroy());
          upstream.on("close", () => client.end());
          upstream.on("connect", () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (rest.length) upstream.write(rest);
            if (state.mode === "drop-after-request") {
              // Take the request, hand it to the router, then vanish before an answer comes back.
              client.once("data", (x) => {
                upstream.write(x);
                setTimeout(() => (upstream.destroy(), client.destroy()), 150);
              });
              return;
            }
            client.on("data", (x) => upstream.write(x));
            upstream.on("data", (x) => client.write(x));
          });
          return;
        } else return;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return Object.assign(state, {
    port: (server.address() as net.AddressInfo).port,
    close: () => (sockets.forEach((s) => s.destroy()), new Promise<void>((r) => server.close(() => r()))),
  });
}
export type StandInTor = Awaited<ReturnType<typeof startTor>>;

/** Something that listens but does not speak SOCKS5. */
export async function startNotSocks() {
  const server = net.createServer((s) => (s.on("error", () => undefined), s.end("HTTP/1.1 400 Bad Request\r\n\r\n")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A certificate for `name`, made with the openssl command; null when it is not installed. */
export function selfSigned(name: string, dir: string): { key: string; cert: string } | null {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`, "-days", "2"], { stdout: "ignore", stderr: "ignore" });
  return made.exitCode === 0 ? { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") } : null;
}

export async function startTlsServer(pem: { key: string; cert: string }, answer: (path: string) => unknown) {
  const server = tls.createServer(pem, (socket) => {
    socket.on("error", () => undefined);
    socket.once("data", (d: Buffer) => {
      const pathName = /^GET (\S+)/.exec(d.toString())?.[1] ?? "/";
      const body = JSON.stringify(answer(pathName));
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The output of a CLI run, and the Io to capture it. */
export function capture(env: Record<string, string | undefined>, extra: { directFetch?: typeof fetch } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s), env, ...extra }, out: () => out.join(""), err: () => err.join("") };
}

import net from "node:net";

// A minimal HTTP/1.1 client that reaches its target through a SOCKS5 proxy (RFC 1928, with the username/password method
// of RFC 1929), used to reach a gateway that is an onion service through a local Tor client. It exists because the
// runtime's fetch does not speak SOCKS.
//
// Two properties matter for privacy. The target's name is always handed to the proxy as a name (address type 3) and is
// never resolved here: a .onion name resolves nowhere else, and a lookup on this host would show what it connects to.
// And the request is built from nothing but the pieces the caller passes; the client adds a Host, a Content-Length and
// `Connection: close`, one request per tunnel, so nothing from one request can carry over into the next.
//
// Only plain http:// targets are supported. An onion service already authenticates and encrypts the connection end to end.

export type SocksProxy = { host: string; port: number; username?: string; password?: string };

/** A failure to reach the proxy, to authenticate to it, or of the proxy to reach the target. */
export class SocksError extends Error {
  override name = "SocksError";
}

/** What the proxy said when it could not connect: the SOCKS5 reply codes, and the extra ones Tor adds for onion services. */
const REPLIES: Record<number, string> = {
  1: "general proxy failure",
  2: "connection not allowed by the proxy",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
  0xf0: "onion service descriptor not found",
  0xf1: "onion service descriptor invalid",
  0xf2: "onion service introduction failed",
  0xf3: "onion service rendezvous failed",
  0xf4: "onion service needs client authorization",
  0xf5: "onion service client authorization is wrong",
  0xf6: "onion service address is invalid",
  0xf7: "onion service introduction timed out",
};

/** Buffers what a socket receives and hands it out in the sizes the protocol parsers ask for. */
class Reader {
  private chunks: Buffer[] = [];
  private length = 0;
  private received = 0;
  private connected = false;
  private closed = false;
  private failure: Error | null = null;
  private waiting: (() => void) | null = null;

  constructor(
    private readonly socket: net.Socket,
    private readonly limit: number,
  ) {
    socket.on("connect", () => this.wake(() => (this.connected = true)));
    socket.on("data", (d: Buffer) =>
      this.wake(() => {
        this.chunks.push(d);
        this.length += d.length;
        this.received += d.length;
        if (this.received > this.limit) {
          this.failure ??= new Error("The response is larger than allowed.");
          socket.destroy();
        }
      }),
    );
    socket.on("end", () => this.wake(() => (this.closed = true)));
    socket.on("close", () => this.wake(() => (this.closed = true)));
    socket.on("error", (e) => this.wake(() => (this.failure ??= e)));
  }

  private wake(update: () => unknown) {
    update();
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  private changed() {
    return new Promise<void>((resolve) => (this.waiting = resolve));
  }

  private flatten(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  private consume(n: number): Buffer {
    const all = this.flatten();
    const out = all.subarray(0, n);
    this.chunks = n < all.length ? [all.subarray(n)] : [];
    this.length -= n;
    return out;
  }

  private check(needMore: boolean) {
    if (this.failure) throw this.failure;
    if (needMore && this.closed) throw new Error("The connection closed before the message was complete.");
  }

  async ready(): Promise<void> {
    while (!this.connected) {
      this.check(true);
      await this.changed();
    }
  }

  /** Exactly n bytes. */
  async take(n: number): Promise<Buffer> {
    while (this.length < n) {
      this.check(true);
      await this.changed();
    }
    return this.consume(n);
  }

  /** Everything up to and including `delimiter`. */
  async takeUntil(delimiter: string, max: number): Promise<Buffer> {
    const d = Buffer.from(delimiter, "latin1");
    for (;;) {
      const at = this.flatten().indexOf(d);
      if (at >= 0 && at + d.length <= max) return this.consume(at + d.length);
      if (at >= 0 || this.length > max) throw new Error("A header or line in the response is too long.");
      this.check(true);
      await this.changed();
    }
  }

  /** Everything until the peer closes the connection. */
  async takeToEnd(): Promise<Buffer> {
    while (!this.closed) {
      this.check(false);
      await this.changed();
    }
    this.check(false);
    return this.consume(this.length);
  }
}

const write = (socket: net.Socket, data: Uint8Array) => new Promise<void>((resolve, reject) => socket.write(data, (e) => (e ? reject(e) : resolve())));

/** Open a tunnel to host:port through the proxy. The host is sent as a name, never resolved here. */
async function tunnel(socket: net.Socket, reader: Reader, proxy: SocksProxy, host: string, port: number) {
  const name = Buffer.from(host, "latin1");
  if (!name.length || name.length > 255 || /[^\x21-\x7e]/.test(host)) throw new SocksError("The target name cannot be sent to a SOCKS5 proxy.");
  await reader.ready();

  const withAuth = proxy.username !== undefined;
  await write(socket, Uint8Array.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]));
  const choice = await reader.take(2);
  if (choice[0] !== 5) throw new SocksError("The proxy did not answer as a SOCKS5 proxy.");
  if (choice[1] === 0x02 && withAuth) {
    const user = Buffer.from(proxy.username!, "utf8");
    const pass = Buffer.from(proxy.password ?? "", "utf8");
    await write(socket, Buffer.concat([Uint8Array.from([1, user.length]), user, Uint8Array.from([pass.length]), pass]));
    const verdict = await reader.take(2);
    if (verdict[1] !== 0) throw new SocksError("The proxy refused the credentials.");
  } else if (choice[1] !== 0x00) {
    throw new SocksError("The proxy accepts none of the offered authentication methods.");
  }

  await write(socket, Buffer.concat([Uint8Array.from([5, 1, 0, 3, name.length]), name, Uint8Array.from([port >> 8, port & 0xff])]));
  const reply = await reader.take(4);
  if (reply[0] !== 5) throw new SocksError("The proxy did not answer as a SOCKS5 proxy.");
  if (reply[1] !== 0) throw new SocksError(`The proxy could not connect: ${REPLIES[reply[1]] ?? `reply code ${reply[1]}`}.`);
  const bound = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await reader.take(1))[0] : -1;
  if (bound < 0) throw new SocksError("The proxy sent an address type that was not asked for.");
  await reader.take(bound + 2);
}

const HEAD_MAX = 16 * 1024;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Reject a request the caller could not have meant: a line break in a name or value would split the message. */
function headerLine(name: string, value: string): string {
  if (!TOKEN.test(name) || /[\r\n\0]/.test(value)) throw new SocksError("A request header is not valid.");
  return `${name}: ${value}\r\n`;
}

async function readChunked(reader: Reader, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const line = (await reader.takeUntil("\r\n", 1024)).toString("latin1");
    const m = /^([0-9a-fA-F]{1,8})(?:;[^\r\n]*)?\r\n$/.exec(line);
    if (!m) throw new Error("The response has a malformed chunk.");
    const size = parseInt(m[1], 16);
    if (size === 0) {
      for (;;) if ((await reader.takeUntil("\r\n", 8192)).length === 2) return Buffer.concat(parts);
    }
    total += size;
    if (total > max) throw new Error("The response is larger than allowed.");
    parts.push(await reader.take(size));
    if ((await reader.take(2)).toString("latin1") !== "\r\n") throw new Error("The response has a malformed chunk.");
  }
}

export type SocksFetchInit = { method?: string; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal };

/**
 * A `fetch` for http:// URLs through the proxy. Supports what a relay needs: one request with a body, one response, no
 * redirects (a 3xx is returned as it came), and every failure to reach the target is an exception. Aborting the signal
 * closes the tunnel and throws the signal's reason.
 */
export function createSocksFetch(proxy: SocksProxy, opts: { maxResponseBytes: number }) {
  return async (input: string | URL, init: SocksFetchInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    if (url.protocol !== "http:") throw new SocksError("Only http:// targets can be reached through the proxy.");
    const method = init.method ?? "GET";
    // Built before anything is connected, so a request that cannot be sent never reaches the proxy.
    const body = init.body ?? new Uint8Array(0);
    let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n`;
    for (const [name, value] of Object.entries(init.headers ?? {})) head += headerLine(name, value);
    head += `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const reader = new Reader(socket, opts.maxResponseBytes + 2 * HEAD_MAX);
    const abort = () => socket.destroy();
    if (init.signal?.aborted) abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    try {
      try {
        socket.setNoDelay(true);
        await tunnel(socket, reader, proxy, url.hostname, Number(url.port || 80));
      } catch (e) {
        // A failure before the tunnel is up is the proxy's (or the target's, as the proxy reports it).
        throw e instanceof SocksError ? e : new SocksError(`The proxy could not be used: ${(e as Error).message}`);
      }

      await write(socket, Buffer.concat([Buffer.from(head, "latin1"), body]));

      // The response, skipping interim 1xx answers.
      let status = 0;
      let lines: string[] = [];
      do {
        const raw = (await reader.takeUntil("\r\n\r\n", HEAD_MAX)).toString("latin1");
        lines = raw.slice(0, -4).split("\r\n");
        const m = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0]);
        if (!m) throw new Error("The response is not HTTP/1.x.");
        status = Number(m[1]);
      } while (status >= 100 && status < 200 && status !== 101);
      if (status < 200 || status > 599) throw new Error("The response has an unsupported status.");

      const headers = new Headers();
      const lengths = new Set<string>();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        const name = colon > 0 ? line.slice(0, colon) : "";
        if (!TOKEN.test(name)) throw new Error("The response has a malformed header.");
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "content-length") lengths.add(value);
        headers.append(name, value);
      }

      let payload: Buffer;
      if (method === "HEAD" || status === 204 || status === 304) payload = Buffer.alloc(0);
      else if (/(^|,)\s*chunked\s*$/i.test(headers.get("transfer-encoding") ?? "")) payload = await readChunked(reader, opts.maxResponseBytes);
      else if (lengths.size) {
        const [only] = [...lengths];
        if (lengths.size !== 1 || !/^\d{1,10}$/.test(only) || Number(only) > opts.maxResponseBytes) throw new Error("The response has an invalid Content-Length.");
        payload = await reader.take(Number(only));
      } else payload = await reader.takeToEnd();

      // What the Response object needs to be a plain, complete message.
      headers.delete("transfer-encoding");
      headers.delete("content-length");
      return new Response(payload.length ? payload : null, { status, headers });
    } catch (e) {
      if (init.signal?.aborted) throw init.signal.reason;
      throw e;
    } finally {
      init.signal?.removeEventListener("abort", abort);
      socket.destroy();
    }
  };
}

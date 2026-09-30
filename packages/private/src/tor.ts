import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parseOnionAddress } from "./onion.ts";
import { createSocksFetch, type SocksFetchInit, type SocksFetchOptions, type SocksProxy } from "./socks.ts";

// Everything that talks to the network goes through here, and every byte goes to your Tor client's SOCKS5 port: the
// only address this program ever connects to is that port. There is no other way out and no fallback. If Tor is not
// running, nothing is sent.

export const DEFAULT_ROUTER = "https://anyroute.tech";
export type TorCandidate = { host: string; port: number; label: string };
export const DEFAULT_SOCKS: readonly TorCandidate[] = [
  { host: "127.0.0.1", port: 9050, label: "Tor daemon" },
  { host: "127.0.0.1", port: 9150, label: "Tor Browser" },
];

export class TorUnavailable extends Error {
  override name = "TorUnavailable";
}

export type TorProxy = SocksProxy & { label: string };

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;

/** Read "host:port" (host may be an IPv6 address in brackets). */
export function parseHostPort(raw: string): { host: string; port: number } {
  const m = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(raw.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new TorUnavailable(`"${raw}" is not host:port (for example 127.0.0.1:9050).`);
  return { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

/** Does something on host:port answer the SOCKS5 greeting the way a SOCKS5 proxy does? Never leaves the machine unless host does. */
export function probeSocks(host: string, port: number, timeoutMs = 2_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => socket.write(Uint8Array.from([5, 1, 0])));
    socket.once("data", (d: Buffer) => done(d.length >= 2 && d[0] === 5 && d[1] === 0));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}

/**
 * Find the Tor client: `explicit` (--socks or ANYROUTE_SOCKS) if given, else a Tor daemon on 127.0.0.1:9050, else
 * Tor Browser on 127.0.0.1:9150. Throws TorUnavailable, with what to do about it, if none answers.
 *
 * A SOCKS port on another machine is refused unless `allowRemote`: the request travels to the proxy unencrypted, and
 * only the proxy encrypts it for Tor, so anyone on the path to a remote proxy could read the prompt and the token.
 */
export async function detectTor(o: { explicit?: string; allowRemote?: boolean; candidates?: readonly TorCandidate[] } = {}): Promise<TorProxy> {
  if (o.explicit) {
    const { host, port } = parseHostPort(o.explicit);
    if (!LOOPBACK.test(host) && !o.allowRemote)
      throw new TorUnavailable(`${o.explicit} is not on this machine. The request reaches a SOCKS proxy unencrypted, so a proxy anywhere else can read your prompts and tokens. Use a Tor client on this machine, or pass --allow-remote-socks if you control the network path to it.`);
    if (!(await probeSocks(host, port))) throw new TorUnavailable(`Nothing that speaks SOCKS5 answers at ${o.explicit}. Start Tor there, or leave --socks out to look at 127.0.0.1:9050 and 127.0.0.1:9150.`);
    return { host, port, label: "the SOCKS proxy you gave" };
  }
  const candidates = o.candidates ?? DEFAULT_SOCKS;
  for (const c of candidates) if (await probeSocks(c.host, c.port)) return { ...c };
  throw new TorUnavailable(
    `Tor is not running: nothing answers on ${candidates.map((c) => `${c.host}:${c.port}`).join(" or ")}. Nothing was sent, and nothing will be sent without Tor.\n` +
      "  Start Tor and run this again:\n" +
      "    macOS:  brew install tor && brew services start tor      (or open Tor Browser and leave it running)\n" +
      "    Linux:  sudo apt install tor && sudo systemctl start tor\n" +
      "  Or point at your own Tor client with --socks host:port.",
  );
}

export type TorFetchOptions = {
  /** Give every call its own Tor circuit (a random SOCKS user name each time). On by default. */
  isolate?: boolean;
  maxResponseBytes?: number;
  tls?: SocksFetchOptions["tls"];
};
export type TorFetch = (url: string, init?: SocksFetchInit) => Promise<Response>;

/**
 * A fetch that goes through the Tor client. With isolation (the default) each call sends its own random SOCKS user
 * name, which makes Tor build a separate circuit for it, so two calls are not carried on one circuit.
 */
export function torFetch(proxy: TorProxy, o: TorFetchOptions = {}): TorFetch {
  const inner = (auth?: { username: string; password: string }) => createSocksFetch({ host: proxy.host, port: proxy.port, ...auth }, { maxResponseBytes: o.maxResponseBytes ?? 64 * 1024 * 1024, tls: o.tls });
  const shared = o.isolate === false ? inner() : null;
  return (url, init) => (shared ?? inner({ username: "ar-" + randomBytes(9).toString("hex"), password: "x" }))(url, init);
}

/** A `fetch` in the shape @anyroute/client's blind module takes, over Tor. */
export function asClientFetch(f: TorFetch, timeoutMs = 90_000): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? new TextEncoder().encode(init.body) : (init.body as Uint8Array);
    return f(String(input), { method: init?.method ?? "GET", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  };
}

// ---- asking the router -----------------------------------------------------------------------------------------

/** What GET /api/v1/status says that this tool needs. */
export type RouterStatus = { onion: string | null; unlinkable: { available: boolean; via: string[]; models: number | null } };

function readStatus(json: unknown): RouterStatus {
  const data = (json as { data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== "object") throw new Error("The answer is not a router status.");
  const lane = data.lanes?.unlinkable;
  let onion: string | null = null;
  if (typeof data.onion?.address === "string") {
    try {
      onion = parseOnionAddress(data.onion.address);
    } catch {
      onion = null;
    }
  }
  return {
    onion,
    unlinkable: { available: lane?.available === true, via: Array.isArray(lane?.via) ? lane.via.filter((v: unknown) => typeof v === "string") : [], models: typeof lane?.models === "number" ? lane.models : null },
  };
}

async function getJson(f: TorFetch, url: string, timeoutMs: number): Promise<unknown> {
  const res = await f(url, { headers: { accept: "application/json", "user-agent": "anyroute-private" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url.replace(/^(https?:\/\/[^/]+).*/, "$1")} answered ${res.status}.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The answer is not JSON.");
  }
}

/** The router's own status, asked over Tor at its public name (through an exit; the certificate is checked). */
export async function fetchRouterStatus(f: TorFetch, router: string): Promise<RouterStatus> {
  return readStatus(await getJson(f, `${router.replace(/\/$/, "")}/api/v1/status`, 90_000));
}

/** The status as the onion service itself gives it: proof that the address answers, and whether it serves the lane. */
export async function fetchOnionStatus(f: TorFetch, onion: string, timeoutMs = 120_000): Promise<RouterStatus> {
  return readStatus(await getJson(f, `http://${onion}/api/v1/status`, timeoutMs));
}

// ---- which onion address ---------------------------------------------------------------------------------------

export type OnionChoice = { onion: string; source: "option" | "router" | "saved"; note?: string };

/**
 * The onion address to use. `given` (--onion or ANYROUTE_ONION) wins. Otherwise the router is asked for it over Tor (its
 * public name, through an exit, never directly) and the answer is saved; if it cannot be asked, the address saved
 * from the last time is used and the note says so. Failing all of that, the error says how to pass one.
 */
export async function chooseOnion(o: { given?: string; router: string; f: TorFetch; dir: string }): Promise<OnionChoice> {
  if (o.given) return { onion: parseOnionAddress(o.given), source: "option" };
  const saved = path.join(o.dir, "router.json");
  try {
    const status = await fetchRouterStatus(o.f, o.router);
    if (!status.onion) throw new Error("It does not publish an onion address.");
    await fs.mkdir(o.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(saved, JSON.stringify({ router: o.router, onion: status.onion, seen_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
    return { onion: status.onion, source: "router" };
  } catch (e) {
    const remembered = await fs.readFile(saved, "utf8").then((t) => JSON.parse(t) as { router?: string; onion?: string; seen_at?: string }, () => null);
    if (remembered?.router === o.router && typeof remembered.onion === "string") {
      try {
        return { onion: parseOnionAddress(remembered.onion), source: "saved", note: `Could not ask ${o.router} for its onion address over Tor (${(e as Error).message}); using the one saved on ${remembered.seen_at?.slice(0, 10) ?? "an earlier run"}.` };
      } catch {
        // fall through to the error below
      }
    }
    throw new Error(`Could not get ${o.router}'s onion address over Tor: ${(e as Error).message} Pass it with --onion <address> (it is in GET /api/v1/status as onion.address, and on the documentation page).`);
  }
}

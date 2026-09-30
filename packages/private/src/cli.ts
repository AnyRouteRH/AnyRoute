import { parseArgs, intOption, UsageError, type OptionSpec, type Parsed } from "./args.ts";
import { asClientFetch, chooseOnion, detectTor, DEFAULT_ROUTER, fetchOnionStatus, torFetch, TorUnavailable, type RouterStatus, type TorCandidate, type TorProxy } from "./tor.ts";
import { startProxy } from "./proxy.ts";
import { purchase, PurchaseError } from "./purchase.ts";
import { stateDir, StoreError, TokenStore } from "./store.ts";
import { VERSION } from "./version.ts";

export type Io = {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  /** The runtime's own fetch, used only by `buy --clearnet`. Nothing else in this program can reach the network directly. */
  directFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};
export type CliHooks = {
  /** Where to look for Tor when --socks is not given. */
  torCandidates?: readonly TorCandidate[];
  /** Called with the port once `start` is serving. */
  onStarted?: (port: number) => void;
  /** `start` returns when this aborts (a process also stops on SIGINT and SIGTERM). */
  stop?: AbortSignal;
};

const USAGE = `anyroute-private ${VERSION}: make any OpenAI-compatible app private in one command.

A local proxy that sends every call to AnyRoute over Tor, on the unlinkable lane, paid with blind tokens.
The router still reads each prompt. What it does not learn is who sent it and who paid.

Usage
  anyroute-private buy --key <API key> --count <n> [--denomination 10000]
  anyroute-private start [--port 8788]
  anyroute-private status [--json]

Commands
  buy      Buy blind tokens with an API key that has credits, over Tor. Saved to ~/.anyroute/tokens.json (mode 0600).
           One token pays for one call. Tokens expire at the end of the router's redemption window (one to two weeks).
  start    Serve an OpenAI-compatible API on 127.0.0.1. Refuses to start unless Tor is reachable. Never uses the clearnet.
  status   Show whether Tor and the onion service answer, whether the lane is available, and how many tokens are left.

Options
  --socks <host:port>     Your Tor client's SOCKS5 port. Default: 127.0.0.1:9050 (Tor daemon), then 127.0.0.1:9150 (Tor Browser).
  --onion <address>       The router's onion address. Default: asked from the router over Tor (and saved).
  --router <url>          The router's public name, used only to ask for its onion address. Default: ${DEFAULT_ROUTER}
  --allow-remote-socks    Allow a SOCKS port that is not on this machine (the request reaches it unencrypted).
  buy:    --key <API key> (or ANYROUTE_API_KEY), --count <1-1000>, --denomination <1000|10000|100000> (default 10000),
          --clearnet to buy without Tor (the router then sees your network address; the tokens stay unlinkable)
  start:  --port <n> (default 8788), --local-key <secret> (require it as the app's API key), --shared-circuit (reuse one Tor
          circuit instead of one per call), --max-concurrent <n> (default 8), --timeout <seconds> (default 600), --quiet
  status: --json

Environment  ANYROUTE_API_KEY, ANYROUTE_HOME (default ~/.anyroute), ANYROUTE_SOCKS, ANYROUTE_ONION, ANYROUTE_ROUTER
`;

const COMMON = { values: ["socks", "onion", "router"], flags: ["allow-remote-socks", "help", "version"] } as const;
const SPECS: Record<string, OptionSpec> = {
  buy: { values: [...COMMON.values, "key", "count", "denomination"], flags: [...COMMON.flags, "clearnet"] },
  start: { values: [...COMMON.values, "port", "local-key", "max-concurrent", "timeout"], flags: [...COMMON.flags, "shared-circuit", "quiet"] },
  status: { values: [...COMMON.values], flags: [...COMMON.flags, "json"] },
};

/** 0.02 -> $0.02, 0.2 -> $0.20, 0.002 -> $0.002. */
function usd(value: string): string {
  const s = Number(value).toFixed(6).replace(/0+$/, "");
  return "$" + (s.endsWith(".") ? s + "00" : /\.\d$/.test(s) ? s + "0" : s);
}

/** How to point apps at the proxy. */
export function howToUse(port: number, localKey = false): string {
  const base = `http://127.0.0.1:${port}/v1`;
  return [
    "Point an app at it:",
    "  OpenAI SDKs and most tools:",
    `    export OPENAI_BASE_URL=${base}`,
    `    export OPENAI_API_KEY=${localKey ? "<your --local-key>" : "anyroute-private"}   # ${localKey ? "the proxy checks it and never forwards it" : "any non-empty value; the proxy discards it"}`,
    `  Cursor: Settings > Models > Override OpenAI Base URL: ${base} (API key: any value).`,
    "    Cursor may send requests from its own servers, which cannot reach an address on this machine and would see your",
    "    prompts. Check that your version calls the API from your computer before relying on it.",
    "  Claude Code and the Anthropic SDKs are not supported: the router takes the Messages API with an API key only.",
    `  Models on this lane: curl ${base}/models`,
  ].join("\n");
}

function laneText(s: RouterStatus): string {
  return s.unlinkable.available ? `available over ${s.unlinkable.via.join(" and ") || "an unnamed path"}${s.unlinkable.models != null ? `, ${s.unlinkable.models} models` : ""}` : "not available";
}

type Run = {
  args: Parsed;
  io: Io;
  hooks: CliHooks;
  dir: string;
  store: TokenStore;
  router: string;
  givenOnion: string | undefined;
  tor: () => Promise<TorProxy>;
};

export async function runCli(argv: readonly string[], io: Io, hooks: CliHooks = {}): Promise<number> {
  try {
    const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
    if (argv.includes("--version") || argv.includes("-v") || command === "version") return io.out(VERSION + "\n"), 0;
    if (argv.length === 0 || command === "help" || argv.includes("--help") || argv.includes("-h")) return io.out(USAGE), 0;
    if (command === undefined) throw new UsageError("Say what to do: buy, start or status. Run with --help for the options.");
    const spec = SPECS[command];
    if (!spec) throw new UsageError(`Unknown command "${command}". Commands: buy, start, status.`);
    const args = parseArgs(argv.slice(1), spec);
    if (args.positionals.length) throw new UsageError(`Unexpected argument "${args.positionals[0]}".`);

    const env = io.env;
    const dir = stateDir(env);
    const explicitSocks = args.options.get("socks") ?? env.ANYROUTE_SOCKS;
    const run: Run = {
      args,
      io,
      hooks,
      dir,
      store: new TokenStore(dir, (m) => io.err(`warning: ${m}\n`)),
      router: (args.options.get("router") ?? env.ANYROUTE_ROUTER ?? DEFAULT_ROUTER).replace(/\/$/, ""),
      givenOnion: args.options.get("onion") ?? env.ANYROUTE_ONION,
      tor: () => detectTor({ explicit: explicitSocks, allowRemote: args.flags.has("allow-remote-socks"), candidates: hooks.torCandidates }),
    };
    if (command === "buy") return await buy(run, env);
    if (command === "start") return await start(run);
    return await status(run);
  } catch (e) {
    if (e instanceof UsageError) io.err(`${e.message}\n`);
    else if (e instanceof TorUnavailable || e instanceof PurchaseError || e instanceof StoreError) io.err(`${e.message}\n`);
    else io.err(`${(e as Error).message}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

// ---- buy ---------------------------------------------------------------------------------------------------------

async function buy(r: Run, env: Io["env"]): Promise<number> {
  const { args, io } = r;
  const apiKey = (args.options.get("key") ?? env.ANYROUTE_API_KEY ?? "").trim();
  if (!/^sk-ar-v1-[0-9a-f]{64}$/.test(apiKey)) throw new UsageError("Give the API key to pay with: --key sk-ar-v1-… (or set ANYROUTE_API_KEY). It needs credits.");
  const count = intOption("count", args.options.get("count"), 0, 1, 1000);
  if (!count) throw new UsageError("Say how many tokens to buy: --count 20");
  const denomination = intOption("denomination", args.options.get("denomination"), 10_000, 1000, 100_000);
  if (![1000, 10_000, 100_000].includes(denomination)) throw new UsageError("--denomination must be 1000, 10000 or 100000.");

  let baseUrl: string;
  let fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  if (args.flags.has("clearnet")) {
    io.err("Buying without Tor: the router will see your network address with this purchase. The tokens you get stay unlinkable to it.\n");
    baseUrl = r.router;
    const direct = io.directFetch;
    if (!direct) throw new UsageError("--clearnet is not available in this environment.");
    fetchImpl = direct;
  } else {
    const proxy = await r.tor();
    const f = torFetch(proxy);
    io.err(`Tor found at ${proxy.host}:${proxy.port} (${proxy.label}).\n`);
    const choice = await chooseOnion({ given: r.givenOnion, router: r.router, f, dir: r.dir });
    if (choice.note) io.err(`warning: ${choice.note}\n`);
    baseUrl = `http://${choice.onion}`;
    fetchImpl = asClientFetch(f, 180_000);
  }
  io.err(`Buying ${count} token${count === 1 ? "" : "s"} of ${denomination} units. The first call over Tor can take a minute.\n`);
  const bought = await purchase({ fetch: fetchImpl, baseUrl, apiKey, denomination, count, store: r.store, log: (l) => io.err(l + "\n") });
  const left = await r.store.summary();
  io.out(`Bought ${bought.count} tokens of ${bought.denomination} units (${usd(bought.valueUsd)} each, ${usd(bought.costUsd)} in total).\n`);
  io.out(`Saved in ${r.store.file} (mode 0600). Usable tokens: ${left.usable}.\n`);
  io.out(`These tokens can be spent until ${bought.redeemUntil.slice(0, 16).replace("T", " ")} UTC; after that they are worth nothing, so buy what you will use soon.\n`);
  io.out("A call spends one token whatever it costs; the rest of its value is not refunded. Next: anyroute-private start\n");
  return 0;
}

// ---- status ------------------------------------------------------------------------------------------------------

async function status(r: Run): Promise<number> {
  const { args, io } = r;
  const summary = await r.store.summary();
  const report: Record<string, unknown> = {
    tokens: { usable: summary.usable, expired: summary.expired, unconfirmed: summary.unconfirmed, by_denomination: summary.byDenomination, next_expiry: summary.nextExpiry, value_usd: summary.valueUsd },
  };
  let ok = summary.usable > 0;
  let proxy: TorProxy | null = null;
  let lane: RouterStatus | null = null;
  try {
    proxy = await r.tor();
    report.tor = { reachable: true, socks: `${proxy.host}:${proxy.port}`, kind: proxy.label };
  } catch (e) {
    if (!(e instanceof TorUnavailable)) throw e;
    ok = false;
    report.tor = { reachable: false, detail: e.message.split("\n")[0] };
  }
  if (proxy) {
    const f = torFetch(proxy);
    let onion: string | null = null;
    try {
      const choice = await chooseOnion({ given: r.givenOnion, router: r.router, f, dir: r.dir });
      onion = choice.onion;
      if (choice.note) io.err(`warning: ${choice.note}\n`);
      const started = Date.now();
      lane = await fetchOnionStatus(f, onion);
      report.onion = { address: onion, reachable: true, seconds: Math.round((Date.now() - started) / 100) / 10 };
      report.unlinkable_lane = { available: lane.unlinkable.available, via: lane.unlinkable.via, models: lane.unlinkable.models };
      if (!lane.unlinkable.available || !lane.unlinkable.via.includes("onion")) ok = false;
    } catch (e) {
      ok = false;
      report.onion = { address: onion, reachable: false, detail: (e as Error).message };
    }
  }
  report.ready = ok;

  if (args.flags.has("json")) {
    io.out(JSON.stringify(report, null, 2) + "\n");
    return ok ? 0 : 1;
  }
  const line = (label: string, text: string) => io.out(`${label.padEnd(18)}${text}\n`);
  const t = report.tor as { reachable: boolean; socks?: string; kind?: string; detail?: string };
  line("Tor:", t.reachable ? `reachable at ${t.socks} (${t.kind})` : `NOT reachable. ${t.detail}`);
  if (proxy) {
    const o = report.onion as { address: string | null; reachable: boolean; seconds?: number; detail?: string };
    line("Onion service:", o.reachable ? `${o.address} answers (${o.seconds} s)` : `${o.address ?? "address unknown"}: NOT reachable. ${o.detail}`);
    if (lane) line("Unlinkable lane:", laneText(lane));
  }
  const byDenomination = Object.entries(summary.byDenomination).map(([d, n]) => `${n} x ${d} units`).join(", ");
  line(
    "Blind tokens:",
    `${summary.usable} usable${summary.usable ? ` (${byDenomination}; ${usd(summary.valueUsd)} of face value)` : ""}${summary.expired ? `, ${summary.expired} expired` : ""}${summary.unconfirmed ? `, ${summary.unconfirmed} sent without an answer (they may have been spent; they are not used again)` : ""}`,
  );
  if (summary.usable === 0) io.out("  Buy some with: anyroute-private buy --key <your API key> --count 20\n");
  if (summary.nextExpiry) io.out(`  The soonest expiry is ${summary.nextExpiry.slice(0, 16).replace("T", " ")} UTC.\n`);
  return ok ? 0 : 1;
}

// ---- start -------------------------------------------------------------------------------------------------------

async function start(r: Run): Promise<number> {
  const { args, io, hooks } = r;
  const port = intOption("port", args.options.get("port"), 8788, 0, 65535);
  const maxConcurrent = intOption("max-concurrent", args.options.get("max-concurrent"), 8, 1, 64);
  const timeout = intOption("timeout", args.options.get("timeout"), 600, 10, 86_400);
  const localKey = args.options.get("local-key");
  if (localKey !== undefined && localKey.length < 8) throw new UsageError("--local-key must be at least 8 characters.");
  const shared = args.flags.has("shared-circuit");

  // Tor first: with no Tor client nothing else is attempted, and nothing is ever sent without it.
  const proxy = await r.tor();
  io.err(`Tor found at ${proxy.host}:${proxy.port} (${proxy.label}). Reaching the router's onion service; the first connection can take a minute.\n`);
  const bootstrap = torFetch(proxy);
  const choice = await chooseOnion({ given: r.givenOnion, router: r.router, f: bootstrap, dir: r.dir });
  if (choice.note) io.err(`warning: ${choice.note}\n`);
  let lane: RouterStatus;
  try {
    lane = await fetchOnionStatus(bootstrap, choice.onion);
  } catch (e) {
    io.err(`Cannot start: the onion service ${choice.onion} did not answer through Tor: ${(e as Error).message}\nNothing was sent anywhere else. Try again in a minute.\n`);
    return 1;
  }
  if (!lane.unlinkable.available || !lane.unlinkable.via.includes("onion")) {
    io.err(`Cannot start: the router does not serve the unlinkable lane over Tor right now (${laneText(lane)}). Without it a call could not be made private, so none will be made.\n`);
    return 1;
  }

  const summary = await r.store.summary();
  const running = await startProxy({
    port,
    onion: choice.onion,
    fetch: torFetch(proxy, { isolate: !shared }),
    store: r.store,
    localKey,
    maxConcurrent,
    idleTimeoutMs: timeout * 1000,
    log: args.flags.has("quiet") ? undefined : (l) => io.err(l + "\n"),
  });
  io.out(`anyroute-private is serving on http://127.0.0.1:${running.port} (this machine only)\n`);
  io.out(`  Tor:              ${proxy.host}:${proxy.port} (${proxy.label}); ${shared ? "one circuit shared by all calls" : "each call on its own circuit"}\n`);
  io.out(`  Router:           ${choice.onion}\n`);
  io.out(`  Unlinkable lane:  ${laneText(lane)}\n`);
  io.out(`  Blind tokens:     ${summary.usable} usable${summary.usable === 0 ? "   (none: buy some with: anyroute-private buy --key <your API key> --count 20)" : ""}\n\n`);
  io.out(howToUse(running.port, localKey !== undefined) + "\n\n");
  io.out("The router reads each prompt to answer it, and the model provider receives it. What stays hidden is who sent it (Tor) and who paid (blind tokens).\n");
  io.out("Press Ctrl-C to stop.\n");
  hooks.onStarted?.(running.port);

  await new Promise<void>((resolve) => {
    if (hooks.stop) {
      if (hooks.stop.aborted) resolve();
      else hooks.stop.addEventListener("abort", () => resolve(), { once: true });
    } else {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }
  });
  await running.close();
  io.err("Stopped.\n");
  return 0;
}

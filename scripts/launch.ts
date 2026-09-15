// One command to run all of Anyroute on this machine: a local chain with every contract deployed,
// three mock model providers, the router, and the website served at /.
//   bun run launch              # http://127.0.0.1:8787
//   bun run launch --fresh      # wipe the local chain and database first
//   bun run launch --open       # also open the site in the default browser
//   bun run launch --port 8800  # serve on another port
// If it is already running, it prints the address instead of starting a second copy.
// Chain state, the database and the admin token persist in .data/ between runs. Everything here is
// local test infrastructure: anvil's public development keys, mock USDG and Stock Tokens, mock models.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const DATA = resolve(ROOT, ".data");
const WEB = resolve(ROOT, "web");
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? `${process.env.HOME}/.foundry/bin`;
const CHAIN_PORT = 8546;
const CHAIN_ID = 4663;
const RPC = `http://127.0.0.1:${CHAIN_PORT}`;
const STATE_FILE = resolve(DATA, "anvil-4663.json");
const DB_DIR = resolve(DATA, "pglite-launch");
const SECRETS_FILE = resolve(DATA, "launch.env");
const ENV_LOCAL = resolve(ROOT, ".env.local");
const PROVIDER_PORTS = [9101, 9102, 9103];
// anvil development account #9 ("test test … junk"): funds the local test-USDG faucet.
const FAUCET_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const openBrowser = args.includes("--open");
const portArg = args.indexOf("--port");
const PORT_FIXED = portArg >= 0 || !!process.env.PORT;
let PORT = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.PORT ?? 8787);
let URL_BASE = `http://127.0.0.1:${PORT}`;

const children: { name: string; proc: Subprocess; signal: NodeJS.Signals }[] = [];
let stopping = false;
const say = (msg: string) => console.log(`[launch] ${msg}`);

function die(msg: string): never {
  console.error(`[launch] ${msg}`);
  void shutdown(1);
  throw new Error(msg);
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  // Router first (it may be writing), then providers, then the chain (SIGINT makes anvil save its state).
  for (const c of [...children].reverse()) {
    if (c.proc.exitCode !== null) continue;
    c.proc.kill(c.signal);
    await Promise.race([c.proc.exited, Bun.sleep(8_000)]);
    if (c.proc.exitCode === null) c.proc.kill("SIGKILL");
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

function spawn(name: string, cmd: string[], opts: { env?: Record<string, string>; log?: string; signal?: NodeJS.Signals } = {}) {
  const out = opts.log ? Bun.file(opts.log) : "inherit";
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...opts.env }, stdout: out, stderr: out, stdin: "ignore" });
  children.push({ name, proc, signal: opts.signal ?? "SIGTERM" });
  void proc.exited.then((code) => {
    if (!stopping) {
      console.error(`[launch] ${name} exited unexpectedly (code ${code})${opts.log ? `; see ${opts.log}` : ""}. Stopping.`);
      void shutdown(1);
    }
  });
  return proc;
}

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  const code = await proc.exited;
  if (code !== 0) die(`${cmd.join(" ")} failed (exit ${code}).`);
}

async function listening(port: number) {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open() {}, close() {}, error() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(250);
  }
  die(`${what} did not come up within ${timeoutMs / 1000}s.`);
}

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^'(.*)'$/, "$1");
  }
  return out;
}

function newestMtime(dir: string): number {
  let t = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name.startsWith(".")) continue;
    const p = resolve(dir, name.name);
    t = Math.max(t, name.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return t;
}

async function buildWebsite() {
  const index = resolve(WEB, "out/index.html");
  const sources = ["app", "components", "lib", "public"].map((d) => resolve(WEB, d)).filter(existsSync);
  const stale = !existsSync(index) || Math.max(...sources.map(newestMtime), statSync(resolve(WEB, "package.json")).mtimeMs) > statSync(index).mtimeMs;
  if (!stale) return say("website build is up to date");
  if (!Bun.which("pnpm")) {
    if (existsSync(index)) return say("website sources changed but pnpm is not installed; serving the existing build");
    return say("pnpm is not installed, so the website cannot be built; the router will serve its small built-in page");
  }
  if (!existsSync(resolve(WEB, "node_modules"))) {
    say("installing website dependencies (first run)…");
    await run(["pnpm", "install", "--frozen-lockfile"], WEB);
  }
  say("building the website…");
  await run(["pnpm", "build"], WEB);
}

/** An Anyroute router started by this launcher (local chain + test faucet) already serving on a nearby port? */
async function runningInstance(): Promise<string | null> {
  for (let port = 8787; port < 8807; port++) {
    if (!(await listening(port))) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { signal: AbortSignal.timeout(1500) });
      const d = ((await r.json()) as { data?: { dev_faucet?: boolean; chain?: { chain_id?: number } } }).data;
      if (d?.dev_faucet && d.chain?.chain_id === CHAIN_ID) return `http://127.0.0.1:${port}`;
    } catch {
      /* not ours */
    }
  }
  return null;
}

function openUrl(url: string) {
  Bun.spawn(process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", url] : ["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
}

async function main() {
  const existing = fresh ? null : await runningInstance();
  if (existing) {
    console.log(`\n  Anyroute is already running: ${existing}/  (dashboard: ${existing}/dashboard/)\n  Stop it with Ctrl-C in the terminal that started it, then run this again to restart.\n`);
    if (openBrowser) openUrl(existing + "/");
    process.exit(0);
  }
  for (const tool of ["anvil", "forge"]) if (!existsSync(`${FOUNDRY_BIN}/${tool}`)) die(`${tool} not found in ${FOUNDRY_BIN}. Install Foundry: https://getfoundry.sh`);
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) die("--port needs a port number.");
  if (await listening(PORT)) {
    if (PORT_FIXED) die(`port ${PORT} is already in use. Stop whatever is using it or pick another --port.`);
    const first = PORT;
    while (PORT < first + 20 && (await listening(PORT))) PORT++;
    if (await listening(PORT)) die(`ports ${first}-${PORT} are all in use; pass --port.`);
    URL_BASE = `http://127.0.0.1:${PORT}`;
    say(`port ${first} is busy (another program), using ${PORT} instead`);
  }
  for (const port of PROVIDER_PORTS) if (await listening(port)) die(`port ${port} (mock providers) is already in use — is another "bun run launch" still running? Stop it and retry.`);
  mkdirSync(DATA, { recursive: true });

  if (fresh) {
    say("--fresh: removing the local chain state and launch database");
    for (const p of [STATE_FILE, DB_DIR]) rmSync(p, { recursive: true, force: true });
  }

  await buildWebsite();

  // ---- chain
  if (await listening(CHAIN_PORT)) {
    const id = Number(await rpc<string>("eth_chainId").catch(() => "0x0"));
    if (id !== CHAIN_ID) die(`port ${CHAIN_PORT} is in use by something that is not the local Anyroute chain (chain id ${id}).`);
    say(`reusing the local chain already running on ${RPC}`);
  } else {
    say(`starting the local chain on ${RPC}${existsSync(STATE_FILE) ? " (restoring saved state)" : ""}`);
    spawn("anvil", [`${FOUNDRY_BIN}/anvil`, "--port", String(CHAIN_PORT), "--chain-id", String(CHAIN_ID), "--block-time", "1", "--state", STATE_FILE, "--state-interval", "15", "--silent"], { signal: "SIGINT" });
    await waitFor("the local chain", async () => Number(await rpc<string>("eth_chainId")) === CHAIN_ID, 30_000);
  }
  const deployed = async () => {
    const credits = readEnvFile(ENV_LOCAL).CREDITS_ADDRESS;
    return !!credits && (await rpc<string>("eth_getCode", [credits, "latest"]).catch(() => "0x")) !== "0x";
  };
  if (!(await deployed())) {
    say("deploying the contracts (first run, about a minute)…");
    rmSync(DB_DIR, { recursive: true, force: true }); // a new chain needs a new ledger
    await run(["bun", "scripts/deploy-local.ts"], ROOT);
    if (!(await deployed())) die("the contracts did not deploy; see the output above.");
  } else say("contracts already deployed");

  // ---- secrets for this local install (never committed; .data/ is ignored)
  if (!existsSync(SECRETS_FILE)) {
    writeFileSync(SECRETS_FILE, `APP_SECRET=${randomBytes(32).toString("hex")}\nADMIN_TOKEN=${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
  }
  const local = readEnvFile(ENV_LOCAL);
  const env: Record<string, string> = {
    ...local,
    ...readEnvFile(SECRETS_FILE),
    ANYROUTE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    PUBLIC_BASE_URL: URL_BASE,
    DATABASE_URL: `pglite://${DB_DIR}`,
    PUBLIC_RPC_URL: RPC,
    EXPLORER_URL: "",
    CHAIN_START_BLOCK: local.DEPLOY_BLOCK ?? "0",
    ALLOW_DEV_ATTESTATION: "true",
    CANARIES: "false",
    DEV_FAUCET: "true",
    DEV_FAUCET_PRIVATE_KEY: FAUCET_KEY,
    // Faster than production so the full flow is visible within minutes.
    ANCHOR_INTERVAL_MS: "120000",
    SETTLEMENT_INTERVAL_MS: "300000",
    PAYWITH_THRESHOLD_USD: "0.000001",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    WEB_DIR: resolve(WEB, "out"),
  };

  // ---- mock providers, then seed them (the database is single-process, so seed before the router)
  say("starting three mock model providers (ports 9101-9103)");
  spawn("mock providers", ["bun", "scripts/mock-providers.ts"], { log: resolve(DATA, "launch-providers.log") });
  await waitFor("the mock providers", async () => (await Promise.all(PROVIDER_PORTS.map(listening))).every(Boolean), 20_000);
  await run(["bun", "scripts/seed.ts", "config/providers.local.yaml"], ROOT, env);

  // ---- router + website
  say(`starting the router on ${URL_BASE}`);
  spawn("router", ["bun", "src/index.ts"], { env });
  await waitFor("the router", async () => (await fetch(`${URL_BASE}/health`)).ok, 60_000);

  const token = readEnvFile(SECRETS_FILE).ADMIN_TOKEN;
  console.log(`
  Anyroute is running locally.

    Website    ${URL_BASE}/
    Dashboard  ${URL_BASE}/dashboard/
    API        ${URL_BASE}/api/v1   (OpenAI/OpenRouter-compatible)
    Chain      ${RPC}   (local test chain, id ${CHAIN_ID})

  Try it: open the dashboard → "Create a new key" → Payments → Deposit → "Add 10 test USDG" →
  Playground. All money and models here are test fixtures.

  Admin token (tRPC at /trpc, header x-admin-token): ${token.slice(0, 6)}… in .data/launch.env
  Your chain, keys and balances are kept in .data/ between runs; "bun run launch --fresh" starts over.
  Press Ctrl-C to stop everything.
`);
  if (openBrowser) openUrl(URL_BASE + "/");
}

main().catch((e) => {
  if (!stopping) {
    console.error(`[launch] ${(e as Error).message}`);
    void shutdown(1);
  }
});

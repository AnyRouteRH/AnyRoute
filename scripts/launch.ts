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

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildBundle } from "../packages/private/scripts/build.ts";
import { VERSION } from "../packages/private/src/version.ts";
import { API_KEY, ONION, startRouter, startTor, tempDir, freePort, type StandInRouter, type StandInTor } from "./private-fixtures.ts";
import { purchase } from "../packages/private/src/purchase.ts";
import { TokenStore } from "../packages/private/src/store.ts";

setDefaultTimeout(60_000);

// The single-file program that the site serves at /private.mjs is built from packages/private and committed as
// web/public/private.mjs. These checks hold the two together, and run the file itself under Node.

const root = path.resolve(import.meta.dir, "..");
const served = path.join(root, "web/public/private.mjs");
const src = (name: string) => readFileSync(path.join(root, "packages/private/src", name), "utf8");
const pinnedBun = /bun-version:\s*'?([\d.]+)'?/.exec(readFileSync(path.join(root, ".github/workflows/release-checks.yml"), "utf8"))?.[1];

describe("the served file", () => {
  test.skipIf(Bun.version !== pinnedBun)("is exactly what the source builds to (rebuild with: bun packages/private/scripts/build.ts)", async () => {
    expect(readFileSync(served, "utf8")).toBe(await buildBundle());
  });

  test("is one readable file with its licences, no source map, and no path from the machine that built it", () => {
    const text = readFileSync(served, "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n// anyroute-private:")).toBe(true);
    expect(text).toContain("Apache License 2.0");
    expect(text).toContain("@cloudflare/blindrsa-ts 0.4.6");
    expect(text).toContain("Stanford University");
    expect(text).not.toContain("sourceMappingURL");
    expect(text).not.toMatch(/\/Users\/|\/home\/[a-z]|[A-Z]:\\\\Users/);
    expect(statSync(served).size).toBeLessThan(400_000);
    expect(text.split("\n").length).toBeGreaterThan(3000); // not minified
  });

  test("names its version, the version in package.json", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(path.join(root, "packages/private/package.json"), "utf8")).version);
    expect(readFileSync(served, "utf8")).toContain(`var VERSION = "${VERSION}";`);
  });

  test("the package is Apache-2.0, has no runtime dependencies and ships only its build, README and licence", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "packages/private/package.json"), "utf8"));
    expect(pkg.name).toBe("@anyroute/private");
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.bin).toEqual({ "anyroute-private": "./dist/anyroute-private.mjs" });
    expect(pkg.files.sort()).toEqual(["LICENSE", "README.md", "dist"]);
    expect(pkg.private).toBeUndefined();
  });
});

describe("no way out but Tor", () => {
  // The modules that touch the network, and the calls that would open a connection to something other than the SOCKS proxy.
  const forbidden = [/(?<![\w.])fetch\(/, /globalThis\.fetch/, /https?\.(request|get)\(/, /\bdns\b/, /node:dns/, /node:dgram/, /node:child_process/, /\bWebSocket\b/, /XMLHttpRequest/];
  for (const file of ["proxy.ts", "tor.ts", "socks.ts", "store.ts", "purchase.ts", "cli.ts", "onion.ts", "args.ts"]) {
    test(`${file} opens no connection of its own`, () => {
      const code = src(file).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const pattern of forbidden) expect(code).not.toMatch(pattern);
    });
  }

  test("the entry point switches off the runtime's fetch before anything runs, and hands the original only to `buy --clearnet`", () => {
    const main = src("main.ts");
    expect(main.indexOf("globalThis")).toBeGreaterThan(-1);
    expect(main.indexOf("globalThis")).toBeLessThan(main.indexOf("runCli("));
    expect(src("cli.ts").match(/directFetch/g)?.length).toBeGreaterThan(1);
    expect(src("cli.ts")).toMatch(/args\.flags\.has\("clearnet"\)/);
  });

  test("the only connections in socks.ts and tor.ts are to the proxy's own address, and the TLS session is wrapped around the tunnel", () => {
    const socks = src("socks.ts");
    expect([...socks.matchAll(/net\.connect\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["{ host: proxy.host, port: proxy.port }"]);
    expect(socks).toMatch(/tls\.connect\(\{ \.\.\.opts\.tls, socket: raw,/);
    expect([...src("tor.ts").matchAll(/net\.connect\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["{ host, port }"]);
  });
});

// ---- the file itself, under Node ---------------------------------------------------------------------------------

const nodeMajor = (() => {
  const run = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "ignore" });
  return run.exitCode === 0 ? Number(/^v(\d+)/.exec(run.stdout.toString())?.[1]) : 0;
})();

describe.skipIf(nodeMajor < 20)("run with node", () => {
  let router: StandInRouter;
  let tor: StandInTor;
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

  const node = (args: string[], env: Record<string, string>) => Bun.spawn(["node", served, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });

  test("prints its version and help", async () => {
    const version = Bun.spawnSync(["node", served, "--version"]);
    expect(version.stdout.toString().trim()).toBe(VERSION);
    const help = Bun.spawnSync(["node", served, "--help"]);
    expect(help.stdout.toString()).toContain("anyroute-private buy");
  });

  test("refuses to start without Tor and says what to do", async () => {
    const t = tempDir();
    dirs.push(t);
    const dead = await freePort();
    const run = Bun.spawnSync(["node", served, "start", "--socks", `127.0.0.1:${dead}`], { env: { PATH: process.env.PATH ?? "", ANYROUTE_HOME: t.dir } });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("Nothing that speaks SOCKS5");
    expect(run.stdout.toString()).toBe("");
  });

  test("buys, serves a streamed call and stops, all through the stand-in Tor client", async () => {
    const t = tempDir();
    dirs.push(t);
    const env = { ANYROUTE_HOME: t.dir, ANYROUTE_ONION: ONION, ANYROUTE_API_KEY: API_KEY };
    const asked = tor.asked.length;
    const bought = Bun.spawn(["node", served, "buy", "--count", "2", "--socks", `127.0.0.1:${tor.port}`], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
    expect(await bought.exited).toBe(0);
    expect(await new Response(bought.stdout).text()).toContain("Bought 2 tokens");

    const port = await freePort();
    const proc = node(["start", "--port", String(port), "--socks", `127.0.0.1:${tor.port}`, "--quiet"], env);
    const reader = proc.stdout.getReader();
    let out = "";
    while (!out.includes("Press Ctrl-C")) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain(`OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-app-key-0123456" }, body: JSON.stringify({ model: "stand-in/model-a", stream: true, messages: [] }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("[DONE]");
    const seen = router.seen.filter((s) => s.path === "/api/v1/chat/completions").at(-1)!;
    expect(seen.headers.authorization).toStartWith("PrivateToken token=");
    expect(JSON.stringify(seen)).not.toContain("sk-app-key");
    for (const a of tor.asked.slice(asked)) expect([a.host, a.atyp]).toEqual([ONION, 3]);
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(0);
  });

  test("the bundled program reads what the source writes: a store written by the source works in the file", async () => {
    const t = tempDir();
    dirs.push(t);
    await purchase({ fetch: (i, init) => fetch(i, init), baseUrl: `http://127.0.0.1:${router.port}`, apiKey: API_KEY, denomination: 10_000, count: 3, store: new TokenStore(t.dir) });
    // Asynchronously: the stand-ins run in this process, so it must stay free to answer.
    const run = node(["status", "--json", "--socks", `127.0.0.1:${tor.port}`], { ANYROUTE_HOME: t.dir, ANYROUTE_ONION: ONION });
    const report = JSON.parse(await new Response(run.stdout).text());
    expect(report.tokens.usable).toBe(3);
    expect(report.ready).toBe(true);
    expect(await run.exited).toBe(0);
  });
});

test("the hash the site shows is the hash of the file it serves", async () => {
  // @ts-expect-error web/lib is plain JavaScript, with no declarations
  const { privateProgram } = await import("../web/lib/private-proxy.js");
  const program = privateProgram(served);
  expect(program.sha256).toBe(createHash("sha256").update(readFileSync(served)).digest("hex"));
  expect(program.version).toBe(VERSION);
});

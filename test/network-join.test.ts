import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { walletAuth } from "../src/api/auth.ts";
import type { Ctx } from "../src/context.ts";
import { runJoin, walletHeader } from "../scripts/network-join.ts";
import { loadConfig } from "../src/config.ts";

const address = "0x" + "1".repeat(40);
const signup = ["--name", "Host", "--endpoint", "https://sidecar.example", "--payout-address", address, "--models", "org/model,org/second", "--contact", "operator"];
const payload = { name: "Host", endpoint: "https://sidecar.example", payout_address: address, models: ["org/model", "org/second"], contact: "operator" };
const ctx = { cache: {}, db: { select: () => ({ from: () => ({ where: async () => [] }) }) } } as unknown as Ctx;
function output() {
  const lines: string[] = [];
  return { lines, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
}
function standIn() {
  const app = new Hono();
  const bodies: string[] = [], headers: string[] = [], wallets: string[] = [];
  app.post("/api/v1/network/hosts", async (c) => {
    const body = await c.req.text(); bodies.push(body);
    const header = c.req.header("X-Wallet-Auth")!; headers.push(header);
    const auth = await walletAuth(ctx, header, createHash("sha256").update(body).digest("hex")); wallets.push(auth.wallet);
    return c.json({ provider_id: "host-1", status: "probation", reasons: ["Admission checks passed."], dashboard: "/hosts/?id=host-1" }, 201);
  });
  let polls = 0;
  app.get("/api/v1/network/hosts/host-1/status", (c) => { polls++; return c.json({ provider_id: "host-1", status: polls === 1 ? "pending" : "probation", reasons: [], attested: polls > 1, probation_until: null, weight: 0 }); });
  return { app, bodies, headers, wallets, get polls() { return polls; }, fetcher: ((url, init) => app.request(String(url), init)) as typeof fetch };
}

test("exact payload and header pass the existing walletAuth verifier against a stand-in router", async () => {
  const server = standIn(), key = generatePrivateKey(), io = output();
  expect(await runJoin(signup, { ...io, env: { ANYROUTE_OPERATOR_PRIVATE_KEY: key }, fetcher: server.fetcher })).toBe(0);
  expect(server.bodies).toEqual([JSON.stringify(payload)]);
  expect(server.wallets).toEqual([privateKeyToAccount(key).address.toLowerCase()]);
  expect(server.headers[0]).toMatch(/^0x[0-9a-f]{40}:\d+:0x[0-9a-f]{130}$/);
  expect(io.lines.join("\n")).toContain("Status: probation");
  expect(io.lines.join("\n")).toContain("Admission checks passed.");
  expect(io.lines.join("\n")).toContain("https://anyroute.tech/hosts/?id=host-1");
  expect(io.lines.join("\n")).not.toContain(key);
});
test("wallet header binds the exact bytes, and the verifier rejects a changed body and replay", async () => {
  const body = JSON.stringify(payload), header = await walletHeader(generatePrivateKey(), body);
  await expect(walletAuth(ctx, header, createHash("sha256").update(body + " ").digest("hex"))).rejects.toThrow("signature does not match");
  await walletAuth(ctx, header, createHash("sha256").update(body).digest("hex"));
  await expect(walletAuth(ctx, header, createHash("sha256").update(body).digest("hex"))).rejects.toThrow("already used");
});
test("dry run emits the exact payload and does not read a key or call the network", async () => {
  const io = output(); let called = false;
  expect(await runJoin([...signup, "--dry-run", "--key-file", "/does/not/exist"], { ...io, env: {}, fetcher: (async () => { called = true; throw new Error(); }) as typeof fetch })).toBe(0);
  expect(io.lines.at(-1)).toBe(JSON.stringify(payload)); expect(called).toBe(false);
});
test("file key source signs the same contract without printing the key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "join-key-")), key = generatePrivateKey();
  try {
    const file = path.join(dir, "operator.key"); await writeFile(file, key + "\n", { mode: 0o600 });
    const server = standIn(), io = output();
    expect(await runJoin([...signup, "--key-file", file], { ...io, env: {}, fetcher: server.fetcher })).toBe(0);
    expect(server.wallets).toEqual([privateKeyToAccount(key).address.toLowerCase()]); expect(io.lines.join("\n")).not.toContain(key);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("status polls the contract endpoint with no key, authentication, or signup", async () => {
  const server = standIn(), io = output(), intervals: number[] = [], requests: RequestInit[] = [];
  expect(await runJoin(["--status", "host-1", "--poll-count", "3", "--poll-interval", "100"], { ...io, env: {}, sleep: async (ms) => { intervals.push(ms); }, fetcher: ((url, init) => { requests.push(init!); return server.fetcher(url, init); }) as typeof fetch })).toBe(0);
  expect(server.polls).toBe(3); expect(server.bodies).toEqual([]); expect(intervals).toEqual([100, 100]);
  expect(requests.every((init) => init.method === "GET" && !init.headers && init.redirect === "error")).toBe(true);
  expect(io.lines.join("\n")).toContain("Attested: true");
});
test("invalid options and contract boundaries fail before sending, and argv keys never print", async () => {
  const key = generatePrivateKey();
  const cases = [
    [...signup, "--key", key], [...signup, "--unknown", key.slice(2)],
    [...signup, "--key-file", "x", "--key-env", "Y"], ["--status", "host-1", "--dry-run"],
    ["--status", "host-1", "--poll-count", "0"], ["--status", "host-1", "--poll-interval", "0"],
    signup.map((arg) => arg === "Host" ? "x".repeat(61) : arg),
    signup.map((arg) => arg === "https://sidecar.example" ? "http://sidecar.example" : arg),
    signup.map((arg) => arg === address ? "0xwrong" : arg),
    signup.map((arg) => arg === "org/model,org/second" ? "a,a" : arg),
    signup.map((arg) => arg === "org/model,org/second" ? "a,b,c,d,e,f,g,h,i" : arg),
    signup.map((arg) => arg === "operator" ? "x".repeat(121) : arg),
    [...signup, "--router", "https://router.example/path"], [...signup, "--router", "http://router.example"],
  ];
  for (const args of cases) {
    const io = output(); let called = false;
    expect(await runJoin(args, { ...io, env: {}, fetcher: (async () => { called = true; throw new Error(); }) as typeof fetch })).toBe(1);
    expect(called).toBe(false); expect(io.lines.join("\n")).not.toContain(key); expect(io.lines.join("\n")).not.toContain(key.slice(2));
  }
  const valid = signup.map((arg) => arg === "Host" ? "x".repeat(60) : arg).map((arg) => arg === "operator" ? "x".repeat(120) : arg);
  expect(await runJoin([...valid, "--dry-run"], output())).toBe(0);
});
test("refusals, normal API errors and reflected secrets remain failures without secret output", async () => {
  for (const [status, doc, exit] of [
    [503, { error: { message: "Host registration is closed." } }, 1],
    [200, { provider_id: "host-1", status: "rejected", reasons: ["Admission refused."], dashboard: "/hosts/?id=host-1" }, 2],
    [200, { provider_id: "host-1", status: "pending", reasons: [], dashboard: "https://elsewhere.example" }, 1],
    [200, {}, 1],
  ] as const) {
    const io = output(), key = generatePrivateKey();
    expect(await runJoin(signup, { ...io, env: { KEY: key }, fetcher: (async () => Response.json(doc, { status })) as typeof fetch })).toBe(1); // default key absent: no signing
    expect(await runJoin([...signup, "--key-env", "KEY"], { ...io, env: { KEY: key }, fetcher: (async () => Response.json(doc, { status })) as typeof fetch })).toBe(exit);
    expect(io.lines.join("\n")).not.toContain(key);
  }
  const key = generatePrivateKey(), io = output();
  expect(await runJoin(signup, { ...io, env: { ANYROUTE_OPERATOR_PRIVATE_KEY: key }, fetcher: (async () => Response.json({ error: { message: key } }, { status: 400 })) as typeof fetch })).toBe(1);
  expect(io.lines.join("\n")).not.toContain(key); expect(io.lines.join("\n")).toContain("[redacted]");
});
test("bundle is deterministic, matches served bytes and runs independently in Node", async () => {
  async function build(cwd: string) {
    const source = `import { buildJoinBundle } from ${JSON.stringify(path.resolve("scripts/build-network-join.ts"))}; process.stdout.write(await buildJoinBundle());`;
    const child = Bun.spawn(["bun", "--eval", source], { cwd, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(code).toBe(0); return stdout;
  }
  const first = await build(path.resolve(".")), second = await build(tmpdir());
  expect(first).toBe(second); expect(first).toBe(await readFile("web/public/network/join.mjs", "utf8"));
  expect(first).not.toContain(path.resolve("."));
  const command = Bun.spawn(["node", path.resolve("web/public/network/join.mjs"), ...signup, "--dry-run"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } });
  const [stdout, stderr, code] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
  expect(code).toBe(0); expect(stdout.trim()).toBe(JSON.stringify(payload)); expect(stderr).toContain("dedicated operator wallet");
});
test("Node bundle signs and joins over HTTP against the stand-in router", async () => {
  const standin = standIn(), key = generatePrivateKey();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: standin.app.fetch });
  try {
    const command = Bun.spawn(["node", path.resolve("web/public/network/join.mjs"), ...signup, "--router", `http://127.0.0.1:${server.port}`], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, ANYROUTE_OPERATOR_PRIVATE_KEY: key } });
    const [stdout, stderr, code] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
    expect(code).toBe(0); expect(standin.bodies).toEqual([JSON.stringify(payload)]); expect(standin.wallets).toEqual([privateKeyToAccount(key).address.toLowerCase()]); expect(stdout + stderr).not.toContain(key);
  } finally { server.stop(true); }
});
test("production signup can't be switched on alone: it needs the host policy and the key log", () => {
  expect(() => loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", NETWORK_HOSTS_ENABLED: "true", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64) })).toThrow("NETWORK_POLICY_ENABLED");
  expect(loadConfig({}).networkHosts.enabled).toBe(false);
});

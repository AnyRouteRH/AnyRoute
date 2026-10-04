import { expect, spyOn, test } from "bun:test";
import { createPublicClient } from "viem";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { createRpcRedactor, DEFAULT_PUBLIC_RPC, redactRpcError } from "../src/chain/rpc-redaction.ts";
import { rpcTransport } from "../src/chain/rpc-transport.ts";
import { ApiError } from "../src/lib/errors.ts";
import { log } from "../src/lib/util.ts";
import { kv } from "../src/db/schema.ts";
import { startRouter, ADMIN } from "./helpers.ts";

const privateRpc = "https://rpc.example/key/SECRETKEY123?api_key=SECRETKEY123";
const message = `RPC Request failed. URL: ${privateRpc}`;

test("pure redaction covers exact URLs, origin/path, same-host variants and shortened URLs; public URL stays intact", () => {
  const redact = createRpcRedactor([privateRpc, DEFAULT_PUBLIC_RPC]);
  for (const url of [privateRpc, "https://rpc.example/key/SECRETKEY123", "https://rpc.example/other/SECRETKEY123?key=SECRETKEY123", "HTTPS://RPC.EXAMPLE/SECRETKEY123", "https://user:SECRETKEY123@rpc.example/elsewhere", "https://rpc.example/key/SECRETKEY"])
    expect(redact(`URL: ${url}\nDetails: failed`)).toBe("URL: https://rpc.example/…\nDetails: failed");
  expect(redact(DEFAULT_PUBLIC_RPC)).toBe(DEFAULT_PUBLIC_RPC);
  expect(redact("https://rpc.example.other/key/SECRETKEY123")).toContain("SECRETKEY123");
  expect(redact("not a URL")).toBe("not a URL");
});

test("redaction preserves typed errors, nested causes and codes", () => {
  const error = Object.assign(new TypeError(message), { code: 429, cause: new Error(message), details: [message] });
  (error as any).cycle = error;
  expect(redactRpcError(error, createRpcRedactor([privateRpc]))).toBe(error);
  expect(error).toBeInstanceOf(TypeError);
  expect(error.code).toBe(429);
  for (const text of [error.message, error.stack!, error.cause.message, error.details[0]]) expect(text).not.toContain("SECRETKEY123");
});

test("config keeps public-only behaviour, supports defaults/disabled/deduplicated fallbacks and rejects unsafe URLs without echoing them", () => {
  expect(loadConfig({ RHC_RPC_URL: DEFAULT_PUBLIC_RPC }).chain.rpcFallbackUrls).toEqual([]);
  expect(loadConfig({ RHC_RPC_URL: privateRpc }).chain.rpcFallbackUrls).toEqual([DEFAULT_PUBLIC_RPC]);
  expect(loadConfig({ RHC_RPC_URL: privateRpc, RHC_RPC_FALLBACK_URLS: "" }).chain.rpcFallbackUrls).toEqual([]);
  expect(loadConfig({ RHC_RPC_URL: privateRpc, RHC_RPC_FALLBACK_URLS: ` ${DEFAULT_PUBLIC_RPC},${privateRpc},${DEFAULT_PUBLIC_RPC}` }).chain.rpcFallbackUrls).toEqual([DEFAULT_PUBLIC_RPC]);
  expect(loadConfig({ RHC_RPC_URL: "http://127.0.0.1:8545", RHC_RPC_FALLBACK_URLS: "" }).chain.rpcUrl).toBe("http://127.0.0.1:8545");
  for (const change of [
    { RHC_RPC_URL: "ws://rpc.example/key/SECRETKEY123" },
    { RHC_RPC_URL: "SECRETKEY123" },
    { RHC_RPC_FALLBACK_URLS: "wss://rpc.example/key/SECRETKEY123" },
    { RHC_RPC_FALLBACK_URLS: "https://rpc.example/key/SECRETKEY123," },
    { RHC_RPC_URL: privateRpc, PUBLIC_RPC_URL: privateRpc },
    { RHC_RPC_URL: "https://rpc.example/key/SECRETKEY123#fragment" },
  ]) {
    try { loadConfig(change); throw new Error("unsafe configuration accepted"); }
    catch (error) {
      expect((error as Error).message).not.toContain("SECRETKEY123");
      expect((error as Error).message).toMatch(/RHC_RPC|PUBLIC_RPC/);
    }
  }
});

test("production-like real config loader accepts keyed primary and private-network HTTP, rejects other schemes", () => {
  const address = "0x" + "1".repeat(40);
  const base = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), RHC_RPC_URL: privateRpc };
  expect(loadConfig(base).chain.rpcFallbackUrls).toEqual([DEFAULT_PUBLIC_RPC]);
  expect(loadConfig({ ...base, RHC_RPC_URL: "http://chain:8545", RHC_RPC_FALLBACK_URLS: "" }).chain.rpcUrl).toBe("http://chain:8545"); // compose / private network
  expect(() => loadConfig({ ...base, RHC_RPC_URL: "ws://rpc.example/key/SECRETKEY123" })).toThrow("RHC_RPC_URL must use http or https");
  expect(loadConfig({ ...base, RHC_RPC_URL: "http://localhost:8545", RHC_RPC_FALLBACK_URLS: "" }).chain.rpcUrl).toBe("http://localhost:8545"); // loopback cannot leak; CI smoke runs production mode against it
  expect(() => loadConfig({ ...base, RHC_RPC_FALLBACK_URLS: "ftp://rpc.example/fallback" })).toThrow("RHC_RPC_FALLBACK_URLS must use http or https");
});

for (const failure of [429, 500, 503, "timeout"] as const) test(`viem falls back on primary ${failure} and keeps the primary first`, async () => {
  const calls: string[] = [];
  const client = createPublicClient({ transport: rpcTransport({ rpcUrl: privateRpc, rpcFallbackUrls: [DEFAULT_PUBLIC_RPC] }, {
    retryCount: 0,
    timeout: 10,
    fetchFn: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === privateRpc) {
        if (failure === "timeout") return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }); });
        return new Response("Too Many Requests", { status: failure });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x2a" });
    },
  }) });
  expect(await client.getBlockNumber()).toBe(42n);
  expect(calls).toEqual([privateRpc, new URL(DEFAULT_PUBLIC_RPC).href]);
});

test("successful primary, disabled fallback and public-only transport never send duplicate requests", async () => {
  for (const chain of [{ rpcUrl: privateRpc, rpcFallbackUrls: [DEFAULT_PUBLIC_RPC] }, { rpcUrl: privateRpc, rpcFallbackUrls: [] }, loadConfig({ RHC_RPC_URL: DEFAULT_PUBLIC_RPC }).chain]) {
    const calls: string[] = [];
    const client = createPublicClient({ transport: rpcTransport(chain, { retryCount: 0, fetchFn: async (url) => {
      calls.push(String(url));
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x2a" });
    } }) });
    expect(await client.getBlockNumber()).toBe(42n);
    expect(calls).toEqual([new URL(chain.rpcUrl).href]);
  }
});

test("real viem failures, logs, job-health records and HTTP error envelopes never contain the keyed URL", async () => {
  const h = await startRouter({ env: { RHC_RPC_URL: "https://rpc.example/key/SECRETKEY123", RHC_RPC_FALLBACK_URLS: "" } });
  const captured: string[] = [];
  const logger = spyOn(console, "error").mockImplementation((line) => { captured.push(String(line)); });
  const client = createPublicClient({ transport: rpcTransport(h.ctx.cfg.chain, { retryCount: 0, fetchFn: async () => new Response(message, { status: 429 }) }) });
  let chainError: Error;
  try {
    try { await client.getBlockNumber(); throw new Error("expected failure"); } catch (error) { chainError = error as Error; }
    expect(chainError.message).not.toContain("SECRETKEY123");
    expect(JSON.stringify(chainError)).not.toContain("SECRETKEY123");
    log.error(message, { nested: { list: [message, { [privateRpc]: message }], count: 1n } });
    h.ctx.jobs.register("rpc1-failure", 1000, async () => { throw new Error(message); });
    await expect(h.ctx.jobs.run("rpc1-failure")).rejects.toThrow("rpc.example/…");
    expect(JSON.stringify(h.ctx.jobs.status())).not.toContain("SECRETKEY123");
    const [record] = await h.ctx.db.select().from(kv).where(eq(kv.key, "job-health:rpc1-failure"));
    expect(record).toBeDefined();
    expect(JSON.stringify(record)).not.toContain("SECRETKEY123");
    h.app.get("/rpc1-api-error", () => { throw new ApiError(502, message, "chain_failed", { nested: [message] }, undefined, { error: { message } }); });
    h.app.get("/rpc1-chain-error", () => { throw chainError; });
    for (const [path, status] of [["/rpc1-api-error", 502], ["/rpc1-chain-error", 500], ["/api/v1/status", 200], ["/trpc/jobs.status", 200]] as const) {
      const response = await h.request(path, { headers: { "x-admin-token": ADMIN } });
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("SECRETKEY123");
    }
    expect(captured.length).toBeGreaterThanOrEqual(3);
    expect(captured.join("\n")).not.toContain("SECRETKEY123");
    expect(h.ctx.chain.chain.rpcUrls.default.http).toEqual([h.ctx.cfg.chain.publicRpcUrl]);
  } finally { logger.mockRestore(); await h.close(); }
});

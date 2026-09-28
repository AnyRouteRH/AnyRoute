import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
const address = "0x" + "1".repeat(40);
const base = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64) };
test("production fails closed for each required dependency and unsafe runtime configuration", () => {
  expect(loadConfig(base).runtimeRole).toBe("api");
  for (const change of [{ DATABASE_URL: "pglite://.data/dev" }, { DATABASE_URL: "postgres://anyroute:anyroute@postgres/db" }, { REDIS_URL: "" }, { REDIS_URL: "redis://redis:6379" }, { CREDITS_ADDRESS: "" }, { CALLPAY_ADDRESS: "" }, { RECEIPT_ANCHOR_ADDRESS: "" }, { HOST: "127.0.0.1" }, { RUNTIME_ROLE: "all" }, { AUTO_MIGRATE: "true" }, { ROUTER_PRIVATE_KEY: "" }, { SETTLEMENT_PRIVATE_KEY: "0x" + "1".repeat(64) }]) expect(() => loadConfig({ ...base, ...change })).toThrow();
});
test("privileged workers require a matching role and never share signing authorities", () => {
  const worker = { ...base, RUNTIME_ROLE: "worker", WORKER_JOBS: "settlement", SETTLEMENT_PRIVATE_KEY: "0x" + "1".repeat(64) };
  expect(loadConfig(worker).workerJobs).toEqual(["settlement"]);
  expect(() => loadConfig({ ...worker, SETTLEMENT_PRIVATE_KEY: "" })).toThrow();
  expect(() => loadConfig({ ...worker, ANCHORER_PRIVATE_KEY: "0x" + "2".repeat(64) })).toThrow();
  expect(() => loadConfig({ ...worker, WORKER_JOBS: "unknown" })).toThrow();
});

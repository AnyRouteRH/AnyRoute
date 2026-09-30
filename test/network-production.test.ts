import { test, expect } from "bun:test";
import { loadConfig } from "../src/config.ts";

test("real production loader starts with the always-available waitlist and existing guards", () => {
  const address = "0x" + "1".repeat(40);
  const cfg = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64) });
  expect(cfg.production).toBe(true);
  expect(cfg.runtimeRole).toBe("api");
  expect(cfg.autoMigrate).toBe(false);
});

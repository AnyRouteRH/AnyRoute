import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
const token = "123456789:AAFixtureTokenFixtureToken0123456789";
test("Telegram linking defaults off and requires the bot and agent policies", () => {
  expect(loadConfig({}).telegram.linkingEnabled).toBe(false);
  for (const env of [{}, { TELEGRAM_BOT_TOKEN: token }, { AGENT_POLICY_ENABLED: "true" }]) expect(() => loadConfig({ ...env, TELEGRAM_LINKING_ENABLED: "true" })).toThrow(/requires/);
});
test("the real production loader starts with Telegram linking enabled", () => {
  const address = "0x" + "1".repeat(40);
  const config = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "worker", WORKER_JOBS: "telegram-bot", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), TELEGRAM_LINKING_ENABLED: "true", AGENT_POLICY_ENABLED: "true", TELEGRAM_BOT_TOKEN: token });
  expect(config.telegram.linkingEnabled).toBe(true);
  expect(config.workerJobs).toContain("telegram-bot");
});
test("only roles that run the bot and alert jobs need the bot token", () => {
  expect(loadConfig({ RUNTIME_ROLE: "api", AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true" }).telegram.linkingEnabled).toBe(true);
  expect(() => loadConfig({ RUNTIME_ROLE: "worker", AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  expect(() => loadConfig({ RUNTIME_ROLE: "api", TELEGRAM_LINKING_ENABLED: "true" })).toThrow(/AGENT_POLICY_ENABLED/);
});

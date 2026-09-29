import { expect, test } from "bun:test";
import { probe } from "../scripts/monitor.ts";

// A pool-priced token ($ANYR) has no price whenever its pool is swinging or thin. Its deposits wait and are credited
// once the price settles, so the probe reports it without failing; a feed-priced token with no price still fails.
const serve = (tokens: object[]): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const body = path === "/health" ? { ok: true } : path === "/ready" ? { ok: true, checks: { database: true }, warnings: [] } : path === "/api/v1/escrow" ? { data: { enabled: true, tokens } } : null;
    return body ? Response.json(body) : new Response("not found", { status: 404 });
  }) as typeof fetch;

test("a pool-priced token without a price is a waiting price, not a failure", async () => {
  const { code, result } = await probe("https://router.example", {
    fetch: serve([
      { symbol: "NVDA", price_usd: 180.5, price_source: "chainlink" },
      { symbol: "ANYR", price_usd: null, price_source: "twap" },
    ]),
  });
  expect(code).toBe(0);
  expect(result.checks["escrow.prices"]).toBe(true);
  expect(result.escrow).toEqual({ enabled: true, tokens: 2, stale_prices: [], waiting_prices: ["ANYR"] });
});

test("a feed-priced token without a price still fails, and a listing without price sources behaves as before", async () => {
  const stale = await probe("https://router.example", { fetch: serve([{ symbol: "NVDA", price_usd: null, price_source: "chainlink" }, { symbol: "ANYR", price_usd: 0.0001, price_source: "twap" }]) });
  expect(stale.code).toBe(1);
  expect(stale.result.failing).toEqual(["escrow.prices"]);
  expect(stale.result.escrow).toEqual({ enabled: true, tokens: 2, stale_prices: ["NVDA"] });
  const legacy = await probe("https://router.example", { fetch: serve([{ symbol: "ANYR", price_usd: null }]) });
  expect(legacy.result.escrow?.stale_prices).toEqual(["ANYR"]);
});

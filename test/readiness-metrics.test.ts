import { expect, test } from "bun:test";
import { readinessMetrics } from "../src/services/readiness-metrics.ts";

test("failed dependencies remain observable as zeroes without leaking arbitrary labels", () => {
  const output = readinessMetrics({ ok: false, checks: { database: true, settlement: false, 'host="secret"': false } });
  expect(output).toContain("anyroute_ready 0\n");
  expect(output).toContain('anyroute_readiness_check{check="database"} 1\n');
  expect(output).toContain('anyroute_readiness_check{check="settlement"} 0\n');
  expect(output).not.toContain("secret");
});

import { startRouter } from "./helpers.ts";

test("metrics can be scraped when readiness fails, and are never cached", async () => {
  const h = await startRouter();
  try {
    expect((await h.request("/ready")).status).toBe(503);
    const response = await h.request("/ready/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("anyroute_ready 0\n");
  } finally { await h.close(); }
});

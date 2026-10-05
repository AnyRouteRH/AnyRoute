import { expect, spyOn, test } from "bun:test";
import { kv } from "../src/db/schema.ts";
import { refreshThrottle } from "../src/rush/availability.ts";
import { refreshUpstreamHealth } from "../src/rush/monitor.ts";
import { MODELS, startRouter } from "./helpers.ts";

// The throttle and the failure handling are tested on their own inputs: the router's background health job also reads
// upstream state every five seconds, so counting the shared database's reads in a live router is not deterministic.
const env = { UPSTREAM_MONITOR_ENABLED: "true", CATALOG_CACHE_ENABLED: "true" };
const paths = ["/api/v1/models", "/v1/models"];
const batch = (h: Awaited<ReturnType<typeof startRouter>>) => Promise.all(
  Array.from({ length: 24 }, (_, i) => h.request(paths[i % paths.length])),
);
const availability = async (response: Response) => {
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  return body.data.find((m: any) => m.id === MODELS.qwen.slug).availability;
};
async function balance(h: Awaited<ReturnType<typeof startRouter>>, value: number) {
  const snapshot = { balance_usd: value, checked_at: Date.now(), status: "ok" };
  await h.ctx.db.insert(kv).values({ key: "upstream-balance:alpha", value: snapshot })
    .onConflictDoUpdate({ target: kv.key, set: { value: snapshot } });
}
const deferred = () => { let resolve!: () => void, reject!: (e: unknown) => void; const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("throttle: concurrent callers share one run; no new run inside the window; a new run after it", async () => {
  let now = 0, runs = 0;
  const gate = deferred();
  const refresh = refreshThrottle(() => { runs++; return gate.promise; }, () => now);
  const calls = Array.from({ length: 24 }, () => refresh());
  expect(runs).toBe(1);
  gate.resolve(); await Promise.all(calls);
  now = 4_999; await refresh(); expect(runs).toBe(1);
  now = 5_000; await refresh(); expect(runs).toBe(2);
});

test("throttle: callers after the window still share an unfinished run instead of queuing another", async () => {
  let now = 0, runs = 0;
  const gate = deferred();
  const refresh = refreshThrottle(() => { runs++; return gate.promise; }, () => now);
  const first = refresh();
  now = 6_000;
  const later = refresh();
  expect(runs).toBe(1);
  expect(later).toBe(first);
  gate.resolve(); await Promise.all([first, later]);
  expect(runs).toBe(1);
});

test("throttle: a failed run is swallowed and retried only after the window", async () => {
  let now = 0, runs = 0;
  const refresh = refreshThrottle(async () => { runs++; throw new Error("read failed"); }, () => now);
  await expect(refresh()).resolves.toBeUndefined();
  now = 4_999; await refresh(); expect(runs).toBe(1);
  now = 5_000; await refresh(); expect(runs).toBe(2);
});

test("a failed balance read keeps the last state: a new hold seen in the same refresh is not applied", async () => {
  const h = await startRouter({ env });
  try {
    await balance(h, 0);
    expect(await availability(await h.request(paths[0]))).toBe("temporarily_unavailable");
    // A private stand-in database: first read returns a new hold, the balance read fails.
    let reads = 0;
    const db = { select: () => ({ from: () => ({ where: async () => {
      if (++reads === 1) return [{ key: "upstream-credit-hold:beta", value: { until: Date.now() + 60_000 } }];
      throw new Error("balance read unavailable");
    } }) }) } as any;
    await expect(refreshUpstreamHealth(h.ctx.health, db)).rejects.toThrow("balance read unavailable");
    expect(h.ctx.health.outage(MODELS.llama.slug, "beta")).toBe(false);
  } finally { await h.close(); }
});

test("models requests reflect exhaustion and recovery, refreshed at most every five seconds", async () => {
  const h = await startRouter({ env });
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const healthy = await (await h.request(paths[0])).text();
    await balance(h, 0);
    now = 5_000;
    for (const response of await batch(h)) expect(await availability(response)).toBe("temporarily_unavailable");
    await balance(h, 30);
    now = 10_000;
    for (const response of await batch(h)) expect(await response.text()).toBe(healthy);
  } finally { clock.mockRestore(); await h.close(); }
});

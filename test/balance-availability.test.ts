import { expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { kv } from "../src/db/schema.ts";
import { MODELS, startRouter } from "./helpers.ts";

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

test("concurrent models requests share one refresh per five seconds and invalidate cached exhaustion and recovery", async () => {
  const h = await startRouter({ env });
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  let selects: ReturnType<typeof spyOn> | undefined;
  try {
    const healthy = await (await h.request(paths[0])).text();
    selects = spyOn(h.ctx.db, "select");
    await balance(h, 0);
    now = 4_999;
    for (const response of await batch(h)) expect(await response.text()).toBe(healthy);
    expect(selects).toHaveBeenCalledTimes(0);
    now = 5_000;
    for (const response of await batch(h)) expect(await availability(response)).toBe("temporarily_unavailable");
    expect(selects).toHaveBeenCalledTimes(2); // One refresh, two kv reads, even across both aliases.
    await balance(h, 30);
    now = 9_999;
    for (const response of await batch(h)) expect(await availability(response)).toBe("temporarily_unavailable");
    expect(selects).toHaveBeenCalledTimes(2);
    now = 10_000;
    for (const response of await batch(h)) expect(await response.text()).toBe(healthy);
    expect(selects).toHaveBeenCalledTimes(4);
  } finally { selects?.mockRestore(); clock.mockRestore(); await h.close(); }
});

test("requests arriving after five seconds still share the same unfinished refresh without queuing another", async () => {
  const h = await startRouter({ env });
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const select = h.ctx.db.select.bind(h.ctx.db);
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const selects = spyOn(h.ctx.db, "select").mockImplementationOnce(() => ({
    from: () => ({ where: async () => { started(); await blocked; return []; } }),
  }) as any).mockImplementation(select);
  try {
    const first = batch(h);
    await reading;
    expect(selects).toHaveBeenCalledTimes(1);
    now = 6_000;
    const later = batch(h);
    await Promise.resolve();
    expect(selects).toHaveBeenCalledTimes(1);
    release();
    for (const response of [...await first, ...await later]) expect(response.status).toBe(200);
    expect(selects).toHaveBeenCalledTimes(2);
  } finally { release(); selects.mockRestore(); clock.mockRestore(); await h.close(); }
});

test("a failed refresh preserves availability and holds, serves requests, and retries only after the window", async () => {
  const h = await startRouter({ env });
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  let selects: ReturnType<typeof spyOn> | undefined;
  try {
    await balance(h, 0);
    expect(await availability(await h.request(paths[0]))).toBe("temporarily_unavailable");
    await balance(h, 30);
    const select = h.ctx.db.select.bind(h.ctx.db);
    // A first read with a new hold must not change memory if the balance read fails.
    selects = spyOn(h.ctx.db, "select")
      .mockImplementationOnce(() => ({ from: () => ({ where: async () => [{ key: "upstream-credit-hold:beta", value: { until: Date.now() + 60_000 } }] }) }) as any)
      .mockImplementationOnce(() => { throw new Error("balance read unavailable"); })
      .mockImplementation(select);
    now = 5_000;
    for (const response of await batch(h)) expect(await availability(response)).toBe("temporarily_unavailable");
    expect(selects).toHaveBeenCalledTimes(2);
    expect(h.ctx.health.outage(MODELS.llama.slug, "beta")).toBe(false);
    now = 9_999;
    for (const response of await batch(h)) expect(await availability(response)).toBe("temporarily_unavailable");
    expect(selects).toHaveBeenCalledTimes(2);
    now = 10_000;
    for (const response of await batch(h)) expect(await availability(response)).toBeUndefined();
    expect(selects).toHaveBeenCalledTimes(4);
  } finally { selects?.mockRestore(); clock.mockRestore(); await h.close(); }
});

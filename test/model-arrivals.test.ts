import { expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { addedWithin, ARRIVAL_PREFIX, ARRIVAL_SEED, recordModelArrivals } from "../src/catalog/model-arrivals.ts";
import { modelsAtom, newModelsFeedRoutes } from "../src/api/models-new-feed.ts";
import { loadConfig } from "../src/config.ts";
import { kv, models, offers } from "../src/db/schema.ts";
import { startRouter } from "./helpers.ts";

const now = 1_790_000_000;
test("arrival windows exclude unknown, future, invalid and boundary dates", () => {
  for (const days of [7, 30]) {
    expect(addedWithin(now, days, now)).toBe(true);
    expect(addedWithin(now - days * 86400 + 1, days, now)).toBe(true);
    for (const value of [null, undefined, 0, "1790000000", NaN, now + 1, now - days * 86400]) expect(addedWithin(value, days, now)).toBe(false);
  }
});

test("arrival tracking defaults off and accepts explicit opt-in", () => {
  expect(loadConfig({}).modelArrivalsEnabled).toBe(false);
  expect(loadConfig({ MODEL_ARRIVALS_ENABLED: "true" }).modelArrivalsEnabled).toBe(true);
  expect(loadConfig({ MODEL_ARRIVALS_ENABLED: "false" }).modelArrivalsEnabled).toBe(false);
});

test("Atom feed has required fields, escapes text and excludes unknown, future and old models", () => {
  const m = { id: "sample/a&b", name: `Fresh <model> & "name"`, added_at: now, capabilities: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } };
  const xml = modelsAtom([m, { ...m, id: "unknown", added_at: null }, { ...m, id: "old", added_at: now - 30 * 86400 }, { ...m, id: "future", added_at: now + 1 }], now);
  expect(xml).toStartWith('<?xml version="1.0" encoding="utf-8"?>');
  expect(xml).toContain('xmlns="http://www.w3.org/2005/Atom"');
  expect(xml).toContain('<author><name>Anyroute</name></author>');
  expect(xml).toContain('Fresh &lt;model&gt; &amp; &quot;name&quot;');
  expect(xml).toContain('<published>' + new Date(now * 1000).toISOString() + '</published>');
  expect(xml).toContain('sample%2Fa%26b');
  expect(xml.match(/<entry>/g)).toHaveLength(1);
  expect(xml).toContain('input $0.000001; output $0.000002');
  const empty = modelsAtom([], now);
  expect(empty).not.toContain('<entry>');
  expect(empty).toContain('<updated>' + new Date(now * 1000).toISOString() + '</updated>');
});

test("initial seed stays unknown; later observations survive concurrent refreshes and reintroduction", async () => {
  const r = await startRouter({ providers: [] });
  try {
    expect((await recordModelArrivals(r.ctx.db, ["sample/baseline"], now)).get("sample/baseline")).toBeNull();
    const [one, two] = await Promise.all([recordModelArrivals(r.ctx.db, ["sample/baseline", "sample/new"], now + 1), recordModelArrivals(r.ctx.db, ["sample/baseline", "sample/new"], now + 2)]);
    // The seed row lock serializes the two refreshes; whichever takes it first records the date and both agree on it.
    const first = one.get("sample/new")!;
    expect([now + 1, now + 2]).toContain(first);
    expect(two.get("sample/new")).toBe(first);
    await recordModelArrivals(r.ctx.db, [], now + 3);
    expect((await recordModelArrivals(r.ctx.db, ["sample/new"], now + 100)).get("sample/new")).toBe(first);
    const [seed] = await r.ctx.db.select().from(kv).where(eq(kv.key, ARRIVAL_SEED));
    expect(seed!.value).toEqual({ initialized: true, seeded_at: now });
  } finally { await r.close(); }
});

test("public APIs are byte-identical when off, additive when on; catalogue refresh seeds existing models and records later IDs", async () => {
  const r = await startRouter();
  try {
    const beforeResponse = await r.request("/api/v1/models");
    expect(beforeResponse.status).toBe(200);
    const before = await beforeResponse.text();
    expect(before).not.toContain('"added_at"');
    expect(await (await r.request("/v1/models")).text()).toBe(before);
    const rows = await r.ctx.db.select().from(kv).where(like(kv.key, ARRIVAL_PREFIX + "%"));
    expect(rows).toEqual([]);
    expect((await r.ctx.db.select().from(kv).where(eq(kv.key, ARRIVAL_SEED)))).toEqual([]);
    const offFeed = await r.request("/api/v1/models/new.atom");
    expect(offFeed.status).toBe(200);
    expect(await offFeed.text()).not.toContain('<entry>');
    r.ctx.cfg.modelArrivalsEnabled = true;
    r.ctx.catalog.trackArrivals = true;
    await r.ctx.catalog.refresh();
    const seeded = await (await r.request("/api/v1/models")).json();
    for (const m of seeded.data) expect(m.added_at).toBeNull();
    const stripAddedAt = (data: any) => { for (const m of data.data) delete m.added_at; return JSON.stringify(data); };
    expect(stripAddedAt(seeded)).toBe(before);
    const sourceId = [...r.ctx.catalog.models.keys()][0]!;
    const [source] = await r.ctx.db.select().from(models).where(eq(models.id, sourceId));
    const [offer] = await r.ctx.db.select().from(offers).where(eq(offers.modelId, sourceId));
    const id = "sample/arriving";
    await r.ctx.db.insert(models).values({ ...source!, id, author: "sample", name: "New arrival" });
    await r.ctx.db.insert(offers).values({ ...offer!, modelId: id });
    await r.ctx.catalog.refresh();
    expect(addedWithin(r.ctx.catalog.addedAt.get(id), 7)).toBe(true);
    const after = await (await r.request("/api/v1/models")).json();
    expect(after.data.find((m: any) => m.id === id).added_at).toBe(r.ctx.catalog.addedAt.get(id));
    expect(stripAddedAt({ data: after.data.filter((m: any) => m.id !== id) })).toBe(before);
    expect(await (await r.request("/v1/models")).json()).toEqual(await (await r.request("/api/v1/models")).json());
    const app = new Hono(); newModelsFeedRoutes(app, r.ctx);
    const feed = await app.request("/api/v1/models/new.atom");
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    expect(feed.headers.get("cache-control")).toBe("public, max-age=30");
    const xml = await feed.text();
    expect(xml.match(/<entry>/g)).toHaveLength(1);
    r.ctx.catalog.models.get(id)!.name = "Changed without refresh";
    expect(await (await app.request("/api/v1/models/new.atom")).text()).toBe(xml);
    await r.ctx.db.update(models).set({ hidden: true }).where(eq(models.id, id));
    await r.ctx.catalog.refresh();
    expect(await (await app.request("/api/v1/models/new.atom")).text()).not.toContain('<entry>');
  } finally { await r.close(); }
});

test("public feed inherits the same ingress authentication guard as the models API", async () => {
  const r = await startRouter({ providers: [], env: { ORIGIN_LOCK_ENABLED: "true", ORIGIN_LOCK_SECRET: "fixture-origin-lock-".repeat(3) } });
  try {
    for (const path of ["/api/v1/models", "/api/v1/models/new.atom"]) {
      expect((await r.app.request(path)).status).toBe(403);
      expect((await r.request(path)).status).toBe(200);
    }
  } finally { await r.close(); }
});

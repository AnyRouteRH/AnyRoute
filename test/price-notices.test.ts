import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { generations, keys, kv, models, offers, teamMembers } from "../src/db/schema.ts";
import { diffPrices, significantPriceChange } from "../src/catalog/price-notices-text.ts";
import { registerPriceNoticesJob, runPriceNotices } from "../src/catalog/price-notices.ts";
import { startRouter, type Harness } from "./helpers.ts";

let h: Harness, off: Harness, sequence = 0;
beforeAll(async () => {
  h = await startRouter({ env: { PRICE_NOTICES_ENABLED: "true", AGENT_POLICY_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "133:fixture-only-telegram-token" } });
  off = await startRouter();
});
afterAll(async () => { await h?.close(); await off?.close(); });
beforeEach(async () => { if (h) await h.ctx.db.delete(kv).where(like(kv.key, "price-notices:%")); });
const price = (prompt: string, completion = "0") => ({ name: "Model", prompt, completion });
async function accountOf(hash: string) { return (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0].accountId; }
async function usage(account: string | null, model: string, ts = new Date(Date.now() - 1000)) {
  await h.ctx.db.insert(generations).values({ id: `price-use-${++sequence}`, accountId: account, modelId: model, ts, providerId: "alpha", mode: "prepaid" });
}
async function inbox(key: { auth: Record<string, string> }, since?: string) {
  const response = await h.request("/api/v1/inbox" + (since ? `?since=${encodeURIComponent(since)}` : ""), { headers: key.auth });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()).data.filter((item: any) => item.kind === "price_notice");
}
async function addModel(id: string, value = 800_000n) {
  await h.ctx.db.insert(models).values({ id, author: "sample-provider", name: `Model ${id}`, createdUnix: 0 });
  await h.ctx.db.insert(offers).values({ modelId: id, providerId: "alpha", providerModelId: id, pricePrompt: value, priceCompletion: 0n });
}
async function change(id: string, value: bigint, completion = 0n) {
  await h.ctx.db.update(offers).set({ pricePrompt: value, priceCompletion: completion }).where(eq(offers.modelId, id));
}
test("diff uses exact one-percent thresholds, zero rates, independent input/output and silent first snapshots", () => {
  expect(significantPriceChange(10000n, 9901n)).toBe(false);
  expect(significantPriceChange(10000n, 9900n)).toBe(true);
  expect(significantPriceChange(10000n, 10100n)).toBe(true);
  expect(significantPriceChange(0n, 0n)).toBe(false);
  expect(significantPriceChange(0n, 1n)).toBe(true);
  expect(significantPriceChange(1n, 0n)).toBe(true);
  expect(diffPrices({}, { a: price("800000") })).toEqual([]);
  expect(diffPrices({ a: price("800000") }, {})).toEqual([]);
  expect(diffPrices({ a: price("800000", "2000000") }, { a: price("600000", "3000000") })).toEqual([
    { model: "a", title: "Model got cheaper: $0.80 → $0.60 per million input tokens; Model got pricier: $2.00 → $3.00 per million output tokens" },
  ]);
  expect(diffPrices({ a: price("1") }, { a: price("2") })[0].title).toContain("$0.000001 → $0.000002");
  expect(diffPrices({ a: price("10000", "10000") }, { a: price("9999", "10100") })[0].title).toContain("output tokens");
  expect(diffPrices({ a: price("10000") }, { a: { ...price("10000"), name: "Renamed" } })).toEqual([]);
});
test("flag defaults off: no registration, database reads, sends or inbox additions; API role never runs the job", async () => {
  expect(loadConfig({ ANYROUTE_ENV: "test" }).priceNoticesEnabled).toBe(false);
  const names: string[] = [];
  registerPriceNoticesJob({ cfg: { priceNoticesEnabled: false }, jobs: { register: (name: string) => names.push(name) } } as any);
  expect(await runPriceNotices({ cfg: { priceNoticesEnabled: false } } as any)).toEqual({ skipped: true, created: 0 });
  registerPriceNoticesJob({ cfg: { priceNoticesEnabled: true, runtimeRole: "api" }, jobs: { register: (name: string) => names.push(name) } } as any);
  expect(await runPriceNotices({ cfg: { priceNoticesEnabled: true, runtimeRole: "api" } } as any)).toEqual({ skipped: true, created: 0 });
  expect(names).toEqual([]);
  let interval = 0;
  registerPriceNoticesJob({ cfg: { priceNoticesEnabled: true, runtimeRole: "worker" }, jobs: { register: (name: string, ms: number) => { names.push(name); interval = ms; } } } as any);
  expect(names).toEqual(["price-notices"]); expect(interval).toBe(3_600_000);
  const key = await off.newKey();
  const before = await (await off.request("/api/v1/inbox", { headers: key.auth })).json();
  expect(await runPriceNotices(off.ctx)).toEqual({ skipped: true, created: 0 });
  expect((await off.ctx.db.select().from(kv).where(like(kv.key, "price-notices:%"))).length).toBe(0);
  const after = await (await off.request("/api/v1/inbox", { headers: key.auth })).json();
  expect(after.data).toEqual(before.data); expect(after.count).toBe(before.count);
});
test("production guards accept the isolated price worker and still refuse auto-migration and unknown jobs", () => {
  const env = {
    NODE_ENV: "production", ANYROUTE_ENV: "production", AUTO_MIGRATE: "false", HOST: "0.0.0.0",
    APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example",
    DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379",
    PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: "0x" + "1".repeat(40), ESCROW_START_BLOCK: "1",
    ESCROW_TOKENS: JSON.stringify([{ symbol: "UNIT", address: "0x" + "2".repeat(40), decimals: 18, feed: "0x" + "3".repeat(40) }]),
    PRICE_NOTICES_ENABLED: "true", RUNTIME_ROLE: "worker", WORKER_JOBS: "price-notices",
  };
  expect(loadConfig(env).workerJobs).toEqual(["price-notices"]);
  expect(loadConfig({ ...env, RUNTIME_ROLE: "api", WORKER_JOBS: "" }).priceNoticesEnabled).toBe(true);
  expect(() => loadConfig({ ...env, AUTO_MIGRATE: "true" })).toThrow(/AUTO_MIGRATE/);
  expect(() => loadConfig({ ...env, WORKER_JOBS: "unknown-job" })).toThrow();
});
test("recent account use targets once; old, future, anonymous and unused accounts are excluded; inbox auth stays scoped", async () => {
  const id = "price-target", owner = await h.newKey(), other = await h.newKey(), stale = await h.newKey(), future = await h.newKey();
  const account = await accountOf(owner.hash);
  await addModel(id);
  await usage(account, id); await usage(account, id); // Repeated use still produces one notice.
  await usage(await accountOf(stale.hash), id, new Date(Date.now() - 31 * 86_400_000));
  await usage(await accountOf(future.hash), id, new Date(Date.now() + 86_400_000));
  await usage(null, id);
  expect((await runPriceNotices(h.ctx)).created).toBe(0);
  await change(id, 795_000n); expect((await runPriceNotices(h.ctx)).created).toBe(0);
  await change(id, 600_000n, 200_000n);
  expect((await runPriceNotices(h.ctx)).created).toBe(1);
  const notices = await inbox(owner); expect(notices).toHaveLength(1);
  expect(notices[0].title).toContain("$0.795 → $0.60"); expect(notices[0].title).toContain("output tokens");
  expect(await inbox(other)).toEqual([]); expect(await inbox(stale)).toEqual([]); expect(await inbox(future)).toEqual([]);
  expect((await runPriceNotices(h.ctx)).created).toBe(0); expect(await inbox(owner)).toEqual(notices);
  expect(await inbox(owner, notices[0].at)).toEqual([]);
  expect(await inbox(owner, new Date(Date.parse(notices[0].at) - 1).toISOString())).toHaveLength(1);
  expect((await h.request("/api/v1/inbox")).status).toBe(401);
  expect((await h.request("/api/v1/inbox", { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
  const response = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Agent" } });
  const child = await response.json();
  expect(await inbox({ auth: { authorization: `Bearer ${child.key}` } })).toEqual([]);
  const session = await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json();
  expect(await inbox({ auth: { authorization: `Bearer ${session.data.key}` } })).toEqual([]);
  h.ctx.cfg.priceNoticesEnabled = false;
  try { expect(await inbox(owner)).toEqual([]); } finally { h.ctx.cfg.priceNoticesEnabled = true; }
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owner.hash));
  expect((await h.request("/api/v1/inbox", { headers: owner.auth })).status).toBe(401);
});
test("five daily items group overflow across hours; concurrent jobs and price cycles are idempotent; Telegram attempts cap", async () => {
  const owner = await h.newKey(), account = await accountOf(owner.hash), ids = Array.from({ length: 8 }, (_, i) => `price-cap-${i}`);
  await h.ctx.db.insert(kv).values({ key: "telegram-link:133001", value: { uid: 133001, account, key_hash: owner.hash, generation: "price-link", linked_at: new Date().toISOString() } });
  for (const id of ids) { await addModel(id); await usage(account, id); }
  const sent: string[] = [];
  const telegramFetch = (async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await runPriceNotices(h.ctx, { telegramFetch });
  for (const id of ids) await change(id, 600_000n);
  const runs = await Promise.all([runPriceNotices(h.ctx, { telegramFetch }), runPriceNotices(h.ctx, { telegramFetch })]);
  expect(runs.reduce((sum, run) => sum + run.created, 0)).toBe(5);
  expect(sent).toHaveLength(5); expect(sent[4]).toBe("And 4 more model price changes");
  const notices = await inbox(owner); expect(notices).toHaveLength(5);
  expect(notices.filter((item: any) => item.model === null)[0].title).toBe("And 4 more model price changes");
  await change(ids[0], 800_000n); await runPriceNotices(h.ctx, { telegramFetch });
  expect(sent).toHaveLength(5);
  expect((await inbox(owner)).find((item: any) => item.model === null).title).toBe("And 5 more model price changes");
  const tomorrow = new Date(Date.now() + 86_400_000);
  await change(ids[0], 500_000n);
  expect((await runPriceNotices(h.ctx, { now: tomorrow, telegramFetch })).created).toBe(1);
  expect(sent).toHaveLength(6);
  expect((await runPriceNotices(h.ctx, { now: tomorrow, telegramFetch })).created).toBe(0);
});
test("availability loss and reappearance are silent; cleanup keeps the latest snapshot and removes old daily rows", async () => {
  const owner = await h.newKey(), account = await accountOf(owner.hash), id = "price-availability";
  await addModel(id); await usage(account, id); await runPriceNotices(h.ctx);
  await h.ctx.db.update(offers).set({ status: "disabled" }).where(eq(offers.modelId, id));
  expect((await runPriceNotices(h.ctx)).created).toBe(0);
  await change(id, 0n);
  await h.ctx.db.update(offers).set({ status: "live" }).where(eq(offers.modelId, id));
  expect((await runPriceNotices(h.ctx)).created).toBe(0);
  await change(id, 800_000n); expect((await runPriceNotices(h.ctx)).created).toBe(1);
  await runPriceNotices(h.ctx, { now: new Date(Date.now() + 32 * 86_400_000) });
  expect(await inbox(owner)).toEqual([]);
  expect(await h.ctx.db.select().from(kv).where(eq(kv.key, "price-notices:snapshot"))).toHaveLength(1);
});
test("failed Telegram delivery is not retried and account history is not sent to team administrators", async () => {
  const owner = await h.newKey(), account = await accountOf(owner.hash), id = "price-failed-send";
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Team admin" } })).json();
  await h.ctx.db.update(keys).set({ teamId: "price-notice-team" }).where(eq(keys.keyHash, child.data.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "price-notice-team", keyHash: child.data.hash, role: "admin" });
  for (const [uid, hash] of [[133002, owner.hash], [133003, child.data.hash]] as const) {
    await h.ctx.db.insert(kv).values({ key: `telegram-link:${uid}`, value: { uid, account, key_hash: hash, generation: `price-${uid}`, linked_at: new Date().toISOString() } });
  }
  await addModel(id); await usage(account, id); await runPriceNotices(h.ctx);
  await change(id, 600_000n);
  let attempts = 0;
  const telegramFetch = (async (_url: unknown, init: RequestInit) => {
    attempts++; expect(JSON.parse(String(init.body)).chat_id).toBe(133002);
    return new Response(JSON.stringify({ ok: false, description: "Unavailable" }), { status: 500 });
  }) as typeof fetch;
  expect((await runPriceNotices(h.ctx, { telegramFetch })).created).toBe(1);
  expect(attempts).toBe(1); expect(await inbox(owner)).toHaveLength(1);
  expect(await inbox({ auth: { authorization: `Bearer ${child.key}` } })).toEqual([]);
  expect((await runPriceNotices(h.ctx, { telegramFetch })).created).toBe(0); expect(attempts).toBe(1);
});
test("a management rights change waits for the authorized Telegram send to finish", async () => {
  const owner = await h.newKey(), account = await accountOf(owner.hash), id = "price-rights-lock";
  await h.ctx.db.insert(kv).values({ key: "telegram-link:133004", value: { uid: 133004, account, key_hash: owner.hash, generation: "price-rights", linked_at: new Date().toISOString() } });
  await addModel(id); await usage(account, id); await runPriceNotices(h.ctx); await change(id, 600_000n);
  let release!: () => void, entered!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const continueSend = new Promise<void>(resolve => { release = resolve; });
  const telegramFetch = (async () => {
    entered(); await continueSend;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }) as typeof fetch;
  const job = runPriceNotices(h.ctx, { telegramFetch });
  await sending;
  let changed = false;
  const demotion = h.ctx.db.update(keys).set({ management: false }).where(eq(keys.keyHash, owner.hash)).then(() => { changed = true; });
  try {
    await Bun.sleep(50);
    expect(changed).toBe(false);
  } finally { release(); await job; await demotion; }
  expect(changed).toBe(true); expect(await inbox(owner)).toEqual([]);
});

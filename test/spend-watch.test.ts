import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generations, keys, spendAlerts } from "../src/db/schema.ts";
import { usdToPico } from "../src/lib/money.ts";
import { decrypt, encrypt, uid } from "../src/lib/util.ts";
import {
  claimFiring,
  isAnomaly,
  maskWebhookUrl,
  parseAlertState,
  runSpendWatch,
  sendWebhook,
  spendReport,
  webhookUrlProblem,
  type SpendWatchOptions,
} from "../src/services/spend-watch.ts";
import { startRouter, type Harness } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0); // Tuesday 2026-09-15 12:00 UTC
const HOOK = "https://hooks.example.com/services/T000/B000/s3cr3t-path?token=abc";

type Key = { secret: string; hash: string; auth: { authorization: string } };

async function accountOf(h: Harness, keyHash: string) {
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, keyHash));
  return k.accountId;
}
async function subKey(h: Harness, parent: Key, body: Record<string, unknown> = {}): Promise<Key> {
  const r = await h.request("/api/v1/keys", { method: "POST", headers: parent.auth, json: { name: "sub", ...body } });
  expect(r.status).toBe(201);
  const j = await r.json();
  return { secret: j.key, hash: j.data.hash, auth: { authorization: `Bearer ${j.key}` } };
}
async function gen(h: Harness, accountId: string, keyHash: string | null, at: number, usd: string, model = "acme/model-x", provider = "alpha") {
  await h.ctx.db.insert(generations).values({ id: uid("gen-test-"), ts: new Date(at), keyHash, accountId, modelId: model, providerId: provider, mode: "prepaid", cost: usdToPico(usd) });
}
async function rule(h: Harness, id: string) {
  const [r] = await h.ctx.db.select().from(spendAlerts).where(eq(spendAlerts.id, id));
  return r;
}
async function createRule(h: Harness, k: Key, body: Record<string, unknown>) {
  const r = await h.request("/api/v1/spend/alerts", { method: "POST", headers: k.auth, json: body });
  const j = await r.json();
  if (r.status !== 201) throw new Error(`rule rejected (${r.status}): ${JSON.stringify(j)}`);
  return j.data as { id: string; webhook_url: string | null };
}
const at = (t: number) => ({ now: () => t });

describe("Spend Watch: aggregation", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => {
    await h.close();
  });

  test("totals, projection, series and breakdowns at a fixed instant, bounded to the scope's keys", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const b = await subKey(h, root, { name: "batch" });
    const other = await h.newKey();
    const A = root.hash;
    const B = b.hash;
    const today = Date.UTC(2026, 8, 15, 10);
    await gen(h, acct, A, today, "2", "acme/model-x", "alpha");
    await gen(h, acct, B, today + 60_000, "1", "acme/model-y", "beta");
    await gen(h, acct, A, Date.UTC(2026, 8, 14, 9), "1");
    await gen(h, acct, B, Date.UTC(2026, 8, 10, 9), "0.5", "acme/model-y", "beta");
    await gen(h, acct, A, Date.UTC(2026, 8, 1, 0, 0, 0), "4"); // first instant of the month
    await gen(h, acct, A, Date.UTC(2026, 7, 31, 23, 59, 59), "10"); // last month, inside the 30-day period
    await gen(h, acct, A, Date.UTC(2026, 7, 1), "100"); // outside every window
    await gen(h, acct, A, Date.UTC(2026, 8, 16, 0, 0, 0), "50"); // tomorrow: after `now`
    await gen(h, acct, null, today, "7"); // wallet-paid per call, no key: not key spend
    await gen(h, await accountOf(h, other.hash), other.hash, today, "999"); // another account

    const all = await spendReport(h.ctx.db, { accountId: acct, keyHash: null }, { periodDays: 30, groupBy: "day", now: NOW });
    expect(all.scope).toBe("account");
    expect(all.range).toEqual({ from: "2026-08-17", to: "2026-09-15" });
    expect(all.totals).toEqual({
      today_usd: 3,
      last_7d_usd: 4.5, // Sep 9..15
      month_to_date_usd: 8.5,
      projected_month_usd: 17, // 8.5 / 15 days * 30
      period_usd: 18.5,
      period_requests: 6,
      day_of_month: 15,
      days_in_month: 30,
    });
    expect(all.series).toHaveLength(30);
    expect(all.series[0]).toEqual({ date: "2026-08-17", cost_usd: 0, requests: 0 });
    expect(all.series.find((s) => s.date === "2026-08-31")).toEqual({ date: "2026-08-31", cost_usd: 10, requests: 1 });
    expect(all.series.at(-1)).toEqual({ date: "2026-09-15", cost_usd: 3, requests: 2 });
    expect(all.series.reduce((s, d) => s + d.cost_usd, 0)).toBeCloseTo(18.5, 9);
    // Trailing week (Sep 8..14) is $1.50, a $0.214/day average; $3 today is 14x it.
    expect(all.anomaly).toMatchObject({ flagged: true, today_usd: 3, ratio: 14, multiplier: 3, min_today_usd: 1 });

    const byModel = await spendReport(h.ctx.db, { accountId: acct, keyHash: null }, { periodDays: 30, groupBy: "model", now: NOW });
    expect(byModel.breakdown.map((r) => [r.id, r.cost_usd, r.requests])).toEqual([["acme/model-x", 17, 4], ["acme/model-y", 1.5, 2]]);
    expect(byModel.breakdown[0].share).toBeCloseTo(17 / 18.5, 3);
    const byKey = await spendReport(h.ctx.db, { accountId: acct, keyHash: null }, { periodDays: 30, groupBy: "key", now: NOW });
    expect(byKey.breakdown.map((r) => [r.id, r.cost_usd, r.name])).toEqual([[A, 17, "test"], [B, 1.5, "batch"]]);
    expect(byKey.breakdown[1].label).toMatch(/^sk-ar-v1-/);
    const byProvider = await spendReport(h.ctx.db, { accountId: acct, keyHash: null }, { periodDays: 7, groupBy: "provider", now: NOW });
    expect(byProvider.breakdown.map((r) => [r.id, r.cost_usd])).toEqual([["alpha", 3], ["beta", 1.5]]);
    expect(byProvider.totals.period_usd).toBe(4.5);

    // A single key's view: only its own generations.
    const mine = await spendReport(h.ctx.db, { accountId: acct, keyHash: B }, { periodDays: 90, groupBy: "key", now: NOW });
    expect(mine.scope).toBe("key");
    expect(mine.totals).toMatchObject({ today_usd: 1, last_7d_usd: 1.5, month_to_date_usd: 1.5, period_usd: 1.5 });
    expect(mine.breakdown.map((r) => r.id)).toEqual([B]);
    expect(mine.series).toHaveLength(90);
  });

  test("the anomaly flag needs at least $1 today and 3x the trailing daily average", () => {
    const usd = (v: string) => usdToPico(v);
    expect(isAnomaly(usd("0.99"), 0n)).toBe(false);
    expect(isAnomaly(usd("1"), 0n)).toBe(true);
    expect(isAnomaly(usd("3"), usd("7"))).toBe(true); // avg $1, today exactly 3x
    expect(isAnomaly(usd("2.99"), usd("7"))).toBe(false);
    expect(isAnomaly(usd("5"), usd("7"), 500)).toBe(true);
    expect(isAnomaly(usd("4.99"), usd("7"), 500)).toBe(false);
  });

  test("budgets report the current period: a key idle since an earlier period has spent nothing in this one", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const s = await subKey(h, root, { name: "agent", limit: 10, limit_reset: "monthly" });
    const stale = await subKey(h, root, { name: "stale", limit: 5, limit_reset: "daily" });
    await h.ctx.db.update(keys).set({ spent: usdToPico("8.5"), periodStart: new Date(Date.UTC(2026, 8, 1)) }).where(eq(keys.keyHash, s.hash));
    await h.ctx.db.update(keys).set({ spent: usdToPico("4"), periodStart: new Date(Date.UTC(2026, 8, 14)) }).where(eq(keys.keyHash, stale.hash));
    const r = await spendReport(h.ctx.db, { accountId: acct, keyHash: null }, { periodDays: 7, groupBy: "day", now: NOW });
    expect(r.budgets).toEqual([
      { key_hash: s.hash, name: "agent", label: expect.any(String), budget_usd: 10, spent_usd: 8.5, remaining_usd: 1.5, pct: 85, reset: "monthly", resets_at: "2026-10-01T00:00:00.000Z", disabled: false },
      { key_hash: stale.hash, name: "stale", label: expect.any(String), budget_usd: 5, spent_usd: 0, remaining_usd: 5, pct: 0, reset: "daily", resets_at: "2026-09-16T00:00:00.000Z", disabled: false },
    ]);
    const own = await spendReport(h.ctx.db, { accountId: acct, keyHash: stale.hash }, { periodDays: 7, groupBy: "day", now: NOW });
    expect(own.budgets.map((b) => b.key_hash)).toEqual([stale.hash]);
  });

  test("GET /api/v1/spend: a management key sees every key of its account; a sub-key only its own", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const s = await subKey(h, root, { name: "worker", limit: 20 });
    const other = await h.newKey();
    const now = Date.now();
    await gen(h, acct, root.hash, now, "1.25", "acme/model-x");
    await gen(h, acct, s.hash, now, "2", "acme/model-y");
    await gen(h, await accountOf(h, other.hash), other.hash, now, "5");

    const get = async (k: Key, qs = "") => {
      const r = await h.request("/api/v1/spend" + qs, { headers: k.auth });
      return { status: r.status, body: await r.json(), cache: r.headers.get("cache-control") };
    };
    const mgmt = await get(root, "?period=7d&group_by=key");
    expect(mgmt.status).toBe(200);
    expect(mgmt.cache).toBe("no-store");
    expect(mgmt.body.data.scope).toBe("account");
    expect(mgmt.body.data.totals.today_usd).toBe(3.25);
    expect(mgmt.body.data.series).toHaveLength(7);
    expect(mgmt.body.data.breakdown.map((r: any) => r.id).sort()).toEqual([root.hash, s.hash].sort());
    expect(mgmt.body.data.budgets.map((b: any) => b.key_hash)).toEqual([s.hash]);

    const sub = await get(s, "?group_by=model");
    expect(sub.body.data).toMatchObject({ scope: "key", key_hash: s.hash, period: "30d", group_by: "model" });
    expect(sub.body.data.totals.today_usd).toBe(2);
    expect(sub.body.data.breakdown.map((r: any) => r.id)).toEqual(["acme/model-y"]);
    expect(sub.body.data.budgets.map((b: any) => b.key_hash)).toEqual([s.hash]);

    expect((await get(other)).body.data.totals.today_usd).toBe(5);
    expect((await get(root, "?period=365d")).status).toBe(400);
    expect((await get(root, "?group_by=prompt")).status).toBe(400);
    expect((await h.request("/api/v1/spend")).status).toBe(401);
  });
});

describe("Spend Watch: alert rules API", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => {
    await h.close();
  });

  test("webhook URLs are stored encrypted with APP_SECRET and only ever returned masked", async () => {
    const root = await h.newKey();
    const created = await createRule(h, root, { kind: "threshold", window: "day", threshold_usd: 5, webhook_url: HOOK });
    expect(created.webhook_url).toBe("https://hooks.example.com/…");
    const row = await rule(h, created.id);
    expect(row.webhookUrlEnc).toMatch(/^v1\./);
    expect(row.webhookUrlEnc).not.toContain("hooks.example.com");
    expect(decrypt(h.ctx.cfg.appSecret, row.webhookUrlEnc!)).toBe(HOOK);
    expect(row.thresholdUsd).toBe(usdToPico("5"));
    const listed = await (await h.request("/api/v1/spend/alerts", { headers: root.auth })).text();
    expect(listed).not.toContain("s3cr3t");
    expect(listed).not.toContain("token=abc");
    expect(JSON.parse(listed)).toMatchObject({ data: [{ id: created.id, kind: "threshold", window: "day", threshold_usd: 5, webhook_url: "https://hooks.example.com/…", enabled: true, history: [] }], limits: { max_rules: 20 } });
    expect(maskWebhookUrl("https://h.example.org:8443/a/b?c=d")).toBe("https://h.example.org:8443/…");

    // Replace, then remove.
    const patched = await (await h.request(`/api/v1/spend/alerts/${created.id}`, { method: "PATCH", headers: root.auth, json: { webhook_url: "https://other.example.net/x" } })).json();
    expect(patched.data.webhook_url).toBe("https://other.example.net/…");
    const removed = await (await h.request(`/api/v1/spend/alerts/${created.id}`, { method: "PATCH", headers: root.auth, json: { webhook_url: null } })).json();
    expect(removed.data.webhook_url).toBeNull();
    expect((await rule(h, created.id)).webhookUrlEnc).toBeNull();
  });

  test("private, local and plain-http webhook destinations are refused at save", async () => {
    const root = await h.newKey();
    const bad = [
      "http://hooks.example.com/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/hook",
      "https://192.168.1.10/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[fd00::1]/x",
      "https://2130706433/", // 127.0.0.1 as a decimal host
      "https://0x7f.1/",
      "https://localhost/x",
      "https://metadata.internal/x",
      "https://printer.local/x",
      "https://intranet/x",
      "https://user:pw@hooks.example.com/x",
      "https://hooks.example.com/x#frag",
      "ftp://hooks.example.com/x",
      "not a url",
    ];
    for (const url of bad) {
      expect(webhookUrlProblem(url)).not.toBeNull();
      const r = await h.request("/api/v1/spend/alerts", { method: "POST", headers: root.auth, json: { kind: "anomaly", webhook_url: url } });
      expect({ url, status: r.status }).toEqual({ url, status: 400 });
      expect((await r.json()).error.type).toBe("invalid_webhook_url");
    }
    for (const url of ["https://hooks.example.com/x", "https://8.8.8.8/hook", "https://[2606:4700:4700::1111]/hook", "https://hooks.example.com:8443/a?b=c"]) expect(webhookUrlProblem(url)).toBeNull();
    const ok = await createRule(h, root, { kind: "anomaly" });
    const r = await h.request(`/api/v1/spend/alerts/${ok.id}`, { method: "PATCH", headers: root.auth, json: { webhook_url: "http://hooks.example.com/x" } });
    expect(r.status).toBe(400);
    expect((await rule(h, ok.id)).webhookUrlEnc).toBeNull();
  });

  test("rule shapes are validated per kind", async () => {
    const root = await h.newKey();
    const noBudget = await subKey(h, root);
    const withBudget = await subKey(h, root, { limit: 10, limit_reset: "weekly" });
    const post = (json: Record<string, unknown>) => h.request("/api/v1/spend/alerts", { method: "POST", headers: root.auth, json });
    for (const body of [
      { kind: "threshold" },
      { kind: "threshold", threshold_usd: 0 },
      { kind: "threshold", threshold_usd: 5, window: "year" },
      { kind: "threshold", threshold_usd: 5, pct: 50 },
      { kind: "budget_pct", pct: 80 },
      { kind: "budget_pct", key_hash: withBudget.hash },
      { kind: "budget_pct", key_hash: noBudget.hash, pct: 80 },
      { kind: "budget_pct", key_hash: withBudget.hash, pct: 80, threshold_usd: 1 },
      { kind: "anomaly", window: "week" },
      { kind: "anomaly", multiplier: 1 },
      { kind: "anomaly", threshold: 5 },
      { kind: "velocity" },
    ])
      expect({ body, status: (await post(body)).status }).toEqual({ body, status: 400 });
    expect((await post({ kind: "threshold", threshold_usd: 5, key_hash: "f".repeat(64) })).status).toBe(404);

    const b = await createRule(h, root, { kind: "budget_pct", key_hash: withBudget.hash, pct: 80 });
    expect(b).toMatchObject({ kind: "budget_pct", window: "week", pct: 80, key_hash: withBudget.hash, threshold_usd: null, multiplier: null });
    const a = await createRule(h, root, { kind: "anomaly", multiplier: 2.5 });
    expect(a).toMatchObject({ kind: "anomaly", window: "day", multiplier: 2.5, pct: null, key_hash: null });
    expect((await rule(h, a.id)).pct).toBe(250);
    const t = await createRule(h, root, { kind: "threshold", threshold_usd: 12.5, window: "month", enabled: false });
    expect(t).toMatchObject({ window: "month", threshold_usd: 12.5, enabled: false });
    const kindChange = await h.request(`/api/v1/spend/alerts/${t.id}`, { method: "PATCH", headers: root.auth, json: { kind: "anomaly" } });
    expect(kindChange.status).toBe(400);
  });

  test("only owners/admins write; a sub-key watches only itself; other accounts see nothing", async () => {
    const root = await h.newKey();
    const member = await subKey(h, root);
    const team = await (await h.request("/api/v1/teams", { method: "POST", headers: root.auth, json: { name: "ops" } })).json();
    const admin = await subKey(h, root, { team: team.data.id });
    expect((await h.request(`/api/v1/teams/${team.data.id}/members/${admin.hash}`, { method: "PUT", headers: root.auth, json: { role: "admin" } })).status).toBe(200);
    const stranger = await h.newKey();

    const accountRule = await createRule(h, root, { kind: "threshold", threshold_usd: 5 });
    const memberRule = await createRule(h, root, { kind: "threshold", threshold_usd: 1, key_hash: member.hash });
    const post = (k: Key, json: Record<string, unknown>) => h.request("/api/v1/spend/alerts", { method: "POST", headers: k.auth, json });

    expect((await post(member, { kind: "threshold", threshold_usd: 1, key_hash: member.hash })).status).toBe(403); // role member
    expect((await post(admin, { kind: "threshold", threshold_usd: 1 })).status).toBe(403); // whole account
    expect((await post(admin, { kind: "threshold", threshold_usd: 1, key_hash: root.hash })).status).toBe(403); // another key
    const own = await createRule(h, admin, { kind: "anomaly", key_hash: admin.hash });
    expect((await h.request(`/api/v1/spend/alerts/${own.id}`, { method: "PATCH", headers: admin.auth, json: { key_hash: null } })).status).toBe(403);

    const list = async (k: Key) => ((await (await h.request("/api/v1/spend/alerts", { headers: k.auth })).json()).data as { id: string }[]).map((r) => r.id).sort();
    expect(await list(root)).toEqual([accountRule.id, memberRule.id, own.id].sort());
    expect(await list(member)).toEqual([memberRule.id]); // read-only view of rules on its own key
    expect(await list(admin)).toEqual([own.id]);
    expect(await list(stranger)).toEqual([]);

    for (const k of [stranger, admin])
      for (const [method, json] of [["PATCH", { enabled: false }], ["DELETE", undefined]] as const)
        expect((await h.request(`/api/v1/spend/alerts/${accountRule.id}`, { method, headers: k.auth, json })).status).toBe(404);
    expect((await h.request(`/api/v1/spend/alerts/${memberRule.id}`, { method: "DELETE", headers: member.auth })).status).toBe(403);
    expect((await h.request("/api/v1/spend/alerts")).status).toBe(401);

    expect((await h.request(`/api/v1/spend/alerts/${accountRule.id}`, { method: "DELETE", headers: root.auth })).status).toBe(200);
    expect(await list(root)).toEqual([memberRule.id, own.id].sort());
  });

  test("an account holds at most 20 rules", async () => {
    const root = await h.newKey();
    const made = await Promise.all(Array.from({ length: 21 }, (_, i) => h.request("/api/v1/spend/alerts", { method: "POST", headers: root.auth, json: { kind: "threshold", threshold_usd: i + 1 } })));
    expect(made.filter((r) => r.status === 201)).toHaveLength(20);
    const refused = made.find((r) => r.status !== 201)!;
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.type).toBe("too_many_rules");
    const [row] = await h.ctx.db.select({ n: spendAlerts.id }).from(spendAlerts).where(eq(spendAlerts.accountId, await accountOf(h, root.hash))).then((r) => [r.length]);
    expect(row).toBe(20);
  });
});

describe("Spend Watch: the spend-watch job", () => {
  let h: Harness;
  let sent: { url: string; body: any }[];
  let replies: (number | Error)[];
  const send: SpendWatchOptions["send"] = async (url, init) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const next = replies.length > 1 ? replies.shift()! : (replies[0] ?? 204);
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  };
  const tick = (t: number, extra: SpendWatchOptions = {}) => runSpendWatch(h.ctx, { now: () => t, send, ...extra });
  const history = async (id: string) => parseAlertState((await rule(h, id)).state).history;
  const servers: ReturnType<typeof Bun.serve>[] = [];

  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    sent = [];
    replies = [];
    await h.ctx.db.delete(spendAlerts); // the job evaluates every account's rules
  });
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });

  test("threshold rules fire once per window period", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const r = await createRule(h, root, { kind: "threshold", window: "day", threshold_usd: 5 });
    const weekly = await createRule(h, root, { kind: "threshold", window: "week", threshold_usd: 8 });
    await gen(h, acct, root.hash, NOW - 3_600_000, "3");
    expect((await tick(NOW)).fired).toBe(0);
    await gen(h, acct, root.hash, NOW - 60_000, "3");
    expect((await tick(NOW)).fired).toBe(1);
    expect(await tick(NOW + 60_000)).toMatchObject({ fired: 0 });
    expect(await tick(NOW + 3_600_000)).toMatchObject({ fired: 0 });
    const [f] = await history(r.id);
    expect(f).toMatchObject({ period: "day:2026-09-15", kind: "threshold", window: "day", value: usdToPico("6").toString(), threshold: usdToPico("5").toString(), delivery: { status: "none", attempts: 0 } });
    expect((await rule(h, r.id)).lastPeriod).toBe("day:2026-09-15");

    // Next day: $2 is under the daily threshold; the week ($8) now crosses the weekly one.
    await gen(h, acct, root.hash, NOW + DAY, "2");
    expect((await tick(NOW + DAY + 60_000)).fired).toBe(1);
    expect((await history(weekly.id)).map((x) => x.period)).toEqual(["week:2026-09-14"]);
    await gen(h, acct, root.hash, NOW + DAY + 120_000, "3.5");
    expect((await tick(NOW + DAY + 180_000)).fired).toBe(1);
    expect((await history(r.id)).map((x) => x.period)).toEqual(["day:2026-09-16", "day:2026-09-15"]);
    expect((await tick(NOW + DAY + 240_000)).fired).toBe(0);
    expect(sent).toHaveLength(0); // no webhook configured
  });

  test("budget_pct rules fire once per budget period", async () => {
    const root = await h.newKey();
    const s = await subKey(h, root, { name: "agent", limit: 10, limit_reset: "monthly" });
    const r = await createRule(h, root, { kind: "budget_pct", key_hash: s.hash, pct: 80, webhook_url: HOOK });
    await h.ctx.db.update(keys).set({ spent: usdToPico("7.99"), periodStart: new Date(Date.UTC(2026, 8, 1)) }).where(eq(keys.keyHash, s.hash));
    expect((await tick(NOW)).fired).toBe(0);
    await h.ctx.db.update(keys).set({ spent: usdToPico("8.5") }).where(eq(keys.keyHash, s.hash));
    expect((await tick(NOW)).fired).toBe(1);
    expect((await tick(NOW + 60_000)).fired).toBe(0);
    await h.ctx.db.update(keys).set({ spent: usdToPico("9.9") }).where(eq(keys.keyHash, s.hash));
    expect((await tick(NOW + 120_000)).fired).toBe(0);
    const [label] = await h.ctx.db.select({ l: keys.label }).from(keys).where(eq(keys.keyHash, s.hash));
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ alert_id: r.id, kind: "budget_pct", window: "month", value_usd: 8.5, threshold_usd: 8, pct: 85, key_label: label.l, period: "budget:month:2026-09-01", at: new Date(NOW).toISOString() });

    // October: September's spend no longer counts until the key spends in the new period.
    const oct = Date.UTC(2026, 9, 2, 12);
    expect((await tick(oct)).fired).toBe(0);
    await h.ctx.db.update(keys).set({ spent: usdToPico("9"), periodStart: new Date(Date.UTC(2026, 9, 1)) }).where(eq(keys.keyHash, s.hash));
    expect((await tick(oct + 60_000)).fired).toBe(1);
    expect((await history(r.id)).map((x) => x.period)).toEqual(["budget:month:2026-10-01", "budget:month:2026-09-01"]);
  });

  test("anomaly rules fire once per day, only above N x the trailing average and $1", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const r = await createRule(h, root, { kind: "anomaly", webhook_url: HOOK }); // default 3x
    const strict = await createRule(h, root, { kind: "anomaly", multiplier: 4, key_hash: root.hash });
    for (let d = 1; d <= 7; d++) await gen(h, acct, root.hash, NOW - d * DAY, "1"); // $1/day average
    await gen(h, acct, root.hash, NOW - 60_000, "2.5");
    expect((await tick(NOW)).fired).toBe(0);
    await gen(h, acct, root.hash, NOW - 30_000, "1"); // $3.50 today: 3.5x
    expect((await tick(NOW)).fired).toBe(1);
    expect((await tick(NOW + 60_000)).fired).toBe(0);
    expect(await history(strict.id)).toEqual([]);
    expect(sent.map((x) => x.body)).toEqual([{ alert_id: r.id, kind: "anomaly", window: "day", value_usd: 3.5, threshold_usd: 3, pct: 350, period: "day:2026-09-15", at: new Date(NOW).toISOString() }]);
    await gen(h, acct, root.hash, NOW + 1000, "1"); // $4.50: now over 4x too
    expect((await tick(NOW + 120_000)).fired).toBe(1);
    expect((await history(strict.id))[0]).toMatchObject({ period: "day:2026-09-15", key_label: expect.stringMatching(/^sk-ar-v1-/) });
  });

  test("two replicas evaluating at once fire and deliver exactly once; a stale copy cannot re-fire", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const r = await createRule(h, root, { kind: "threshold", threshold_usd: 1, webhook_url: HOOK });
    await gen(h, acct, root.hash, NOW - 60_000, "2");
    const stale = await rule(h, r.id);
    const results = await Promise.all([tick(NOW), tick(NOW), tick(NOW)]);
    expect(results.reduce((n, x) => n + x.fired, 0)).toBe(1);
    // Delivery claims the rule with SKIP LOCKED, so the replica that fired can skip its own delivery
    // while a sibling holds the row; the pending firing then goes out on the next tick. One more tick
    // cannot fire again, and the delivery still happens exactly once.
    expect((await tick(NOW)).fired).toBe(0);
    expect(sent).toHaveLength(1);
    expect(await history(r.id)).toHaveLength(1);
    expect((await history(r.id))[0].delivery).toMatchObject({ status: "delivered", attempts: 1, http_status: 204 });

    // A replica that read the rule before the firing (last_period still empty) is refused by the
    // conditional update, whatever it computed.
    expect(stale.lastPeriod).toBeNull();
    const plan = { period: "day:2026-09-15", window: "day", value: usdToPico("2"), threshold: usdToPico("1"), pct: null, keyLabel: null };
    expect(await claimFiring(h.ctx.db, stale, plan, NOW)).toBeNull();
    // An edit between evaluation and claim also voids the stale evaluation.
    await h.request(`/api/v1/spend/alerts/${r.id}`, { method: "PATCH", headers: root.auth, json: { threshold_usd: 1.5 } });
    expect((await rule(h, r.id)).lastPeriod).toBeNull(); // a changed condition re-arms the rule
    expect(await claimFiring(h.ctx.db, stale, plan, NOW)).toBeNull();
    expect(await history(r.id)).toHaveLength(1);
    expect((await tick(NOW + 60_000)).fired).toBe(1); // re-armed with the new threshold
    expect(sent).toHaveLength(2);
  });

  test("failed deliveries retry on the next ticks, at most 3 attempts, with the status recorded", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const a = await createRule(h, root, { kind: "threshold", threshold_usd: 1, webhook_url: HOOK });
    await gen(h, acct, root.hash, NOW - 60_000, "2");
    replies = [500, Object.assign(new Error("slow"), { name: "TimeoutError" }), 204];
    await tick(NOW);
    expect((await history(a.id))[0].delivery).toMatchObject({ status: "pending", attempts: 1, http_status: 500, error: "http_500", lease_until: null });
    await tick(NOW + 60_000);
    expect((await history(a.id))[0].delivery).toMatchObject({ status: "pending", attempts: 2, http_status: null, error: "timeout" });
    await tick(NOW + 120_000);
    expect((await history(a.id))[0].delivery).toMatchObject({ status: "delivered", attempts: 3, http_status: 204, error: null });
    await tick(NOW + 180_000);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => JSON.stringify(s.body))).size).toBe(1); // the same firing each time
    expect(sent[0].url).toBe(HOOK);

    // Always failing: three attempts, then `failed`, and no fourth.
    await h.ctx.db.delete(spendAlerts);
    sent = [];
    replies = [503];
    const b = await createRule(h, root, { kind: "threshold", threshold_usd: 1, webhook_url: HOOK });
    for (let i = 0; i < 5; i++) await tick(NOW + i * 60_000);
    expect(sent).toHaveLength(3);
    expect((await history(b.id))[0].delivery).toMatchObject({ status: "failed", attempts: 3, http_status: 503, error: "http_503" });
    const api = await (await h.request("/api/v1/spend/alerts", { headers: root.auth })).json();
    expect(api.data[0].history[0]).toMatchObject({ alert_id: b.id, value_usd: 2, threshold_usd: 1, delivery: { status: "failed", attempts: 3, max_attempts: 3, http_status: 503 } });
    expect(JSON.stringify(api)).not.toContain("s3cr3t");
  });

  test("an attempt in flight on another replica is not repeated until its lease lapses", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const r = await createRule(h, root, { kind: "threshold", threshold_usd: 1, webhook_url: HOOK });
    await gen(h, acct, root.hash, NOW - 60_000, "2");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: SpendWatchOptions["send"] = async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      await gate;
      return new Response(null, { status: 204 });
    };
    const first = runSpendWatch(h.ctx, { now: () => NOW, send: slow });
    while (!sent.length) await Bun.sleep(5);
    await runSpendWatch(h.ctx, { now: () => NOW + 1_000, send: slow }); // lease still held
    expect(sent).toHaveLength(1);
    release();
    await first;
    expect((await history(r.id))[0].delivery).toMatchObject({ status: "delivered", attempts: 1 });
  });

  test("a replica that stops mid-attempt: the lapsed lease is retried, and a lost last attempt ends as failed", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const r = await createRule(h, root, { kind: "threshold", threshold_usd: 1, webhook_url: HOOK });
    await gen(h, acct, root.hash, NOW - 60_000, "2");
    replies = [500];
    await tick(NOW); // attempt 1 fails normally
    // Simulate a replica that claimed attempt 2 and died before recording its result.
    const crash = async (attempts: number) => {
      const state = parseAlertState((await rule(h, r.id)).state);
      Object.assign(state.history[0].delivery, { status: "pending", attempts, lease_until: NOW + 90_000 });
      await h.ctx.db.update(spendAlerts).set({ state }).where(eq(spendAlerts.id, r.id));
    };
    await crash(2);
    await tick(NOW + 60_000); // lease still held: nothing sent
    expect(sent).toHaveLength(1);
    replies = [204];
    await tick(NOW + 120_000); // lease lapsed: the third and last attempt
    expect(sent).toHaveLength(2);
    expect((await history(r.id))[0].delivery).toMatchObject({ status: "delivered", attempts: 3 });
    await crash(3);
    await tick(NOW + 240_000);
    expect(sent).toHaveLength(2); // no fourth attempt
    expect((await history(r.id))[0].delivery).toMatchObject({ status: "failed", attempts: 3, lease_until: null });
  });

  test("webhook egress refuses private and plain-http destinations at send, before any socket opens", async () => {
    let hits = 0;
    const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return new Response("ok"); } });
    servers.push(local);
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    await gen(h, acct, root.hash, NOW - 60_000, "2");
    // Passes the static check at save, but its DNS answer is private at send time.
    const rebinding = await createRule(h, root, { kind: "threshold", threshold_usd: 1, webhook_url: "https://hooks.example.test/in" });
    // Rows written around the API (an older release, a manual fix): refused all the same.
    const direct = async (url: string) => {
      const id = uid("sa_");
      await h.ctx.db.insert(spendAlerts).values({ id, accountId: acct, kind: "threshold", window: "day", thresholdUsd: usdToPico("1"), webhookUrlEnc: encrypt(h.ctx.cfg.appSecret, url), state: { v: 1, history: [] } });
      return id;
    };
    const literal = await direct(`https://127.0.0.1:${local.port}/hook`);
    const plain = await direct(`http://127.0.0.1:${local.port}/hook`);
    const metadata = await direct("https://169.254.169.254/latest");
    const resolve = async () => [{ address: "10.0.0.7", family: 4 }];
    await runSpendWatch(h.ctx, { now: () => NOW, resolve }); // the real egress path: no `send` override
    for (const id of [rebinding.id, literal, plain, metadata])
      expect((await history(id))[0].delivery).toMatchObject({ status: "blocked", attempts: 1, error: "destination_blocked", http_status: null });
    await runSpendWatch(h.ctx, { now: () => NOW + 60_000, resolve });
    expect((await history(rebinding.id))[0].delivery.attempts).toBe(1); // terminal: not retried
    expect(hits).toBe(0);

    // Loopback answers are refused too, and the transport is never reached for a bad URL.
    const loop = await sendWebhook("https://hooks.example.test/x", { a: 1 }, { resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    expect(loop).toEqual({ ok: false, status: null, error: "destination_blocked", blocked: true });
    let transport = 0;
    const viaStub = await sendWebhook(`http://127.0.0.1:${local.port}/x`, {}, { send: async () => { transport++; return new Response(null, { status: 204 }); } });
    expect(viaStub.blocked).toBe(true);
    expect(transport).toBe(0);
    expect(hits).toBe(0);
  });

  test("disabling a rule or removing its webhook cancels pending deliveries", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const r = await createRule(h, root, { kind: "threshold", threshold_usd: 1, webhook_url: HOOK });
    await gen(h, acct, root.hash, NOW - 60_000, "2");
    replies = [500];
    await tick(NOW);
    expect((await history(r.id))[0].delivery.status).toBe("pending");
    await h.request(`/api/v1/spend/alerts/${r.id}`, { method: "PATCH", headers: root.auth, json: { enabled: false } });
    expect((await history(r.id))[0].delivery.status).toBe("cancelled");
    await h.request(`/api/v1/spend/alerts/${r.id}`, { method: "PATCH", headers: root.auth, json: { enabled: true } });
    await tick(NOW + 60_000);
    expect(sent).toHaveLength(1);
    expect((await rule(h, r.id)).lastPeriod).toBe("day:2026-09-15"); // re-enabling does not re-fire the period
    expect(await history(r.id)).toHaveLength(1);
  });

  test("history keeps the last 20 firings", async () => {
    const root = await h.newKey();
    const acct = await accountOf(h, root.hash);
    const r = await createRule(h, root, { kind: "threshold", threshold_usd: 1 });
    for (let d = 0; d < 23; d++) {
      await gen(h, acct, root.hash, NOW + d * DAY, "1");
      await tick(NOW + d * DAY + 1000);
    }
    const hist = await history(r.id);
    expect(hist).toHaveLength(20);
    expect(hist[0].period).toBe("day:2026-10-07");
    expect(hist.at(-1)!.period).toBe("day:2026-09-18");
  });
});

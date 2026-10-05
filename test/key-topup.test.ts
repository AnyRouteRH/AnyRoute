import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { accounts, keys, keyTopups, ledger, teams } from "../src/db/schema.ts";
import { balanceOf, reserve, settle, verifyInvariants } from "../src/ledger/ledger.ts";
import { topupWeekStart } from "../src/ledger/topup.ts";
import { usdToPico } from "../src/lib/money.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";

// Auto top-up: a key's limit rises from the account's own credits when it runs low, within a weekly maximum.
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });

type Key = { hash: string; auth: Record<string, string> };
const rule = (below: number, add: number, week: number) => ({ below_usd: below, add_usd: add, max_per_week_usd: week });
async function agentKey(owner: Key, limit: number | null = 10, name = "Research agent"): Promise<Key> {
  const r = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name, limit } });
  expect(r.status).toBe(201);
  const j = await r.json();
  return { hash: j.data.hash, auth: { authorization: `Bearer ${j.key}` } };
}
const patch = (owner: Key, k: Key, body: object) => h.request(`/api/v1/keys/${k.hash}`, { method: "PATCH", headers: owner.auth, json: body });
const getKey = async (owner: Key, k: Key) => (await (await h.request(`/api/v1/keys/${k.hash}`, { headers: owner.auth })).json()).data;
const row = async (k: Key) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash)))[0];
const records = (k: Key) => h.ctx.db.select().from(keyTopups).where(eq(keyTopups.keyHash, k.hash)).orderBy(keyTopups.createdAt);
let n = 0;
async function hold(k: Key, usd: number, agent = false) {
  const id = `topup-hold-${++n}`;
  const { accountId } = await row(k);
  await reserve(h.ctx.db, { id, accountId, keyHash: k.hash, amount: usdToPico(usd), ...(agent ? { agent: { models: [MODELS.llama.slug], lane: "public" as const, max_output_tokens: 32, body: {} } } : {}) });
  return id;
}
async function debit(k: Key, usd: number, agent = false) {
  await settle(h.ctx.db, await hold(k, usd, agent), usdToPico(usd));
}
async function inbox(k: Key) {
  const r = await h.request("/api/v1/inbox", { headers: k.auth });
  expect(r.status).toBe(200);
  return (await r.json()).data.filter((item: any) => item.kind === "topup");
}

test("crossing the threshold tops the key up once, recorded, in Activity and the inbox; the balance does not move", async () => {
  const owner = await h.fundedKey(20n), k = await agentKey(owner);
  const r = await patch(owner, k, { topup: rule(2, 5, 20) });
  expect(r.status).toBe(200);
  expect((await r.json()).data).toMatchObject({ limit: 10, topup: rule(2, 5, 20), topups_this_week_usd: 0 });
  const { accountId } = await row(k);
  await debit(k, 7); // $3 left: above $2, nothing happens
  expect((await row(k)).budget).toBe(usdToPico(10));
  expect(await records(k)).toHaveLength(0);
  const before = await balanceOf(h.ctx.db, accountId);
  await debit(k, 1.5); // $1.50 left: below $2, add $5
  expect((await row(k)).budget).toBe(usdToPico(15));
  expect((await balanceOf(h.ctx.db, accountId)).balance).toBe(before.balance - usdToPico(1.5)); // only the debit moved money
  await debit(k, 0.1); // $6.40 left
  expect((await row(k)).budget).toBe(usdToPico(15));
  const rows = await records(k);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ outcome: "added", accountId, amount: usdToPico(5), limitBefore: usdToPico(10), limitAfter: usdToPico(15), spent: usdToPico(8.5), weekTotal: usdToPico(5), maxPerWeek: usdToPico(20) });
  expect(rows[0].ref).toStartWith("settle:");
  expect(rows[0].weekStart.getUTCDay()).toBe(1);
  expect(rows[0].weekStart.getTime()).toBe(topupWeekStart(rows[0].createdAt).getTime());
  expect(await h.ctx.db.select().from(ledger).where(and(eq(ledger.accountId, accountId), eq(ledger.kind, "topup")))).toHaveLength(0);
  expect(await getKey(owner, k)).toMatchObject({ limit: 15, limit_remaining: 6.4, topup: rule(2, 5, 20), topups_this_week_usd: 5 });
  const items = await inbox(owner);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ title: "Topped up Research agent by $5; $15 left this week", status: "added", key_label: "Research agent", href: "/dashboard/#api-keys" });
  expect((await inbox(k)).map((item: any) => item.id)).toEqual([items[0].id]); // the key sees its own top-ups
  const activity = await (await h.request("/api/v1/activity?kind=topup", { headers: owner.auth })).json();
  expect(activity.data.map((a: any) => [a.title, a.amount, a.status])).toEqual([["Topped up Research agent by $5; $15 left this week", "0", "added"]]);
  expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
});

test("concurrent debits and requests make exactly one top-up per crossing", async () => {
  const owner = await h.fundedKey(50n), k = await agentKey(owner);
  expect((await patch(owner, k, { topup: rule(5, 10, 50) })).status).toBe(200);
  await debit(k, 4.5); // $5.50 left
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push(await hold(k, 0.5));
  await Promise.all(ids.map((id) => settle(h.ctx.db, id, usdToPico(0.5)))); // the second settle crosses $5
  expect(await records(k)).toHaveLength(1);
  expect((await row(k)).budget).toBe(usdToPico(20));
  // A key stalled at its limit: concurrent requests the limit would refuse make one top-up, then fit.
  const stalled = await agentKey(owner, 1);
  await debit(stalled, 1);
  expect((await patch(owner, stalled, { topup: rule(1, 5, 50) })).status).toBe(200);
  const { accountId } = await row(stalled);
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => reserve(h.ctx.db, { id: `stalled-${i}-${stalled.hash}`, accountId, keyHash: stalled.hash, amount: usdToPico(0.5) })));
  expect(results.map((r) => r.status)).toEqual(Array(5).fill("fulfilled"));
  const stalledRows = await records(stalled);
  expect(stalledRows.map((r) => [r.outcome, r.ref.split(":")[0]])).toEqual([["added", "reserve"]]);
  expect((await row(stalled)).budget).toBe(usdToPico(6));
  expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
});

test("the weekly maximum is respected, last week's top-ups do not count, and the inbox says why once", async () => {
  const owner = await h.fundedKey(50n), k = await agentKey(owner);
  expect((await patch(owner, k, { topup: rule(2, 5, 8) })).status).toBe(200);
  const { accountId } = await row(k);
  const lastWeek = new Date(topupWeekStart(new Date()).getTime() - 3_600_000);
  await h.ctx.db.insert(keyTopups).values({ id: "kt_last_week", ref: `settle:last-week-${k.hash}`, keyHash: k.hash, accountId, outcome: "added", amount: usdToPico(5), limitBefore: usdToPico(5), limitAfter: usdToPico(10), spent: 0n, available: usdToPico(50), weekStart: topupWeekStart(lastWeek), weekTotal: usdToPico(5), maxPerWeek: usdToPico(8), createdAt: lastWeek });
  expect((await getKey(owner, k)).topups_this_week_usd).toBe(0);
  await debit(k, 8.5); // $1.50 left: first top-up this week, $5 of $8
  expect((await row(k)).budget).toBe(usdToPico(15));
  await debit(k, 5); // $1.50 left again: $5 more would make $10 > $8
  await debit(k, 0.5); // still below: the same reason is not repeated
  expect((await row(k)).budget).toBe(usdToPico(15));
  const rows = (await records(k)).filter((r) => r.id !== "kt_last_week");
  expect(rows.map((r) => [r.outcome, r.weekTotal])).toEqual([["added", usdToPico(5)], ["skipped_weekly", usdToPico(5)]]);
  expect(rows[1].limitAfter).toBe(rows[1].limitBefore);
  expect((await getKey(owner, k)).topups_this_week_usd).toBe(5);
  expect((await inbox(owner)).filter((item: any) => item.id !== "topup:kt_last_week").map((item: any) => [item.title, item.status])).toEqual([
    ["Could not top up Research agent by $5: its $8 weekly top-up limit is reached", "skipped"],
    ["Topped up Research agent by $5; $3 left this week", "added"],
  ]);
  // A request the limit refuses stays refused; no top-up beyond the weekly maximum.
  await expect(hold(k, 2)).rejects.toMatchObject({ type: "key_budget_exceeded" });
  expect((await records(k)).filter((r) => r.id !== "kt_last_week")).toHaveLength(2);
});

test("an account that cannot cover the top-up gets no top-up and a clear inbox note, then resumes after a deposit", async () => {
  const owner = await h.fundedKey(3n), k = await agentKey(owner, 2);
  expect((await patch(owner, k, { topup: rule(1, 5, 20) })).status).toBe(200);
  await debit(k, 1.5); // $0.50 left, the account has $1.50: a $5.50 allowance would be above what it holds
  expect((await row(k)).budget).toBe(usdToPico(2));
  expect((await records(k)).map((r) => [r.outcome, r.available])).toEqual([["skipped_balance", usdToPico(1.5)]]);
  expect((await inbox(owner)).map((item: any) => item.title)).toEqual(["Could not top up Research agent by $5: your account has $1.50 available"]);
  // The next request the limit refuses tries again, records nothing new and is refused.
  await expect(hold(k, 1)).rejects.toMatchObject({ status: 402, type: "key_budget_exceeded" });
  expect(await records(k)).toHaveLength(1);
  // After a deposit the same request tops up first and fits.
  const funded = (await h.ctx.db.select({ chain: keys.chainKeyHash }).from(keys).where(eq(keys.keyHash, owner.hash)))[0].chain;
  await h.chain.deposit(h.ctx, funded, 10n * 1_000_000n);
  await hold(k, 1);
  expect((await row(k)).budget).toBe(usdToPico(7));
  expect((await records(k)).map((r) => r.outcome)).toEqual(["skipped_balance", "added"]);
  expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
});

test("a team key's top-up must fit the org budget", async () => {
  const owner = await h.fundedKey(50n), k = await agentKey(owner);
  const { accountId } = await row(k);
  await h.ctx.db.insert(teams).values({ id: `topup-team-${k.hash.slice(0, 8)}`, name: "Agents", ownerAccount: accountId, budget: usdToPico(12) });
  await h.ctx.db.update(keys).set({ teamId: `topup-team-${k.hash.slice(0, 8)}` }).where(eq(keys.keyHash, k.hash));
  expect((await patch(owner, k, { topup: rule(2, 5, 20) })).status).toBe(200);
  await debit(k, 9);
  expect((await row(k)).budget).toBe(usdToPico(10));
  expect((await records(k)).map((r) => r.outcome)).toEqual(["skipped_org_budget"]);
  expect((await inbox(owner))[0].title).toBe("Could not top up Research agent by $5: the team budget is fully allocated");
});

test("the rule is validated, needs a total limit, and clearing it stops top-ups", async () => {
  const owner = await h.fundedKey(20n), k = await agentKey(owner);
  for (const bad of [rule(2, 6, 5), rule(2, 1001, 5000), rule(2, 5, 5001), rule(1001, 5, 20), rule(0, 5, 20), rule(2, -1, 20), { ...rule(2, 5, 20), extra: 1 }, { below_usd: 2, add_usd: 5 }]) {
    const r = await patch(owner, k, { topup: bad });
    expect(r.status).toBe(400);
    expect((await r.json()).error.type).toBe("invalid_request");
  }
  expect((await patch(owner, k, { topup: rule(1000, 1000, 5000) })).status).toBe(200);
  // A limit that resets, or no limit, cannot carry a rule; both can change together with the rule.
  expect((await (await patch(owner, k, { limit_reset: "weekly" })).json()).error.message).toContain("does not reset");
  expect((await (await patch(owner, k, { limit: null })).json()).error.message).toContain("set `limit` too");
  const unlimited = await agentKey(owner, null);
  expect((await patch(owner, unlimited, { topup: rule(1, 5, 20) })).status).toBe(400);
  expect((await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "x", limit: 5, topup: rule(1, 5, 20) } })).status).toBe(400);
  // Viewers and the key itself cannot change it.
  expect((await patch(k, k, { topup: null })).status).toBe(403);
  // Clearing.
  expect((await patch(owner, k, { topup: rule(2, 5, 20) })).status).toBe(200);
  const cleared = await patch(owner, k, { topup: null });
  expect((await cleared.json()).data.topup).toBeNull();
  await debit(k, 9.5);
  expect((await row(k)).budget).toBe(usdToPico(10));
  expect(await records(k)).toHaveLength(0);
  expect((await patch(owner, k, { limit: null, topup: null })).status).toBe(200);
  expect((await (await h.request("/api/v1/keys", { headers: owner.auth })).json()).data.find((x: any) => x.hash === k.hash).topup).toBeNull();
});

test("rulebook caps still apply after a top-up", async () => {
  const owner = await h.fundedKey(30n), k = await agentKey(owner);
  expect((await patch(owner, k, { topup: rule(2, 5, 20) })).status).toBe(200);
  const policy = await h.request(`/api/v1/agents/${k.hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: { per_day_usd: 9 }, on_breach: "deny" } });
  expect(policy.status).toBe(200);
  await debit(k, 8.5, true); // $1.50 left: topped up to $15
  expect((await row(k)).budget).toBe(usdToPico(15));
  // The key's limit has room, but $9.50 today is over the $9 cap per day.
  await expect(hold(k, 1, true)).rejects.toMatchObject({ status: 403, type: "agent_policy_denied" });
  expect(await records(k)).toHaveLength(1);
});

test("chat requests through the router top up after the debit, and a stalled key resumes", async () => {
  const owner = await h.fundedKey(5n);
  const chat = (k: Key) => h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 5, provider: { only: ["alpha"] } } });
  const low = await agentKey(owner, 0.005);
  expect((await patch(owner, low, { topup: rule(0.01, 0.01, 1) })).status).toBe(200);
  expect((await chat(low)).status).toBe(200);
  expect((await records(low)).map((r) => [r.outcome, r.ref.split(":")[0], r.limitAfter])).toEqual([["added", "settle", usdToPico(0.015)]]);
  const stalled = await agentKey(owner, 0.0000001);
  expect((await chat(stalled)).status).toBe(402);
  expect((await patch(owner, stalled, { topup: rule(0.01, 0.05, 1) })).status).toBe(200);
  expect((await chat(stalled)).status).toBe(200);
  expect((await records(stalled)).map((r) => [r.outcome, r.ref.split(":")[0]])).toEqual([["added", "reserve"]]);
  const [acct] = await h.ctx.db.select().from(accounts).where(eq(accounts.id, (await row(low)).accountId));
  expect(acct.held).toBe(0n);
});

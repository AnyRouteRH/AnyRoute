import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { loadReplay, replayRulebook, REPLAY, type ReplayAction, type ReplayCall, type ReplayInput, type ReplayItem } from "../src/agents/replay.ts";
import { agentPolicySchema, type AgentPolicy } from "../src/agents/policy.ts";
import { accounts, generations, holds, keys, ledger } from "../src/db/schema.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { agentActionDecisions } from "../src/agents/guard-schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { agentLedgerLinks } from "../src/agents/ledger-schema.ts";
import { usdToPico } from "../src/lib/money.ts";
import { MemoryRateLimiter } from "../src/lib/ratelimit.ts";

// The pure replay runs on fixed past times only; the database cases place rows relative to the moment they run.
const MIN = 60_000, DAY = 86_400_000;
const start = Date.parse("2026-09-21T00:00:00Z"); // a Monday, 00:00 UTC
const policy = (extra: Record<string, unknown> = {}): AgentPolicy => agentPolicySchema.parse({ version: 1, models: {}, caps: {}, on_breach: "deny", ...extra });
const call = (minutes: number, usd: number, extra: Partial<ReplayCall> = {}): ReplayItem => ({ kind: "call", ts: new Date(start + minutes * MIN), model: "alpha/model", lane: "public", cost_pico: usdToPico(usd), tokens_out: 10, est_cost_pico: usdToPico(usd), max_output_tokens: 64, tools: [], actual: "allow", ...extra });
const action = (minutes: number, name: string, usd: number, extra: Partial<ReplayAction> = {}): ReplayItem => ({ kind: "action", ts: new Date(start + minutes * MIN), action: name, amount_pico: usdToPico(usd), outcome: null, outcome_pico: null, actual: "allow", ...extra });
const input = (items: ReplayItem[], extra: Partial<ReplayInput> = {}): ReplayInput => ({ from: new Date(start), to: new Date(start + 7 * DAY), days: 7, items, truncated: false, seed: { spend: [], calls: [], actions: [] }, refused: 0, inherited: 0, ...extra });
const decisions = (r: ReturnType<typeof replayRulebook>) => r.examples.map(e => e.decision);

describe("replaying a draft against recorded activity", () => {
  test("a cap reached mid-window refuses later calls until the rolling hour clears", () => {
    const r = replayRulebook(policy({ caps: { per_hour_usd: 1 } }), input([call(0, 0.3), call(10, 0.3), call(20, 0.3), call(30, 0.3), call(61, 0.3)]));
    expect([r.evaluated, r.allowed, r.denied, r.asked]).toEqual([5, 4, 1, 0]);
    expect(r.by_reason).toEqual({ over_per_hour: 1 });
    expect(decisions(r)).toEqual(["allow", "allow", "allow", "deny", "allow"]);
    expect(r.examples[3]).toMatchObject({ time: new Date(start + 30 * MIN).toISOString(), kind: "call", model: "alpha/model", lane: "public", cost_usd: 0.3, decision: "deny", reason: { code: "over_per_hour" }, actual: "allow" });
    expect(r.changed).toBe(1); expect(r.actual).toEqual({ allowed: 5, denied: 0, asked: 0, not_recorded: 0 });
    expect(r.stopped_at).toBeUndefined(); expect(r.truncated).toBe(false);
  });

  test("the rolling week counts what was charged before the window, until it ages out", () => {
    const seed = { spend: [{ ts: new Date(start - 2 * DAY), pico: usdToPico(4.5) }], calls: [], actions: [] };
    const r = replayRulebook(policy({ caps: { per_week_usd: 5 } }), input([call(60, 0.6), call(5 * 24 * 60 + 60, 0.6)], { seed }));
    expect(decisions(r)).toEqual(["deny", "allow"]); expect(r.by_reason).toEqual({ over_per_week: 1 });
  });

  test("calls per hour ask first once the rolling hour holds that many, and asked calls add no calls", () => {
    const seed = { spend: [], calls: [{ ts: new Date(start - 10 * MIN), n: 1 }], actions: [] };
    const r = replayRulebook(policy({ approval: { above_usd: 100, above_calls_per_hour: 2 } }), input([call(1, 0.01), call(2, 0.01), call(3, 0.01), call(51, 0.01), call(52, 0.01)], { seed }));
    expect(decisions(r)).toEqual(["allow", "approval_required", "approval_required", "allow", "approval_required"]);
    expect([r.allowed, r.asked, r.denied]).toEqual([2, 3, 0]); expect(r.by_reason).toEqual({ approval_calls_per_hour: 3 });
    expect(r.notes.join(" ")).toContain("cannot know whether you would have approved them");
  });

  test("UTC windows refuse calls outside them, at the time each call was recorded", () => {
    const r = replayRulebook(policy({ windows: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] }), input([call(10 * 60, 0.01), call(18 * 60, 0.01), call(5 * 24 * 60 + 10 * 60, 0.01)]));
    expect(decisions(r)).toEqual(["allow", "deny", "deny"]); expect(r.by_reason).toEqual({ outside_window: 2 });
  });

  test("a breaker stops the key; every later call is refused and nobody is assumed to press Resume", () => {
    const at = (s: number) => call(60 + s / 60, 0.01);
    const r = replayRulebook(policy({ breakers: { max_requests_per_minute: 2 } }), input([at(0), at(10), at(20), at(30 * 60)]));
    expect(decisions(r)).toEqual(["allow", "allow", "deny", "deny"]);
    expect(r.stopped_at).toBe(new Date(start + 60 * MIN + 20_000).toISOString()); expect(r.stopped_reason).toBe("breaker:max_requests_per_minute");
    expect(r.by_reason).toEqual({ "breaker:max_requests_per_minute": 1, killed: 1 });
    const stopped = r.examples[3]!.reason!;
    expect(stopped.code).toBe("killed"); expect(stopped.message).toContain("stopped this key earlier in the replay"); expect(stopped.message).not.toMatch(/kill/i);
    expect(r.notes.join(" ")).toContain("nobody pressed Resume");
  });

  test("the spend-per-minute breaker counts the replay's own admitted spend", () => {
    const r = replayRulebook(policy({ breakers: { max_spend_usd_per_minute: 1 } }), input([call(60, 0.6), call(60.2, 0.6), call(70, 0.1)]));
    expect(decisions(r)).toEqual(["allow", "deny", "deny"]); expect(r.stopped_reason).toBe("breaker:max_spend_usd_per_minute");
  });

  test("on_breach kill stops on the first refusal", () => {
    const r = replayRulebook(policy({ models: { deny: ["beta/*"] }, on_breach: "kill" }), input([call(1, 0.01), call(2, 0.01, { model: "beta/model" }), call(3, 0.01)]));
    expect(decisions(r)).toEqual(["allow", "deny", "deny"]); expect(r.stopped_reason).toBe("model_not_allowed");
    expect(r.by_reason).toEqual({ model_not_allowed: 1, killed: 1 });
  });

  test("lanes and models outside the draft are refused; a call with no recorded lane is replayed as public", () => {
    const r = replayRulebook(policy({ models: { allow: ["alpha/*"], deny: ["alpha/no"] }, lanes: ["attested"] }), input([
      call(1, 0.01), call(2, 0.01, { model: "beta/model", lane: "attested" }), call(3, 0.01, { model: "alpha/no", lane: "attested" }), call(4, 0.01, { lane: "attested" }), call(5, 0.01, { lane: null }),
    ]));
    expect(decisions(r)).toEqual(["deny", "deny", "deny", "allow", "deny"]);
    expect(r.by_reason).toEqual({ lane_not_allowed: 2, model_not_allowed: 2 });
    expect(r.notes.join(" ")).toContain("1 call has no recorded lane; it is replayed as public.");
  });

  test("approval thresholds use the recorded estimate, else the charged cost; past approvals are not reused", () => {
    const r = replayRulebook(policy({ approval: { above_usd: 0.5 } }), input([
      call(1, 0.2, { est_cost_pico: usdToPico(1) }), call(2, 0.7, { est_cost_pico: undefined }), call(3, 0.3, { est_cost_pico: undefined }), call(4, 0.6, { actual: "approval_required" }),
    ]));
    expect(decisions(r)).toEqual(["approval_required", "approval_required", "allow", "approval_required"]);
    expect(r.by_reason).toEqual({ approval_required: 3 }); expect(r.changed).toBe(2);
    expect(r.actual).toEqual({ allowed: 3, denied: 0, asked: 1, not_recorded: 0 });
    const notes = r.notes.join(" ");
    expect(notes).toContain("2 calls have no recorded cost estimate"); expect(notes).toContain("1 call ran after an approval at the time. Past approvals are not reused");
  });

  test("without a recorded output limit the tokens a call produced stand in for it", () => {
    const r = replayRulebook(policy({ caps: { max_output_tokens: 50 } }), input([call(1, 0.01, { max_output_tokens: undefined, tokens_out: 40 }), call(2, 0.01, { max_output_tokens: undefined, tokens_out: 80 }), call(3, 0.01, { max_output_tokens: 64 })]));
    expect(decisions(r)).toEqual(["allow", "deny", "deny"]); expect(r.by_reason).toEqual({ max_tokens: 2 });
    expect(r.notes.join(" ")).toContain("2 calls have no recorded output token limit");
  });

  test("Guard actions: per-day and per-hour caps from the replay's own allows, outcomes counted as the router counts them", () => {
    const r = replayRulebook(policy({ actions: { allow: ["trade.*"], per_day_usd: 100, approval_above_usd: 50, max_per_hour: 2 } }), input([
      action(600, "trade.order", 40, { outcome: "skipped" }), action(601, "trade.order", 60, { actual: "approval_required" }), action(602, "trade.order", 45, { outcome: "executed", outcome_pico: usdToPico(45) }),
      action(603, "trade.order", 10), action(700, "trade.order", 50, { actual: "deny" }), action(701, "trade.order", 10), action(702, "wire.send", 1, { actual: "deny" }),
    ]));
    expect(decisions(r)).toEqual(["allow", "approval_required", "allow", "deny", "allow", "deny", "deny"]);
    expect(r.by_reason).toEqual({ approval_action_amount: 1, over_action_per_hour: 1, over_action_per_day: 1, action_not_allowed: 1 });
    expect(r.changed).toBe(3);
    expect(r.examples[0]).toMatchObject({ kind: "action", action: "trade.order", model: null, lane: null, cost_usd: 40 });
  });

  test("progressive autonomy starts at its first step and raises caps after clean calls", () => {
    const r = replayRulebook(policy({ caps: { per_request_usd: 1 }, autonomy: { rungs: [{ after_days: 0, clean_requests: 2, caps_multiplier: 2 }], demote_on: ["deny"] } }), input([call(1, 1.5), call(2, 0.5), call(3, 0.5), call(4, 1.5)]));
    expect(decisions(r)).toEqual(["deny", "allow", "allow", "allow"]);
    expect(r.notes.join(" ")).toContain("starts again from its first step");
  });

  test("at most 20 examples: one of each outcome and reason first, then changed calls, in time order", () => {
    const items = Array.from({ length: 60 }, (_, i) => i % 3 === 0 ? call(i, 0.01, { model: "beta/model" }) : i % 3 === 1 ? call(i, 0.9) : call(i, 0.01));
    const r = replayRulebook(policy({ models: { deny: ["beta/*"] }, caps: { per_request_usd: 0.5 } }), input(items));
    expect([r.evaluated, r.allowed, r.denied]).toEqual([60, 20, 40]);
    expect(r.examples).toHaveLength(REPLAY.examples);
    expect(new Set(r.examples.map(e => e.reason?.code ?? "allow"))).toEqual(new Set(["model_not_allowed", "over_per_request", "allow"]));
    const times = r.examples.map(e => Date.parse(e.time));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("a truncated load says how far the replay reached; inherited rulebooks and refused calls are named", () => {
    const r = replayRulebook(policy(), input([call(1, 0.01)], { truncated: true, refused: 3, inherited: 1 }));
    const notes = r.notes.join(" ");
    expect(r.truncated).toBe(true); expect(notes).toContain(`Only the oldest 5,000 calls and actions were replayed, up to ${new Date(start + MIN).toISOString()}`);
    expect(notes).toContain("3 model calls refused at the time are not replayed"); expect(notes).toContain("also follows an inherited rulebook");
  });
});

describe("POST /api/v1/agents/:key_hash/replay", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true" } }); });
  afterAll(async () => { await h?.close(); });
  const base: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
  type K = { hash: string; auth: Record<string, string> };
  const replay = (caller: { auth: Record<string, string> }, target: string, body: unknown) => h.request(`/api/v1/agents/${target}/replay`, { method: "POST", headers: caller.auth, json: body });
  const put = (k: K, p: AgentPolicy) => h.request(`/api/v1/agents/${k.hash}/policy`, { method: "PUT", headers: k.auth, json: p });
  const chat = (k: { auth: Record<string, string> }) => h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "replay prompt text is never read" }], max_tokens: 32, provider: { only: ["alpha"] } } });
  const tables = [agentPolicies, agentPolicyEvents, agentApprovals, agentActionDecisions, agentLedgerLinks, generations, ledger, holds, keys, accounts] as const;
  const counts = async () => Promise.all(tables.map(async t => (await h.ctx.db.select().from(t)).length));
  const accountOf = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0]!.accountId;

  test("authorized exactly like saving the rulebook", async () => {
    const owner = await h.fundedKey(), stranger = await h.fundedKey();
    expect((await h.request(`/api/v1/agents/${owner.hash}/replay`, { method: "POST", json: { policy: base } })).status).toBe(401);
    expect((await replay(stranger, owner.hash, { policy: base })).status).toBe(404);
    const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "replay-role" } })).json()).data;
    const target = (await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { team: team.id } })).json()).data;
    for (const role of ["member", "viewer", "admin"] as const) {
      const created = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { team: team.id, role } })).json();
      const auth = { authorization: `Bearer ${created.key}` };
      expect((await replay({ auth }, target.hash, { policy: base })).status).toBe(role === "admin" ? 200 : 403);
      if (role === "admin") expect((await replay({ auth }, owner.hash, { policy: base })).status).toBe(403);
    }
    const s = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
    const r = await replay({ auth: { authorization: `Bearer ${s.key}` } }, s.key_hash, { policy: base });
    expect(r.status).toBe(403); expect((await r.json()).error.message).toBe("Session keys cannot manage rulebooks.");
    expect((await replay(owner, owner.hash, { policy: base })).status).toBe(200);
  });

  test("replays real calls with their recorded intent, compares what happened, and writes nothing", async () => {
    const k = await h.fundedKey();
    expect((await put(k, base)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await chat(k)).status).toBe(200);
    const s = (await (await h.request("/api/v1/sessions", { method: "POST", headers: k.auth, json: { budget_usd: 1 } })).json()).data;
    expect((await chat({ auth: { authorization: `Bearer ${s.key}` } })).status).toBe(200); // the session's call is under its parent's rulebook
    const [before, balance] = [await counts(), (await h.ctx.db.select().from(accounts).where(eq(accounts.id, await accountOf(k.hash))))[0]];
    const res = await replay(k, k.hash, { policy: { ...base, models: { deny: [MODELS.llama.slug] }, on_breach: "kill" }, days: 7 });
    expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
    const data = (await res.json()).data;
    expect(data).toMatchObject({ evaluated: 3, allowed: 0, denied: 3, asked: 0, by_reason: { model_not_allowed: 3, killed: 2 }, stopped_reason: "model_not_allowed", truncated: false, changed: 3, actual: { allowed: 3, denied: 0, asked: 0, not_recorded: 0 } });
    expect(data.window.days).toBe(7); expect(Date.parse(data.window.to) - Date.parse(data.window.from)).toBe(7 * DAY);
    expect(data.examples[0]).toMatchObject({ kind: "call", model: MODELS.llama.slug, lane: "public", decision: "deny", reason: { code: "model_not_allowed" }, actual: "allow" });
    // The recorded max_tokens (32) is what a draft output cap is checked against.
    const tokens = (await (await replay(k, k.hash, { policy: { ...base, caps: { max_output_tokens: 31 } } })).json()).data;
    expect(tokens.by_reason).toEqual({ max_tokens: 3 }); expect(tokens.notes.join(" ")).not.toContain("no recorded output token limit");
    expect((await (await replay(k, k.hash, { policy: base, days: 1 })).json()).data).toMatchObject({ evaluated: 3, allowed: 3 });
    expect(await counts()).toEqual(before);
    expect((await h.ctx.db.select().from(accounts).where(eq(accounts.id, await accountOf(k.hash))))[0]).toEqual(balance);
    expect((await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, k.hash)))[0]).toMatchObject({ killed: false, spec: base });
    expect(JSON.stringify(data)).not.toContain("replay prompt text");
  });

  test("Guard action checks are replayed with the calls", async () => {
    const k = await h.fundedKey();
    await put(k, { ...base, actions: { allow: ["trade.*"] } });
    const decide = (action: string) => h.request("/api/v1/guard/decide", { method: "POST", headers: k.auth, json: { action, target: "STOCK_A", amount_usd: "5.00" } });
    expect((await (await decide("trade.order")).json()).data.decision).toBe("allow");
    expect((await (await decide("wire.send")).json()).data.decision).toBe("deny");
    const data = (await (await replay(k, k.hash, { policy: { ...base, actions: { allow: ["wire.*"] } } })).json()).data;
    expect(data).toMatchObject({ evaluated: 2, allowed: 1, denied: 1, changed: 2, by_reason: { action_not_allowed: 1 } });
    expect(data.examples.map((e: any) => [e.action, e.decision, e.actual])).toEqual([["trade.order", "deny", "allow"], ["wire.send", "allow", "deny"]]);
  });

  test("loads at most 5,000, oldest first, and says the rest were not replayed", async () => {
    const k = await h.fundedKey(), accountId = await accountOf(k.hash), now = Date.now();
    const row = (i: number, ts: number) => ({ id: `replay-${k.hash.slice(0, 12)}-${i}`, ts: new Date(ts), keyHash: k.hash, accountId, modelId: "alpha/model", providerId: "alpha", mode: "prepaid", cost: 1000n, tokensOut: 5, receipt: { lane: "public" } });
    const rows = Array.from({ length: REPLAY.limit + 1 }, (_, i) => row(i, now - 2 * DAY + i * 1000));
    rows.push(row(-1, now - 8 * DAY)); // outside the window
    for (let i = 0; i < rows.length; i += 1000) await h.ctx.db.insert(generations).values(rows.slice(i, i + 1000));
    const data = (await (await replay(k, k.hash, { policy: base })).json()).data;
    expect(data).toMatchObject({ evaluated: REPLAY.limit, allowed: REPLAY.limit, truncated: true, actual: { not_recorded: REPLAY.limit } });
    expect(data.examples[0].time).toBe(new Date(now - 2 * DAY).toISOString());
    expect(data.notes[0]).toContain(`up to ${new Date(now - 2 * DAY + (REPLAY.limit - 1) * 1000).toISOString()}`);
    const loaded = await loadReplay(h.ctx.db, k.hash, { days: 7, now: new Date(now + 1000), actions: false });
    expect(loaded.items).toHaveLength(REPLAY.limit); expect(loaded.truncated).toBe(true);
    expect(loaded.items.every(i => i.ts.getTime() > now - 7 * DAY)).toBe(true);
  });

  test("refuses bad drafts and windows", async () => {
    const k = await h.fundedKey();
    for (const body of [{ policy: { ...base, on_breach: undefined } }, { policy: { ...base, caps: { per_day_usd: -1 } } }, { policy: base, days: 8 }, { policy: base, days: 0 }, { policy: base, days: 1.5 }, { policy: base, extra: true }, {}]) {
      const r = await replay(k, k.hash, body); expect(r.status).toBe(400);
    }
  });

  test("rate limited to ten a minute per key", async () => {
    const k = await h.fundedKey(), other = await h.fundedKey(), saved = h.ctx.limiter;
    h.ctx.limiter = new MemoryRateLimiter(() => 30_000); // one fixed minute, whatever the clock says
    try {
      for (let i = 0; i < REPLAY.perMinute; i++) expect((await replay(k, k.hash, { policy: base })).status).toBe(200);
      const limited = await replay(k, k.hash, { policy: base });
      expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("30");
      expect((await limited.json()).error.type).toBe("rate_limited");
      expect((await replay(other, other.hash, { policy: base })).status).toBe(200);
    } finally { await h.ctx.limiter.close(); h.ctx.limiter = saved; }
  });

  test("switched off with the rulebooks", async () => {
    const off = await startRouter();
    try {
      const k = await off.fundedKey();
      const r = await off.request(`/api/v1/agents/${k.hash}/replay`, { method: "POST", headers: k.auth, json: { policy: base } });
      expect(r.status).toBe(404);
    } finally { await off.close(); }
  });
});

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { agentSessions, generations, keys as keysTable, savedRoutes } from "../src/db/schema.ts";
import { KEY_RE } from "../src/chain/keys.ts";
import { usdToPico } from "../src/lib/money.ts";
import { verifyInvariants } from "../src/ledger/ledger.ts";
import { sessionStatus } from "../src/services/agent-sessions.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const QWEN = "qwen/qwen3-32b";
type Auth = Record<string, string>;
const bearer = (secret: string): Auth => ({ authorization: `Bearer ${secret}` });

describe("Agent Sessions", () => {
  let h: Harness;
  let owner: Awaited<ReturnType<Harness["fundedKey"]>>;
  const chat = (auth: Auth, body: Record<string, unknown> = {}) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: LLAMA, messages: [{ role: "user", content: "summarise the ticket" }], max_tokens: 5, provider: { only: ["alpha"] }, ...body } });
  const create = (auth: Auth, json: Record<string, unknown>) => h.request("/api/v1/sessions", { method: "POST", headers: auth, json });
  const newSession = async (auth: Auth, json: Record<string, unknown>) => {
    const r = await create(auth, json);
    expect(r.status).toBe(201);
    return (await r.json()).data as { id: string; key: string; key_label: string; key_hash: string; expires_at: string; budget_usd: number; allowed_models: string[] };
  };
  const get = async (auth: Auth, id: string) => h.request(`/api/v1/sessions/${id}`, { headers: auth });
  const subKey = async (auth: Auth, json: Record<string, unknown> = {}) => (await (await h.request("/api/v1/keys", { method: "POST", headers: auth, json })).json()) as { key: string; data: { hash: string } };

  beforeAll(async () => {
    h = await startRouter({ rand: () => 0.5 });
    owner = await h.fundedKey(5n);
  });
  afterAll(async () => {
    setSystemTime();
    await h.close();
  });

  test("create: a sub-key of the caller with the budget (no reset), expiry and allowlist; the secret is shown once", async () => {
    const t0 = Date.now();
    const s = await newSession(owner.auth, { name: "crawler", budget_usd: 0.5, ttl_minutes: 30, allowed_models: [LLAMA], metadata: { ticket: "OPS-1", attempt: 2 } });
    expect(s.id).toMatch(/^as_/);
    expect(s.key).toMatch(KEY_RE);
    expect(s.key_label).toBe(`${s.key.slice(0, 13)}...${s.key.slice(-4)}`);
    expect(s.budget_usd).toBe(0.5);
    expect(Math.abs(Date.parse(s.expires_at) - (t0 + 30 * 60_000))).toBeLessThan(5_000);
    const [k] = await h.ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, s.key_hash));
    expect(k.parentHash).toBe(owner.hash);
    expect(k.budget).toBe(usdToPico(0.5));
    expect(k.budgetReset).toBeNull();
    expect(k.expiresAt?.toISOString()).toBe(s.expires_at);
    expect(k.allowedModels).toEqual([LLAMA]);
    expect(k.management).toBe(false);
    expect(k.name).toBe("session: crawler");
    const [row] = await h.ctx.db.select().from(agentSessions).where(eq(agentSessions.id, s.id));
    expect(row.parentKeyHash).toBe(owner.hash);
    expect(row.budget).toBe(usdToPico(0.5));
    expect(row.metadata).toEqual({ ticket: "OPS-1", attempt: 2 });
    // Never shown again.
    const detail = await (await get(owner.auth, s.id)).json();
    expect(JSON.stringify(detail)).not.toContain(s.key);
    expect(detail.data).toMatchObject({ id: s.id, name: "crawler", status: "active", key_label: s.key_label, budget_usd: 0.5, spent_usd: 0, calls: 0, last_call_at: null, allowed_models: [LLAMA], metadata: { ticket: "OPS-1", attempt: 2 } });
    expect(detail.data.time_left_s).toBeGreaterThan(1790);
    expect(detail.data.time_left_s).toBeLessThanOrEqual(1800);
    // Default TTL is 60 minutes.
    const d = await newSession(owner.auth, { budget_usd: 1 });
    expect(Math.abs(Date.parse(d.expires_at) - (Date.now() + 60 * 60_000))).toBeLessThan(5_000);
  });

  test("the session key calls like any key; the list and detail report spend and calls, metadata only", async () => {
    const s = await newSession(owner.auth, { name: "worker", budget_usd: 1, ttl_minutes: 10 });
    const r = await chat(bearer(s.key));
    expect(r.status).toBe(200);
    const gen = await r.json();
    const detail = (await (await get(owner.auth, s.id)).json()).data;
    expect(detail.status).toBe("active");
    expect(detail.calls).toBe(1);
    expect(detail.spent_usd).toBeGreaterThan(0);
    expect(detail.spent_usd).toBeCloseTo(gen.usage.cost, 12);
    expect(detail.remaining_usd).toBeCloseTo(1 - detail.spent_usd, 12);
    expect(detail.reserved_usd).toBe(0);
    expect(Date.parse(detail.last_call_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(detail.recent_calls).toHaveLength(1);
    const call = detail.recent_calls[0];
    expect(Object.keys(call).sort()).toEqual(["anchored", "cost_usd", "finish_reason", "id", "latency_ms", "model", "provider", "receipt", "tokens_in", "tokens_out", "ts"]);
    expect(call).toMatchObject({ id: gen.id, model: LLAMA, provider: "alpha", receipt: true });
    expect(call.tokens_in).toBeGreaterThan(0);
    // No prompt or completion text anywhere in the session views.
    const text = JSON.stringify(detail) + JSON.stringify(await (await h.request("/api/v1/sessions", { headers: owner.auth })).json());
    expect(text).not.toContain("summarise the ticket");
    expect(text).not.toContain(gen.choices[0].message.content);
    // Newest first.
    const later = await newSession(owner.auth, { name: "later", budget_usd: 1 });
    const list = (await (await h.request("/api/v1/sessions", { headers: owner.auth })).json()).data;
    expect(list[0].id).toBe(later.id);
    expect(list.findIndex((x: any) => x.id === s.id)).toBeGreaterThan(0);
    for (const x of list) for (const f of ["status", "spent_usd", "calls", "last_call_at", "time_left_s"]) expect(x).toHaveProperty(f);
  });

  test("GET /sessions/current: a session key sees its own remaining budget and time; other keys get 404", async () => {
    const s = await newSession(owner.auth, { name: "self", budget_usd: 0.25, ttl_minutes: 5 });
    expect((await chat(bearer(s.key))).status).toBe(200);
    const me = (await (await h.request("/api/v1/sessions/current", { headers: bearer(s.key) })).json()).data;
    expect(me).toMatchObject({ id: s.id, name: "self", status: "active", budget_usd: 0.25, calls: 1 });
    expect(me.remaining_usd).toBeCloseTo(0.25 - me.spent_usd, 12);
    expect(me.time_left_s).toBeGreaterThan(290);
    expect(me.time_left_s).toBeLessThanOrEqual(300);
    const r = await h.request("/api/v1/sessions/current", { headers: owner.auth });
    expect(r.status).toBe(404);
    expect((await h.request("/api/v1/sessions/current")).status).toBe(401);
  });

  test("budget: the reserve check refuses a request that would exceed the session budget, and nothing is charged", async () => {
    // Far below one call's worst case: refused before any provider is called.
    const tiny = await newSession(owner.auth, { name: "tiny", budget_usd: 0.0000001 });
    const r = await chat(bearer(tiny.key));
    expect(r.status).toBe(402);
    expect((await r.json()).error.type).toBe("key_budget_exceeded");
    const t = (await (await get(owner.auth, tiny.id)).json()).data;
    expect(t).toMatchObject({ status: "active", spent_usd: 0, calls: 0, reserved_usd: 0 });

    // A small budget: calls succeed until what remains no longer covers a call's worst case.
    const s = await newSession(owner.auth, { name: "capped", budget_usd: 0.000004 });
    const codes: number[] = [];
    for (let i = 0; i < 10 && !codes.includes(402); i++) {
      const res = await chat(bearer(s.key));
      codes.push(res.status);
      if (res.status === 402) expect((await res.json()).error.type).toBe("key_budget_exceeded");
    }
    expect(codes[0]).toBe(200);
    expect(codes.at(-1)).toBe(402);
    const d = (await (await get(owner.auth, s.id)).json()).data;
    expect(d.calls).toBe(codes.filter((c) => c === 200).length);
    expect(d.spent_usd).toBeLessThanOrEqual(0.000004);
    const [g] = await h.ctx.db.select({ n: generations.id }).from(generations).where(eq(generations.keyHash, s.key_hash)).limit(1);
    expect(g).toBeDefined();
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("budget_exhausted is computed once the budget is spent and persisted lazily, idempotently", async () => {
    const s = await newSession(owner.auth, { name: "spent", budget_usd: 0.01 });
    // As if the ledger had settled the whole budget against this key.
    await h.ctx.db.update(keysTable).set({ spent: usdToPico(0.01), spentTotal: usdToPico(0.01) }).where(eq(keysTable.keyHash, s.key_hash));
    const r = await chat(bearer(s.key));
    expect(r.status).toBe(402);
    expect((await r.json()).error.type).toBe("key_budget_exceeded");
    const a = (await (await get(owner.auth, s.id)).json()).data;
    expect(a).toMatchObject({ status: "budget_exhausted", end_reason: "budget", remaining_usd: 0, time_left_s: 0 });
    expect(a.ended_at).not.toBeNull();
    const b = (await (await get(owner.auth, s.id)).json()).data;
    expect(b.ended_at).toBe(a.ended_at);
    const [row] = await h.ctx.db.select().from(agentSessions).where(eq(agentSessions.id, s.id));
    expect(row.endReason).toBe("budget");
    expect(row.endedAt?.toISOString()).toBe(a.ended_at);
    // The session key can still introspect; the final status holds.
    expect((await (await h.request("/api/v1/sessions/current", { headers: bearer(s.key) })).json()).data.status).toBe("budget_exhausted");
  });

  test("expiry: key resolution refuses the key once its time runs out; the list shows expired and records it once", async () => {
    const s = await newSession(owner.auth, { name: "short", budget_usd: 1, ttl_minutes: 1 });
    expect((await chat(bearer(s.key))).status).toBe(200);
    try {
      setSystemTime(new Date(Date.now() + 61_000));
      const r = await chat(bearer(s.key));
      expect(r.status).toBe(401);
      expect((await r.json()).error.type).toBe("key_expired");
      expect((await h.request("/api/v1/sessions/current", { headers: bearer(s.key) })).status).toBe(401);
      const list = (await (await h.request("/api/v1/sessions", { headers: owner.auth })).json()).data;
      const x = list.find((v: any) => v.id === s.id);
      expect(x).toMatchObject({ status: "expired", end_reason: "expired", ended_at: s.expires_at, time_left_s: 0, remaining_usd: 0, calls: 1 });
      const again = (await (await get(owner.auth, s.id)).json()).data;
      expect(again.ended_at).toBe(s.expires_at);
      const [row] = await h.ctx.db.select().from(agentSessions).where(eq(agentSessions.id, s.id));
      expect(row.endReason).toBe("expired");
    } finally {
      setSystemTime();
    }
  });

  test("DELETE ends a session now (the key stops working) and is idempotent", async () => {
    const s = await newSession(owner.auth, { name: "stop me", budget_usd: 1 });
    expect((await chat(bearer(s.key))).status).toBe(200);
    const r1 = await h.request(`/api/v1/sessions/${s.id}`, { method: "DELETE", headers: owner.auth });
    expect(r1.status).toBe(200);
    const a = (await r1.json()).data;
    expect(a).toMatchObject({ id: s.id, status: "ended", end_reason: "ended", time_left_s: 0, calls: 1 });
    const r = await chat(bearer(s.key));
    expect(r.status).toBe(401);
    expect((await r.json()).error.type).toBe("key_disabled");
    const r2 = await h.request(`/api/v1/sessions/${s.id}`, { method: "DELETE", headers: owner.auth });
    expect(r2.status).toBe(200);
    expect((await r2.json()).data.ended_at).toBe(a.ended_at);
    const [k] = await h.ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, s.key_hash));
    expect(k.disabled).toBe(true);
    // Ending an already expired session keeps its reason but still disables the key.
    const e = await newSession(owner.auth, { name: "late", budget_usd: 1, ttl_minutes: 1 });
    try {
      setSystemTime(new Date(Date.now() + 61_000));
      const d = (await (await h.request(`/api/v1/sessions/${e.id}`, { method: "DELETE", headers: owner.auth })).json()).data;
      expect(d).toMatchObject({ status: "expired", end_reason: "expired" });
    } finally {
      setSystemTime();
    }
    expect((await h.ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, e.key_hash)))[0].disabled).toBe(true);
    expect((await h.request("/api/v1/sessions/as_missing", { method: "DELETE", headers: owner.auth })).status).toBe(404);
  });

  test("roles: members and viewers read; owners/admins create and end within their scope; session keys only see themselves", async () => {
    const mine = await newSession(owner.auth, { name: "owner's", budget_usd: 1 });
    // A plain sub-key (member role).
    const memberKey = await subKey(owner.auth, { name: "ci" });
    const member = bearer(memberKey.key);
    expect((await h.request("/api/v1/sessions", { headers: member })).status).toBe(200);
    expect((await get(member, mine.id)).status).toBe(200);
    const denied = await create(member, { budget_usd: 1 });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.type).toBe("forbidden");
    expect((await h.request(`/api/v1/sessions/${mine.id}`, { method: "DELETE", headers: member })).status).toBe(403);
    // Team viewer reads; team admin creates and ends its team's sessions, not the owner's.
    const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "agents" } })).json()).data;
    const viewerKey = await subKey(owner.auth, { team: team.id });
    await h.request(`/api/v1/teams/${team.id}/members/${viewerKey.data.hash}`, { method: "PUT", headers: owner.auth, json: { role: "viewer" } });
    const adminKey = await subKey(owner.auth, { team: team.id });
    await h.request(`/api/v1/teams/${team.id}/members/${adminKey.data.hash}`, { method: "PUT", headers: owner.auth, json: { role: "admin" } });
    const viewer = bearer(viewerKey.key);
    const admin = bearer(adminKey.key);
    expect((await h.request("/api/v1/sessions", { headers: viewer })).status).toBe(200);
    expect((await create(viewer, { budget_usd: 1 })).status).toBe(403);
    const teamSession = await newSession(admin, { name: "team run", budget_usd: 1 });
    const [tk] = await h.ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, teamSession.key_hash));
    expect(tk.teamId).toBe(team.id);
    expect((await h.request(`/api/v1/sessions/${mine.id}`, { method: "DELETE", headers: admin })).status).toBe(403);
    expect((await h.request(`/api/v1/sessions/${teamSession.id}`, { method: "DELETE", headers: viewer })).status).toBe(403);
    expect((await h.request(`/api/v1/sessions/${teamSession.id}`, { method: "DELETE", headers: admin })).status).toBe(200);
    // Management keys end any session of the account.
    const other = await newSession(admin, { name: "team run 2", budget_usd: 1 });
    expect((await h.request(`/api/v1/sessions/${other.id}`, { method: "DELETE", headers: owner.auth })).status).toBe(200);
    // A session key reads only itself and cannot create sessions or keys.
    const sk = bearer(mine.key);
    expect((await h.request("/api/v1/sessions", { headers: sk })).status).toBe(403);
    expect((await get(sk, mine.id)).status).toBe(403);
    expect((await create(sk, { budget_usd: 1 })).status).toBe(403);
    expect((await h.request("/api/v1/keys", { method: "POST", headers: sk, json: {} })).status).toBe(403);
    // Another account sees nothing.
    const stranger = await h.fundedKey(1n);
    expect((await get(stranger.auth, mine.id)).status).toBe(404);
    expect((await h.request(`/api/v1/sessions/${mine.id}`, { method: "DELETE", headers: stranger.auth })).status).toBe(404);
    expect((await (await h.request("/api/v1/sessions", { headers: stranger.auth })).json()).data).toEqual([]);
    expect((await h.request("/api/v1/sessions")).status).toBe(401);
  });

  test("validation: budget, TTL, models and metadata", async () => {
    const bad = async (json: Record<string, unknown>, status = 400) => {
      const r = await create(owner.auth, json);
      expect(r.status).toBe(status);
      return (await r.json()).error.message as string;
    };
    await bad({});
    await bad({ budget_usd: 0 });
    await bad({ budget_usd: -1 });
    await bad({ budget_usd: 1000.01 });
    await bad({ budget_usd: "5" });
    await bad({ budget_usd: 1, ttl_minutes: 0 });
    await bad({ budget_usd: 1, ttl_minutes: 1441 });
    await bad({ budget_usd: 1, ttl_minutes: 1.5 });
    await bad({ budget_usd: 1, name: "x".repeat(81) });
    expect(await bad({ budget_usd: 1, allowed_models: ["nobody/nothing"] })).toContain("Unknown model");
    expect(await bad({ budget_usd: 1, allowed_models: ["@route/nope"] })).toContain("No saved route");
    await bad({ budget_usd: 1, allowed_models: ["@route/Bad Slug"] });
    expect(await bad({ budget_usd: 1, metadata: { prompt: "tell me a secret" } })).toContain("labels only");
    expect(await bad({ budget_usd: 1, metadata: { Messages: "x" } })).toContain("labels only");
    await bad({ budget_usd: 1, metadata: { nested: { a: 1 } } });
    await bad({ budget_usd: 1, metadata: { long: "x".repeat(257) } });
    await bad({ budget_usd: 1, metadata: [1, 2] });
    const big = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, "v".repeat(200)]));
    expect(await bad({ budget_usd: 1, metadata: big })).toContain("2048");
    // Limits are inclusive.
    expect((await create(owner.auth, { budget_usd: 1000, ttl_minutes: 1440 })).status).toBe(201);
    expect((await create(owner.auth, { budget_usd: 1, ttl_minutes: 1, allowed_models: [`${LLAMA}:nitro`, LLAMA] })).status).toBe(201);
  });

  test("allowlists: catalog ids and saved routes; the creating key's allowlist, budget and expiry bound its sessions", async () => {
    const s = await newSession(owner.auth, { name: "qwen only", budget_usd: 1, allowed_models: [QWEN] });
    const r = await chat(bearer(s.key));
    expect(r.status).toBe(403);
    expect((await r.json()).error.type).toBe("model_not_allowed");
    expect((await chat(bearer(s.key), { model: QWEN })).status).toBe(200);
    // Saved routes of the account (Saved Routes owns the table; a row is enough here).
    const [acct] = await h.ctx.db.select({ accountId: keysTable.accountId }).from(keysTable).where(eq(keysTable.keyHash, owner.hash));
    await h.ctx.db.insert(savedRoutes).values({ id: "rt_test", accountId: acct.accountId, slug: "fast", name: "Fast", config: { models: [LLAMA] } });
    const routed = await newSession(owner.auth, { budget_usd: 1, allowed_models: ["@route/fast", QWEN, QWEN] });
    expect(routed.allowed_models).toEqual(["@route/fast", QWEN]);
    // A team admin limited to qwen, $0.50 and 10 minutes creates sessions within those bounds only.
    const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "bounded" } })).json()).data;
    const bounded = await subKey(owner.auth, { team: team.id, allowed_models: [QWEN], limit: 0.5, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    await h.request(`/api/v1/teams/${team.id}/members/${bounded.data.hash}`, { method: "PUT", headers: owner.auth, json: { role: "admin" } });
    const b = bearer(bounded.key);
    expect((await create(b, { budget_usd: 0.1, ttl_minutes: 5, allowed_models: [LLAMA] })).status).toBe(403);
    expect((await create(b, { budget_usd: 0.6, ttl_minutes: 5 })).status).toBe(400);
    expect((await create(b, { budget_usd: 0.1, ttl_minutes: 60 })).status).toBe(400);
    const inherited = await newSession(b, { budget_usd: 0.1, ttl_minutes: 5 });
    expect(inherited.allowed_models).toEqual([QWEN]);
  });

  test("pagination: limit and the before cursor", async () => {
    const acct = await h.fundedKey(1n);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await newSession(acct.auth, { name: `p${i}`, budget_usd: 1 })).id);
    const p1 = await (await h.request("/api/v1/sessions?limit=2", { headers: acct.auth })).json();
    expect(p1.data.map((x: any) => x.id)).toEqual([ids[2], ids[1]]);
    expect(p1.next).not.toBeNull();
    const p2 = await (await h.request(`/api/v1/sessions?limit=2&before=${encodeURIComponent(p1.next)}`, { headers: acct.auth })).json();
    expect(p2.data.map((x: any) => x.id)).toEqual([ids[0]]);
    expect(p2.next).toBeNull();
    expect((await h.request("/api/v1/sessions?before=yesterday", { headers: acct.auth })).status).toBe(400);
  });

  test("a session key is managed only through /sessions and sees only its own calls and budget", async () => {
    const s = await newSession(owner.auth, { name: "scoped", budget_usd: 0.25, ttl_minutes: 10 });
    // The keys API refuses to edit it (re-enabling an ended session's key would contradict the session).
    const patch = await h.request(`/api/v1/keys/${s.key_hash}`, { method: "PATCH", headers: owner.auth, json: { disabled: false } });
    expect(patch.status).toBe(409);
    expect(JSON.stringify(await patch.json())).toContain("session_key");
    // The owner makes a call; the session key's history excludes it, and includes its own call.
    expect((await chat(owner.auth)).status).toBe(200);
    expect((await chat(bearer(s.key))).status).toBe(200);
    const mine = (await (await h.request("/api/v1/generations", { headers: bearer(s.key) })).json()).data as { id: string }[];
    const own = await h.ctx.db.select({ id: generations.id }).from(generations).where(eq(generations.keyHash, s.key_hash));
    expect(mine.map((g) => g.id).sort()).toEqual(own.map((g) => g.id).sort());
    expect(mine.length).toBe(1);
    // Credits for a session key are its own budget, not the account balance.
    const credits = (await (await h.request("/api/v1/credits", { headers: bearer(s.key) })).json()).data;
    expect(credits.session).toBe(s.id);
    expect(credits.total_credits).toBe(0.25);
    expect(credits.available).toBeLessThan(0.25);
    expect(credits.deposit).toBeUndefined();
  });

  test("a session allowed only a saved route can call that route's models and nothing else", async () => {
    const created = await h.request("/api/v1/routes", { method: "POST", headers: owner.auth, json: { slug: "llama-only", config: { models: [LLAMA], provider: { only: ["alpha"] } } } });
    expect(created.status).toBe(201);
    const s = await newSession(owner.auth, { name: "routed", budget_usd: 0.25, ttl_minutes: 10, allowed_models: ["@route/llama-only"] });
    const ok = await chat(bearer(s.key), { model: "@route/llama-only", provider: undefined });
    expect(ok.status).toBe(200);
    expect((await ok.json()).route).toBe("llama-only");
    const direct = await chat(bearer(s.key), { model: QWEN });
    expect(direct.status).toBe(403);
    // Request-supplied fallbacks outside the route are dropped: the call is served by the route's model only.
    const widened = await chat(bearer(s.key), { model: "@route/llama-only", models: [QWEN], provider: undefined });
    expect(widened.status).toBe(200);
    expect((await widened.json()).model).toBe(LLAMA);
  });
});

describe("sessionStatus", () => {
  const base = { endedAt: null, endReason: null, expiresAt: new Date(10_000) };
  const key = { disabled: false, budget: 100n, spentTotal: 0n, lastUsed: null };
  test("active, ended, expired and budget_exhausted; a recorded end is final", () => {
    expect(sessionStatus(base, key, 5_000)).toEqual({ status: "active" });
    expect(sessionStatus(base, { ...key, disabled: true }, 5_000)).toEqual({ status: "ended" });
    expect(sessionStatus(base, null, 5_000)).toEqual({ status: "ended" });
    expect(sessionStatus(base, key, 10_000)).toEqual({ status: "expired", persist: { endedAt: base.expiresAt, endReason: "expired" } });
    const spentAt = new Date(4_000);
    expect(sessionStatus(base, { ...key, spentTotal: 100n, lastUsed: spentAt }, 5_000)).toEqual({ status: "budget_exhausted", persist: { endedAt: spentAt, endReason: "budget" } });
    expect(sessionStatus(base, { ...key, spentTotal: 99n }, 5_000).status).toBe("active");
    expect(sessionStatus(base, { ...key, budget: null, spentTotal: 10n ** 15n }, 5_000).status).toBe("active");
    expect(sessionStatus({ ...base, endedAt: new Date(1), endReason: "budget" }, key, 20_000)).toEqual({ status: "budget_exhausted" });
    expect(sessionStatus({ ...base, endedAt: new Date(1), endReason: "ended" }, key, 1)).toEqual({ status: "ended" });
    expect(sessionStatus({ ...base, endedAt: new Date(1), endReason: "expired" }, { ...key, disabled: true }, 1)).toEqual({ status: "expired" });
  });
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { schedules, scheduleRuns } from "../src/schedules/schema.ts";
import { generations, keys, teamMembers } from "../src/db/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { nextDue } from "../src/schedules/time.ts";
import { claimRun, runSchedules, registerScheduledPrompts } from "../src/schedules/worker.ts";
import { SCHEDULE_CALL } from "../src/schedules/caller.ts";
import { internalEnv } from "../src/hardening/client.ts";
import { retainedRuns } from "../src/schedules/store.ts";
let h: Harness;
type Owner = Awaited<ReturnType<Harness["newKey"]>>;
beforeAll(async () => { h = await startRouter({ env: { SCHEDULED_PROMPTS_ENABLED: "true", AGENT_POLICY_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true" }, providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama], reply: () => "scheduled answer sentinel" }] }); });
afterAll(async () => { await h?.close(); });
const dispatch = (path: string, init: RequestInit, env?: Record<string | symbol, unknown>) => h.app.request(path, init, internalEnv(env) as never);
async function create(owner: Owner, extra = {}) {
  const response = await h.request("/api/v1/schedules", { method: "POST", headers: owner.auth, json: { name: "Morning note", prompt: "scheduled prompt sentinel", model: MODELS.llama.slug, key_hash: owner.hash, cadence: "daily", time_utc: "09:00", max_cost_usd: "0.05", ...extra } });
  expect(response.status).toBe(201);
  return (await response.json()).data;
}
const runNow = async (owner: Owner, id: string, approval?: string) => (await (await h.request(`/api/v1/schedules/${id}/run-now`, { method: "POST", headers: { ...owner.auth, ...(approval ? { "x-agent-approval": approval } : {}) } })).json()).data;
const policy = (owner: Owner, hash: string, spec: any) => h.request(`/api/v1/agents/${hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: {}, on_breach: "deny", ...spec } });

test("UTC recurrence is strict at boundaries, through DST, leap days and Monday transitions", () => {
  for (const [cadence, time, after, expected] of [
    ["hourly", null, "2026-10-08T09:00:00Z", "2026-10-08T10:00:00.000Z"],
    ["hourly", null, "2026-12-31T23:59:59Z", "2027-01-01T00:00:00.000Z"],
    ["daily", "09:00", "2026-03-08T08:59:59Z", "2026-03-08T09:00:00.000Z"],
    ["daily", "09:00", "2026-03-08T09:00:00Z", "2026-03-09T09:00:00.000Z"],
    ["daily", "00:00", "2028-02-28T23:59:59Z", "2028-02-29T00:00:00.000Z"],
    ["monday", "09:00", "2026-10-05T09:00:00Z", "2026-10-12T09:00:00.000Z"],
    ["monday", "09:00", "2026-10-04T23:59:59Z", "2026-10-05T09:00:00.000Z"],
    ["monday", "09:00", "2026-10-05T08:59:59Z", "2026-10-05T09:00:00.000Z"],
  ] as const) expect(nextDue(cadence, time, new Date(after)).toISOString()).toBe(expected);
  expect(() => nextDue("daily", "24:00", new Date())).toThrow();
});
test("off by default registers no job and refuses schedule routes; API role registers no worker", async () => {
  expect(loadConfig({}).scheduledPromptsEnabled).toBe(false);
  const off = await startRouter();
  try {
    const owner = await off.newKey();
    registerScheduledPrompts(off.ctx, dispatch);
    expect(off.ctx.jobs.status().some(job => job.name === "scheduled-prompts")).toBe(false);
    expect((await off.request("/api/v1/schedules", { headers: owner.auth })).status).toBe(404);
    expect(await runSchedules(off.ctx, dispatch)).toEqual({ runs: 0 });
  } finally { await off.close(); }
  expect(h.ctx.jobs.status().find(job => job.name === "scheduled-prompts")?.every_ms).toBe(60_000);
  const api = { ...h.ctx, cfg: { ...h.ctx.cfg, runtimeRole: "api" as const }, jobs: { register: () => { throw new Error("must not register"); } } };
  registerScheduledPrompts(api as unknown as typeof h.ctx, dispatch);
});
test("CRUD validates required ceiling and UTC time, encrypts prompts, and deletes saved runs", async () => {
  const owner = await h.fundedKey();
  for (const extra of [{ max_cost_usd: undefined }, { max_cost_usd: 0 }, { time_utc: null }, { time_utc: "24:00" }]) {
    expect((await h.request("/api/v1/schedules", { method: "POST", headers: owner.auth, json: { name: "Note", prompt: "hi", model: MODELS.llama.slug, key_hash: owner.hash, cadence: "daily", time_utc: "09:00", max_cost_usd: 0.05, ...extra } })).status).toBe(400);
  }
  const created = await create(owner);
  const [stored] = await h.ctx.db.select().from(schedules).where(eq(schedules.id, created.id));
  expect(stored.promptEnc).not.toContain("scheduled prompt sentinel");
  expect((await (await h.request(`/api/v1/schedules/${created.id}`, { headers: owner.auth })).json()).data.prompt).toBe("scheduled prompt sentinel");
  const changed = await h.request(`/api/v1/schedules/${created.id}`, { method: "PATCH", headers: owner.auth, json: { cadence: "hourly", name: "Hourly note" } });
  expect(changed.status).toBe(200); expect((await changed.json()).data.time_utc).toBeNull();
  expect((await runNow(owner, created.id)).status).toBe("succeeded");
  expect((await h.request(`/api/v1/schedules/${created.id}`, { method: "DELETE", headers: owner.auth })).status).toBe(200);
  expect(await h.ctx.db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, created.id))).toHaveLength(0);
});
test("all endpoints require owners; inference, session, foreign and ordinary keys cannot manage schedules", async () => {
  const owner = await h.fundedKey(), other = await h.fundedKey(), created = await create(owner);
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Paying key", scope: "inference" } })).json();
  const childAuth = { authorization: "Bearer " + child.key };
  const session = await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json();
  for (const [method, suffix] of [["GET", ""], ["POST", ""], ["GET", "/" + created.id], ["PATCH", "/" + created.id], ["DELETE", "/" + created.id], ["POST", "/" + created.id + "/run-now"], ["GET", "/" + created.id + "/runs"]]) {
    expect((await h.request("/api/v1/schedules" + suffix, { method })).status).toBe(401);
    expect((await h.request("/api/v1/schedules" + suffix, { method, headers: childAuth })).status).toBe(403);
    expect((await h.request("/api/v1/schedules" + suffix, { method, headers: { authorization: "Bearer " + session.data.key } })).status).toBe(403);
  }
  expect((await h.request(`/api/v1/schedules/${created.id}`, { headers: other.auth })).status).toBe(404);
  expect((await h.request(`/api/v1/schedules/${created.id}/run-now`, { method: "POST", headers: other.auth })).status).toBe(404);
  // A network header/body cannot manufacture the in-process identity.
  expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: { "x-schedule-key": owner.hash }, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], schedule_key_hash: owner.hash } })).status).toBe(402);
});
test("normal chat billing charges the selected child key and encrypts full replies with inbox excerpts", async () => {
  const owner = await h.fundedKey();
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Research", scope: "inference", budget_usd: 1 } })).json();
  const created = await create(owner, { key_hash: child.data.hash });
  const run = await runNow(owner, created.id); expect(run.status).toBe("succeeded"); expect(run.reply).toBe("scheduled answer sentinel");
  const [generation] = await h.ctx.db.select().from(generations).where(eq(generations.id, run.generation_id));
  expect(generation.keyHash).toBe(child.data.hash); expect(generation.cost).toBeGreaterThan(0n);
  const [stored] = await h.ctx.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, run.id)); expect(stored.replyEnc).not.toContain("scheduled answer sentinel");
  const inbox = await (await h.request("/api/v1/inbox", { headers: owner.auth })).json();
  expect(inbox.data.find((item: any) => item.id === `schedule:${run.id}`).title).toBe("Morning note: scheduled answer sentinel");
  const inferenceInbox = await h.request("/api/v1/inbox", { headers: { authorization: "Bearer " + child.key } });
  expect(inferenceInbox.status).toBe(403);
});
test("cost ceiling refuses before calling a provider or charging funds; three failures pause and Resume resets", async () => {
  const owner = await h.fundedKey(), created = await create(owner, { max_cost_usd: "0.000000000001" });
  const requests = h.mocks.alpha.stats.requests;
  for (let i = 0; i < 3; i++) { const result = await runNow(owner, created.id); expect(result.reason).toBe("schedule_max_cost"); }
  expect(h.mocks.alpha.stats.requests).toBe(requests);
  const [row] = await h.ctx.db.select().from(schedules).where(eq(schedules.id, created.id)); expect(row.paused).toBe(true); expect(row.failures).toBe(3);
  const runs = await retainedRuns(h.ctx, row); expect(runs.every(run => run.reply === null)).toBe(true);
  expect(await h.ctx.db.select().from(generations).where(eq(generations.keyHash, owner.hash))).toHaveLength(0);
  expect((await (await h.request(`/api/v1/schedules/${row.id}`, { method: "PATCH", headers: owner.auth, json: { paused: false } })).json()).data.consecutive_failures).toBe(0);
});
test("rulebook model denial, key budget, disabled owner and expired payer are enforced", async () => {
  const owner = await h.fundedKey(), created = await create(owner);
  expect((await policy(owner, owner.hash, { models: { deny: [MODELS.llama.slug] } })).status).toBe(200);
  const before = h.mocks.alpha.stats.requests;
  expect((await runNow(owner, created.id)).reason).toBe("agent_policy_denied"); expect(h.mocks.alpha.stats.requests).toBe(before);
  await policy(owner, owner.hash, {});
  await h.ctx.db.update(keys).set({ budget: 1n }).where(eq(keys.keyHash, owner.hash));
  expect((await runNow(owner, created.id)).status).toBe("failed"); expect(h.mocks.alpha.stats.requests).toBe(before);
  await h.ctx.db.update(keys).set({ budget: null, expiresAt: new Date(Date.now() - 1000) }).where(eq(keys.keyHash, owner.hash));
  const row = (await h.ctx.db.select().from(schedules).where(eq(schedules.id, created.id)))[0];
  const { executeRun } = await import("../src/schedules/worker.ts");
  const claimed = await claimRun(h.ctx, row.id, new Date(), true); expect((await executeRun(h.ctx, claimed!, dispatch))?.reason).toBe("key_expired");
});
test("ask-first creates an ordinary approval and run-now consumes it exactly once", async () => {
  const owner = await h.fundedKey(), created = await create(owner);
  await policy(owner, owner.hash, { approval: { above_usd: 0.000000001 } });
  expect((await runNow(owner, created.id)).reason).toBe("agent_approval_required");
  const [approval] = await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.keyHash, owner.hash));
  expect((await h.request(`/api/v1/agents/approvals/${approval.id}/approve`, { method: "POST", headers: owner.auth })).status).toBe(200);
  expect((await runNow(owner, created.id, approval.id)).status).toBe("succeeded");
  expect((await runNow(owner, created.id, approval.id)).status).toBe("failed");
});
test("two workers claim a due slot once, skip paused schedules, coalesce missed intervals and keep ten runs", async () => {
  const owner = await h.fundedKey(), created = await create(owner, { cadence: "hourly" }), now = new Date();
  await h.ctx.db.update(schedules).set({ nextAt: new Date(now.getTime() - 7_200_000) }).where(eq(schedules.id, created.id));
  const before = h.mocks.alpha.stats.requests;
  await Promise.all([runSchedules(h.ctx, dispatch, now), runSchedules(h.ctx, dispatch, now)]);
  expect(h.mocks.alpha.stats.requests - before).toBe(1);
  const [row] = await h.ctx.db.select().from(schedules).where(eq(schedules.id, created.id)); expect(row.nextAt).toEqual(nextDue("hourly", null, now));
  for (let i = 0; i < 11; i++) await runNow(owner, row.id);
  expect(await h.ctx.db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, row.id))).toHaveLength(10);
  await h.ctx.db.update(schedules).set({ paused: true, nextAt: new Date(now.getTime() - 1) }).where(eq(schedules.id, row.id));
  expect((await runSchedules(h.ctx, dispatch, now)).runs).toBe(0);
});
test("active runs prevent edits/deletion; interrupted runs are recorded once without redispatch", async () => {
  const owner = await h.fundedKey(), created = await create(owner), now = new Date();
  await claimRun(h.ctx, created.id, new Date(now.getTime() - 960_000), true);
  expect((await h.request(`/api/v1/schedules/${created.id}`, { method: "PATCH", headers: owner.auth, json: { name: "Changed" } })).status).toBe(409);
  expect((await h.request(`/api/v1/schedules/${created.id}`, { method: "DELETE", headers: owner.auth })).status).toBe(409);
  const before = h.mocks.alpha.stats.requests;
  await runSchedules(h.ctx, dispatch, now); await runSchedules(h.ctx, dispatch, now);
  expect(h.mocks.alpha.stats.requests).toBe(before);
  const run = (await h.ctx.db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, created.id)))[0];
  expect(run.reason).toBe("worker_interrupted"); expect(run.notified).toBe(true);
});
test("team owners are confined to their keys; administrators and ordinary keys cannot manage schedules", async () => {
  const owner = await h.fundedKey();
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Team owner" } })).json();
  const teamOwner = { ...owner, hash: child.data.hash, auth: { authorization: "Bearer " + child.key } };
  expect((await h.request("/api/v1/schedules", { headers: teamOwner.auth })).status).toBe(403);
  await h.ctx.db.update(keys).set({ teamId: "scheduled-team" }).where(eq(keys.keyHash, teamOwner.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "scheduled-team", keyHash: teamOwner.hash, role: "owner" });
  const own = await create(teamOwner), outside = await create(owner);
  expect((await (await h.request("/api/v1/schedules", { headers: teamOwner.auth })).json()).data.map((row: any) => row.id)).toEqual([own.id]);
  expect((await h.request(`/api/v1/schedules/${outside.id}`, { headers: teamOwner.auth })).status).toBe(403);
  await h.ctx.db.update(teamMembers).set({ role: "admin" }).where(eq(teamMembers.keyHash, teamOwner.hash));
  expect((await h.request("/api/v1/schedules", { headers: teamOwner.auth })).status).toBe(403);
});
test("normal lane defaults apply to scheduled calls and refused lanes contact no provider", async () => {
  const owner = await h.fundedKey(), created = await create(owner);
  await h.ctx.db.update(keys).set({ routing: { provider: { lane: "attested" } } }).where(eq(keys.keyHash, owner.hash));
  const before = h.mocks.alpha.stats.requests;
  expect((await runNow(owner, created.id)).status).toBe("failed");
  expect(h.mocks.alpha.stats.requests).toBe(before);
});
test("an upstream usage overreport cannot charge more than the schedule ceiling", async () => {
  const bounded = await startRouter({ env: { SCHEDULED_PROMPTS_ENABLED: "true" }, providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama], usage: { completion_tokens: 100_000_000 } }] });
  try {
    const owner = await bounded.fundedKey();
    const response = await bounded.request("/api/v1/schedules", { method: "POST", headers: owner.auth, json: { name: "Bounded note", prompt: "hi", model: MODELS.llama.slug, key_hash: owner.hash, cadence: "hourly", max_cost_usd: 0.05 } });
    expect(response.status).toBe(201); const id = (await response.json()).data.id;
    const result = await (await bounded.request(`/api/v1/schedules/${id}/run-now`, { method: "POST", headers: owner.auth })).json();
    const [generation] = await bounded.ctx.db.select().from(generations).where(eq(generations.id, result.data.generation_id));
    expect(generation.cost).toBeLessThanOrEqual(50_000_000_000n);
  } finally { await bounded.close(); }
});
test("linked Telegram gets exactly one 300-character excerpt and an authenticated result link", async () => {
  const { issueCode, consumeCode } = await import("../src/telegram/linking.ts");
  const { deliverScheduleNotice } = await import("../src/schedules/worker.ts");
  const owner = await h.fundedKey(), created = await create(owner), run = await runNow(owner, created.id);
  const [row] = await h.ctx.db.select().from(schedules).where(eq(schedules.id, created.id));
  const [principal] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  const ctx = { ...h.ctx, cfg: { ...h.ctx.cfg, telegram: { ...h.ctx.cfg.telegram, linkingEnabled: true, botToken: "000000:fixture-telegram-token" } } };
  const code = await issueCode(ctx, principal); await consumeCode(ctx, 73001, code.code);
  await h.ctx.db.update(scheduleRuns).set({ notified: false }).where(eq(scheduleRuns.id, run.id));
  const sent: any[] = [];
  const transport = (async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof fetch;
  const done = { id: run.id, reason: null, paused: false };
  await Promise.all([deliverScheduleNotice(ctx, row, done, "x".repeat(350), transport), deliverScheduleNotice(ctx, row, done, "x".repeat(350), transport)]);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toBe(`Morning note: ${"x".repeat(300)}\nhttps://anyroute.tech/dashboard/?schedule=${row.id}&run=${run.id}#schedules`);
  expect(sent[0].text).not.toContain(owner.secret);
});
test("a Telegram link downgraded to administrator cannot receive saved reply excerpts", async () => {
  const { issueCode, consumeCode } = await import("../src/telegram/linking.ts");
  const { deliverScheduleNotice } = await import("../src/schedules/worker.ts");
  const owner = await h.fundedKey();
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Schedule owner" } })).json();
  const key = { ...owner, hash: child.data.hash, auth: { authorization: "Bearer " + child.key } };
  await h.ctx.db.update(keys).set({ teamId: "schedule-notices-team" }).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "schedule-notices-team", keyHash: key.hash, role: "owner" });
  const created = await create(key), run = await runNow(key, created.id);
  const [row] = await h.ctx.db.select().from(schedules).where(eq(schedules.id, created.id));
  const [principal] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  const ctx = { ...h.ctx, cfg: { ...h.ctx.cfg, telegram: { ...h.ctx.cfg.telegram, linkingEnabled: true, botToken: "000000:fixture-telegram-token" } } };
  const code = await issueCode(ctx, principal); await consumeCode(ctx, 73002, code.code);
  await h.ctx.db.update(teamMembers).set({ role: "admin" }).where(eq(teamMembers.keyHash, key.hash));
  await h.ctx.db.update(scheduleRuns).set({ notified: false }).where(eq(scheduleRuns.id, run.id));
  let sends = 0;
  const transport = (async () => { sends++; return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof fetch;
  await deliverScheduleNotice(ctx, row, { id: run.id, reason: null, paused: false }, "private saved reply", transport);
  expect(sends).toBe(0);
});

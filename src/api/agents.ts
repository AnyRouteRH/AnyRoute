import { actionsRemaining, combinedActionsRemaining } from "../agents/guard-state.ts"; // V98
import { autonomyDescription, autonomyMultiplier, spendingCapPico } from "../agents/autonomy.ts";
import { agentAlertsRoutes } from "./agent-alerts.ts";
import type { Context, Hono } from "hono";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { agentSessions, keys } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";
import { requireKey, requireRole, type KeyRow } from "./auth.ts";
import { readJson } from "./common.ts";
import { agentIntentSchema, agentPolicySchema } from "../agents/policy.ts";
import { agentPolicies, agentPolicyEvents } from "../agents/schema.ts";
import { configureAgentPolicies } from "../agents/enforce.ts";
import { evaluateAgentPolicy, type AgentDecision } from "../agents/evaluate.ts";
import { appendEvent, changeKill, eventJson, lockAccount, policiesFor, policyState, setPolicy, type PolicyRow } from "../agents/store.ts";
const jsonPolicy = (row: PolicyRow) => ({ policy: row.spec, sha256: row.sha256, version: row.version, killed: row.killed, killed_at: row.killedAt?.toISOString() ?? null, killed_reason: row.killedReason });
const killBody = z.strictObject({ reason: z.string().max(160).optional() });
export async function principal(ctx: Ctx, c: Context) {
  const key = await requireKey(ctx, c.req.header("authorization"));
  if ((await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash)).limit(1)).length) fail(403, "Session keys cannot manage rulebooks.", "forbidden");
  await requireRole(ctx, key, ["owner", "admin"]);
  return key;
}
export async function ownedKey(ctx: Ctx, caller: KeyRow, hash: string) {
  const [key] = await ctx.db.select().from(keys).where(and(eq(keys.keyHash, hash), eq(keys.accountId, caller.accountId)));
  if (!key) fail(404, "Key not found.", "not_found");
  if (!caller.management && (!caller.teamId || key.teamId !== caller.teamId)) fail(403, "This key cannot manage that key.", "forbidden");
  return key;
}
async function ownPolicy(ctx: Ctx, hash: string) {
  const [row] = await ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, hash));
  if (!row) fail(404, "Rulebook not found.", "not_found");
  return row;
}
async function describe(ctx: Ctx, key: KeyRow, rows: PolicyRow[], now: Date) {
  return Promise.all(rows.map(async row => {
    const state = await policyState(ctx.db, row, now);
    const spent = Object.fromEntries(Object.entries(state.spent_pico).map(([w, v]) => [w, picoToUsd(v)]));
    const remaining = Object.fromEntries((["hour", "day", "week"] as const).map(w => {
      const cap = row.spec.caps[`per_${w}_usd`];
      const value = cap === undefined ? null : spendingCapPico(cap, autonomyMultiplier(row.spec, state.autonomy)) - state.spent_pico[w];
      return [w, value === null ? null : picoToUsd(value > 0n ? value : 0n)];
    }));
    return { key_hash: row.keyHash, inherited: row.keyHash !== key.keyHash, ...jsonPolicy(row), spent, remaining, ...(ctx.cfg.agentGuardEnabled ? actionsRemaining(row.spec, state) : {}), ...autonomyDescription(row.spec, state.autonomy, now) };
  }));
}
export function agentsRoutes(app: Hono, ctx: Ctx) {
  configureAgentPolicies(ctx);
  agentAlertsRoutes(app, ctx);
  app.use("/api/v1/agents/*", async (_c, next) => { if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found"); await next(); });
  app.use("/api/v1/agents", async (_c, next) => { if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found"); await next(); });
  app.get("/api/v1/agents", async c => {
    const caller = await principal(ctx, c);
    const rows = await ctx.db.select().from(keys).where(eq(keys.accountId, caller.accountId));
    const visible = caller.management ? rows : rows.filter(k => k.teamId === caller.teamId);
    const data = await Promise.all(visible.map(async key => {
      const policies = await policiesFor(ctx.db, key.keyHash);
      const descriptions = await describe(ctx, key, policies, new Date());
      const own = descriptions.find(p => !p.inherited) ?? descriptions[0];
      const uncapped = own ? null : await policyState(ctx.db, { keyHash: key.keyHash, killed: false }, new Date());
      return { key_hash: key.keyHash, name: key.name, has_policy: !!own, killed: descriptions.some(p => p.killed), policy_sha256: own?.sha256 ?? null, spent: own?.spent ?? Object.fromEntries(Object.entries(uncapped!.spent_pico).map(([w, v]) => [w, picoToUsd(v)])), caps: own?.effective_caps ?? own?.policy.caps ?? {}, policies: descriptions };
    }));
    return c.json({ data });
  });
  app.get("/api/v1/agents/me", async c => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const policies = await describe(ctx, key, await policiesFor(ctx.db, key.keyHash), new Date());
    const own = policies.find(p => !p.inherited) ?? policies[0];
    const remaining = Object.fromEntries((["hour", "day", "week"] as const).map(window => {
      const limits = policies.map(p => p.remaining[window]).filter((v): v is number => typeof v === "number");
      return [window, limits.length ? Math.min(...limits) : null];
    }));
    return c.json({ data: { key_hash: key.keyHash, name: key.name, policy: own?.policy ?? null, sha256: own?.sha256 ?? null, killed: policies.some(p => p.killed), remaining, policies, ...(ctx.cfg.agentGuardEnabled ? combinedActionsRemaining(policies) : {}), ...(own?.autonomy ? { autonomy: own.autonomy, effective_caps: own.effective_caps } : {}) } });
  });
  app.post("/api/v1/agents/check", async c => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const intent = agentIntentSchema.parse(await readJson(c));
    if (intent.kind === "action" && !ctx.cfg.agentGuardEnabled) fail(404, "Not found.", "not_found"); // V98
    // Account locking gives the dry run one coherent state without writing events or changing kill state.
    const data = await ctx.db.transaction(async tx => {
      await lockAccount(tx, key.accountId);
      const rows = await policiesFor(tx, key.keyHash);
      const now = new Date();
      const decisions = await Promise.all(rows.map(async row => evaluateAgentPolicy(row.spec, await policyState(tx, row, now), intent, now)));
      const decision: AgentDecision["decision"] = decisions.some(d => d.decision === "deny") ? "deny" : decisions.some(d => d.decision === "approval_required") ? "approval_required" : "allow";
      return { decision, reasons: decisions.flatMap(d => d.reasons) };
    });
    return c.json({ data });
  });
  app.get("/api/v1/agents/:key_hash/policy", async c => {
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    return c.json({ data: jsonPolicy(await ownPolicy(ctx, key.keyHash)) });
  });
  app.put("/api/v1/agents/:key_hash/policy", async c => {
    const caller = await principal(ctx, c);
    const key = await ownedKey(ctx, caller, c.req.param("key_hash"));
    const policy = agentPolicySchema.parse(await readJson(c));
    return c.json({ data: jsonPolicy(await setPolicy(ctx.db, key.accountId, key.keyHash, policy, caller.keyHash)) });
  });
  app.delete("/api/v1/agents/:key_hash/policy", async c => {
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    await ctx.db.transaction(async tx => {
      await lockAccount(tx, key.accountId);
      const [row] = await tx.delete(agentPolicies).where(eq(agentPolicies.keyHash, key.keyHash)).returning();
      if (row) await appendEvent(tx, { keyHash: key.keyHash, kind: "policy_set", policySha256: row.sha256 });
    });
    return c.json({ data: { key_hash: key.keyHash, deleted: true } });
  });
  for (const action of ["kill", "resume"] as const) app.post(`/api/v1/agents/:key_hash/${action}`, async c => {
    const caller = await principal(ctx, c);
    const key = await ownedKey(ctx, caller, c.req.param("key_hash"));
    const body = action === "kill" ? killBody.parse(await readJson(c)) : {};
    const row = await ctx.db.transaction(async tx => {
      await lockAccount(tx, key.accountId);
      const [policy] = await tx.select().from(agentPolicies).where(eq(agentPolicies.keyHash, key.keyHash));
      if (!policy) fail(404, "Rulebook not found.", "not_found");
      return changeKill(tx, policy, action === "kill", body.reason ?? null, caller.keyHash);
    });
    return c.json({ data: jsonPolicy(row) });
  });
  app.get("/api/v1/agents/:key_hash/events", async c => {
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    const cursor = c.req.query("cursor");
    const before = cursor === undefined ? undefined : z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(cursor);
    const rows = await ctx.db.select().from(agentPolicyEvents).where(and(eq(agentPolicyEvents.keyHash, key.keyHash), before === undefined ? undefined : lt(agentPolicyEvents.id, before))).orderBy(desc(agentPolicyEvents.id)).limit(51);
    const page = rows.slice(0, 50);
    return c.json({ data: page.map(eventJson), next_cursor: rows.length > 50 ? String(page.at(-1)!.id) : null });
  });
}

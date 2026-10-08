import type { Hono, Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { requireKey, requireRole } from "./auth.ts";
import { principal, ownedKey } from "./agents.ts";
import { readJson } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { genId } from "../lib/util.ts";
import { usdToPico } from "../lib/money.ts";
import { outputModalities } from "../catalog/catalog.ts";
import { schedules } from "../schedules/schema.ts";
import { nextDue } from "../schedules/time.ts";
import { assertIdle, ownSchedule, retainedRuns, sealContent, scheduleJson } from "../schedules/store.ts";
import { claimRun, executeRun } from "../schedules/worker.ts";
import type { Dispatch } from "../services/batches.ts";

const fields = z.strictObject({
  name: z.string().trim().min(1).max(100), prompt: z.string().min(1).max(64_000),
  model: z.string().min(1).max(200), key_hash: z.string().regex(/^[a-f0-9]{64}$/),
  cadence: z.enum(["hourly", "daily", "monday"]), time_utc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  max_cost_usd: z.union([z.number().positive().max(1000), z.string().regex(/^\d+(\.\d{1,12})?$/)]).refine(v => Number(v) > 0 && Number(v) <= 1000),
  paused: z.boolean().optional(),
});
async function owner(ctx: Ctx, c: Context) {
  c.header("cache-control", "no-store");
  const key = await requireKey(ctx, c.req.header("authorization"));
  if (key.scope === "inference") fail(403, "Use an owner key to manage schedules.", "forbidden");
  await requireRole(ctx, await principal(ctx, c), ["owner"]);
  if (!ctx.cfg.scheduledPromptsEnabled) fail(404, "Scheduled prompts are not switched on.", "feature_disabled");
  return key;
}
function cadenceTime(value: z.infer<typeof fields>) {
  if (value.cadence !== "hourly" && !value.time_utc) fail(400, "Choose a UTC time.", "invalid_request");
  return value.cadence === "hourly" ? null : value.time_utc!;
}
export function scheduledPromptRoutes(app: Hono, ctx: Ctx, dispatch: Dispatch) {
  app.get("/api/v1/schedules", async c => {
    const key = await owner(ctx, c);
    const rows = await ctx.db.select().from(schedules).where(eq(schedules.accountId, key.accountId)).orderBy(schedules.createdAt).limit(100);
    const visible = [];
    for (const row of rows) { try { await ownedKey(ctx, key, row.keyHash); visible.push(scheduleJson(ctx, row)); } catch { /* Team boundary. */ } }
    return c.json({ data: visible });
  });
  app.post("/api/v1/schedules", async c => {
    const key = await owner(ctx, c), body = fields.parse(await readJson(c)), time = cadenceTime(body);
    const payer = await ownedKey(ctx, key, body.key_hash);
    if (payer.disabled || (payer.expiresAt && payer.expiresAt <= new Date())) fail(400, "Choose an active key.", "invalid_key");
    await ctx.catalog.ensureFresh();
    const resolved = ctx.catalog.resolve(body.model);
    if (!resolved || !outputModalities(resolved.model).includes("text")) fail(400, "Choose an available text model.", "invalid_schedule_model");
    const id = genId(), identity = { accountId: key.accountId, id };
    const row = await ctx.db.transaction(async tx => {
      // Bound owner storage and serialize creation on the existing account row.
      await tx.execute(sql`SELECT id FROM accounts WHERE id = ${key.accountId} FOR UPDATE`);
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(schedules).where(eq(schedules.accountId, key.accountId));
      if (count >= 100) fail(409, "This account already has 100 schedules.", "schedule_limit");
      return (await tx.insert(schedules).values({ ...identity, ownerHash: key.keyHash, keyHash: payer.keyHash, name: body.name, promptEnc: sealContent(ctx, identity, body.prompt), model: body.model, cadence: body.cadence, timeUtc: time, maxCostPico: usdToPico(body.max_cost_usd), paused: body.paused ?? false, nextAt: nextDue(body.cadence, time, new Date()) }).returning())[0];
    });
    return c.json({ data: scheduleJson(ctx, row) }, 201);
  });
  app.get("/api/v1/schedules/:id", async c => { const key = await owner(ctx, c); return c.json({ data: scheduleJson(ctx, await ownSchedule(ctx, key, c.req.param("id"))) }); });
  app.patch("/api/v1/schedules/:id", async c => {
    const key = await owner(ctx, c), row = await ownSchedule(ctx, key, c.req.param("id")), patch = fields.partial().parse(await readJson(c));
    if (patch.model) {
      await ctx.catalog.ensureFresh();
      const resolved = ctx.catalog.resolve(patch.model);
      if (!resolved || !outputModalities(resolved.model).includes("text")) fail(400, "Choose an available text model.", "invalid_schedule_model");
    }
    const updated = await ctx.db.transaction(async tx => {
      const [live] = await tx.select().from(schedules).where(eq(schedules.id, row.id)).for("update");
      if (!live) fail(404, "Schedule not found.", "not_found");
      await assertIdle(tx as unknown as Ctx["db"], row.id);
      const scoped = { ...ctx, db: tx as unknown as Ctx["db"] };
      await ownedKey(scoped, key, live.keyHash);
      const { id, consecutive_failures, next_at, created_at, ...saved } = scheduleJson(ctx, live);
      const body = fields.parse({ ...saved, ...patch }), time = cadenceTime(body);
      await ownedKey(scoped, key, body.key_hash);
      const nextAt = patch.cadence !== undefined || patch.time_utc !== undefined || patch.paused === false ? nextDue(body.cadence, time, new Date()) : live.nextAt;
      return (await tx.update(schedules).set({ ownerHash: key.keyHash, keyHash: body.key_hash, name: body.name, promptEnc: sealContent(ctx, live, body.prompt), model: body.model, cadence: body.cadence, timeUtc: time, maxCostPico: usdToPico(body.max_cost_usd), paused: body.paused ?? live.paused, failures: patch.paused === false ? 0 : live.failures, nextAt }).where(eq(schedules.id, row.id)).returning())[0];
    });
    return c.json({ data: scheduleJson(ctx, updated) });
  });
  app.delete("/api/v1/schedules/:id", async c => {
    const key = await owner(ctx, c), row = await ownSchedule(ctx, key, c.req.param("id"));
    await ctx.db.transaction(async tx => { await tx.select().from(schedules).where(eq(schedules.id, row.id)).for("update"); await assertIdle(tx as unknown as Ctx["db"], row.id); await tx.delete(schedules).where(eq(schedules.id, row.id)); });
    return c.json({ deleted: true });
  });
  app.get("/api/v1/schedules/:id/runs", async c => { const key = await owner(ctx, c); return c.json({ data: await retainedRuns(ctx, await ownSchedule(ctx, key, c.req.param("id"))) }); });
  app.post("/api/v1/schedules/:id/run-now", async c => {
    const key = await owner(ctx, c), row = await ownSchedule(ctx, key, c.req.param("id"));
    const claimed = await claimRun(ctx, row.id, new Date(), true);
    if (!claimed) fail(409, "This run was already claimed.", "schedule_busy");
    await executeRun(ctx, claimed, dispatch, c.req.header("x-agent-approval"));
    return c.json({ data: (await retainedRuns(ctx, row)).find(run => run.id === claimed.run.id) });
  });
}

import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { readJson } from "./common.ts";
import { requireKey, requireRole, type KeyRow } from "./auth.ts";
import { createSession, describe, endSession, getSession, listSessions, parseSessionCursor, recentCalls, sessionForKey, type SessionRow } from "../services/agent-sessions.ts";

// Agent Sessions: short-lived, budget-capped session keys for agent runs.
//   POST   /api/v1/sessions          owner/admin (management keys are owners): create; the secret is shown once
//   GET    /api/v1/sessions          any key of the account except session keys: newest first
//   GET    /api/v1/sessions/current  the session key itself: its remaining budget and time
//   GET    /api/v1/sessions/:id      any key of the account except session keys: detail + recent calls
//   DELETE /api/v1/sessions/:id      owner/admin: end now (idempotent)

const intParam = (v: string | undefined, dflt: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(Number(v ?? dflt)) || dflt));

async function member(ctx: Ctx, c: Context) {
  const k = await requireKey(ctx, c.req.header("authorization"));
  if (await sessionForKey(ctx, k.keyHash)) fail(403, "A session key can read only its own session: GET /api/v1/sessions/current.", "forbidden");
  await requireRole(ctx, k, ["owner", "admin", "member", "viewer"]);
  return k;
}

async function manager(ctx: Ctx, c: Context) {
  const k = await requireKey(ctx, c.req.header("authorization"));
  if (await sessionForKey(ctx, k.keyHash)) fail(403, "A session key cannot create or end sessions.", "forbidden");
  await requireRole(ctx, k, ["owner", "admin"]);
  return k;
}

/** Management keys end any session; team owners/admins end their team's sessions and their own. */
function canManage(caller: KeyRow, s: SessionRow, key: KeyRow | null) {
  if (caller.management || s.parentKeyHash === caller.keyHash) return true;
  return !!caller.teamId && key?.teamId === caller.teamId;
}

export function agentSessionsRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/sessions", async (c) => {
    const caller = await manager(ctx, c);
    return c.json({ data: await createSession(ctx, caller, await readJson(c)) }, 201);
  });

  app.get("/api/v1/sessions", async (c) => {
    const caller = await member(ctx, c);
    const beforeParam = c.req.query("before");
    const before = beforeParam ? parseSessionCursor(beforeParam) : undefined;
    return c.json(await listSessions(ctx, caller.accountId, { limit: intParam(c.req.query("limit"), 50, 1, 200), before }));
  });

  // Registered before /:id. Expired or ended session keys are refused by key resolution (401).
  app.get("/api/v1/sessions/current", async (c) => {
    const k = await requireKey(ctx, c.req.header("authorization"));
    const s = await sessionForKey(ctx, k.keyHash);
    if (!s) fail(404, "This key is not an Agent Session key.", "not_found");
    const [d] = await describe(ctx, [s]);
    return c.json({ data: d.json });
  });

  app.get("/api/v1/sessions/:id", async (c) => {
    const caller = await member(ctx, c);
    const d = await getSession(ctx, caller.accountId, c.req.param("id"));
    return c.json({ data: { ...d.json, recent_calls: await recentCalls(ctx, d.row.keyHash, intParam(c.req.query("limit"), 50, 1, 200)) } });
  });

  app.delete("/api/v1/sessions/:id", async (c) => {
    const caller = await manager(ctx, c);
    const d = await getSession(ctx, caller.accountId, c.req.param("id"));
    if (!canManage(caller, d.row, d.key)) fail(403, "This key cannot end that session.", "forbidden");
    await endSession(ctx, d.row);
    return c.json({ data: (await getSession(ctx, caller.accountId, d.row.id)).json });
  });
}

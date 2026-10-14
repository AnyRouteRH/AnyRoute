// H171
import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { principal } from "../api/agents.ts";
import { keyJson } from "../api/keys.ts";
import { readJson } from "../api/common.ts";
import { duplicateAgent } from "./store.ts";

const duplicateBody = z.strictObject({ name: z.string().trim().min(1).max(100).optional() });
export function agentDuplicateRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/agents/:key/duplicate", async c => {
    const caller = await principal(ctx, c);
    const body = duplicateBody.parse(await readJson(c));
    const result = await duplicateAgent(ctx, caller, c.req.param("key"), body.name);
    c.header("cache-control", "no-store");
    return c.json({ data: keyJson(result.row), key: result.secret, note: result.note }, 201);
  });
}

// D144: the same owner/admin, management and account/team guards as PUT policy.
import type { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { policyHistory, restorePolicy } from "../agents/policy-history.ts";
import { fail } from "../lib/errors.ts";
import { ownedKey, principal } from "./agents.ts";
import { readJson } from "./common.ts";

const restoreBody = z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export function agentPolicyHistoryRoutes(app: Hono, ctx: Ctx) {
  app.get("/api/v1/agents/:key_hash/policy/versions", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    c.header("Cache-Control", "no-store");
    return c.json({ data: await policyHistory(ctx.db, key.keyHash) });
  });
  app.post("/api/v1/agents/:key_hash/policy/restore", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const caller = await principal(ctx, c);
    const key = await ownedKey(ctx, caller, c.req.param("key_hash"));
    const body = restoreBody.parse(await readJson(c));
    c.header("Cache-Control", "no-store");
    return c.json({ data: await restorePolicy(ctx.db, key.accountId, key.keyHash, body.sha256, caller.keyHash) });
  });
}

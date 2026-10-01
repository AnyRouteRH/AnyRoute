import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { principal, ownedKey } from "./agents.ts";
import { readJson } from "./common.ts";
import type { SealedIO } from "../agents/sealed/verify.ts";
import { registrationSchema } from "../agents/sealed/bindings.ts";
import { getSealed, registerSealed, removeSealed, sealedStatus } from "../agents/sealed/store.ts";
export function agentSealedRoutes(app: Hono, ctx: Ctx, io?: SealedIO) {
  if (!ctx.cfg.agentSealedEnabled) return;
  // Enrich the existing authenticated responses without changing their rulebook or accounting logic.
  app.use("/api/v1/agents", async (c, next) => {
    await next();
    if (c.req.method !== "GET" || c.res.status !== 200) return;
    const json = await c.res.clone().json() as { data: any };
    for (const agent of json.data) agent.sealed = sealedStatus(await getSealed(ctx, agent.key_hash));
    c.res = new Response(JSON.stringify(json), c.res);
  });
  app.use("/api/v1/agents/me", async (c, next) => {
    await next();
    if (c.req.method !== "GET" || c.res.status !== 200) return;
    const json = await c.res.clone().json() as { data: any };
    json.data.sealed = sealedStatus(await getSealed(ctx, json.data.key_hash));
    c.res = new Response(JSON.stringify(json), c.res);
  });
  app.post("/api/v1/agents/:key_hash/sealed", async c => {
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    if (key.disabled || key.management || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) fail(400, "Use an active agent key without management permissions.", "invalid_request");
    const registration = registrationSchema.parse(await readJson(c));
    const data = await registerSealed(ctx, key.keyHash, registration, io);
    return c.json({ data }, data?.attested ? 200 : 422);
  });
  app.delete("/api/v1/agents/:key_hash/sealed", async c => {
    const key = await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash"));
    await removeSealed(ctx, key.keyHash);
    return c.json({ data: { deleted: true } });
  });
}

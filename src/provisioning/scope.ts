import type { Hono, MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { accounts, generations, keys } from "../db/schema.ts";
import { bearer, requireKey } from "../api/auth.ts";
import { readJson } from "../api/common.ts";
import { sha256 } from "../lib/util.ts";
import { fail } from "../lib/errors.ts";

// Allow-list by method and full path: every added route starts refused. A stored
// restriction stays in force even when INFERENCE_KEYS_ENABLED is turned off.
export function inferenceRouteAllowed(method: string, path: string, guardEnabled = true) {
  if (method === "POST" && ((guardEnabled && path === "/mcp") || path === "/api/v1/guard/decide" || /^\/api\/v1\/guard\/decisions\/[^/]+\/outcome$/.test(path))) return true; // V98: internal MCP calls pass this middleware again.
  if (guardEnabled && method === "GET" && (path === "/api/v1/agents/me" || /^\/api\/v1\/agents\/approvals\/[^/]+$/.test(path))) return true;
  if (method === "POST") return /^\/(api\/)?v1\/(chat\/completions|completions|embeddings|responses|messages)$/.test(path);
  if (method !== "GET") return false;
  // B: paid market-data tools, charged per call like inference (src/data-tools); read-only and account-free.
  if (/^\/api\/v1\/data(?:\/stock\/[^/]+(?:\/actions)?|\/ipx\/[^/]+)?$/.test(path)) return true;
  return /^\/(api\/)?v1\/models$/.test(path) || /^\/api\/v1\/generation(s)?$/.test(path) || /^\/api\/v1\/receipts\/[^/]+(?:\/(proof|privacy))?$/.test(path);
}

export function inferenceScopeMiddleware(ctx: Ctx): MiddlewareHandler {
  return async (c, next) => {
    // Check both credential transports, including Anthropic's x-api-key. Looking
    // up only existing hashes preserves deposit-first registration in auth.ts.
    const secrets = new Set([bearer(c.req.header("authorization")), c.req.header("x-api-key")?.trim()].filter((s): s is string => !!s));
    for (const secret of secrets) {
      const [key] = await ctx.db.select({ keyHash: keys.keyHash, scope: keys.scope }).from(keys).where(eq(keys.keyHash, sha256(secret)));
      if (key?.scope !== "inference") continue;
      if (!inferenceRouteAllowed(c.req.method, c.req.path, ctx.cfg.agentGuardEnabled)) fail(403, "Inference-only keys may call models and data tools and read only their own generations and receipts.", "inference_only");
      await requireKey(ctx, `Bearer ${secret}`);
      const receipt = c.req.path.match(/^\/api\/v1\/receipts\/([^/]+)(?:\/(proof|privacy))?$/);
      // keys and verify are public helper endpoints, not this key's receipts.
      if (receipt && ["keys", "verify"].includes(receipt[1]!)) fail(403, "Inference-only keys may read only their own receipts.", "inference_only");
      const id = receipt ? decodeURIComponent(receipt[1]!) : c.req.path === "/api/v1/generation" ? c.req.query("id") : undefined;
      if (id) {
        const [own] = await ctx.db.select({ id: generations.id }).from(generations).where(and(eq(generations.id, id), eq(generations.keyHash, key.keyHash)));
        if (!own) fail(404, "Generation or receipt not found.", "not_found");
      }
    }
    await next();
  };
}

const defaultsSpec = z.object({ scope: z.enum(["inference", "account"]) }).strict();
export function keyDefaultsRoutes(app: Hono, ctx: Ctx) {
  const owner = async (authorization: string | undefined) => {
    const key = await requireKey(ctx, authorization);
    if (!key.management || key.scope === "inference") fail(403, "Only a management key can read or change key defaults.", "forbidden");
    return key;
  };
  app.get("/api/v1/keys/defaults", async (c) => {
    const key = await owner(c.req.header("authorization"));
    const [account] = await ctx.db.select({ inference: accounts.inferenceKeysDefault }).from(accounts).where(eq(accounts.id, key.accountId));
    return c.json({ data: { scope: account?.inference ? "inference" : "account", provisioning_enabled: ctx.cfg.inferenceKeysEnabled } });
  });
  app.patch("/api/v1/keys/defaults", async (c) => {
    const key = await owner(c.req.header("authorization"));
    const spec = defaultsSpec.parse(await readJson(c));
    if (spec.scope === "inference" && !ctx.cfg.inferenceKeysEnabled) fail(403, "Inference-only key provisioning is not switched on.", "feature_disabled");
    await ctx.db.update(accounts).set({ inferenceKeysDefault: spec.scope === "inference" }).where(eq(accounts.id, key.accountId));
    return c.json({ data: { scope: spec.scope, provisioning_enabled: ctx.cfg.inferenceKeysEnabled } });
  });
}

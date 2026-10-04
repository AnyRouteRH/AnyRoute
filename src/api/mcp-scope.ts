import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { Ctx } from "../context.ts";
// Request-local credentials only: no persistence or logging. Public-tool adapters must not drop an inference restriction.
const caller = new AsyncLocalStorage<{ authorization?: string; apiKey?: string }>();
export const mcpScopeMiddleware = (ctx: Ctx): MiddlewareHandler => async (c, next) => ctx.cfg.agentGuardEnabled
  ? caller.run({ authorization: c.req.header("authorization"), apiKey: c.req.header("x-api-key") }, next)
  : caller.exit(next);
export function withMcpScope(init?: RequestInit): RequestInit | undefined {
  const key = caller.getStore();
  if (!key?.authorization && !key?.apiKey) return init;
  const headers = new Headers(init?.headers);
  if (key.authorization) headers.set("authorization", key.authorization);
  if (key.apiKey) headers.set("x-api-key", key.apiKey);
  return { ...init, headers };
}

import type { MiddlewareHandler } from "hono";
// C134: retain the existing origin/auth middleware and CORS policy. Untagged preflights are unchanged.
export const projectCors: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method !== "OPTIONS" || !/^\/(api|v1|ollama)\//.test(c.req.path)) return;
  const requested = c.req.header("access-control-request-headers")?.split(',').map(value => value.trim().toLowerCase());
  const allowed = c.res.headers.get("access-control-allow-headers");
  if (allowed && requested?.includes("x-anyroute-project")) c.header("access-control-allow-headers", allowed + ",x-anyroute-project");
};

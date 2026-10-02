import type { MiddlewareHandler } from "hono";
import { zkapiCsp } from "../lib/csp.ts";

/** Register before the site's security headers so only these static responses override its policy. */
export function zkapiHosting(sitePolicy: string, origins: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status >= 400) return;
    const type = c.res.headers.get("content-type")?.split(";")[0];
    if (type !== "text/html" && !(c.req.path === "/zkapi/prover-worker.js" && type === "text/javascript")) return;
    const policy = zkapiCsp(c.req.path, sitePolicy, origins);
    if (policy) c.header("content-security-policy", policy);
  };
}

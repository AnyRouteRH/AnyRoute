import type { Context } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Hardening } from "./config.ts";
// Only router code can attach this marker. No network header or JSON field can produce it.
export const INTERNAL_REQUEST = Symbol("router internal dispatch");
export const internalEnv = (env?: unknown) => ({ ...(env && typeof env === "object" ? env : {}), [INTERNAL_REQUEST]: true });
export function socketAddress(c: Context): string {
  if (c.get("socketAddress") !== undefined) return c.get("socketAddress");
  const env = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
  try { const address = env?.requestIP?.(c.req.raw)?.address ?? "unknown"; c.set("socketAddress", address); return address; } catch { return "unknown"; }
}
export function validOriginLock(c: Context, cfg: Hardening): boolean {
  if (!cfg.originLockEnabled || !cfg.originLockSecret) return false;
  const value = c.req.header("x-origin-lock");
  if (!value) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(value), digest(cfg.originLockSecret));
}
export function privateAddress(value: string): boolean {
  const ip = value.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  return isIP(ip) === 6 && (ip === "::1" || /^f[cd]/.test(ip));
}
export function internalCaller(c: Context): boolean {
  if ((c.env as Record<symbol, unknown> | undefined)?.[INTERNAL_REQUEST] === true) return true;
  // Public edge traffic carries Forwarded/XFF. It must never inherit a private edge socket's exemption.
  const address = socketAddress(c);
  if (c.req.header("x-forwarded-for") !== undefined || c.req.header("forwarded") !== undefined) return false;
  return privateAddress(address);
}
export function derivedClientIp(c: Context, trustProxy: boolean, cfg?: Hardening): string {
  if (cfg && validOriginLock(c, cfg)) {
    const cf = c.req.header("cf-connecting-ip")?.trim();
    if (cf && isIP(cf)) return cf;
  }
  if (trustProxy) {
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map(s => s.trim());
    const selected = hops[hops.length - (cfg?.trustProxyHops ?? 1)];
    if (selected && isIP(selected)) return selected;
  }
  return socketAddress(c);
}

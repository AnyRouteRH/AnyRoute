// E148: owner settings are stored; observed caller addresses stay in request memory.
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ipAllowed, parseIpRange } from './address.js';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { keys } from '../db/schema.ts';
import { bearer, requireKey, requireRole } from '../api/auth.ts';
import { clientIp, viaOnion } from '../api/common.ts';
import { gatewayOrigin } from '../ohttp/origin.ts';
import { fail } from '../lib/errors.ts';
import { sha256 } from '../lib/util.ts';

export const allowedIpsInput = z.array(z.string().max(64).refine(value => !!parseIpRange(value), 'Use an IPv4 or IPv6 address or CIDR range.')).min(1).max(32).nullable();
const refused = () => fail(403, 'This key only works from its allowed IP addresses.', 'ip_not_allowed');
const hidden = () => fail(403, 'This key only works from its allowed IP addresses. Onion and unlinkable requests cannot verify a client IP address.', 'ip_not_allowed');

// Request-scoped memory only: in-process adapters may retain a verified originating address,
// but cannot introduce one through a network header. Each hop rechecks the current stored rule.
const origins = new AsyncLocalStorage<ReadonlyMap<string, string>>();

export function assertKeyIp(ctx: Ctx, c: Context, key: { keyHash: string; allowedIps: string[] | null }, background = false) {
  if (key.allowedIps == null) return;
  c.set('keyIpRestricted', true);
  if (viaOnion(c, ctx.cfg) || gatewayOrigin(c.req.raw) || c.req.header('x-anyroute-lane') === 'unlinkable') hidden();
  if (background) fail(403, 'This key only works from its allowed IP addresses. Background calls cannot verify a client IP address.', 'ip_not_allowed');
  const address = origins.getStore()?.get(key.keyHash) ?? clientIp(c, ctx.cfg.trustProxy);
  if (!ipAllowed(address, key.allowedIps)) refused();
  return address;
}

export function assertKeyIpLane(c: Context, lane: string) {
  if (lane === 'unlinkable' && c.get('keyIpRestricted')) hidden();
}

export const keyIpMiddleware = (ctx: Ctx): MiddlewareHandler => async (c, next) => {
  const verified = new Map(origins.getStore());
  const secrets = new Set([bearer(c.req.header('authorization')), c.req.header('x-api-key')?.trim()].filter((value): value is string => !!value));
  for (const secret of secrets) {
    const [key] = await ctx.db.select({ keyHash: keys.keyHash, allowedIps: keys.allowedIps }).from(keys).where(eq(keys.keyHash, sha256(secret)));
    if (key) { const address = assertKeyIp(ctx, c, key); if (address) verified.set(key.keyHash, address); }
  }
  await origins.run(verified, next);
};

export function keyIpRoutes(app: Hono, ctx: Ctx) {
  app.get('/api/v1/keys/current-ip', async c => {
    const key = await requireKey(ctx, c.req.header('authorization'));
    await requireRole(ctx, key, ['owner', 'admin']);
    if (viaOnion(c, ctx.cfg) || gatewayOrigin(c.req.raw)) hidden();
    const address = clientIp(c, ctx.cfg.trustProxy);
    if (!parseIpRange(address) || address.includes('/')) fail(503, 'Your client IP address is not available on this connection.', 'client_ip_unavailable');
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ip: address } });
  });
}

// E149: full method/path allow-list. Paid GET tools and unknown routes fail closed.
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { keys } from '../db/schema.ts';
import { fail } from '../lib/errors.ts';
import { batchLineOf } from '../router/batch-line.ts';
import { scheduleCallOf } from '../schedules/caller.ts';

const paths = [
  /^\/api\/v1\/account\/runway$/,
  /^\/api\/v1\/(activity|insights|spend|credits|inbox|lane-report|proof-pack(?:\/limits)?|keys|key|generations|generation)$/,
  /^\/api\/v1\/keys\/(?:defaults|[a-f0-9]{64})$/,
  /^\/api\/v1\/statements\/\d{4}-\d{2}$/,
  /^\/api\/v1\/agents(?:\/(?:me|spend|approvals))?$/,
  /^\/api\/v1\/agents\/(?:me|[a-f0-9]{64})\/(?:policy(?:\/versions)?|events|ledger)$/,
  /^\/api\/v1\/playbooks(?:\/[^/]+)?$/,
  /^\/api\/v1\/status(?:\/(?:slo|incidents(?:\.(?:atom|rss)|\/[^/]+)?))?$/,
  /^\/(?:api\/)?v1\/models$/,
];
export function readRouteAllowed(method: string, path: string) {
  return method === 'GET' && paths.some(pattern => pattern.test(path));
}
export function assertReadRoute(scope: string | null, method: string, path: string) {
  if (scope === 'read' && !readRouteAllowed(method, path)) fail(403, 'Read-only keys cannot spend or change anything.', 'read_only_key');
}
// Internal batch/schedule capabilities must not bypass the same scope boundary.
export async function enforceReadInternal(ctx: Ctx, c: Context) {
  const batch = batchLineOf(c), schedule = scheduleCallOf(c);
  const hashes = new Set([batch?.keyHash, schedule?.ownerHash, schedule?.keyHash].filter((hash): hash is string => !!hash));
  for (const hash of hashes) {
    const [key] = await ctx.db.select({ scope: keys.scope }).from(keys).where(eq(keys.keyHash, hash));
    if (key) assertReadRoute(key.scope, c.req.method, c.req.path);
  }
}

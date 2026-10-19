// K190: same management-key boundary as project budgets; read-only keys stay refused.
import type { Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { requireKey } from '../api/auth.ts';
import { fail } from '../lib/errors.ts';
import { readRefusal } from './details.ts';
export function refusalRoutes(app: Hono, ctx: Ctx) {
  app.get('/api/v1/refusals/:id', async c => {
    c.header('cache-control', 'no-store');
    const caller = await requireKey(ctx, c.req.header('authorization'));
    if (!caller.management) fail(403, 'Connect an account management key to read refusal details.', 'forbidden');
    return c.json({ data: await readRefusal(ctx, caller.accountId, c.req.param('id'), c.req.query('type') ?? '') });
  });
}

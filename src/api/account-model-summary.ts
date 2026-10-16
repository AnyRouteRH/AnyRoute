import type { Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { requireKey } from './auth.ts';
import { readModelSummary } from '../account/model-summary.ts';
export function accountModelSummaryRoutes(app: Hono, ctx: Ctx) {
  app.get('/api/v1/account/models/:id/summary', async c => {
    c.header('cache-control', 'no-store');
    const key = await requireKey(ctx, c.req.header('authorization'));
    return c.json(await readModelSummary(ctx, key, c.req.param('id')));
  });
}

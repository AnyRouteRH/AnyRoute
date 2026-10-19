import type { Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { requireKey } from './auth.ts';
import { readModelsUsed } from '../account/models-used.ts';

export function accountModelsUsedRoutes(app: Hono, ctx: Ctx) {
  app.get('/api/v1/account/models/used', async c => {
    c.header('cache-control', 'no-store');
    const key = await requireKey(ctx, c.req.header('authorization'));
    return c.json(await readModelsUsed(ctx, key));
  });
}

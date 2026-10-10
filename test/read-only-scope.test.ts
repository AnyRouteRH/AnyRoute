// E149: scope boundary tests require neither a database service nor Redis.
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Ctx } from '../src/context.ts';
import type { KeyRow } from '../src/api/auth.ts';
import { requireKey } from '../src/api/auth.ts';
import { generateApiKey } from '../src/chain/keys.ts';
import { inferenceScopeMiddleware } from '../src/provisioning/scope.ts';
import { readRouteAllowed, assertReadRoute } from '../src/read-only/scope.ts';
import { readPrincipal, readKeyFields } from '../src/read-only/keys.ts';
import { ApiError } from '../src/lib/errors.ts';

const secret = generateApiKey();
const row = { keyHash: 'a'.repeat(64), scope: 'read', management: false, disabled: false, expiresAt: null, accountId: 'sample-account' } as KeyRow;
function boundary(scope: string | null = 'read') {
  const record = { ...row, scope };
  const ctx = { cfg: { agentGuardEnabled: false }, db: { select: () => ({ from: () => ({ where: async () => [record] }) }) } } as unknown as Ctx;
  const app = new Hono();
  app.onError((error, c) => error instanceof ApiError ? c.json(error.toJSON(), error.status as 403) : c.json({ error: 'unexpected' }, 500));
  app.use('*', inferenceScopeMiddleware(ctx));
  app.get('/api/v1/activity', async c => {
    const key = await requireKey(ctx, c.req.header('authorization'));
    return c.json({ account: key.accountId, whole: key.management });
  });
  app.post('/api/v1/keys', c => c.text('changed'));
  app.get('/api/v1/data/stock/AAPL', c => c.text('charged'));
  app.get('/api/v1/new-account-route', c => c.text('new data'));
  return app;
}

test('stored read key permits account reads, denies writes, paid GETs and future routes through the shared middleware', async () => {
  const app = boundary();
  const auth = { authorization: `Bearer ${secret}` };
  const allowed = await app.request('/api/v1/activity', { headers: auth });
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ account: 'sample-account', whole: true });
  for (const [method, path] of [['POST', '/api/v1/keys'], ['GET', '/api/v1/data/stock/AAPL'], ['GET', '/api/v1/new-account-route'], ['DELETE', '/unknown']]) {
    for (const headers of [auth, { 'x-api-key': secret }]) {
      const r = await app.request(path!, { method, headers });
      expect(r.status).toBe(403); expect((await r.json()).error.type).toBe('read_only_key');
    }
  }
});
test('account scope remains unchanged and owner visibility is never persisted', async () => {
  expect((await boundary().request('/api/v1/activity')).status).toBe(401);
  expect((await boundary(null).request('/api/v1/keys', { method: 'POST', headers: { authorization: `Bearer ${secret}` } })).status).toBe(200);
  expect(row.management).toBe(false);
  expect(readPrincipal(row).management).toBe(true);
  expect(readKeyFields(readPrincipal(row))).toEqual({ management: false });
  const normal = { ...row, scope: null };
  expect(readPrincipal(normal)).toBe(normal);
  expect(readKeyFields(normal)).toEqual({});
});
test('explicit path matching rejects malformed identifiers, subpaths and all non-GET methods', () => {
  expect(readRouteAllowed('GET', `/api/v1/keys/${row.keyHash}`)).toBe(true);
  for (const path of ['/api/v1/keys/cleanup', '/api/v1/keys/short', '/api/v1/activity/extra', '/api/v1/agents/approvals/sample', '/api/v1/credits/withdrawal-proof']) expect(readRouteAllowed('GET', path), path).toBe(false);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) expect(() => assertReadRoute('read', method, '/api/v1/activity')).toThrow(ApiError);
  expect(() => assertReadRoute('inference', 'POST', '/api/v1/chat/completions')).not.toThrow();
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { MODEL_POST_PATHS, acceptsHtml, firstCallRoutes } from "../src/developers/first-call.ts";
import { loadConfig } from "../src/config.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";

for (const path of MODEL_POST_PATHS) {
  test(`${path}: HTML guidance, JSON 405, and POST pass-through`, async () => {
    const app = new Hono(); firstCallRoutes(app, true, "https://router.example");
    app.post(path, c => c.json({ original: true }, 201));
    const html = await app.request(path + '?input=caller-sentinel', { headers: { accept: 'text/html,application/xhtml+xml', authorization: 'Bearer credential-sentinel' } });
    expect(html.status).toBe(200); expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('vary')).toBe('Accept'); expect(html.headers.get('allow')).toBe('POST');
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
    const body = await html.text();
    expect(body).toContain('This address is for code: send a POST request');
    expect(body).toContain(path); expect(body).toContain('/docs/#quickstart'); expect(body).toContain('/dashboard/');
    expect(body).toContain('JavaScript fetch'); expect(body).toContain('Python');
    expect(body).not.toContain('caller-sentinel'); expect(body).not.toContain('credential-sentinel'); expect(body).not.toContain('<script');
    for (const accept of ['', '*/*', 'application/json', 'text/html;q=0']) {
      const json = await app.request(path, { headers: { accept } });
      expect(json.status).toBe(405); expect(json.headers.get('allow')).toBe('POST');
      expect((await json.json()).error.type).toBe('method_not_allowed');
    }
    expect((await app.request(path, { method: 'POST' })).status).toBe(201);
    const head = await app.request(path, { method: 'HEAD', headers: { accept: 'text/html' } });
    expect(head.status).toBe(404); expect(head.headers.get('allow')).toBeNull();
    expect((await app.request(path, { method: 'PUT' })).status).toBe(404);
    const disabled = new Hono(); firstCallRoutes(disabled, false, 'https://router.example');
    expect((await disabled.request(path)).status).toBe(404);
  });
}

test('HTML acceptance is explicit and respects a disabled quality value', () => {
  for (const value of ['TEXT/HTML; charset=utf-8', 'application/json, text/html;q=0.8']) expect(acceptsHtml(value)).toBe(true);
  for (const value of ['*/*', 'text/*', 'text/html;q=0', 'text/html;q=bad', 'text/html;q=2']) expect(acceptsHtml(value)).toBe(false);
});

test('opt-in passes the real production config guards without weakening them', () => {
  const address = '0x' + '1'.repeat(40);
  const env = {
    NODE_ENV: 'production', ANYROUTE_ENV: 'production', RUNTIME_ROLE: 'api', AUTO_MIGRATE: false, HOST: '0.0.0.0',
    APP_SECRET: 'fixture-'.repeat(6), ADMIN_TOKEN: 'fixture-admin-'.repeat(3), PUBLIC_BASE_URL: 'https://router.example',
    DATABASE_URL: 'postgres://fixture:fixture-only-credential@localhost/test', REDIS_URL: 'redis://:fixture-only-credential@localhost:6379',
    CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address,
    ROUTER_PRIVATE_KEY: '0x' + '3'.repeat(64),
  };
  expect(loadConfig({ ...env, DEVELOPER_FIRST_CALL_ENABLED: undefined }).developerFirstCallEnabled).toBe(false);
  expect(loadConfig({ ...env, DEVELOPER_FIRST_CALL_ENABLED: true }).developerFirstCallEnabled).toBe(true);
  expect(() => loadConfig({ ...env, DEVELOPER_FIRST_CALL_ENABLED: true, REDIS_URL: '' })).toThrow();
});

let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { DEVELOPER_FIRST_CALL_ENABLED: true } }); });
afterAll(async () => { await h?.close(); });
test('real router returns guidance without auth and preserves a billed POST and receipt', async () => {
  for (const path of MODEL_POST_PATHS) {
    expect((await h.request(path, { headers: { accept: 'text/html' } })).status).toBe(200);
    const json = await h.request(path); expect(json.status).toBe(405); expect(json.headers.get('allow')).toBe('POST');
    expect((await h.request(path, { method: 'HEAD' })).status).toBe(404);
  }
  const html = await h.request('/v1/chat/completions', { headers: { accept: 'text/html' } });
  expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
  for (const path of ['/api/v1/chat/completions/unknown', '/v1/messages', '/api/v1/unknown']) expect((await h.request(path)).status).toBe(404);
  const key = await h.fundedKey();
  const response = await h.request('/api/v1/chat/completions', { method: 'POST', headers: key.auth, json: { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'First call' }], max_tokens: 32 } });
  expect(response.status).toBe(200); expect(response.headers.get('x-receipt-id')).toBeTruthy();
  await response.text();
  expect((await (await h.request('/api/v1/generations?limit=1', { headers: key.auth })).json()).data).toHaveLength(1);
});

// J183: browser-generated tags exercise the existing auth and project-budget path.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { startRouter, MODELS, type Harness } from './helpers.ts';
import { generations } from '../src/db/schema.ts';
import { effectiveProject, projectStream } from '../web/lib/chat-projects.js';
let h: Harness;
beforeAll(async () => { h = await startRouter(); }, 60_000);
afterAll(async () => { await h?.close(); });
const body = { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'Explain gravity' }], max_tokens: 16 };
test('J183: tagged Chat requires existing auth and stores chat overrides and folder defaults', async () => {
  const key = await h.fundedKey();
  const call = (auth: Record<string, string>, chat = {}, folder = null) => projectStream((options: any) => h.request('/api/v1/chat/completions', { method: 'POST', headers: { ...auth, ...options.headers }, json: options.body }), () => effectiveProject(chat, folder))({ body });
  expect((await call({ authorization: 'Bearer invalid-key' }, { project: 'research' })).status).toBe(401);
  for (const [chat, folder, project] of [[{ project: 'RESEARCH' }, { project: 'team' }, 'research'], [{}, { project: 'TEAM' }, 'team'], [{}, null, null]] as const) {
    const response = await call(key.auth, chat, folder); expect(response.status).toBe(200); await response.text();
    const [stored] = await h.ctx.db.select().from(generations).where(eq(generations.id, response.headers.get('x-receipt-id')!));
    expect(stored.project).toBe(project);
  }
});
test('J183: a tagged Chat refusal retains the existing project budget message', async () => {
  const key = await h.fundedKey();
  expect((await h.request('/api/v1/projects/research/budget', { method: 'PUT', headers: key.auth, json: { budget_usd: 0 } })).status).toBe(200);
  const response = await projectStream((options: any) => h.request('/api/v1/chat/completions', { method: 'POST', headers: { ...key.auth, ...options.headers }, json: options.body }), () => 'research')({ body });
  expect(response.status).toBe(402);
  const result = await response.json();
  expect(result.error.type).toBe('project_budget_exceeded');
  expect(result.error.message).toContain("Project 'research' has used $0 of its $0 budget this month");
  expect(await h.ctx.db.select().from(generations).where(eq(generations.keyHash, key.hash))).toHaveLength(0);
});

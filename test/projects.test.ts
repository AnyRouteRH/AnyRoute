import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { keys, generations, ledger } from "../src/db/schema.ts";
import { captureProject, projectFields, projectInput, projectJson, assertProjectLane } from "../src/projects/tags.ts";
import { activityFingerprint, activityQuery } from "../src/activity/query.ts";
import { insightsQuery } from "../src/insights/query.ts";
import { Context } from "hono";
import { keyJson } from "../src/api/keys.ts";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { SPEND_INSIGHTS_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });
const callBody = { model: MODELS.llama.slug, messages: [{ role: "user", content: "Project request" }], max_tokens: 16 };
const range = 'from=2026-09-28T00:00:00Z&to=2026-09-29T00:00:00Z';
const at = new Date('2026-09-28T12:00:00Z');
type Key = { hash: string; auth: Record<string, string> };
async function call(key: Key, project?: string, stream = false) {
  const response = await h.request('/api/v1/chat/completions', { method: 'POST', headers: { ...key.auth, ...(project === undefined ? {} : { 'X-Anyroute-Project': project }) }, json: { ...callBody, stream } });
  await response.text(); return response;
}
async function patch(owner: Key, target: Key, project: unknown) {
  return h.request('/api/v1/keys/' + target.hash, { method: 'PATCH', headers: owner.auth, json: { project } });
}
async function child(owner: Key) {
  const r = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Project worker' } });
  const j = await r.json(); return { hash: j.data.hash, auth: { authorization: 'Bearer ' + j.key } };
}
async function seed(key: Key, id: string, project: string | null, cost = 1000000000000n) {
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  await h.ctx.db.insert(generations).values({ id, keyHash: key.hash, accountId: k.accountId, modelId: MODELS.llama.slug, providerId: 'alpha', mode: 'prepaid', cost, project, ts: at });
  return k;
}
test('project names fold ASCII case and strictly bound length and characters', () => {
  expect(projectInput.parse('Research.v2_01-x')).toBe('research.v2_01-x');
  expect(projectInput.parse('A'.repeat(48))).toHaveLength(48);
  for (const value of ['', 'x'.repeat(49), 'a b', 'a/b', 'café', 'a\nb', {}, 12]) expect(() => projectInput.parse(value)).toThrow();
  expect(activityQuery({ project: 'TEAM' }).project).toBe('team');
  expect(insightsQuery({ project: 'TEAM' }).project).toBe('team');
  expect(() => activityQuery({ project: '' })).toThrow();
  expect(() => insightsQuery({ project: 'a b' })).toThrow();
});
test('absent labels contribute no bytes to existing object serialization or cursor fingerprints', () => {
  const c = new Context(new Request('https://router.example/api/v1/chat/completions'));
  captureProject(c, null);
  expect(JSON.stringify({ answer: 'same', ...projectFields(c) })).toBe('{"answer":"same"}');
  expect(projectJson({ project: null })).toEqual({});
  const scope = { account: 'sample-account' }, q = activityQuery({});
  const { project, ...legacy } = q;
  expect(activityFingerprint(q, scope)).toBe(activityFingerprint(legacy, scope));
});
test('key default uses the existing PATCH authorization and nullable clearing', async () => {
  const owner = await h.fundedKey(), worker = await child(owner), other = await h.fundedKey();
  expect((await h.request('/api/v1/keys/' + worker.hash, { method: 'PATCH', json: { project: 'research' } })).status).toBe(401);
  expect((await patch(other, worker, 'research')).status).toBe(404);
  expect((await patch(worker, worker, 'research')).status).toBe(403);
  expect((await patch(owner, worker, 'bad project')).status).toBe(400);
  const r = await patch(owner, worker, 'RESEARCH'); expect(r.status).toBe(200); expect((await r.json()).data.project).toBe('research');
  const cleared = await patch(owner, worker, null); expect(cleared.status).toBe(200); expect((await cleared.json()).data).not.toHaveProperty('project');
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, worker.hash));
  const { project, ...legacy } = k;
  expect(JSON.stringify(keyJson(k))).toBe(JSON.stringify(keyJson(legacy as typeof k)));
  expect((await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { project: 'research' } })).status).toBe(400);
});
test('header overrides a key default; labels remain outside signed receipts', async () => {
  const owner = await h.fundedKey(); expect((await patch(owner, owner, 'DEFAULT')).status).toBe(200);
  for (const [header, expected] of [[undefined, 'default'], ['RESEARCH', 'research']] as const) {
    const r = await call(owner, header); expect(r.status).toBe(200);
    const [g] = await h.ctx.db.select().from(generations).where(eq(generations.id, r.headers.get('x-receipt-id')!));
    expect(g.project).toBe(expected); expect(g.receipt).not.toHaveProperty('project'); expect(g.receiptV2).not.toHaveProperty('project');
  }
  const stream = await call(owner, 'STREAM', true); expect(stream.status).toBe(200);
  const rows = await h.ctx.db.select().from(generations).where(eq(generations.keyHash, owner.hash));
  expect(rows.some(g => g.project === 'stream')).toBe(true);
});
test('invalid inference headers return clear 400 errors before a call record is written', async () => {
  const owner = await h.fundedKey();
  for (const value of ['', 'bad project', 'a'.repeat(49), 'bad/path']) {
    const r = await h.request('/api/v1/chat/completions', { method: 'POST', headers: { ...owner.auth, 'X-Anyroute-Project': value }, json: callBody });
    expect(r.status).toBe(400); expect(JSON.stringify(await r.json())).toContain('Project must be');
  }
  const r = await h.request('/api/v1/embeddings', { method: 'POST', headers: { ...owner.auth, 'X-Anyroute-Project': 'bad project' }, json: { model: MODELS.embed.slug, input: 'Project input' } });
  expect(r.status).toBe(400);
  expect(await h.ctx.db.select().from(generations).where(eq(generations.keyHash, owner.hash))).toEqual([]);
});
test('untagged calls preserve reply and receipt shapes and leave the stored label empty', async () => {
  const owner = await h.fundedKey();
  const response = await h.request('/api/v1/chat/completions', { method: 'POST', headers: owner.auth, json: callBody });
  expect(response.status).toBe(200); const body = await response.json(); expect(body).not.toHaveProperty('project'); expect(body.receipt.payload).not.toHaveProperty('project');
  const [g] = await h.ctx.db.select().from(generations).where(eq(generations.id, response.headers.get('x-receipt-id')!)); expect(g.project).toBeNull();
  const feed = await (await h.request('/api/v1/activity?kind=call', { headers: owner.auth })).json(); expect(feed.data[0]).not.toHaveProperty('project');
  const insights = await (await h.request('/api/v1/insights', { headers: owner.auth })).json(); expect(insights).not.toHaveProperty('projects');
});
test('embeddings use default and overriding labels without changing receipts', async () => {
  const owner = await h.fundedKey(); await patch(owner, owner, 'embedding-default');
  for (const [header, project] of [[undefined, 'embedding-default'], ['EMBEDDING-HEADER', 'embedding-header']] as const) {
    const r = await h.request('/api/v1/embeddings', { method: 'POST', headers: { ...owner.auth, ...(header ? { 'X-Anyroute-Project': header } : {}) }, json: { model: MODELS.embed.slug, input: 'Project input' } });
    expect(r.status).toBe(200); await r.text();
    const [g] = await h.ctx.db.select().from(generations).where(eq(generations.id, r.headers.get('x-receipt-id')!)); expect(g.project).toBe(project); expect(g.receipt).not.toHaveProperty('project');
  }
});
test('Activity filters before pagination, binds cursors, exports labels and preserves key/account isolation', async () => {
  const owner = await h.fundedKey(), worker = await child(owner), other = await h.fundedKey();
  await seed(owner, 'projects-owner', 'research'); await seed(worker, 'projects-worker', 'research'); await seed(other, 'projects-other', 'research'); await seed(owner, 'projects-untagged', null); await seed(owner, 'projects-other-label', 'other');
  expect((await h.request('/api/v1/activity?project=research')).status).toBe(401);
  expect((await h.request('/api/v1/activity?project=bad%20label', { headers: owner.auth })).status).toBe(400);
  const path = '/api/v1/activity?' + range + '&project=RESEARCH';
  const page = await (await h.request(path, { headers: owner.auth })).json(); expect(page.data.map((r: any) => r.id).sort()).toEqual(['call:projects-owner', 'call:projects-worker']); expect(page.data.every((r: any) => r.project === 'research')).toBe(true);
  const scoped = await (await h.request(path, { headers: worker.auth })).json(); expect(scoped.data.map((r: any) => r.id)).toEqual(['call:projects-worker']);
  const first = await (await h.request(path + '&limit=1', { headers: owner.auth })).json();
  const second = await (await h.request(path + '&limit=1&cursor=' + first.next_cursor, { headers: owner.auth })).json(); expect(second.data).toHaveLength(1); expect(second.data[0].id).not.toBe(first.data[0].id);
  expect((await h.request(path.replace('RESEARCH', 'other') + '&cursor=' + first.next_cursor, { headers: owner.auth })).status).toBe(400);
  const csv = await (await h.request(path + '&format=csv', { headers: owner.auth })).text(); expect(csv.split('\r\n')[0]).toEndWith(',project'); expect(csv).toContain('research'); expect(csv).not.toContain('projects-untagged'); expect(csv).not.toContain('projects-other-label');
  expect((await (await h.request(path + '&kind=balance', { headers: owner.auth })).json()).data).toEqual([]);
});
test('Insights includes project breakdowns and filters generation-linked refunds with existing access', async () => {
  const owner = await h.fundedKey(), worker = await child(owner), other = await h.fundedKey();
  const k = await seed(owner, 'insight-project-owner', 'research'); await seed(worker, 'insight-project-worker', 'research', 2000000000000n); await seed(other, 'insight-project-other', 'research'); await seed(owner, 'insight-project-untagged', null); await seed(owner, 'insight-project-different', 'other');
  await h.ctx.db.insert(ledger).values([{ id: 'project-refund', accountId: k.accountId, keyHash: owner.hash, amount: 500000000000n, kind: 'refund', ref: 'project-refund', generationId: 'insight-project-owner', createdAt: at }, { id: 'project-unlinked-refund', accountId: k.accountId, keyHash: owner.hash, amount: 100000000000n, kind: 'refund', ref: 'project-unlinked-refund', createdAt: at }]);
  expect((await h.request('/api/v1/insights?project=research')).status).toBe(401);
  expect((await h.request('/api/v1/insights?project=bad%20label', { headers: owner.auth })).status).toBe(400);
  const path = '/api/v1/insights?' + range;
  const report = await (await h.request(path + '&project=RESEARCH', { headers: owner.auth })).json(); expect(report.totals).toMatchObject({ calls: '2', charged_usd: '3', refunded_usd: '0.5', cost_usd: '2.5' }); expect(report.projects.map((r: any) => r.id)).toEqual(['research']);
  const scoped = await (await h.request(path + '&project=research', { headers: worker.auth })).json(); expect(scoped.totals).toMatchObject({ calls: '1', cost_usd: '2', refunded_usd: '0' });
  const all = await (await h.request(path, { headers: owner.auth })).json(); expect(all.projects.map((r: any) => r.id).sort()).toEqual([null, 'other', 'research'].sort());
  const empty = await (await h.request(path + '&project=missing', { headers: owner.auth })).json(); expect(empty.totals.calls).toBe('0'); expect(empty.projects).toEqual([]);
});
test('Insights stays off by default, including requests using a project filter', async () => {
  const off = await startRouter();
  try { expect(off.ctx.cfg.spendInsightsEnabled).toBe(false); expect((await off.request('/api/v1/insights?project=research')).status).toBe(404); }
  finally { await off.close(); }
});
test('project tags retain the unlinkable lane separation between calls', () => {
  const c = new Context(new Request('https://router.example/api/v1/chat/completions', { headers: { 'X-Anyroute-Project': 'research' } }));
  captureProject(c, null); expect(() => assertProjectLane(c, 'unlinkable')).toThrow('unlinkable lane');
  expect(() => assertProjectLane(c, 'attested')).not.toThrow();
  const plain = new Context(new Request('https://router.example/api/v1/chat/completions'));
  captureProject(plain, null); expect(() => assertProjectLane(plain, 'unlinkable')).not.toThrow();
});
test('browser preflights allow project headers while untagged preflights stay unchanged', async () => {
  for (const path of ['/api/v1/chat/completions', '/v1/embeddings', '/ollama/api/chat']) {
    const plain = await h.request(path, { method: 'OPTIONS', headers: { origin: 'https://client.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    expect(plain.headers.get('access-control-allow-headers')).not.toContain('x-anyroute-project');
    const tagged = await h.request(path, { method: 'OPTIONS', headers: { origin: 'https://client.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,X-Anyroute-Project' } });
    expect(tagged.status).toBe(204); expect(tagged.headers.get('access-control-allow-headers')).toContain('x-anyroute-project');
  }
});
test('Responses, Messages, Ollama and text adapters forward the call label', async () => {
  const owner = await h.fundedKey();
  const calls = [
    ['/api/v1/responses', { model: MODELS.llama.slug, input: 'Project adapter call' }],
    ['/v1/messages', { model: MODELS.llama.slug, max_tokens: 16, messages: callBody.messages }],
    ['/ollama/api/chat', { model: MODELS.llama.slug, messages: callBody.messages, stream: false }],
    ['/api/v1/completions', { model: MODELS.llama.slug, prompt: 'Project adapter call', max_tokens: 16 }],
  ] as const;
  for (const [path, json] of calls) {
    const response = await h.request(path, { method: 'POST', headers: { ...owner.auth, 'X-Anyroute-Project': 'ADAPTERS' }, json });
    expect(response.status).toBe(200); await response.text();
    const [g] = await h.ctx.db.select().from(generations).where(eq(generations.id, response.headers.get('x-receipt-id')!));
    expect(g.project).toBe('adapters'); expect(g.receipt).not.toHaveProperty('project');
  }
});
test('RAG applies the project header to both retrieval and answer calls', async () => {
  const owner = await h.fundedKey(); await patch(owner, owner, 'rag-default');
  const r = await h.request('/api/v1/rag', { method: 'POST', headers: { ...owner.auth, 'X-Anyroute-Project': 'RAG-HEADER' }, json: { documents: ['A short project note.'], question: 'What is in the note?', model: MODELS.llama.slug, embedding_model: MODELS.embed.slug, provider: { lane: 'public' } } });
  expect(r.status).toBe(200); await r.text();
  const rows = await h.ctx.db.select().from(generations).where(eq(generations.keyHash, owner.hash));
  expect(rows).toHaveLength(2); expect(rows.every(g => g.project === 'rag-header')).toBe(true);
});

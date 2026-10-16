import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { generations, keys, ledger } from "../src/db/schema.ts";
import { activityQuery } from "../src/activity/query.ts";
import { spendActivityUrl, spendWebLinks } from "../src/telegram/spend-links.ts";

let h: Harness;
beforeAll(async () => { h = await startRouter(); });
afterAll(async () => { await h?.close(); });
const from = '2026-10-01T00:00:00.000Z', to = '2026-10-02T00:00:00.000Z';
type Key = { hash: string; auth: Record<string, string> };
async function child(owner: Key) {
  const r = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Charge agent' } });
  expect(r.status).toBe(201);
  const j = await r.json(); return { hash: j.data.hash, auth: { authorization: 'Bearer ' + j.key } };
}
async function account(key: Key) { return (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)))[0]!.accountId; }
async function call(key: Key, id: string, options: { project?: string; cost?: bigint; ts?: string } = {}) {
  await h.ctx.db.insert(generations).values({ id, accountId: await account(key), keyHash: key.hash, modelId: MODELS.llama.slug, providerId: 'alpha', mode: 'prepaid',
    project: options.project, cost: options.cost ?? 10n, ts: new Date(options.ts || from), receipt: { lane: 'public' } as any });
}
async function charge(key: Key, id: string, generationId: string | null, kind = 'usage', at = from, amount = -10n) {
  await h.ctx.db.insert(ledger).values({ id, ref: id, accountId: await account(key), keyHash: key.hash, generationId, kind, createdAt: new Date(at), amount });
}
const path = (extra: Record<string, string> = {}) => '/api/v1/activity?' + new URLSearchParams({ kind: 'call', from, to, ...extra });
async function feed(key: Key, extra: Record<string, string> = {}) {
  const r = await h.request(path(extra), { headers: key.auth }); expect(r.status).toBe(200); return r.json();
}

test('default call feed stays generation-based; combined URL filters narrow exactly and never expand key/account access', async () => {
  const owner = await h.fundedKey(), agent = await child(owner), foreign = await h.fundedKey();
  await call(agent, 'trace-selected', { project: 'research' });
  await call(agent, 'trace-other-project', { project: 'other' });
  await call(agent, 'trace-boundary', { project: 'research', ts: to });
  await call(owner, 'trace-owner', { project: 'research' }); await call(foreign, 'trace-foreign', { project: 'research' });
  const filters = { key: agent.hash, model: MODELS.llama.slug, project: 'research' };
  expect((await feed(owner, filters)).data.map((r: any) => r.id)).toEqual(['call:trace-selected']);
  expect((await feed(agent, { ...filters, key: owner.hash })).data).toEqual([]);
  expect((await feed(foreign, filters)).data).toEqual([]);
  expect((await h.request(path(filters))).status).toBe(401);
  const disabled = await child(owner); await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, disabled.hash));
  expect((await h.request(path(filters), { headers: disabled.auth })).status).toBe(401);
});

test('removed-key drill-down retains only account-stamped calls already visible to the owner', async () => {
  const owner = await h.fundedKey(), removed = await child(owner), other = await h.fundedKey();
  await call(removed, 'trace-removed-key');
  await h.ctx.db.delete(keys).where(eq(keys.keyHash, removed.hash));
  expect((await feed(owner, { key: removed.hash })).data.map((r: any) => r.id)).toEqual(['call:trace-removed-key']);
  expect((await feed(other, { key: removed.hash })).data).toEqual([]);
});

test('posted charge drill-down uses settlement dates, exact charge kinds and unchanged ordinary/session scoping', async () => {
  const owner = await h.fundedKey(), agent = await child(owner), foreign = await h.fundedKey();
  await call(agent, 'trace-delayed', { ts: '2026-09-30T12:00:00Z', project: 'research' });
  await charge(agent, 'trace-posted', 'trace-delayed'); await charge(agent, 'trace-tool', null, 'tool_call'); await charge(agent, 'trace-data', null, 'data_tool');
  await charge(agent, 'trace-refund', 'trace-delayed', 'refund', from, 5n); await charge(agent, 'trace-after', null, 'usage', to);
  await charge(foreign, 'trace-foreign-charge', null);
  expect((await feed(owner)).data).toEqual([]);
  const selected = { basis: 'charges', key: agent.hash };
  const page = await feed(owner, selected);
  expect(page.data.map((r: any) => r.id).sort()).toEqual(['charge:trace-data', 'charge:trace-posted', 'charge:trace-tool']);
  expect(page.data.every((r: any) => r.amount === '-0.00000000001')).toBe(true);
  expect((await feed(owner, { ...selected, model: MODELS.llama.slug, project: 'research' })).data.map((r: any) => r.id)).toEqual(['charge:trace-posted']);
  expect((await feed(owner, { ...selected, charge_kind: 'usage' })).data.map((r: any) => r.id)).toEqual(['charge:trace-posted']);
  expect((await feed(owner, { ...selected, charge_kind: 'rulebook' })).data).toHaveLength(2);
  expect((await feed(agent, { basis: 'charges', key: foreign.hash })).data).toEqual([]);
  const session = (await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await feed({ hash: session.key_hash, auth: { authorization: 'Bearer ' + session.key } }, selected)).data).toEqual([]);
});

test('missing metadata, paid-only and lane filters work without inventing receipt evidence', async () => {
  const owner = await h.fundedKey();
  await call(owner, 'trace-free', { cost: 0n }); await call(owner, 'trace-paid', { project: 'tagged' });
  expect((await feed(owner, { paid: 'true', lane: 'public' })).data.map((r: any) => r.id)).toEqual(['call:trace-paid']);
  expect((await feed(owner, { missing_project: 'true' })).data.map((r: any) => r.id)).toEqual(['call:trace-free']);
  await charge(owner, 'trace-missing', null, 'tool_call');
  const row = (await feed(owner, { basis: 'charges', missing_model: 'true', missing_project: 'true', lane: 'unknown' })).data[0];
  expect(row).toMatchObject({ id: 'charge:trace-missing', model: null, receipt_id: null, receipt_url: null, verify_url: null });
});

test('new filters bind cursors and apply to CSV, and reject invalid combinations', async () => {
  const key = await h.fundedKey();
  for (const suffix of ['a', 'b']) { await call(key, 'trace-page-' + suffix); await charge(key, 'trace-charge-' + suffix, 'trace-page-' + suffix); }
  const q = { basis: 'charges', limit: '1' }, page = await feed(key, q);
  expect(page.next_cursor).toBeTruthy();
  const bad = await h.request(path({ ...q, charge_kind: 'usage', cursor: page.next_cursor }), { headers: key.auth }); expect(bad.status).toBe(400);
  const csv = await h.request(path({ ...q, format: 'csv' }), { headers: key.auth });
  expect(csv.status).toBe(200); expect(await csv.text()).toContain(page.data[0].id);
  for (const extra of [{ basis: 'other' }, { paid: 'false' }, { charge_kind: 'other' }, { model: 'recorded', missing_model: 'true' }, { project: 'tagged', missing_project: 'true' }]) {
    expect(() => activityQuery(extra)).toThrow();
    expect((await h.request(path(extra), { headers: key.auth })).status).toBe(400);
  }
});

test('recorded signed calls keep the existing receipt checker and public receipt retrieval', async () => {
  const key = await h.fundedKey();
  const r = await h.request('/api/v1/chat/completions', { method: 'POST', headers: key.auth, json: { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'Charge evidence' }], max_tokens: 8 } });
  expect(r.status).toBe(200); await r.text();
  const page = await feed(key, { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' });
  expect(page.data[0].verify_url).toBe('/verify/?r=' + r.headers.get('x-receipt-id'));
  expect((await h.request(page.data[0].receipt_url)).status).toBe(200);
});

test('Telegram web links use the top agent hash and precise Monday settlement range without authentication in URLs', () => {
  const hash = 'a'.repeat(64), url = new URL(spendActivityUrl(hash, from, '2026-10-01T12:34:56.123Z'));
  expect(url.origin).toBe('https://anyroute.tech'); expect(url.hash).toBe('#activity');
  expect(url.searchParams.get('key')).toBe(hash); expect(url.searchParams.get('to')).toBe('2026-10-01T12:34:56.123001Z');
  expect(url.searchParams.get('basis')).toBe('charges'); expect(url.searchParams.get('from')).toBe(from);
  expect(spendWebLinks([{ name: 'Charge agent', activity_url: url.href }])).toContain('View on the web: https://anyroute.tech/');
  expect(spendWebLinks([])).toBe('');
});

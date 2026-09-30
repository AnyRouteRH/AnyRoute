import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { agentLedgerLinks } from "../src/agents/ledger-schema.ts";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { appendEvent } from "../src/agents/store.ts";
import { csvCell, ledgerQuery } from "../src/agents/ledger.ts";
import { generations } from "../src/db/schema.ts";
import { picoToUsd } from "../src/lib/money.ts";
import { verifyReceipt } from "../src/api/generation.ts";
import { pruneAgentLedgerLinks } from "../src/agents/ledger-context.ts";
import { loadConfig } from "../src/config.ts";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", ANYROUTE_FEATURE_COUNCIL: "true" }, providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.qwen, MODELS.embed], reply: prompt => prompt.includes("Valid winners") ? '{"winner":"A"}' : undefined }] }); });
afterAll(async () => { await h?.close(); });
type Key = { hash: string; auth: Record<string, string> };
const base = { version: 1, models: {}, caps: {}, on_breach: "deny" };
const path = (key: Key) => `/api/v1/agents/${key.hash}/ledger`;
const policy = (key: Key, spec: object = base, owner = key) => h.request(`/api/v1/agents/${key.hash}/policy`, { method: "PUT", headers: owner.auth, json: spec });
const call = (key: Pick<Key, 'auth'>, extra = {}) => h.request('/api/v1/chat/completions', { method: "POST", headers: key.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "ledger prompt sentinel" }], max_tokens: 32, ...extra } });
async function ledger(key: Key, suffix = '', caller = key) {
  const r = await h.request(path(key) + suffix, { headers: caller.auth }); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store"); return r.json();
}
test("concurrent requests match exact events and signed generations, totals never multiply", async () => {
  const key = await h.fundedKey(); await policy(key);
  const responses = await Promise.all([call(key), call(key), call(key, { stream: true })]);
  for (const r of responses) { expect(r.status).toBe(200); await r.text(); }
  const { data } = await ledger(key);
  expect(data.rows).toHaveLength(3);
  const gs = await h.ctx.db.select().from(generations).where(eq(generations.keyHash, key.hash));
  const es = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, key.hash));
  const decisions = es.filter(e => e.kind === 'decision');
  expect(data.rows.flatMap((r: any) => r.event_ids).sort()).toEqual(decisions.map(e => String(e.id)).sort());
  expect(data.rows.flatMap((r: any) => r.receipts.map((s: any) => s.generation_id)).sort()).toEqual(gs.map(g => g.id).sort());
  for (const row of data.rows) {
    const g = gs.find(g => g.id === row.receipts[0].generation_id)!;
    expect(row).toMatchObject({ model: g.modelId, tokens_in: g.tokensIn, tokens_out: g.tokensOut, cost_pico: g.cost.toString(), cost_usd: picoToUsd(g.cost), decision: 'allow', unlinked: false, receipt_id: g.receiptId, verify_url: `/verify/?r=${g.receiptId}` });
    expect(row.policy_sha256).toBe(decisions.find(e => String(e.id) === row.event_ids[0])!.policySha256);
    expect((await verifyReceipt(h.ctx, { payload: g.receipt, sig: g.receiptSig!, key_id: g.receiptKeyId! })).valid).toBe(true);
  }
  const total = data.totals_per_day[0];
  expect(total.requests).toBe(3); expect(total.cost_pico).toBe(gs.reduce((s, g) => s + g.cost, 0n).toString());
  expect(JSON.stringify(data)).not.toContain('ledger prompt sentinel');
});
test("denials cost zero and preserve the decision policy even after a rulebook edit", async () => {
  const key = await h.fundedKey(); const saved = await (await policy(key, { ...base, models: { allow: [] } })).json();
  expect((await call(key)).status).toBe(403); await policy(key);
  const { data } = await ledger(key); expect(data.rows).toHaveLength(1);
  expect(data.rows[0]).toMatchObject({ decision: 'deny', cost_usd: 0, cost_pico: '0', tokens_in: 0, tokens_out: 0, receipt_id: null, verify_url: null, policy_sha256: saved.data.sha256, receipts: [] });
});
test("an approval retry records the exact used id, not the pending request", async () => {
  const key = await h.fundedKey(); await policy(key, { ...base, approval: { above_usd: 0.000000001 } });
  const waiting = await call(key); expect(waiting.status).toBe(403); const id = (await waiting.json()).error.metadata.approval_id;
  expect((await h.request(`/api/v1/agents/approvals/${id}/approve`, { method: 'POST', headers: key.auth })).status).toBe(200);
  const r = await call({ auth: { ...key.auth, 'x-agent-approval': id } }); expect(r.status).toBe(200); await r.text();
  const { data } = await ledger(key); expect(data.rows).toHaveLength(2);
  const used = data.rows.find((r: any) => r.receipts.length); expect(used).toMatchObject({ decision: 'approval', approval_id: id });
  expect(data.rows.find((r: any) => !r.receipts.length)).toMatchObject({ decision: 'approval', approval_id: null, cost_usd: 0 });
});
test("session requests group parent and child decisions, and do not appear as parent requests", async () => {
  const owner = await h.fundedKey(); await policy(owner);
  const session = (await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  const key = { hash: session.key_hash, auth: { authorization: `Bearer ${session.key}` } }; await policy(key, { ...base, caps: { per_day_usd: 1 } }, owner);
  expect((await call(key)).status).toBe(200);
  const r = await h.request('/api/v1/agents/me/ledger', { headers: key.auth }); expect(r.status).toBe(200);
  const { data } = await r.json(); expect(data.rows).toHaveLength(1); expect(data.rows[0].event_ids).toHaveLength(2); expect(data.rows[0].policy_sha256s).toHaveLength(2);
  expect((await ledger(owner)).data.rows).toHaveLength(0);
  expect((await ledger(key, '', owner)).data.rows).toEqual(data.rows);
  expect((await h.request(path(owner), { headers: key.auth })).status).toBe(403);
});
test("cached calls and keys without rulebooks still have generation receipts", async () => {
  const key = await h.fundedKey(); await policy(key);
  for (let i = 0; i < 2; i++) expect((await call(key, { cache: { mode: 'exact' } })).status).toBe(200);
  const gs = await h.ctx.db.select().from(generations).where(eq(generations.keyHash, key.hash)); expect(gs.some(g => g.mode === 'cache')).toBe(true);
  const { data } = await ledger(key); expect(data.rows).toHaveLength(2); expect(data.rows.every((r: any) => r.receipts.length === 1 && !r.unlinked)).toBe(true);
  const bare = await h.fundedKey(); expect((await call(bare)).status).toBe(200);
  expect((await ledger(bare)).data.rows[0]).toMatchObject({ policy_sha256: null, policy_sha256s: [], event_ids: [], unlinked: false });
});
test("stable pagination handles identical times and full-range daily totals", async () => {
  const key = await h.fundedKey(); const ts = new Date('2026-09-29T12:00:00Z');
  await h.ctx.db.insert(generations).values(Array.from({ length: 105 }, (_, i) => ({ id: `page-${key.hash}-${i.toString().padStart(3,'0')}`, keyHash: key.hash, ts, modelId: '=model,"line\nnext', providerId: 'alpha', cost: BigInt(i), tokensIn: i, tokensOut: 1, mode: 'prepaid' })));
  const range = '?from=2026-09-29T00:00:00Z&to=2026-09-30T00:00:00Z';
  const first = await ledger(key, range); expect(first.data.rows).toHaveLength(100); expect(first.next_cursor).toBeString();
  const second = await ledger(key, range + '&cursor=' + first.next_cursor); expect(second.data.rows).toHaveLength(5); expect(second.next_cursor).toBeNull();
  expect(second.data.totals_per_day).toEqual(first.data.totals_per_day); expect(first.data.totals_per_day[0]).toMatchObject({ day: '2026-09-29', requests: 105, cost_pico: '5460', tokens_in: 5460, tokens_out: 105 });
  expect(new Set([...first.data.rows, ...second.data.rows].map((r: any) => r.id)).size).toBe(105);
  expect((await ledger(key, '?from=2026-09-30T00:00:00Z')).data.rows).toHaveLength(0);
  const csv = await h.request(path(key) + range + '&format=csv', { headers: key.auth }); expect(csv.status).toBe(200); expect(csv.headers.get('x-next-cursor')).toBe(first.next_cursor); expect(csv.headers.get('content-type')).toContain('text/csv');
  const text = await csv.text(); expect(text).toContain('"\'=model,""line\nnext"'); expect(text).not.toContain('page-' + key.hash + '-004');
});
test("CSV escapes quotes, commas, newlines and spreadsheet formulas", () => {
  expect(csvCell('a,"b\n')).toBe('"a,""b\n"'); expect(csvCell(null)).toBe('""');
  for (const start of ['=', '+', '-', '@']) expect(csvCell(start + '1')).toBe('"\'' + start + '1"');
  expect(csvCell(0)).toBe('"0"');
});
test("old events remain unlinked instead of acquiring a nearby generation", async () => {
  const key = await h.fundedKey(); await call(key);
  await appendEvent(h.ctx.db, { keyHash: key.hash, kind: 'decision', decision: 'deny', policySha256: 'a'.repeat(64), intent: { kind: 'inference', model: MODELS.llama.slug, lane: 'public' } });
  const { data } = await ledger(key); expect(data.rows).toHaveLength(2); const denied = data.rows.find((r: any) => r.decision === 'deny'); expect(denied).toMatchObject({ unlinked: true, receipts: [], cost_usd: 0 });
});
test("principal, account, team and self authorization; flag off returns 404", async () => {
  const owner = await h.fundedKey(), other = await h.fundedKey();
  expect((await h.request(path(owner))).status).toBe(401);
  expect((await h.request(path(owner), { headers: other.auth })).status).toBe(404);
  const team = (await (await h.request('/api/v1/teams', { method: 'POST', headers: owner.auth, json: { name: 'ledger-team' } })).json()).data;
  const member = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { team: team.id, role: 'member' } })).json();
  const auth = { authorization: `Bearer ${member.key}` };
  expect((await h.request(`/api/v1/agents/${member.data.hash}/ledger`, { headers: auth })).status).toBe(403);
  expect((await h.request('/api/v1/agents/me/ledger', { headers: auth })).status).toBe(200);
  const admin = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { team: team.id, role: 'admin' } })).json();
  expect((await h.request(`/api/v1/agents/${member.data.hash}/ledger`, { headers: { authorization: `Bearer ${admin.key}` } })).status).toBe(200);
  expect((await h.request(path(owner), { headers: { authorization: `Bearer ${admin.key}` } })).status).toBe(403);
  const off = await startRouter(); try { for (const url of [path(owner), '/api/v1/agents/me/ledger']) { const r = await off.request(url); expect(r.status).toBe(404); expect((await r.json()).error.type).toBe('not_found'); } expect((await off.ctx.db.select().from(agentLedgerLinks))).toHaveLength(0); } finally { await off.close(); }
});
test("invalid filters/cursors are rejected, retention expires only old correlations", async () => {
  const key = await h.fundedKey();
  for (const query of ['?from=no', '?from=2026-09-30T00:00:00Z&to=2026-09-29T00:00:00Z', '?cursor=abc', '?format=html']) expect((await h.request(path(key) + query, { headers: key.auth })).status).toBe(400);
  expect(() => ledgerQuery({ cursor: 'x'.repeat(513) })).toThrow();
  await h.ctx.db.insert(agentLedgerLinks).values([{ keyHash: key.hash, requestId: 'old', ts: new Date(0) }, { keyHash: key.hash, requestId: 'new' }]);
  await pruneAgentLedgerLinks(h.ctx.db); expect((await h.ctx.db.select().from(agentLedgerLinks).where(eq(agentLedgerLinks.keyHash, key.hash))).map(l => l.requestId)).toEqual(['new']);
});
test("the production config loader accepts the enabled ledger with existing guards intact", () => {
  const env = { NODE_ENV: 'production', ANYROUTE_ENV: 'production', AGENT_POLICY_ENABLED: 'true', PAYMENTS_MODE: 'escrow', ESCROW_ADDRESS: '0x00000000000000000000000000000000000c0001', ESCROW_TOKENS: JSON.stringify([{ symbol: 'USDG', address: '0x00000000000000000000000000000000000c0002', decimals: 6, feed: '0x00000000000000000000000000000000000c0003' }]), ESCROW_START_BLOCK: '1', APP_SECRET: 'fixture-only-ledger-secret-000000000000', ADMIN_TOKEN: 'fixture-only-ledger-admin-000000000000', PUBLIC_BASE_URL: 'https://router.invalid', DATABASE_URL: 'postgres://fixture:fixture-only-ci-password@database.invalid/postgres', REDIS_URL: 'redis://:fixture-only-ci-password@redis.invalid', RUNTIME_ROLE: 'api', AUTO_MIGRATE: 'false', HOST: '0.0.0.0' };
  const cfg = loadConfig(env);
  const worker = loadConfig({ ...env, RUNTIME_ROLE: 'worker', WORKER_JOBS: 'agent-ledger-retention' });
  expect(worker.agentPolicyEnabled).toBe(true);
  expect(cfg.production).toBe(true); expect(cfg.agentPolicyEnabled).toBe(true);
});

test("council requests aggregate multiple generations into one request with exact charges", async () => {
  const key = await h.fundedKey(); await policy(key);
  const r = await call(key, { model: 'anyroute/council', council: { models: [MODELS.llama.slug, MODELS.qwen.slug], judge: MODELS.llama.slug } });
  expect(r.status).toBe(200); await r.text();
  const { data } = await ledger(key); const gs = await h.ctx.db.select().from(generations).where(eq(generations.keyHash, key.hash));
  expect(gs.length).toBeGreaterThan(1); expect(data.rows).toHaveLength(1);
  expect(data.rows[0].receipts.map((r: any) => r.generation_id).sort()).toEqual(gs.map(g => g.id).sort());
  expect(data.rows[0].cost_pico).toBe(gs.reduce((s, g) => s + g.cost, 0n).toString());
  expect(data.rows[0].tokens_in).toBe(gs.reduce((s, g) => s + g.tokensIn, 0));
});
test("pagination retains submillisecond generation timestamps without skipping peers", async () => {
  const key = await h.fundedKey();
  await h.ctx.db.execute(sql`insert into generations (id, key_hash, ts, model_id, provider_id, mode)
    select 'micros-' || ${key.hash} || '-' || n, ${key.hash}, '2026-09-29T12:00:00Z'::timestamptz + n * interval '1 microsecond', 'model', 'alpha', 'prepaid' from generate_series(1, 105) n`);
  const first = await ledger(key); const second = await ledger(key, '?cursor=' + first.next_cursor);
  expect(first.data.rows.length + second.data.rows.length).toBe(105);
  expect(new Set([...first.data.rows, ...second.data.rows].map((r: any) => r.id)).size).toBe(105);
});

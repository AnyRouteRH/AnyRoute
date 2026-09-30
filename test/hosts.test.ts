import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { attestations, attestationEvents, hostAnchors, measurements, providers, settlements } from '../src/db/schema.ts';
import { hostWalletHash, earningsBand } from '../src/api/hosts.ts';
import { loadConfig } from '../src/config.ts';
import { MODELS, startRouter, type Harness } from './helpers.ts';

const id = 'phala-qwen05b-tdx';
const owner = privateKeyToAccount(('0x' + '41'.repeat(32)) as `0x${string}`);
const stranger = privateKeyToAccount(('0x' + '42'.repeat(32)) as `0x${string}`);
const payout = '0x' + '43'.repeat(20);
const hash = '0x' + 'a1'.repeat(32);
const path = `/api/v1/hosts/${id}`;
let nonce = 0;
async function auth(account = owner, target = id) {
  const ts = Math.floor(Date.now() / 1000) + ++nonce;
  const sig = await account.signMessage({ message: `anyroute:${ts}:${hostWalletHash(target)}` });
  return `${account.address}:${ts}:${sig}`;
}
const forbidden = new Set(['api_key', 'apiKey', 'api_key_enc', 'apiKeyEnc', 'base_url', 'baseUrl', 'attestation_url', 'attestationUrl', 'headers', 'contact', 'token', 'tokens', 'operator', 'payout_address', 'payoutAddress', 'payout_mode', 'payoutMode', 'usdg_owed', 'invoiced_usdg_units', 'unpaid_usdg_units', 'upstream', 'fee', 'bond_usdg', 'anyr_stake']);
function assertPublic(value: any) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) { expect(forbidden.has(key), key).toBe(false); assertPublic(child); }
}

describe('read-only public hosts', () => {
  let h: Harness;
  const get = async (headers?: Record<string, string>) => { const res = await h.request(path, { headers }); return { res, data: (await res.json() as any).data }; };
  beforeAll(async () => {
    h = await startRouter({ env: { HOST_DASHBOARD_ENABLED: 'true' }, providers: [
      { id, name: 'Phala Qwen 0.5B', models: [MODELS.qwen] },
      { id: 'unverified', name: 'Unverified', models: [MODELS.llama] },
      { id: 'development', name: 'Development', models: [MODELS.llama] },
    ] });
    await h.ctx.db.update(providers).set({ teeKind: 'tdx', attestationUrl: 'https://private-sidecar.invalid:9443/attest', attested: true, attestedAt: new Date(), attestationHash: hash, operator: owner.address.toUpperCase(), payoutAddress: payout, contact: 'private-contact', headers: { authorization: 'private-token' }, shadowUntil: new Date(Date.now() + 86_400_000) }).where(eq(providers.id, id));
    await h.ctx.db.insert(attestations).values({ providerId: id, ok: true, teeKind: 'tdx', reportHash: hash, detail: { verifiers: ['dcap'], contact: 'private-contact', base_url: 'https://private-sidecar.invalid:9443' } });
    await h.ctx.db.update(providers).set({ teeKind: 'dev', attested: true, attestedAt: new Date(), attestationHash: hash }).where(eq(providers.id, 'development'));
    await h.ctx.db.insert(attestationEvents).values({ providerId: id, kind: 'attestation', ok: true, teeKind: 'tdx', attestationHash: hash, detail: { contact: 'private-contact', token: 'private-token' } });
    await h.ctx.db.insert(measurements).values({ providerId: id, imageDigest: hash, composeHash: hash, modelDigest: hash, verifier: 'dcap', teeKind: 'tdx', quote: '0x1234', quoteProofHash: hash, attestedAt: new Date(), rekorError: 'private-token', rekorUuid: 'entry-id', rekorInclusionVerified: true, status: 'registered' });
    await h.ctx.db.insert(measurements).values({ providerId: id, imageDigest: '0x' + 'b1'.repeat(32), composeHash: hash, modelDigest: hash, verifier: 'dcap', teeKind: 'tdx', quote: '0x1234', quoteProofHash: hash, attestedAt: new Date(), rekorUuid: 'older-entry', rekorInclusionVerified: true, status: 'observed', supersededAt: new Date(Date.now() - 60_000) });
    for (const [status, txHash, toTs] of [['confirmed', hash, new Date(Date.now() - 60_000)], ['local', null, new Date()]] as const) await h.ctx.db.insert(hostAnchors).values({ providerId: id, root: hash, attestationRef: hash.slice(2), receiptKeyId: 'key-id', receiptPublicKey: 'a1'.repeat(32), fromTs: new Date(Date.now() - 3_600_000), toTs, count: 5, status, txHash });
    await h.ctx.db.insert(settlements).values([
      { providerId: id, period: '2026-09-29T12', tokens: 100n, requests: 1, upstream: 2_000_000_000_000n, fee: 0n, usdgOwed: 1_234_567n },
      { providerId: id, period: '2026-09-29T13', tokens: 100n, requests: 1, upstream: 2_000_000_000_000n, fee: 0n, usdgOwed: 2_345_678n, paidTx: hash },
    ]);
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => h.close());
  test('live host identifier has public facts, existing evidence, measurements and root counts', async () => {
    const { res, data } = await get(); expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(data.admission).toBeNull();
    expect(data).toMatchObject({ id, tee_kind: 'tdx', attested: true, status: 'live', probation: true, models: [MODELS.qwen.slug], earnings: { band: '$1–10' }, anchoring: { roots: 2, anchored_roots: 1, latest: { status: 'local', anchored: false, receipts: 5 } } });
    const evidence = (await (await h.request(`/api/v1/attestation/${id}`)).json() as any).data;
    expect(data.measurement).toEqual(evidence.measurement); expect(data.measurement_history).toEqual(evidence.measurement_history);
    expect(data.measurement.transparency_log.entry_url).toContain('entry-id');
    expect(data.measurement_history[0].transparency_log.entry_url).toContain('older-entry');
    expect(data.attestation_history.data).toHaveLength(1); expect(data.proof_time.host.provider).toBe(id);
    expect(data.uptime).toMatchObject({ success_pct_30d: null, observations_30d: 0 });
  });
  test('list includes hardware hosts only and exposes only its allowlisted shape', async () => {
    const res = await h.request('/api/v1/hosts'); const data = (await res.json() as any).data;
    expect(data.map((p: any) => p.id)).toEqual([id]);
    expect(Object.keys(data[0]).sort()).toEqual(['admission', 'id', 'name', 'tee_kind', 'attested', 'status', 'probation', 'shadow_until', 'models', 'attestation', 'verify_url'].sort()); assertPublic(data);
    expect((await h.request('/api/v1/hosts/unverified')).status).toBe(404);
    expect((await h.request('/api/v1/hosts/development')).status).toBe(404);
  });
  test('explicit recursive denylist and secret sentinels never leak in public views', async () => {
    const { data } = await get(); assertPublic(data);
    for (const sentinel of ['private-sidecar', 'private-contact', 'private-token', payout, owner.address, '3580245', '1234567', `upstream-key-${id}`]) expect(JSON.stringify(data)).not.toContain(sentinel);
  });
  test('only the signed operator sees exact invoice totals and payout settings', async () => {
    const header = await auth(); const { res, data } = await get({ 'X-Wallet-Auth': header });
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('vary')).toContain('X-Wallet-Auth');
    expect(data.operator).toEqual({ payout_address: payout, payout_mode: 'invoice', invoiced_usdg_units: '3580245', unpaid_usdg_units: '1234567', decimals: 6 });
    expect((await get()).data.operator).toBeUndefined();
    expect((await get({ 'X-Wallet-Auth': header })).res.status).toBe(401);
    expect((await get({ 'X-Wallet-Auth': await auth(stranger) })).res.status).toBe(403);
    expect((await get({ 'X-Wallet-Auth': await auth(owner, 'other-host') })).res.status).toBe(401);
    expect((await get({ 'X-Wallet-Auth': 'invalid' })).res.status).toBe(401);
  });
  test('stale evidence stays inspectable without a hardware verified claim', async () => {
    await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 10) }).where(eq(providers.id, id));
    const { data } = await get(); expect(data.attested).toBe(false); expect(data.attestation.status).toBe('unverified'); expect(data.measurement).not.toBeNull();
  });
  test('disabled history remains unavailable rather than an empty success record', async () => {
    const cfg = h.ctx.cfg.attestation; const days = cfg.historyDays; cfg.historyDays = 0;
    try { const { data } = await get(); expect(data.proof_time).toBeNull(); expect(data.attestation_history).toBeNull(); } finally { cfg.historyDays = days; }
  });
});

test('dashboard defaults off and endpoints are absent until enabled', async () => {
  expect(loadConfig({ HOST_DASHBOARD_ENABLED: 'false' }).hostDashboard.enabled).toBe(false);
  const h = await startRouter(); try { expect(h.ctx.cfg.hostDashboard.enabled).toBe(false); expect((await h.request('/api/v1/hosts')).status).toBe(404); expect((await h.request(path)).status).toBe(404); } finally { await h.close(); }
});
test('bands use integer invoice units at their boundaries', () => {
  expect([0n, 1n, 999_999n, 1_000_000n, 9_999_999n, 10_000_000n, 100_000_000n, 1_000_000_000n].map(earningsBand)).toEqual(['none yet', '<$1', '<$1', '$1–10', '$1–10', '$10–100', '$100–1,000', '$1,000+']);
});
test('real config loader starts with the dashboard enabled in production', () => {
  const address = '0x' + '1'.repeat(40);
  const cfg = loadConfig({ NODE_ENV: 'production', ANYROUTE_ENV: 'production', HOST_DASHBOARD_ENABLED: 'true', RUNTIME_ROLE: 'api', AUTO_MIGRATE: 'false', HOST: '0.0.0.0', APP_SECRET: 'fixture-'.repeat(6), ADMIN_TOKEN: 'fixture-admin-'.repeat(3), PUBLIC_BASE_URL: 'https://router.example', DATABASE_URL: 'postgres://fixture:fixture-only-credential@localhost/check', REDIS_URL: 'redis://:fixture-only-credential@localhost:6379', CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: '0x' + '3'.repeat(64) });
  expect(cfg.production).toBe(true); expect(cfg.hostDashboard.enabled).toBe(true);
});

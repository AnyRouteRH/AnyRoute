// B122: check actual route packs with the browser verifier, preserving the existing access and off-state rules.
import { expect, test } from 'bun:test';
import { startRouter, MODELS } from './helpers.ts';
import { eq } from 'drizzle-orm';
import { keys } from '../src/db/schema.ts';
import { verifyProofPack as browserVerify } from '../web/lib/proof-pack-verify.js';
import { verifyProofPack as scriptVerify } from '../scripts/verify-proof-pack.mjs';

const range = () => { const day = new Date().toISOString().slice(0, 10); return `from=${day}&to=${day}`; };

test('browser checks a route proof pack with the published keys, including both receipt encodings', async () => {
  const h = await startRouter({ env: { STATEMENTS_ENABLED: 'true' }, providers: [{ id: 'sample-provider', name: 'Sample provider', models: [MODELS.llama] }] });
  try {
    const owner = await h.fundedKey();
    const call = await h.request('/api/v1/chat/completions', { method: 'POST', headers: owner.auth, json: { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'Hello' }] } });
    expect(call.status).toBe(200);
    await call.text();
    const response = await h.request(`/api/v1/proof-pack?${range()}`, { headers: owner.auth });
    expect(response.status).toBe(200);
    const pack = (await response.json()).data;
    const keysResponse = await h.request('/.well-known/anyroute-receipt-keys.json');
    expect(keysResponse.status).toBe(200);
    const result = await browserVerify(pack, { keys: await keysResponse.json() });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.signedByAnyroute).toBe(true);
    expect(result.summary).toEqual(scriptVerify(pack).summary);
    expect(result.summary).toMatchObject({ calls: 1, v1_valid: 1, v2_valid: 1, statements_valid: 1 });
    expect((await h.request(`/api/v1/proof-pack?${range()}`)).status).toBe(401);
    const inference = await h.fundedKey();
    await h.ctx.db.update(keys).set({ scope: 'inference', management: false }).where(eq(keys.keyHash, inference.hash));
    expect((await h.request(`/api/v1/proof-pack?${range()}`, { headers: inference.auth })).status).toBe(403);
  } finally { await h.close(); }
});

test('proof pack download stays off by default while published keys remain public', async () => {
  const h = await startRouter();
  try {
    expect(h.ctx.cfg.statementsEnabled).toBe(false);
    const owner = await h.fundedKey();
    expect((await h.request(`/api/v1/proof-pack?${range()}`, { headers: owner.auth })).status).toBe(404);
    expect((await h.request('/.well-known/anyroute-receipt-keys.json')).status).toBe(200);
  } finally { await h.close(); }
});

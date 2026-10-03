import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kv } from "../src/db/schema.ts";
import { postAgreementRuling, type RulingTransport } from "../src/agreements/posting.ts";
import { JURY_HEARTBEAT_KEY, JURY_HEARTBEAT_MAX_AGE_MS, agreementsStatus, recordJuryHeartbeat } from "../src/agreements/status.ts";
import { startRouter, type Harness } from "./helpers.ts";

const address = (n: number) => `0x${n.toString(16).repeat(40)}` as Hex;
const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const escrow = address(4), oracle = address(5);
const env = { AGENT_AGREEMENTS_ENABLED: "true", AGREEMENT_ESCROW_ADDRESS: escrow, DISPUTE_ORACLE_ADDRESS: oracle, AGREEMENT_START_BLOCK: "77319694", TLOG_ENABLED: "true" };
const signerKeys = [key(3), key(4), key(5)];

describe("GET /api/v1/status agreements", () => {
  let h: Harness;
  const status = async () => (await (await h.request("/api/v1/status")).json()).data.agreements;
  beforeAll(async () => { h = await startRouter({ env }); });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.ctx.db.delete(kv).where(eq(kv.key, JURY_HEARTBEAT_KEY));
    Object.assign(h.ctx.cfg.agreements, { rulings: false, signerKeys: undefined });
  });

  test("reports the contracts this router indexes, with rulings off until a jury worker reports in", async () => {
    expect(await status()).toEqual({
      enabled: true, escrow, oracle, start_block: "77319694", finality: "finalized",
      rulings: { enabled: false, source: "jury-worker-heartbeat", last_seen: null, max_age_ms: JURY_HEARTBEAT_MAX_AGE_MS, threshold: null, jury_size: null },
    });
  });

  test("a fresh heartbeat from the signing worker turns rulings on; a stale one does not", async () => {
    Object.assign(h.ctx.cfg.agreements, { rulings: true, signerKeys });
    const now = new Date();
    await recordJuryHeartbeat(h.ctx, now);
    const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, JURY_HEARTBEAT_KEY));
    expect(row.value).toEqual({ escrow, oracle, threshold: 2, signers: signerKeys.map((k) => privateKeyToAccount(k).address.toLowerCase()), at: now.toISOString() });
    expect((await status()).rulings).toEqual({ enabled: true, source: "jury-worker-heartbeat", last_seen: now.toISOString(), max_age_ms: JURY_HEARTBEAT_MAX_AGE_MS, threshold: 2, jury_size: 3 });

    const stale = new Date(Date.now() - JURY_HEARTBEAT_MAX_AGE_MS - 1_000);
    await recordJuryHeartbeat(h.ctx, stale);
    expect(await status()).toMatchObject({ enabled: true, rulings: { enabled: false, last_seen: stale.toISOString() } });
  });

  test("a heartbeat for other contracts, or from a worker without rulings, never counts", async () => {
    await h.ctx.db.insert(kv).values({ key: JURY_HEARTBEAT_KEY, value: { escrow, oracle: address(6), threshold: 2, signers: [], at: new Date().toISOString() } });
    expect((await status()).rulings).toMatchObject({ enabled: false, last_seen: null });
    await h.ctx.db.delete(kv).where(eq(kv.key, JURY_HEARTBEAT_KEY));
    Object.assign(h.ctx.cfg.agreements, { rulings: false, signerKeys });
    await recordJuryHeartbeat(h.ctx);
    expect(await h.ctx.db.select().from(kv).where(eq(kv.key, JURY_HEARTBEAT_KEY))).toEqual([]);
  });

  test("the posting pass writes the heartbeat only after the oracle signer check passes", async () => {
    Object.assign(h.ctx.cfg.agreements, { rulings: true, signerKeys });
    const refused = { guard: async () => { throw new Error("signer set differs from the oracle"); } } as unknown as RulingTransport;
    await expect(postAgreementRuling(h.ctx, refused)).rejects.toThrow("signer set differs");
    expect((await status()).rulings.enabled).toBe(false);
    const matched = { guard: async () => {}, prepare: async () => { throw new Error("nothing to sign"); }, broadcast: async () => "pending" } as unknown as RulingTransport;
    expect(await postAgreementRuling(h.ctx, matched)).toEqual({ skipped: "nothing canonical and ready" });
    expect((await status()).rulings).toMatchObject({ enabled: true, threshold: 2, jury_size: 3 });
  });

  test("a router without agreements says so", async () => {
    const off = await startRouter();
    try {
      expect((await (await off.request("/api/v1/status")).json()).data.agreements).toMatchObject({ enabled: false, escrow: null, oracle: null, rulings: { enabled: false } });
      expect(await agreementsStatus(off.ctx)).toMatchObject({ enabled: false, start_block: null, finality: null });
    } finally { await off.close(); }
  });
});

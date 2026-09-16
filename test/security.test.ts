// Regression tests for the findings of the adversarial review (each reproduced the bug before its fix).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { parseSignature, serializeSignature } from "viem";
import { MODELS, NVDA, fakeTx, startRouter, type Harness } from "./helpers.ts";
import { balanceOf, release, reserve, verifyInvariants } from "../src/ledger/ledger.ts";
import { keys, paywithDebts, providers, quotes } from "../src/db/schema.ts";
import { recordEvents, processEvents } from "../src/chain/indexer.ts";
import { computeSpentLeaves } from "../src/services/settlement.ts";
import { generateApiKey, deriveKey } from "../src/chain/keys.ts";
import { usdgToPico } from "../src/lib/money.ts";
import { worstCase } from "../src/router/pricing.ts";
import { runPaywithAggregator, clearFairCache } from "../src/pay/paywith.ts";
import { requestHash } from "../src/api/chat.ts";
import { sanitizeUpstream } from "../src/providers/upstream.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const TO = "0x0000000000000000000000000000000000000abc";
const accountOf = async (h: Harness, hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0].accountId;

describe("withdrawal accounting", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());

  test("H1: withdrawal events for an unregistered key are replayed in order when the key appears", async () => {
    const secret = generateApiKey();
    const d = deriveKey(secret);
    await recordEvents(h.ctx, [{ contract: "credits", event: "Deposited", args: { keyHash: d.chainKeyHash, from: TO, amount: 10_000_000n }, txHash: fakeTx(), logIndex: 0, blockNumber: 50n }]);
    await recordEvents(h.ctx, [{ contract: "credits", event: "WithdrawalRequested", args: { keyHash: d.chainKeyHash, to: TO, amount: 10_000_000n, requestedAt: 1n }, txHash: fakeTx(), logIndex: 0, blockNumber: 51n }]);
    await recordEvents(h.ctx, [{ contract: "credits", event: "Withdrawn", args: { keyHash: d.chainKeyHash, to: TO, amount: 10_000_000n }, txHash: fakeTx(), logIndex: 0, blockNumber: 52n }]);
    await processEvents(h.ctx);
    const credits = await (await h.request("/api/v1/credits", { headers: { authorization: `Bearer ${secret}` } })).json();
    expect(credits.data.available).toBe(0);
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${secret}` }, json: { model: LLAMA, max_tokens: 20, messages: [{ role: "user", content: "free money?" }] } });
    expect(r.status).toBe(402);
  });

  test("H2: an in-flight hold counts as spent in the root, so it can never be withdrawn on-chain", async () => {
    const k = await h.fundedKey(10n);
    const acct = await accountOf(h, k.hash);
    await reserve(h.ctx.db, { id: "inflight-big", accountId: acct, keyHash: k.hash, amount: usdgToPico(10_000_000n) });
    await recordEvents(h.ctx, [{ contract: "credits", event: "WithdrawalRequested", args: { keyHash: k.chainKeyHash, to: TO, amount: 10_000_000n, requestedAt: 1n }, txHash: fakeTx(), logIndex: 0, blockNumber: 60n }]);
    await processEvents(h.ctx);
    const { leaves } = await computeSpentLeaves(h.ctx);
    const spent = leaves.find(([x]) => x === k.chainKeyHash)![1];
    expect(spent).toBe(10_000_000n); // deposited 10 - spent 10 - withdrawn 0 = 0 withdrawable on-chain
    // The contract therefore pays 0; releasing the hold leaves a legitimate off-chain balance.
    await recordEvents(h.ctx, [{ contract: "credits", event: "Withdrawn", args: { keyHash: k.chainKeyHash, to: TO, amount: 0n }, txHash: fakeTx(), logIndex: 0, blockNumber: 61n }]);
    await processEvents(h.ctx);
    await release(h.ctx.db, "inflight-big");
    expect((await balanceOf(h.ctx.db, acct)).balance).toBe(usdgToPico(10_000_000n));
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("H3: a sub-key's withdrawal request cannot freeze the shared balance", async () => {
    const root = await h.fundedKey(10n);
    const sub = await (await h.request("/api/v1/keys", { method: "POST", headers: root.auth, json: { name: "contractor" } })).json();
    await recordEvents(h.ctx, [{ contract: "credits", event: "WithdrawalRequested", args: { keyHash: sub.data.chain_key_hash, to: TO, amount: 10n ** 15n, requestedAt: 1n }, txHash: fakeTx(), logIndex: 0, blockNumber: 70n }]);
    await processEvents(h.ctx);
    const c = await (await h.request("/api/v1/credits", { headers: root.auth })).json();
    expect(c.data.available).toBe(10);
  });
});

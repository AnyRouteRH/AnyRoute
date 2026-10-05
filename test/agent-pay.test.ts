import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { fakeTx, startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { agentActionDecisions } from "../src/agents/guard-schema.ts";
import { agentPayments } from "../src/agents/pay-schema.ts";
import { runAgentPayVerify } from "../src/agents/pay.ts";
import { inferenceRouteAllowed } from "../src/provisioning/scope.ts";

// Pay another agent: Agent Guard decides, the payer's own wallet sends USDG straight to the recipient, and the router
// only verifies that transfer on chain and signs a receipt. Anyroute never holds the money.
let h: Harness;
const env = { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true", AGENT_PAY_ENABLED: "true", AGENT_PROFILES_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true" };
type Auth = { auth: Record<string, string>; hash: string };
type Sent = { txHash: Hex; token: Hex; from: Hex; to: Hex; value: bigint; logIndex: number; blockNumber: bigint };
const sent: Sent[] = [];
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const RECIPIENT = "0xabababababababababababababababababababab" as Hex;
const OTHER = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" as Hex;
const units = (usd: number) => BigInt(Math.round(usd * 1e6));
let usdg: Hex, payerWallet: Hex, owner: Auth, agent: Auth, recipient: Auth, profileId: string;

const policy = (actions: Record<string, unknown>) => ({ version: 1, models: {}, caps: {}, on_breach: "deny", actions });
const putPolicy = (actions: Record<string, unknown>) => h.request(`/api/v1/agents/${agent.hash}/policy`, { method: "PUT", headers: owner.auth, json: policy(actions) });
const pay = async (body: Record<string, unknown>, k: Auth = agent) => { const r = await h.request("/api/v1/agents/pay", { method: "POST", headers: k.auth, json: body }); return { status: r.status, body: await r.json() }; };
const confirm = async (id: string, tx_hash: string, k: Auth = agent) => { const r = await h.request(`/api/v1/agents/pay/${id}/confirm`, { method: "POST", headers: k.auth, json: { tx_hash } }); return { status: r.status, body: await r.json() }; };
const read = async (id: string, k: Auth = agent) => (await (await h.request(`/api/v1/agents/pay/${id}`, { headers: k.auth })).json()).data;
const inbox = async (k: Auth) => (await (await h.request("/api/v1/inbox", { headers: k.auth })).json()).data.filter((i: { kind: string }) => i.kind === "payment");
/** A USDG (or other token) transfer mined three blocks below a new head. */
const send = (o: Partial<Sent> & { value: bigint }) => {
  h.chain.escrowHead += 10n;
  const t: Sent = { txHash: fakeTx(), token: usdg, from: payerWallet, to: RECIPIENT, logIndex: 0, blockNumber: h.chain.escrowHead - 3n, ...o };
  sent.push(t);
  return t;
};

beforeAll(async () => {
  h = await startRouter({ env });
  usdg = h.ctx.cfg.chain.usdg.toLowerCase() as Hex;
  h.chain.client.getChainId = (async () => h.ctx.cfg.chain.id) as never;
  // The real receipt reader returns only Transfer logs to the address it is asked about; the shared fake ignores it.
  h.chain.escrowReceipt = (async (txHash: Hex, to: Hex) => {
    const logs = sent.filter(l => l.txHash === txHash && l.blockNumber <= h.chain.escrowHead);
    if (!logs.length) return null;
    const reverted = h.chain.escrowReverted.has(txHash);
    return { success: !reverted, blockNumber: logs[0]!.blockNumber, blockHash: h.chain.escrowBlockHash(logs[0]!.blockNumber)!, transfers: reverted ? [] : logs.filter(l => l.to.toLowerCase() === to.toLowerCase()).map(l => ({ token: l.token, from: l.from, value: l.value, logIndex: l.logIndex })) };
  }) as never;
  // The payer signs in with a wallet: that creates the account the wallet is linked to.
  const account = privateKeyToAccount(generatePrivateKey());
  payerWallet = account.address.toLowerCase() as Hex;
  const challenge = (await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: account.address } })).json()).data;
  const signIn = await (await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: account.address, nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) } })).json();
  owner = { auth: { authorization: `Bearer ${signIn.key}` }, hash: signIn.data.hash };
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "payer agent", scope: "inference" } })).json();
  agent = { auth: { authorization: `Bearer ${child.key}` }, hash: child.data.hash };
  recipient = await h.fundedKey();
  profileId = (await (await h.request(`/api/v1/agents/${recipient.hash}/profile`, { method: "PUT", headers: recipient.auth, json: { name: "Recipient agent", description: "Sells reports", payout_wallet: RECIPIENT.toUpperCase().replace("0X", "0x") } })).json()).data.id;
});
afterAll(async () => { await h?.close(); });

test("off by default, needs Agent Guard, and while off the routes say so and status reports it", async () => {
  expect(loadConfig({ ANYROUTE_ENV: "test" }).agentPayEnabled).toBe(false);
  expect(() => loadConfig({ ANYROUTE_ENV: "test", AGENT_POLICY_ENABLED: "true", AGENT_PAY_ENABLED: "true" })).toThrow("requires AGENT_GUARD_ENABLED");
  expect((await (await h.request("/api/v1/status")).json()).data.agent_pay).toEqual({ enabled: true });
  const off = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true" } });
  try {
    const key = await off.fundedKey();
    for (const [method, path] of [["POST", "/api/v1/agents/pay"], ["POST", "/api/v1/agents/pay/id/confirm"], ["GET", "/api/v1/agents/pay/id"]] as const) {
      const r = await off.request(path, { method, headers: key.auth, ...(method === "POST" ? { json: {} } : {}) });
      expect(r.status).toBe(404);
      expect((await r.json()).error).toMatchObject({ type: "not_found", message: "Paying another agent is not switched on." });
    }
    expect((await (await off.request("/api/v1/status")).json()).data.agent_pay).toEqual({ enabled: false });
  } finally { await off.close(); }
  for (const [method, path] of [["POST", "/api/v1/agents/pay"], ["POST", "/api/v1/agents/pay/id/confirm"], ["GET", "/api/v1/agents/pay/id"]] as const) {
    expect(inferenceRouteAllowed(method, path)).toBe(true);
    expect(inferenceRouteAllowed(method, path, false)).toBe(false);
  }
  expect(inferenceRouteAllowed("POST", "/api/v1/agents/pay/id")).toBe(false);
  // A split worker can run the re-verification job on its own; it needs no signing key.
  const address = "0x" + "1".repeat(40);
  const production = { NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "worker", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true", AGENT_PAY_ENABLED: "true", WORKER_JOBS: "agent-pay-verify" };
  expect(loadConfig(production).workerJobs).toEqual(["agent-pay-verify"]);
});

test("the payer's rulebook decides pay.agent through Agent Guard, and only an allow returns instructions", async () => {
  const none = await pay({ to: profileId, amount_usd: "20" });
  expect(none.status).toBe(200); expect(none.body.data).toMatchObject({ decision: "deny", reasons: [{ code: "no_rulebook" }] }); expect(none.body.data.payment).toBeUndefined();
  expect((await putPolicy({ allow: ["pay.*"], targets: { deny: [OTHER] }, per_action_usd: 100, approval_above_usd: 50 })).status).toBe(200);
  const ok = (await pay({ to: profileId, amount_usd: "20", memo_sha256: "sha256:" + "c".repeat(64) })).body.data;
  expect(ok.decision).toBe("allow"); expect(ok.signed.payload.intent).toMatchObject({ kind: "action", action: "pay.agent", target: profileId, amount_pico: "20000000000000" });
  expect(ok.payment).toMatchObject({ decision_id: ok.decision_id, status: "awaiting_transfer", chain_id: h.ctx.cfg.chain.id, to: RECIPIENT, recipient: { wallet: RECIPIENT, profile_id: profileId }, amount: "20", amount_units: "20000000", token: { symbol: "USDG", address: usdg, decimals: 6 }, from: [payerWallet], reference: `pay-${ok.decision_id.slice(0, 8)}` });
  expect(ok.payment.transfer_call).toEqual({ to: usdg, value: "0x0", data: "0xa9059cbb" + RECIPIENT.slice(2).padStart(64, "0") + (20_000_000).toString(16).padStart(64, "0") });
  expect(ok.payment.custody).toContain("Anyroute never holds the money");
  const [row] = await h.ctx.db.select().from(agentPayments).where(eq(agentPayments.decisionId, ok.decision_id));
  expect(row).toMatchObject({ status: "awaiting_transfer", recipientWallet: RECIPIENT, recipientProfile: profileId, recipientKeyHash: recipient.hash, amountUnits: 20_000_000n, accountId: `w_${payerWallet.slice(2)}` });
  // Raw wallets work too, and a wallet published by exactly one profile is linked to that agent.
  expect((await pay({ to: RECIPIENT.toUpperCase().replace("0X", "0x"), amount_usd: "1.5" })).body.data.payment).toMatchObject({ to: RECIPIENT, recipient: { profile_id: profileId }, amount_units: "1500000" });
  // Every rule of the actions section applies: denied target, per-action limit, ask-first above an amount.
  expect((await pay({ to: OTHER, amount_usd: "1" })).body.data).toMatchObject({ decision: "deny", reasons: [{ code: "target_not_allowed" }] });
  expect((await pay({ to: profileId, amount_usd: "101" })).body.data.reasons.map((r: { code: string }) => r.code)).toContain("over_action_per_request");
  const asked = (await pay({ to: profileId, amount_usd: "60" })).body.data;
  expect(asked).toMatchObject({ decision: "approval_required", poll: `/api/v1/agents/approvals/${asked.approval_id}` }); expect(asked.payment).toBeUndefined();
  expect((await h.request(`/api/v1/agents/approvals/${asked.approval_id}/approve`, { method: "POST", headers: owner.auth })).status).toBe(200);
  expect((await pay({ to: profileId, amount_usd: "60", approval_id: asked.approval_id })).body.data).toMatchObject({ decision: "allow", payment: { amount_units: "60000000" } });
  // Bad requests never reach the rulebook.
  for (const body of [{ to: profileId, amount_usd: "0" }, { to: "someone", amount_usd: "1" }, { to: "0x" + "0".repeat(40), amount_usd: "1" }, { to: usdg, amount_usd: "1" }, { to: profileId, amount_usd: "1", extra: true }]) expect((await pay(body)).status).toBe(400);
  const bare = (await (await h.request(`/api/v1/agents/${recipient.hash}/profile`, { method: "PUT", headers: recipient.auth, json: { name: "Second", description: "" } })).json()).data.id;
  expect((await pay({ to: bare, amount_usd: "1" })).body.error.type).toBe("pay_no_payout_wallet");
  await h.request(`/api/v1/agents/${recipient.hash}/profile`, { method: "PUT", headers: recipient.auth, json: { name: "Recipient agent", description: "Sells reports", payout_wallet: RECIPIENT } });
});

test("confirming checks the USDG transfer on chain, credits the real amount and signs a receipt; finality and reversal follow the chain", async () => {
  await putPolicy({ allow: ["pay.agent"], per_day_usd: 500 });
  const d = (await pay({ to: profileId, amount_usd: "20" })).body.data;
  const code = async (tx: string) => { const r = await confirm(d.decision_id, tx); return [r.status, r.body.error?.type]; };
  // The router reads the chain it is configured for, or verifies nothing.
  h.chain.client.getChainId = (async () => 1) as never;
  const early = send({ value: units(20) });
  expect(await code(early.txHash)).toEqual([503, "pay_chain_unavailable"]);
  h.chain.client.getChainId = (async () => h.ctx.cfg.chain.id) as never;
  expect(await code(fakeTx())).toEqual([409, "pay_tx_not_found"]);
  expect(await code(send({ value: units(20), from: wallet(0xdead) }).txHash)).toEqual([403, "pay_wallet_not_linked"]);
  expect(await code(send({ value: units(19.99) }).txHash)).toEqual([422, "pay_amount_short"]);
  expect(await code(send({ value: units(20), token: wallet(0xbeef) }).txHash)).toEqual([422, "pay_transfer_not_found"]);
  expect(await code(send({ value: units(20), to: OTHER }).txHash)).toEqual([422, "pay_transfer_not_found"]);
  const reverted = send({ value: units(20) }); h.chain.escrowReverted.add(reverted.txHash);
  expect(await code(reverted.txHash)).toEqual([422, "pay_tx_failed"]);
  const other = await pay({ to: profileId, amount_usd: "20" }, owner); // a different key of the account cannot confirm this one
  expect(other.body.data.decision).toBe("deny");
  expect((await confirm(d.decision_id, early.txHash, owner)).status).toBe(403);
  expect((await confirm(d.decision_id, early.txHash, recipient)).status).toBe(404);

  // Seen above the finality point; the paid amount (25, more than the 20 allowed) is what the daily limit counts.
  h.chain.escrowFinalLag = 5n;
  const t = send({ value: units(25), logIndex: 3 });
  const seen = await confirm(d.decision_id, t.txHash.toUpperCase().replace("0X", "0x"));
  expect(seen.status).toBe(200);
  expect(seen.body.data).toMatchObject({ status: "seen", status_text: "Seen, waiting for finality", tx_hash: t.txHash, paid: "25", payer_wallet: payerWallet, block_number: t.blockNumber.toString() });
  const receipt = seen.body.data.receipt;
  expect(receipt.payload).toMatchObject({ type: "anyroute.agent.payment.v1", status: "seen", decision_id: d.decision_id, policy_sha256: d.policy_sha256, payer: { key_hash: agent.hash, wallet: payerWallet }, recipient: { wallet: RECIPIENT, profile_id: profileId }, amount: { allowed_units: "20000000", paid_units: "25000000" }, tx_hash: t.txHash, log_index: 3, chain_id: h.ctx.cfg.chain.id });
  const verified = (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id } })).json()).data;
  expect(verified).toMatchObject({ signature_valid: true, valid: true });
  const [decision] = await h.ctx.db.select().from(agentActionDecisions).where(eq(agentActionDecisions.id, d.decision_id));
  expect(decision).toMatchObject({ outcomeStatus: "executed", outcomeAmountPico: 25_000_000_000_000n });
  // Idempotent with the same transaction; refused with another, or for a transfer that already paid another decision.
  expect((await confirm(d.decision_id, t.txHash)).body.data.status).toBe("seen");
  expect(await code(early.txHash)).toEqual([409, "pay_already_confirmed"]);
  const d2 = (await pay({ to: profileId, amount_usd: "20" })).body.data;
  const reuse = await confirm(d2.decision_id, t.txHash);
  expect([reuse.status, reuse.body.error.type]).toEqual([409, "pay_transfer_used"]);
  // The payer and the recipient agent's owner each get an inbox item.
  expect((await inbox(owner)).map((i: { id: string; status: string; amount: string }) => [i.id, i.status, i.amount])).toEqual([[`payment:sent:${d.decision_id}`, "seen", "25"]]);
  expect((await inbox(recipient)).map((i: { id: string; title: string }) => [i.id, i.title])).toEqual([[`payment:received:${d.decision_id}`, "Payment received, waiting for finality"]]);

  // Final once the chain's finality point passes the block; the receipt is signed again with that status.
  h.chain.escrowFinalLag = 0n; h.chain.escrowHead += 10n;
  const final = await read(d.decision_id);
  expect(final).toMatchObject({ status: "final", receipt: { payload: { status: "final", tx_hash: t.txHash } } });
  expect((await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: final.receipt.payload, sig: final.receipt.sig, key_id: final.receipt.key_id } })).json()).data.valid).toBe(true);
  expect((await inbox(recipient))[0]).toMatchObject({ status: "final", title: "Payment received and final" });

  // A final transfer that leaves the canonical chain inside the horizon makes the receipt reversed.
  const t2 = send({ value: units(20) });
  const r2 = await confirm(d2.decision_id, t2.txHash);
  expect(r2.body.data.status).toBe("final");
  sent.splice(sent.indexOf(t2), 1);
  h.chain.reorg(t2.blockNumber);
  // Final payments are re-checked at most every ten minutes; this one was checked just now.
  await h.ctx.db.update(agentPayments).set({ checkedAt: new Date(Date.now() - 3_600_000) }).where(eq(agentPayments.decisionId, d2.decision_id));
  expect(await runAgentPayVerify(h.ctx)).toMatchObject({ reversed: 1 });
  const gone = await read(d2.decision_id);
  expect(gone).toMatchObject({ status: "reversed", reason: "the transaction is no longer on the canonical chain", receipt: { payload: { status: "reversed" } } });
  expect((await inbox(owner)).find((i: { id: string }) => i.id === `payment:sent:${d2.decision_id}`)).toMatchObject({ status: "reversed" });
  expect((await read(d.decision_id)).status).toBe("final");
});

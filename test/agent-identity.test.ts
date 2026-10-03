import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { decodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { generations, keys, ledger, providers } from "../src/db/schema.ts";
import { agentProfiles } from "../src/agents/profile-schema.ts";
import { agreementProjection } from "../src/agreements/schema.ts";
import { agreementScope } from "../src/agreements/state.ts";
import { walletAccountId } from "../src/api/auth.ts";
import { loadConfig } from "../src/config.ts";
import { canonicalJson } from "../src/lib/util.ts";
import { MerkleTree } from "../src/receipts/merkle.ts";
import { runAnchor } from "../src/services/anchor.ts";
import { noteSigner, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";
import { identityRegistryAbi, reputationRegistryAbi, validationRegistryAbi, RECEIPT_KEYS_METADATA } from "../src/identity/erc8004.ts";
import { setIdentityChain, type IdentityChain, type Registration } from "../src/identity/chain.ts";
import { runAgentIdentity } from "../src/identity/identity.ts";
import { feedbackWeight, paidBand, reputationOf } from "../src/identity/feedback.ts";
import { isLiveStatus, probeEndpoint, runAgentLiveness, type ProbeResult } from "../src/identity/liveness.ts";
import { verifySignedDocument } from "../src/identity/signed.ts";
import { verifyTrackRecord } from "../src/agents/track-record-shared.ts";
import { agentIdentities, agentLiveness } from "../src/identity/schema.ts";

const witness = noteSigner("identity-witness.example/log", SIG_COSIGNATURE_V1, randomBytes(32));
const ESCROW = "0x00000000000000000000000000000000000e5c00", ORACLE = "0x00000000000000000000000000000000000e5c01";
const VALIDATION = "0x00000000000000000000000000000000000ba11d", VALIDATOR = "0x00000000000000000000000000000000000ba11e";
const IDENTITY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
const env = {
  AGENT_PROFILES_ENABLED: "true", AGENT_POLICY_ENABLED: "true", TLOG_ENABLED: "true", TLOG_WITNESSES: witness.verifierKey, TLOG_WITNESS_QUORUM: "1",
  AGENT_IDENTITY_ENABLED: "true", PAID_FEEDBACK_ENABLED: "true", AGENT_AGREEMENTS_ENABLED: "true", AGREEMENT_ESCROW_ADDRESS: ESCROW, DISPUTE_ORACLE_ADDRESS: ORACLE,
  ERC8004_VALIDATION_REGISTRY: VALIDATION, ERC8004_VALIDATOR_ADDRESS: VALIDATOR,
};
const body = { name: "Paid agent", description: "Answers questions", capabilities: ["qa"], show: [] };
type Key = Awaited<ReturnType<Harness["fundedKey"]>>;

/** A chain stand-in: registrations by transaction hash, and registrar submissions. */
class FakeIdentityChain implements IdentityChain {
  txs = new Map<string, Registration>();
  sent: Hex[] = [];
  next = 7n;
  async registration(_registry: Hex, txHash: Hex) { return this.txs.get(txHash.toLowerCase()) ?? { status: "pending" as const }; }
  async register(_registry: Hex, data: Hex) {
    this.sent.push(data);
    const { args } = decodeFunctionData({ abi: identityRegistryAbi, data });
    const hash = keccak256(data);
    this.txs.set(hash, { status: "ok", agentId: this.next++, owner: "0x000000000000000000000000000000000000beef", agentURI: args[0] as string, block: 1n });
    return hash;
  }
}

let h: Harness;
const chain = new FakeIdentityChain();
const publish = (k: Key, json: unknown = body) => h.request(`/api/v1/agents/${k.hash}/profile`, { method: "PUT", headers: k.auth, json });
const slugOf = async (k: Key) => (await h.ctx.db.select().from(agentProfiles).where(eq(agentProfiles.keyHash, k.hash)))[0].slug;
const card = async (slug: string) => (await (await h.request(`/api/v1/agents/profiles/${slug}`)).json());
const settings = (k: Key, json?: unknown) => h.request(`/api/v1/agents/${k.hash}/identity`, json === undefined ? { headers: k.auth } : { method: "PUT", headers: k.auth, json });
const feedback = (reviewer: Key, slug: string, json: unknown) => h.request(`/api/v1/agents/${slug}/feedback`, { method: "POST", headers: reviewer.auth, json });

/** Turn `k`'s account into the operator wallet's account, and mark provider alpha as that wallet's network host. */
async function makeHost(k: Key) {
  const wallet = ("0x" + randomBytes(20).toString("hex")) as Hex;
  await h.ctx.db.update(keys).set({ accountId: walletAccountId(wallet) }).where(eq(keys.keyHash, k.hash));
  await h.ctx.db.update(providers).set({ networkHost: true, operator: wallet }).where(eq(providers.id, "alpha"));
  return wallet;
}
async function paidCall(payer: Key, opts: { cost?: bigint; provider?: string; ts?: Date; mode?: string; accountId?: string | null } = {}) {
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, payer.hash));
  const id = "gen-test-" + randomBytes(8).toString("hex");
  await h.ctx.db.insert(generations).values({ id, receiptId: id, keyHash: payer.hash, accountId: opts.accountId === undefined ? k.accountId : opts.accountId, modelId: MODELS.llama.slug, providerId: opts.provider ?? "alpha", mode: opts.mode ?? "prepaid", cost: opts.cost ?? 2_000_000_000_000n, ts: opts.ts ?? new Date(), finishReason: "stop" });
  return id;
}

beforeAll(async () => { h = await startRouter({ env }); setIdentityChain(h.ctx, chain); await h.ctx.tlog!.idle(); });
afterAll(async () => { await h?.close(); });

describe("flags", () => {
  test("off by default: no routes, no card fields, and the status says so", async () => {
    const off = await startRouter({ env: { AGENT_PROFILES_ENABLED: "true" } });
    try {
      const k = await off.fundedKey();
      const slug = (await (await off.request(`/api/v1/agents/${k.hash}/profile`, { method: "PUT", headers: k.auth, json: body })).json()).data.id;
      const c = await (await off.request(`/api/v1/agents/profiles/${slug}`)).json();
      for (const field of ["identity", "liveness", "reputation", "track_record"]) expect(c.anyroute[field]).toBeUndefined();
      for (const [method, path] of [["GET", `/api/v1/agents/${k.hash}/identity`], ["POST", `/api/v1/agents/${k.hash}/identity/register`], ["GET", `/api/v1/agents/${slug}/reputation`], ["POST", `/api/v1/agents/${slug}/feedback`], ["POST", `/api/v1/agents/${k.hash}/track-record`], ["GET", "/api/v1/agents/identity/" + "a".repeat(24) + "/registration.json"]])
        expect((await off.request(path, { method, headers: k.auth, ...(method === "GET" ? {} : { json: {} }) })).status).toBe(404);
      const status = (await (await off.request("/api/v1/status")).json()).data.identity;
      expect(status).toMatchObject({ enabled: false, paid_feedback: false, registration_mode: null, feedback_receipt_kinds: [] });
      expect(status.registries).toEqual({ identity: IDENTITY, reputation: "0x8004baa17c55a88189ae136b182e5fda19de9b63", validation: null, canonical: true });
      expect(off.ctx.jobs.status().map(j => j.name)).not.toContain("agent-liveness");
    } finally { await off.close(); }
  });

  test("status is truthful when on, and configuration guards dependencies and the registrar key", () => {
    const status = h.ctx.cfg.identity;
    expect(status).toMatchObject({ enabled: true, paidFeedback: true, mode: "owner", validator: VALIDATOR });
    expect(() => loadConfig({ AGENT_IDENTITY_ENABLED: "true" })).toThrow("AGENT_PROFILES_ENABLED");
    expect(() => loadConfig({ AGENT_PROFILES_ENABLED: "true", AGENT_IDENTITY_REGISTRAR_KEY: "0x" + "4".repeat(64) })).toThrow("AGENT_IDENTITY_MODE=registrar");
    expect(loadConfig({ CHAIN_ID: "1", AGENT_PROFILES_ENABLED: "true" }).identity.registries.identity).toBeUndefined();
    expect(h.ctx.jobs.status().map(j => j.name)).toContain("agent-liveness");
  });

  test("the production worker allowlist takes agent-liveness, and the registrar key only on an isolated worker", () => {
    const address = "0x" + "1".repeat(40);
    const production = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "worker", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, AGENT_PROFILES_ENABLED: "true", AGENT_IDENTITY_ENABLED: "true" };
    expect(loadConfig({ ...production, WORKER_JOBS: "agent-liveness" }).workerJobs).toEqual(["agent-liveness"]);
    expect(() => loadConfig({ ...production, WORKER_JOBS: "agent-liveness", AGENT_IDENTITY_ENABLED: "false" })).toThrow("AGENT_IDENTITY_ENABLED");
    const registrar = { ...production, AGENT_IDENTITY_MODE: "registrar", AGENT_IDENTITY_REGISTRAR_KEY: "0x" + "5".repeat(64), WORKER_JOBS: "agent-identity" };
    expect(loadConfig(registrar).identity.registrar).toMatch(/^0x[0-9a-f]{40}$/);
    expect(() => loadConfig({ ...registrar, WORKER_JOBS: "agent-identity,agent-liveness" })).toThrow("isolated");
    expect(() => loadConfig({ ...registrar, RUNTIME_ROLE: "api", WORKER_JOBS: "", ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64) })).toThrow("isolated");
    expect(() => loadConfig({ ...registrar, ANCHORER_PRIVATE_KEY: "0x" + "6".repeat(64) })).toThrow();
  });
});

describe("ERC-8004 identity", () => {
  test("owner mode: register() calldata for the owner's wallet, then the confirmed agent id on the card and registration file", async () => {
    const k = await h.fundedKey();
    expect((await h.request(`/api/v1/agents/${k.hash}/identity/register`, { method: "POST", headers: k.auth, json: {} })).status).toBe(409);
    await publish(k, { ...body, endpoint: "https://agent.example/a2a" });
    const slug = await slugOf(k);
    const r = (await (await h.request(`/api/v1/agents/${k.hash}/identity/register`, { method: "POST", headers: k.auth, json: {} })).json()).data;
    expect(r).toMatchObject({ status: "awaiting_owner", mode: "owner", registry: `eip155:4663:${IDENTITY}` });
    expect(r.transaction).toMatchObject({ chain_id: 4663, to: IDENTITY, value: "0" });
    const call = decodeFunctionData({ abi: identityRegistryAbi, data: r.transaction.data });
    expect(call.functionName).toBe("register");
    expect(call.args[0]).toBe(r.agent_uri);
    expect(call.args[1]).toEqual([{ metadataKey: RECEIPT_KEYS_METADATA, metadataValue: toHex("http://127.0.0.1:8787/.well-known/anyroute-receipt-keys.json") }]);

    const tx = keccak256(toHex("owner-tx-" + k.hash)), wrong = keccak256(toHex("wrong-" + k.hash));
    const confirm = (hash: Hex) => h.request(`/api/v1/agents/${k.hash}/identity/confirm`, { method: "POST", headers: k.auth, json: { tx_hash: hash } });
    expect((await confirm(tx)).status).toBe(409); // not mined yet
    chain.txs.set(wrong, { status: "ok", agentId: 3n, owner: "0x00000000000000000000000000000000000000aa", agentURI: "https://elsewhere.example/agent.json", block: 1n });
    expect((await confirm(wrong)).status).toBe(422);
    chain.txs.set(tx, { status: "ok", agentId: 42n, owner: "0x00000000000000000000000000000000000000AA", agentURI: r.agent_uri, block: 1n });
    const done = (await (await confirm(tx)).json()).data;
    expect(done.registration).toMatchObject({ status: "registered", agent_id: "42", owner_address: "0x00000000000000000000000000000000000000aa" });

    const c = await card(slug);
    expect(c.endpoint).toBe("https://agent.example/a2a");
    expect(c.anyroute.identity).toMatchObject({ card: `http://127.0.0.1:8787/api/v1/agents/profiles/${slug}`, receipt_keys: "http://127.0.0.1:8787/.well-known/anyroute-receipt-keys.json", receipt_key_id: h.ctx.signer.keyId, registration: r.agent_uri, erc8004: { registry: `eip155:4663:${IDENTITY}`, agent_id: "42", status: "registered" } });
    const file = await (await h.request(new URL(r.agent_uri).pathname)).json();
    expect(file).toMatchObject({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: body.name, active: true, registrations: [{ agentId: 42, agentRegistry: `eip155:4663:${IDENTITY}` }] });
    expect(file.services.map((s: { name: string }) => s.name)).toEqual(["web", "anyroute-card", "agent", "anyroute-receipt-keys"]);
    expect(JSON.stringify(file)).not.toContain(k.hash);
    expect((await h.request(`/api/v1/agents/${k.hash}/identity/register`, { method: "POST", headers: k.auth, json: {} })).status).toBe(409);
  });

  test("registrar mode queues, and the isolated worker sends and confirms", async () => {
    const k = await h.fundedKey();
    await publish(k);
    const previous = h.ctx.cfg.identity;
    h.ctx.cfg.identity = { ...previous, mode: "registrar", registrarKey: ("0x" + "7".repeat(64)) as Hex, registrar: "0x000000000000000000000000000000000000beef" };
    try {
      expect((await (await h.request(`/api/v1/agents/${k.hash}/identity/register`, { method: "POST", headers: k.auth, json: {} })).json()).data).toMatchObject({ status: "queued", mode: "registrar" });
      expect(await runAgentIdentity(h.ctx)).toMatchObject({ sent: 1 });
      expect((await (await settings(k)).json()).data.registration.status).toBe("submitted");
      expect(await runAgentIdentity(h.ctx)).toMatchObject({ confirmed: 1 });
      expect((await (await settings(k)).json()).data.registration).toMatchObject({ status: "registered", owner_address: "0x000000000000000000000000000000000000beef", mode: "registrar" });
    } finally { h.ctx.cfg.identity = previous; }
  });

  test("opt-out: unlinkable-only rulebooks are out by default, and opting out removes every published link", async () => {
    const k = await h.fundedKey();
    await h.request(`/api/v1/agents/${k.hash}/policy`, { method: "PUT", headers: k.auth, json: { version: 1, models: {}, lanes: ["unlinkable"], caps: {}, on_breach: "deny" } });
    await publish(k);
    const slug = await slugOf(k);
    expect((await (await settings(k)).json()).data).toMatchObject({ identity_opt_out: true, identity_opt_out_default: true, unlinkable_only_rulebook: true });
    expect((await card(slug)).anyroute.identity).toEqual({ opted_out: true });
    expect((await h.request(`/api/v1/agents/${k.hash}/identity/register`, { method: "POST", headers: k.auth, json: {} })).status).toBe(409);
    await settings(k, { identity_opt_out: false });
    const r = (await (await h.request(`/api/v1/agents/${k.hash}/identity/register`, { method: "POST", headers: k.auth, json: {} })).json()).data;
    expect((await h.request(new URL(r.agent_uri).pathname)).status).toBe(200);
    await settings(k, { identity_opt_out: true });
    expect((await h.request(new URL(r.agent_uri).pathname)).status).toBe(404);
    expect((await card(slug)).anyroute.identity).toEqual({ opted_out: true });
    expect((await (await settings(k)).json()).data.registration.status).toBe("none");
    const other = await h.fundedKey();
    expect((await settings(other)).status).toBe(200);
    expect((await h.request(`/api/v1/agents/${k.hash}/identity`, { headers: other.auth })).status).toBe(404);
    expect((await h.request(`/api/v1/agents/${k.hash}/identity`, { method: "PUT", headers: k.auth, json: { key_hash: k.hash } })).status).toBe(400);
  });
});

describe("paid feedback", () => {
  let agent: Key, reviewer: Key, slug: string;
  beforeAll(async () => {
    agent = await h.fundedKey(); reviewer = await h.fundedKey();
    await publish(agent); slug = await slugOf(agent);
    await makeHost(agent);
  });

  test("an agent that has not opted in to reputation takes no feedback", async () => {
    const id = await paidCall(reviewer);
    expect((await feedback(reviewer, slug, { receipt_id: id, score: 90 })).status).toBe(409);
    expect((await (await h.request(`/api/v1/agents/${slug}/reputation`)).json()).data).toMatchObject({ opted_in: false });
    await settings(agent, { reputation_opt_in: true });
  });

  test("no receipt, no feedback: unknown, foreign, unlinkable, unpaid and unrelated receipts are refused", async () => {
    await settings(agent, { reputation_opt_in: true });
    const r = await feedback(reviewer, slug, { receipt_id: "gen-does-not-exist", score: 10 });
    expect(r.status).toBe(422); expect((await r.json()).error.type).toBe("receipt_required");
    const stranger = await h.fundedKey();
    const notMine = await paidCall(stranger);
    expect((await (await feedback(reviewer, slug, { receipt_id: notMine, score: 10 })).json()).error.type).toBe("not_receipt_payer");
    const blind = await paidCall(reviewer, { mode: "blind", accountId: null });
    expect((await (await feedback(reviewer, slug, { receipt_id: blind, score: 10 })).json()).error.type).toBe("receipt_unlinkable");
    const otherHost = await paidCall(reviewer, { provider: "beta" });
    expect((await (await feedback(reviewer, slug, { receipt_id: otherHost, score: 10 })).json()).error.type).toBe("receipt_subject_mismatch");
    const refunded = await paidCall(reviewer, { cost: 1_000n });
    const [payer] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, reviewer.hash));
    await h.ctx.db.insert(ledger).values({ id: "refund-" + refunded, accountId: payer.accountId, amount: 1_000n, kind: "refund", ref: "refund:" + refunded, generationId: refunded });
    expect((await (await feedback(reviewer, slug, { receipt_id: refunded, score: 10 })).json()).error.type).toBe("receipt_unpaid");
    expect((await feedback(reviewer, slug, { receipt_id: notMine, receipt_kind: "tool.made_up", score: 10 })).status).toBe(422);
    expect((await feedback(reviewer, slug, { receipt_id: notMine, score: 101 })).status).toBe(400);
    expect((await feedback(reviewer, slug, { receipt_id: notMine, score: 5, comment: "free text" })).status).toBe(400);
  });

  test("self-feedback is refused, by the agent's own key and by any key of its account", async () => {
    const own = await paidCall(agent);
    const r = await feedback(agent, slug, { receipt_id: own, score: 100 });
    expect(r.status).toBe(403); expect((await r.json()).error.type).toBe("self_feedback");
  });

  test("a paid receipt backs exactly one entry; weight follows the payment and decays", async () => {
    const fresh = await paidCall(reviewer, { cost: 10_000_000_000_000n }); // $10
    const old = await paidCall(reviewer, { cost: 10_000_000_000_000n, ts: new Date(Date.now() - 90 * 86_400_000) }); // $10, one half-life ago
    const a = await feedback(reviewer, slug, { receipt_id: fresh, receipt_kind: "model.call", score: 100, tag1: "accuracy" });
    expect(a.status).toBe(201);
    const entry = (await a.json()).data;
    expect(entry).toMatchObject({ score: 100, receipt_kind: "model.call", paid_band: "$10 to $100", tag1: "accuracy" });
    expect(entry.weight_usd_now).toBeCloseTo(10, 3);
    expect((await feedback(reviewer, slug, { receipt_id: fresh, score: 0 })).status).toBe(409);
    expect((await feedback(reviewer, slug, { receipt_id: old, score: 0 })).status).toBe(201);
    const rep = (await (await h.request(`/api/v1/agents/${slug}/reputation`)).json()).data;
    expect(rep).toMatchObject({ opted_in: true, feedback_count: 2, half_life_days: 90 });
    expect(rep.score).toBeCloseTo(66.7, 1); // weights 10 and 5
    expect(rep.weight_usd).toBeCloseTo(15, 2);
    const text = JSON.stringify(rep);
    for (const secret of [reviewer.hash, agent.hash, fresh, old, "accountId", "reviewer_account"]) expect(text).not.toContain(secret);
    expect((await card(slug)).anyroute.reputation).toMatchObject({ opted_in: true, feedback_count: 2 });
    // The entry is public at its feedbackURI, without the reviewer.
    const pub = await (await h.request(`/api/v1/agents/feedback/${entry.id}`)).json();
    expect(pub).toMatchObject({ id: entry.id, agent: slug, score: 100 });
    // Withdrawal by the reviewer only.
    expect((await h.request(`/api/v1/agents/${slug}/feedback/${entry.id}`, { method: "DELETE", headers: agent.auth })).status).toBe(404);
    expect((await h.request(`/api/v1/agents/${slug}/feedback/${entry.id}`, { method: "DELETE", headers: reviewer.auth })).status).toBe(200);
    expect((await (await h.request(`/api/v1/agents/${slug}/reputation`)).json()).data.feedback_count).toBe(1);
  });

  test("weight and decay arithmetic", () => {
    const now = new Date("2026-10-02T00:00:00Z");
    expect(feedbackWeight(10n ** 12n, now, now, 90)).toBe(1);
    expect(feedbackWeight(10n ** 12n, new Date(now.getTime() - 90 * 86_400_000), now, 90)).toBeCloseTo(0.5, 10);
    expect(feedbackWeight(4n * 10n ** 12n, new Date(now.getTime() - 180 * 86_400_000), now, 90)).toBeCloseTo(1, 10);
    expect(feedbackWeight(10n ** 12n, new Date(now.getTime() + 86_400_000), now, 90)).toBe(1); // a future time never grows
    const rows = [{ score: 100, paidPico: 3n * 10n ** 12n, paidAt: now, receiptKind: "model.call" }, { score: 0, paidPico: 10n ** 12n, paidAt: now, receiptKind: "agreement.release" }];
    expect(reputationOf(rows, now, 90)).toEqual({ score: 75, feedback_count: 2, weight_usd: 4, by_kind: { "model.call": 1, "agreement.release": 1 } });
    expect(reputationOf([], now, 90).score).toBeNull();
    expect([paidBand(1n), paidBand(5n * 10n ** 10n), paidBand(10n ** 14n)]).toEqual(["under $0.01", "$0.01 to $0.10", "$100 or more"]);
  });

  test("a released agreement paid by the reviewer to the agent's wallet backs feedback", async () => {
    const payer = ("0x" + randomBytes(20).toString("hex")) as Hex;
    const payerKey = await h.fundedKey();
    await h.ctx.db.update(keys).set({ accountId: walletAccountId(payer) }).where(eq(keys.keyHash, payerKey.hash));
    const [agentKey] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, agent.hash));
    const payee = "0x" + agentKey.accountId.slice(2);
    const data = { id: "9.0", agreementId: "9", milestone: "0", creation: "x:0", payer, payee, oracle: ORACLE, amount: "5000000", termsHash: "0x", deadline: "0", deliverables: [], state: "released", resolvedAt: Math.floor(Date.now() / 1000), payeeAmount: "5000000", payerAmount: "0" };
    await h.ctx.db.insert(agreementProjection).values({ scope: agreementScope(h.ctx.cfg), kind: "agreement", id: "9.0", data });
    const r = await feedback(payerKey, slug, { receipt_id: "9.0", receipt_kind: "agreement.release", score: 80 });
    expect(r.status).toBe(201);
    expect((await r.json()).data).toMatchObject({ receipt_kind: "agreement.release", paid_band: "$1 to $10" });
    expect((await feedback(reviewer, slug, { receipt_id: "9.0", receipt_kind: "agreement.release", score: 1 })).status).toBe(403);
  });

  test("a registered agent's entry comes with optional giveFeedback calldata for the reputation registry", async () => {
    await h.ctx.db.update(agentIdentities).set({ status: "registered", agentId: "12", registry: `eip155:4663:${IDENTITY}` }).where(eq(agentIdentities.keyHash, agent.hash));
    const id = await paidCall(reviewer);
    const data = (await (await feedback(reviewer, slug, { receipt_id: id, score: 70, tag1: "speed" })).json()).data;
    expect(data.erc8004).toMatchObject({ to: "0x8004baa17c55a88189ae136b182e5fda19de9b63", chain_id: 4663 });
    const call = decodeFunctionData({ abi: reputationRegistryAbi, data: data.erc8004.data });
    expect(call.args.slice(0, 5)).toEqual([12n, 70n, 0, "speed", ""]);
    const pub = await (await h.request(`/api/v1/agents/feedback/${data.id}`)).json();
    expect(call.args[7]).toBe(keccak256(toHex(canonicalJson(pub))));
  });
});

describe("liveness", () => {
  test("a signed probe receipt per listed endpoint; the card shows live, and a changed endpoint drops the stale result", async () => {
    const up = await h.fundedKey(), down = await h.fundedKey(), none = await h.fundedKey();
    await publish(up, { ...body, endpoint: "https://up.agent.example/" });
    await publish(down, { ...body, endpoint: "https://down.agent.example/" });
    await publish(none);
    const seen: string[] = [];
    const probe = async (url: string): Promise<ProbeResult> => { seen.push(url); return url.includes("up.") ? { live: true, http_status: 402, latency_ms: 12, error: null } : { live: false, http_status: 503, latency_ms: 30, error: "http" }; };
    const result = await runAgentLiveness(h.ctx, { probe });
    expect(result).toMatchObject({ live: expect.any(Number), down: expect.any(Number) });
    expect(seen).toContain("https://up.agent.example/");
    expect(seen).not.toContain(undefined);
    const keys = await h.ctx.signer.jwks();
    const upCard = await card(await slugOf(up));
    expect(upCard.anyroute.liveness).toMatchObject({ endpoint_declared: true, live: true, http_status: 402 });
    const receipt = upCard.anyroute.liveness.receipt;
    expect(receipt.payload).toMatchObject({ type: "anyroute.agent.liveness-probe", agent: await slugOf(up), live: true });
    expect(verifySignedDocument(receipt, keys, receipt.payload.probed_at)).toBe(true);
    expect(verifySignedDocument({ ...receipt, payload: { ...receipt.payload, live: false } }, keys, receipt.payload.probed_at)).toBe(false);
    expect((await card(await slugOf(down))).anyroute.liveness).toMatchObject({ live: false, http_status: 503 });
    expect((await card(await slugOf(none))).anyroute.liveness).toMatchObject({ endpoint_declared: false, live: null });
    await publish(up, { ...body, endpoint: "https://moved.agent.example/" });
    expect((await card(await slugOf(up))).anyroute.liveness.live).toBeNull();
    expect((await h.ctx.db.select().from(agentLiveness).where(eq(agentLiveness.keyHash, up.hash))).length).toBe(1);
  });

  test("probes go to public HTTPS addresses only, and the status rule", async () => {
    expect(await probeEndpoint("https://127.0.0.1/", 1000)).toMatchObject({ live: false, error: "blocked" });
    expect(await probeEndpoint("http://example.com/", 1000)).toMatchObject({ live: false, error: "blocked" });
    expect([200, 204, 401, 402, 403, 405, 301].every(isLiveStatus)).toBe(true);
    expect([404, 410, 500, 502, 503].some(isLiveStatus)).toBe(false);
    const k = await h.fundedKey();
    for (const endpoint of ["http://agent.example/", "https://user:pw@agent.example/", "javascript:alert(1)"]) expect((await publish(k, { ...body, endpoint })).status).toBe(400);
  });
});

describe("portable track record", () => {
  test("a signed ERC-8004 validation payload whose Merkle root covers the key's anchored receipts", async () => {
    const k = await h.fundedKey();
    await publish(k);
    const slug = await slugOf(k);
    for (let i = 0; i < 3; i++) expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "track " + i }], max_tokens: 8 } })).status).toBe(200);
    await Bun.sleep(1100);
    await runAnchor(h.ctx);
    const counted = await h.ctx.db.select().from(generations).where(eq(generations.keyHash, k.hash));
    await h.ctx.db.insert(ledger).values({ id: "refund-tr-" + counted[0].id, accountId: counted[0].accountId!, amount: 1n, kind: "refund", ref: "refund-tr:" + counted[0].id, generationId: counted[0].id });
    const issued = (await (await h.request(`/api/v1/agents/${k.hash}/track-record`, { method: "POST", headers: k.auth, json: { publish: true } })).json()).data;
    const cert = issued.certificate, keys = await h.ctx.signer.jwks();
    expect(verifyTrackRecord(cert, { keys })).toBe(true);
    expect(cert.payload.stats).toMatchObject({ receipts: 3, refunded_receipts: 1, refund_rate_bps: 3333, agreements: 0, dispute_rate_bps: 0 });
    const spend = counted.reduce((s, g) => s + g.cost, 0n);
    expect(Number(cert.payload.stats.spend_usd)).toBeCloseTo(Number(spend) / 1e12, 12);
    expect(cert.payload.merkle).toMatchObject({ leaf_count: 3, anchors: { count: 1, confirmed: 1 } });
    expect(cert.payload.merkle.root).toBe(new MerkleTree(counted.map(g => g.receiptLeaf!.toLowerCase() as Hex).sort()).root.toLowerCase());
    // No counterparty and no per-counterparty amount.
    const text = JSON.stringify(cert);
    for (const secret of [k.hash, "alpha", counted[0].id, counted[0].accountId!, String(counted[0].cost)]) expect(text).not.toContain(secret);
    // Tampering breaks the signature.
    expect(verifyTrackRecord({ ...cert, payload: { ...cert.payload, stats: { ...cert.payload.stats, receipts: 4 } } }, { keys })).toBe(false);
    expect(verifyTrackRecord(cert, { keys, nowMs: Date.parse(cert.payload.expires_at) })).toBe(false);
    expect((await (await h.request("/api/v1/agents/track-records/verify", { method: "POST", json: cert })).json()).data.valid).toBe(true);
    // Every counted receipt proves into the certificate's root and into an anchor root.
    for (let index = 0; index < 3; index++) {
      const proof = (await (await h.request(`/api/v1/agents/track-records/${issued.id}/proof?index=${index}`)).json()).data;
      expect(proof.root).toBe(cert.payload.merkle.root);
      expect(MerkleTree.verify(proof.leaf, proof.proof, cert.payload.merkle.root)).toBe(true);
      expect(MerkleTree.verify(proof.leaf, proof.anchor.proof, proof.anchor.root)).toBe(true);
      expect(proof.anchor.status).toBe("confirmed");
    }
    expect((await h.request(`/api/v1/agents/track-records/${issued.id}/proof?index=3`)).status).toBe(404);
    // ERC-8004 validation entry: hashes of the payload and of the signed certificate.
    const read = (await (await h.request(issued.url.replace("http://127.0.0.1:8787", ""))).json()).data;
    expect(read).toMatchObject({ id: issued.id, valid: true });
    expect(read.validation).toMatchObject({ status: "agent_not_registered", request_uri: issued.url, request_hash: keccak256(toHex(canonicalJson(cert.payload))), response: 100, response_hash: keccak256(toHex(canonicalJson(cert))), tag: "anyroute-track-record", calldata: null });
    expect((await card(slug)).anyroute.track_record).toMatchObject({ id: issued.id, merkle_root: cert.payload.merkle.root, stats: { receipts: 3 } });
  });

  test("with a registered identity and a configured validation registry, the entry carries request and response calldata", async () => {
    const k = await h.fundedKey();
    await publish(k);
    await h.request(`/api/v1/agents/${k.hash}/identity/register`, { method: "POST", headers: k.auth, json: {} });
    await h.ctx.db.update(agentIdentities).set({ status: "registered", agentId: "77", registry: `eip155:4663:${IDENTITY}` }).where(eq(agentIdentities.keyHash, k.hash));
    const issued = (await (await h.request(`/api/v1/agents/${k.hash}/track-record`, { method: "POST", headers: k.auth, json: {} })).json()).data;
    expect(issued.certificate.payload).toMatchObject({ agent: { erc8004: { registry: `eip155:4663:${IDENTITY}`, agent_id: "77" } }, stats: { receipts: 0 }, merkle: { root: null, leaf_count: 0 } });
    expect(issued.published).toBe(false);
    const v = issued.validation;
    expect(v).toMatchObject({ status: "ready", registry: `eip155:4663:${VALIDATION}`, validator: VALIDATOR, agent_id: "77" });
    const req = decodeFunctionData({ abi: validationRegistryAbi, data: v.calldata.request.data });
    expect([String(req.args[0]).toLowerCase(), ...req.args.slice(1)]).toEqual([VALIDATOR, 77n, issued.url, v.request_hash]);
    const res = decodeFunctionData({ abi: validationRegistryAbi, data: v.calldata.response.data });
    expect(res.args).toEqual([v.request_hash, 100, issued.url, v.response_hash, "anyroute-track-record"]);
    // An unpublished record stays off the card.
    expect((await card(await slugOf(k))).anyroute.track_record).toBeNull();
  });
});

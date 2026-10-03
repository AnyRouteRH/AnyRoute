import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { noteSigner, formatSignerKey, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";
import { eq, sql } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { accounts, keys, kv, ledger, providers, spendAlerts, teamMembers } from "../src/db/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { agreementEvents, agreementProjection } from "../src/agreements/schema.ts";
import { agreementScope } from "../src/agreements/state.ts";
import { loadConfig } from "../src/config.ts";
let h: Harness;
const address = (digit: string) => "0x" + digit.repeat(40);
const at = new Date(Date.now() - 60_000);
type Key = { hash: string; auth: Record<string, string> };
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_AGREEMENTS_ENABLED: "true", NETWORK_HOSTS_ENABLED: "true", NETWORK_POLICY_ENABLED: "true", TLOG_ENABLED: "true", AGREEMENT_ESCROW_ADDRESS: address("1"), DISPUTE_ORACLE_ADDRESS: address("2") } }); });
afterAll(async () => { await h?.close(); });
async function inbox(key: Key, since?: string) {
  const response = await h.request("/api/v1/inbox" + (since ? "?since=" + encodeURIComponent(since) : ""), { headers: key.auth });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); return response.json();
}
async function child(owner: Key) {
  const response = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Agent key" } });
  const result = await response.json(); return { hash: result.data.hash, auth: { authorization: "Bearer " + result.key } };
}
async function approval(key: Key, id: string, extra = {}) {
  await h.ctx.db.insert(agentApprovals).values({ id, keyHash: key.hash, requestedAt: at, expiresAt: new Date(Date.now() + 600_000), intent: { kind: "inference", model: MODELS.llama.slug, lane: "public", tools: ["read"], unexpected: "intent sentinel" }, intentHash: "intent", maxCostPico: 1000000000001n, ...extra });
}
async function accountOf(key: Key) { return (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)))[0].accountId; }
test("inbox and seen require valid active keys and isolate account, ordinary and session scopes", async () => {
  for (const path of ["/api/v1/inbox", "/api/v1/inbox/seen?through=" + at.toISOString()]) {
    const method = path.includes("seen") ? "POST" : "GET";
    expect((await h.request(path, { method })).status).toBe(401);
    expect((await h.request(path, { method, headers: { authorization: "Bearer invalid" } })).status).toBe(401);
  }
  const owner = await h.newKey(), peer = await child(owner), other = await h.newKey();
  await approval(owner, "isolation-owner"); await approval(peer, "isolation-peer"); await approval(other, "isolation-other");
  expect((await inbox(owner)).data.map((r: any) => r.id).sort()).toEqual(["approval:isolation-owner", "approval:isolation-peer"]);
  expect((await inbox(peer)).data.map((r: any) => r.id)).toEqual(["approval:isolation-peer"]);
  expect((await inbox(peer)).data[0].can_decide).toBe(false);
  expect((await inbox(other)).data.map((r: any) => r.id)).toEqual(["approval:isolation-other"]);
  expect((await inbox(owner)).seen_scope).not.toBe((await inbox(peer)).seen_scope);
  const result = await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json();
  const session = { hash: result.data.key_hash, auth: { authorization: "Bearer " + result.data.key } };
  await approval(session, "isolation-session");
  const page = await inbox(session); expect(page.scope).toBe("key"); expect(page.data.map((r: any) => r.id)).toEqual(["approval:isolation-session"]); expect(page.data[0].can_decide).toBe(false);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, peer.hash));
  expect((await h.request("/api/v1/inbox", { headers: peer.auth })).status).toBe(401);
});
test("team administrators retain the agent boundary and their own spending alerts", async () => {
  const owner = await h.newKey(), admin = await child(owner), peer = await child(owner);
  await h.ctx.db.update(keys).set({ teamId: "inbox-team" }).where(eq(keys.keyHash, admin.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: "inbox-team", keyHash: admin.hash, role: "admin" });
  await approval(admin, "team-admin"); await approval(peer, "team-peer");
  const account = await accountOf(owner), firing = { id: "firing", at: at.toISOString(), delivery: { status: "sent", target: "delivery sentinel" } };
  await h.ctx.db.insert(spendAlerts).values([{ id: "inbox-account-alert", accountId: account, kind: "threshold", state: { history: [firing] } }, { id: "inbox-admin-alert", accountId: account, keyHash: admin.hash, kind: "threshold", state: { history: [firing] } }]);
  const page = await inbox(admin); expect(page.data.map((r: any) => r.id).sort()).toEqual(["approval:team-admin", "spend-alert:inbox-admin-alert:firing"]);
  expect(page.data.find((r: any) => r.kind === "approval").can_decide).toBe(true);
  expect((await inbox(owner)).count).toBe(4); expect(page.seen_scope).not.toBe((await inbox(owner)).seen_scope);
  expect(JSON.stringify(page)).not.toContain("sentinel");
});
test("merges approvals, retained alerts and posted credits in time/id order with expiry and safe intent", async () => {
  const owner = await h.newKey(), account = await accountOf(owner);
  await approval(owner, "merge-pending"); await approval(owner, "merge-expired", { expiresAt: new Date(Date.now() - 1) }); await approval(owner, "merge-denied", { status: "denied" });
  await h.ctx.db.insert(kv).values({ key: "agent-alerts:" + account, value: { feed: [{ id: "merge-alert", key_hash: owner.hash, at: at.toISOString(), kind: "cap", delivery: "feed_only", channels: ["delivery sentinel"] }] } });
  await h.ctx.db.insert(ledger).values([{ id: "inbox-deposit", accountId: account, keyHash: owner.hash, kind: "deposit", amount: 1000000000001n, ref: "deposit", createdAt: new Date(at.getTime() + 1000) }, { id: "inbox-usage", accountId: account, keyHash: owner.hash, kind: "usage", amount: -1n, ref: "usage", createdAt: at }]);
  const page = await inbox(owner); expect(page.data.map((r: any) => r.kind)).toEqual(["deposit", "approval", "alert"]); expect(page.count).toBe(3);
  const pending = page.data[1]; expect(pending).toMatchObject({ approval_limit: "1.000000000001", can_decide: true, status: "pending" }); expect(Date.parse(pending.expires_at)).toBeGreaterThan(Date.now());
  expect(pending.intent.intents[0]).toEqual({ kind: "inference", model: MODELS.llama.slug, lane: "public", tools: ["read"] });
  expect(JSON.stringify(page)).not.toContain("sentinel"); expect(JSON.stringify(page)).not.toContain(owner.hash);
});
test("seen is browser-held, covers only the displayed snapshot, and never hides pending approvals", async () => {
  const key = await h.newKey(), account = await accountOf(key); await approval(key, "seen-pending");
  await h.ctx.db.insert(ledger).values({ id: "seen-deposit", accountId: account, keyHash: key.hash, kind: "deposit", amount: 5n, ref: "credit", createdAt: at });
  const before = await inbox(key);
  const response = await h.request("/api/v1/inbox/seen?through=" + encodeURIComponent(before.as_of), { method: "POST", headers: key.auth });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.json()).toEqual({ seen_at: before.as_of, seen_scope: before.seen_scope });
  expect((await inbox(key)).count).toBe(2); expect((await inbox(key, before.as_of)).data.map((r: any) => r.id)).toEqual(["approval:seen-pending"]);
  // A snapshot covers [since, as_of): a row stamped in the same millisecond as the next read's as_of belongs to the
  // snapshot after it. Stamp the later credit just after the seen point, and read once the clock has passed it.
  const later = new Date(Date.parse(before.as_of) + 1);
  await h.ctx.db.insert(ledger).values({ id: "seen-later", accountId: account, keyHash: key.hash, kind: "deposit", amount: 3n, ref: "later", createdAt: later });
  while (Date.now() <= later.getTime()) await Bun.sleep(1);
  expect((await inbox(key, before.as_of)).count).toBe(2);
  for (const through of ["bad", new Date(Date.now() + 60_000).toISOString()]) {
    expect((await h.request("/api/v1/inbox?since=" + encodeURIComponent(through), { headers: key.auth })).status).toBe(400);
    expect((await h.request("/api/v1/inbox/seen?through=" + encodeURIComponent(through), { method: "POST", headers: key.auth })).status).toBe(400);
  }
});
test("inbox approvals use the existing owner decision and single-use call binding", async () => {
  const owner = await h.fundedKey(), agent = await child(owner), other = await h.newKey();
  await h.request(`/api/v1/agents/${agent.hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: {}, approval: { above_usd: 0.000000001 }, on_breach: "deny" } });
  const body = { model: MODELS.llama.slug, messages: [{ role: "user", content: "inbox request sentinel" }], max_tokens: 32, provider: { only: ["alpha"] } };
  expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: agent.auth, json: body })).status).toBe(403);
  const page = await inbox(owner), item = page.data.find((r: any) => r.kind === "approval"); expect(item).toBeDefined(); expect(JSON.stringify(page)).not.toContain("inbox request sentinel");
  const path = `/api/v1/agents/approvals/${item.approval_id}/approve`;
  expect((await h.request(path, { method: "POST", headers: agent.auth })).status).toBe(403);
  expect((await h.request(path, { method: "POST", headers: other.auth })).status).toBe(404);
  expect((await h.request(path, { method: "POST", headers: owner.auth })).status).toBe(200);
  expect((await inbox(owner)).data.some((r: any) => r.id === item.id)).toBe(false);
  expect((await h.request(path, { method: "POST", headers: owner.auth })).status).toBe(409);
  const call = () => h.request("/api/v1/chat/completions", { method: "POST", headers: { ...agent.auth, "x-agent-approval": item.approval_id }, json: body });
  expect((await call()).status).toBe(200); expect((await call()).status).toBe(403);
  await approval(agent, "inbox-deny");
  expect((await h.request("/api/v1/agents/approvals/inbox-deny/deny", { method: "POST", headers: owner.auth })).status).toBe(200);
  expect((await inbox(owner)).data.some((r: any) => r.id === "approval:inbox-deny")).toBe(false);
});
test("wallet-party disputes/rulings and operated hosts remain account-only; host history is not invented", async () => {
  const key = await h.newKey(), other = await h.newKey(), wallet = address("3"), account = "w_" + wallet.slice(2);
  await h.ctx.db.insert(accounts).values({ id: account, kind: "wallet", wallet }); await h.ctx.db.update(keys).set({ accountId: account }).where(eq(keys.keyHash, key.hash));
  const agent = await child(key), scope = agreementScope(h.ctx.cfg);
  await h.ctx.db.insert(agreementProjection).values({ scope, kind: "agreement", id: "1.0", data: { agreementId: "1", milestone: "0", payer: wallet, payee: address("4") } });
  await h.ctx.db.insert(agreementEvents).values(["DisputeOpened", "RulingPosted", "MilestoneFunded"].map((event, i) => ({ scope, txHash: "inbox-agreement-" + i, logIndex: 0, block: 1n, blockHash: "block", event, args: { id: "1", milestone: "0", amount: "1", indexedAt: Math.floor(at.getTime() / 1000) } })));
  await h.ctx.db.insert(providers).values([{ id: "inbox-host", name: "Host", baseUrl: "https://host.example/v1", operator: wallet, networkHost: true, status: "probation", updatedAt: at }, { id: "inbox-other-host", name: "Host", baseUrl: "https://other-host.example/v1", operator: address("5"), networkHost: true, status: "live", updatedAt: at }]);
  // Recent non-inbox agreement events must not displace an older dispute or ruling.
  await h.ctx.db.insert(agreementEvents).values(Array.from({ length: 101 }, (_, i) => ({ scope, txHash: "inbox-funding-" + i, logIndex: 0, block: 2n, blockHash: "block", event: "MilestoneFunded", args: { id: "1", milestone: "0", amount: "1", indexedAt: Math.floor(at.getTime() / 1000) + 1 } })));
  const page = await inbox(key); expect(page.data.filter((r: any) => r.kind === "agreement")).toHaveLength(2);
  expect(page.data.find((r: any) => r.kind === "host")).toMatchObject({ title: "Host record updated", status: "probation", href: "/hosts/?id=inbox-host" });
  expect(JSON.stringify(page)).not.toContain(wallet); expect((await inbox(other)).data).toEqual([]); expect((await inbox(agent)).data).toEqual([]);
});
test("sub-millisecond ordering and source cap are explicit", async () => {
  const key = await h.newKey(), account = await accountOf(key);
  await approval(key, "micro-pending"); await h.ctx.db.insert(ledger).values({ id: "micro-credit", accountId: account, keyHash: key.hash, kind: "deposit", amount: 1n, ref: "micro", createdAt: sql`${at.toISOString()}::timestamptz + interval '123 microseconds'` });
  const page = await inbox(key, at.toISOString()); expect(page.data.map((r: any) => r.id)).toEqual(["balance:micro-credit", "approval:micro-pending"]);
  await h.ctx.db.insert(agentApprovals).values(Array.from({ length: 101 }, (_, i) => ({ id: "cap-" + i, keyHash: key.hash, intent: {}, intentHash: "intent", maxCostPico: 0n, requestedAt: at, expiresAt: new Date(Date.now() + 600000) })));
  const capped = await inbox(key); expect(capped.capped).toBe(true); expect(capped.data.filter((r: any) => r.kind === "approval")).toHaveLength(100);
});
test("read-only inbox starts under production guards with existing source flags enabled", () => {
  const witnesses = [1, 2].map(i => noteSigner(`w${i}.example/w`, SIG_COSIGNATURE_V1, randomBytes(32)).verifierKey).join(",");
  const cfg = loadConfig({ TLOG_SIGNING_KEY: formatSignerKey("router.example/tlog", randomBytes(32)), TLOG_WITNESSES: witnesses, ATTESTATION_VERIFIERS: "phala", NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/inbox", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address("1"), CALLPAY_ADDRESS: address("1"), PROVIDER_BOND_ADDRESS: address("1"), RECEIPT_ANCHOR_ADDRESS: address("1"), ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), AGENT_POLICY_ENABLED: "true", AGENT_AGREEMENTS_ENABLED: "true", AGREEMENT_ESCROW_ADDRESS: address("1"), DISPUTE_ORACLE_ADDRESS: address("2"), NETWORK_HOSTS_ENABLED: "true", NETWORK_POLICY_ENABLED: "true", TLOG_ENABLED: "true" });
  expect(cfg.production).toBe(true); expect(cfg.networkHosts.enabled).toBe(true); expect(cfg.agentPolicyEnabled).toBe(true); expect(cfg.agreements.enabled).toBe(true);
});

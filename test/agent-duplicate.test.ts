// H171: all cases run with Postgres/Redis and single-connection PGlite.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { agentSessions, keys, kv, spendAlerts, teamMembers, teams } from "../src/db/schema.ts";
import { agentPolicies, agentPolicyEvents, playbooks } from "../src/agents/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { policyVersions } from "../src/agents/policy-versions-schema.ts";
import { agentPolicySchema, agentPolicySha256 } from "../src/agents/policy.ts";
import { approversKey } from "../src/agents/approvers.ts";
import { QUIET_PREFIX } from "../src/agents/quiet-alerts.ts";
import { verifyEventChain } from "../src/agents/store.ts";
import { duplicateAgent, duplicateName } from "../src/agent-duplicate/store.ts";
import { rotationKey } from "../src/key-rotation/store.ts";
import { browserSessionKey } from "../src/browser-sessions/labels.ts";
import { keyActor } from "../src/security-alerts/records.ts";
import { readPreferences } from "../src/notifications/prefs.ts";
import { runSecurityAlerts } from "../src/security-alerts/worker.ts";
import { uid } from "../src/lib/util.ts";

let h: Harness;
type Key = { hash: string; auth: Record<string, string> };
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true", TRUST_PROXY: "true" } }); });
afterAll(async () => { await h?.close(); });
const row = async (hash: string) => (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0];
const policyRow = async (hash: string) => (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, hash)))[0];
const duplicate = (source: Key, caller: Key, json: unknown = {}) => h.request(`/api/v1/agents/${source.hash}/duplicate`, { method: "POST", headers: caller.auth, json });
async function child(owner: Key, spec: Record<string, unknown> = {}): Promise<Key> {
  const response = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Research agent", ...spec } });
  expect(response.status).toBe(201);
  const result = await response.json();
  return { hash: result.data.hash, auth: { authorization: `Bearer ${result.key}` } };
}
async function fixture() {
  const owner = await h.fundedKey();
  const team = uid("duplicate-team-");
  await h.ctx.db.insert(teams).values({ id: team, name: "Research team", ownerAccount: (await row(owner.hash)).accountId });
  const source = await child(owner, { team, role: "agent", limit: 25, limit_reset: "weekly", allowed_models: ["research-model"], rpm: 14, tpm: 1400 });
  return { owner, team, source };
}
const rules = () => agentPolicySchema.parse({ version: 1, caps: { per_day_usd: 5 }, models: { allow: ["research-model"] }, work_hours: { time_zone: "America/New_York", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", outside: "refuse" }, on_breach: "deny" });

test("default copy names fit the existing key-name limit", () => {
  expect(duplicateName("Research")).toBe("Research copy");
  expect(duplicateName("")).toBe("Unnamed agent copy");
  expect(duplicateName("x".repeat(100))).toHaveLength(100);
});

test("copies settings and only current rules; resets usage, Stop and links, and returns a fresh secret once", async () => {
  const { owner, source, team } = await fixture(), original = await row(source.hash);
  const now = new Date(), expiry = new Date(now.getTime() + 86_400_000);
  await h.ctx.db.update(keys).set({ project: "research", allowedIps: ["192.0.2.0/24"], scope: "inference", includeByokInLimit: true, routing: { provider: { lane: "attested" } }, guardrails: { pii: "redact" }, tracing: { sealed: "sealed-destination" }, payWithDefault: "NVDA", expiresAt: expiry, periodStart: now, spent: 200n, spentTotal: 900n, lastUsed: now, disabled: true }).where(eq(keys.keyHash, source.hash));
  const policy = rules(), sha256 = agentPolicySha256(policy), playbook = uid("duplicate-playbook-");
  await h.ctx.db.insert(playbooks).values({ id: playbook, accountId: original.accountId, name: "Research rules", spec: policy, sha256, version: 3, updatedBy: owner.hash });
  await h.ctx.db.insert(agentPolicies).values({ keyHash: source.hash, version: 1, spec: policy, sha256, killed: true, killedAt: now, killedReason: "Stopped for review", killUntil: expiry, playbookId: playbook, updatedBy: owner.hash });
  const prior = agentPolicySchema.parse({ version: 1, models: {}, on_breach: "deny", caps: { per_day_usd: 1 } });
  await h.ctx.db.insert(policyVersions).values([{ keyHash: source.hash, spec: prior, sha256: agentPolicySha256(prior), savedBy: owner.hash, source: "save" }, { keyHash: source.hash, spec: policy, sha256, savedBy: owner.hash, source: "playbook" }]);
  const approvalId = uid("duplicate-approval-");
  await h.ctx.db.insert(agentApprovals).values({ id: approvalId, keyHash: source.hash, intent: { kind: "action" }, intentHash: approvalId, maxCostPico: 0n, expiresAt: expiry, status: "approved" });
  await h.ctx.db.insert(spendAlerts).values({ id: uid("sa_"), accountId: original.accountId, keyHash: source.hash, kind: "threshold", thresholdUsd: 100n, window: "week", createdBy: owner.hash });
  const approvers = { mode: "specific_members", member_ids: [owner.hash] };
  await h.ctx.db.insert(kv).values([
    { key: approversKey(source.hash), value: approvers },
    { key: QUIET_PREFIX + source.hash, value: { hours: 6, enabled_at: now.toISOString(), notified_for: "previous", notices: [{ id: "old" }] } },
    { key: rotationKey(source.hash), value: { from: "prior-key", to: null, at: now.toISOString(), grace_ends_at: expiry.toISOString(), history_key_hash: "prior-key" } },
    { key: browserSessionKey(source.hash), value: { label: "Browser" } },
    { key: "telegram-link:17101", value: { account: original.accountId, key_hash: source.hash, uid: 17101, generation: "source-link", linked_at: now.toISOString() } },
  ]);
  const before = await row(source.hash), sourcePolicy = await policyRow(source.hash);
  const response = await duplicate(source, owner, { name: "  Independent research  " });
  expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await response.json(), copied = await row(result.data.hash);
  expect(copied.keyHash).not.toBe(source.hash); expect(copied.chainKeyHash).not.toBe(before.chainKeyHash); expect(copied.keyAddress).not.toBe(before.keyAddress);
  expect(copied.name).toBe("Independent research"); expect(copied.parentHash).toBe(owner.hash);
  for (const field of ["accountId", "project", "teamId", "scope", "management", "budget", "budgetReset", "rpm", "tpm", "allowedModels", "allowedIps", "includeByokInLimit", "payWithDefault", "routing", "guardrails", "tracing", "topup", "expiresAt"] as const) expect(copied[field], field).toEqual(before[field]);
  expect(copied.spent).toBe(0n); expect(copied.spentTotal).toBe(0n); expect(copied.periodStart).toBeNull(); expect(copied.lastUsed).toBeNull(); expect(copied.disabled).toBe(false);
  expect(await row(source.hash)).toEqual(before); expect(await policyRow(source.hash)).toEqual(sourcePolicy);
  expect(await policyRow(copied.keyHash)).toMatchObject({ spec: policy, sha256, version: 1, killed: false, killedAt: null, killedReason: null, killUntil: null, playbookId: null, updatedBy: owner.hash });
  const versions = await h.ctx.db.select().from(policyVersions).where(eq(policyVersions.keyHash, copied.keyHash));
  expect(versions).toHaveLength(1); expect(versions[0]).toMatchObject({ spec: policy, sha256, source: "save", savedBy: owner.hash });
  const events = await (await h.request(`/api/v1/agents/${copied.keyHash}/events`, { headers: owner.auth })).json();
  expect(events.data).toHaveLength(1); expect(events.data[0]).toMatchObject({ kind: "duplicated", reasons: [{ code: "agent_duplicated", message: "Copied from Research agent" }] }); expect(verifyEventChain(events.data)).toBe(true);
  expect(result.note).toBe("Copied from Research agent");
  expect((await h.ctx.db.select().from(teamMembers).where(eq(teamMembers.keyHash, copied.keyHash)))[0]).toMatchObject({ teamId: team, role: "agent", principalId: null });
  expect((await h.ctx.db.select().from(kv).where(eq(kv.key, approversKey(copied.keyHash))))[0].value).toEqual(approvers);
  expect((await h.ctx.db.select().from(kv).where(eq(kv.key, QUIET_PREFIX + copied.keyHash)))[0].value).toMatchObject({ hours: 6, notified_for: null, notices: [] });
  for (const key of [rotationKey(copied.keyHash), browserSessionKey(copied.keyHash)]) expect(await h.ctx.db.select().from(kv).where(eq(kv.key, key))).toEqual([]);
  const links = await h.ctx.db.select().from(kv).where(like(kv.key, "telegram-link:%"));
  expect(links.some(link => (link.value as { key_hash: string }).key_hash === copied.keyHash)).toBe(false);
  expect(await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.keyHash, copied.keyHash))).toEqual([]);
  expect(await h.ctx.db.select().from(agentSessions).where(eq(agentSessions.keyHash, copied.keyHash))).toEqual([]);
  expect(await h.ctx.db.select().from(spendAlerts).where(eq(spendAlerts.keyHash, copied.keyHash))).toEqual([]);
  expect((await h.request("/api/v1/models", { headers: { authorization: `Bearer ${result.key}`, "x-forwarded-for": "192.0.2.10" } })).status).toBe(200);
  const get = await h.request(`/api/v1/keys/${copied.keyHash}`, { headers: owner.auth });
  expect(JSON.stringify(await get.json())).not.toContain(result.key);
});

test("rule changes, approvers, quiet settings and stopping either agent remain independent", async () => {
  const { owner, source } = await fixture(), policy = agentPolicySchema.parse({ version: 1, models: {}, on_breach: "deny", caps: { per_day_usd: 5 } });
  expect((await h.request(`/api/v1/agents/${source.hash}/policy`, { method: "PUT", headers: owner.auth, json: policy })).status).toBe(200);
  await h.ctx.db.insert(kv).values([{ key: approversKey(source.hash), value: { mode: "owners_and_admins", member_ids: [] } }, { key: QUIET_PREFIX + source.hash, value: { hours: 6 } }]);
  const result = await (await duplicate(source, owner)).json(), copy = result.data.hash;
  expect(result.data.name).toBe("Research agent copy");
  const stop = async (hash: string) => { expect((await h.request(`/api/v1/agents/${hash}/kill`, { method: "POST", headers: owner.auth, json: { reason: "Owner stopped" } })).status).toBe(200); };
  await stop(source.hash); expect((await policyRow(copy)).killed).toBe(false);
  await h.request(`/api/v1/agents/${source.hash}/resume`, { method: "POST", headers: owner.auth });
  await stop(copy); expect((await policyRow(source.hash)).killed).toBe(false);
  const changed = agentPolicySchema.parse({ version: 1, models: {}, on_breach: "deny", caps: { per_day_usd: 2 } });
  expect((await h.request(`/api/v1/agents/${copy}/policy`, { method: "PUT", headers: owner.auth, json: changed })).status).toBe(200);
  expect((await policyRow(source.hash)).spec).toEqual(policy);
  await h.ctx.db.update(kv).set({ value: { mode: "owners", member_ids: [] } }).where(eq(kv.key, approversKey(copy)));
  await h.ctx.db.update(kv).set({ value: { hours: null } }).where(eq(kv.key, QUIET_PREFIX + copy));
  expect((await h.ctx.db.select().from(kv).where(eq(kv.key, approversKey(source.hash))))[0].value).toEqual({ mode: "owners_and_admins", member_ids: [] });
  expect((await h.ctx.db.select().from(kv).where(eq(kv.key, QUIET_PREFIX + source.hash)))[0].value).toEqual({ hours: 6 });
});

test("auth matrix: management and same-team owner/admin only; cross-account/team and scoped/session keys refused", async () => {
  const { owner, source, team } = await fixture();
  const admin = await child(owner, { team, role: "admin" }), teamOwner = await child(owner, { team, role: "admin" });
  await h.ctx.db.update(teamMembers).set({ role: "owner" }).where(eq(teamMembers.keyHash, teamOwner.hash));
  for (const caller of [owner, admin, teamOwner]) expect((await duplicate(source, caller)).status).toBe(201);
  for (const role of ["member", "dev", "viewer", "agent"]) expect((await duplicate(source, await child(owner, { team, role }))).status).toBe(403);
  const stranger = await h.fundedKey(); expect((await duplicate(source, stranger)).status).toBe(404);
  const otherTeam = uid("other-team-"); await h.ctx.db.insert(teams).values({ id: otherTeam, name: "Other team", ownerAccount: (await row(owner.hash)).accountId });
  expect((await duplicate(source, await child(owner, { team: otherTeam, role: "admin" }))).status).toBe(403);
  for (const scope of ["read", "inference"]) expect((await duplicate(source, await child(owner, { scope }))).status).toBe(403);
  expect((await h.request(`/api/v1/agents/${source.hash}/duplicate`, { method: "POST", json: {} })).status).toBe(401);
  expect((await duplicate({ hash: "absent", auth: {} }, owner)).status).toBe(404);
  const session = await child(owner, { team, role: "admin" });
  await h.ctx.db.insert(agentSessions).values({ id: uid("as_"), accountId: (await row(owner.hash)).accountId, parentKeyHash: owner.hash, keyHash: session.hash, expiresAt: new Date(Date.now() + 60_000) });
  expect((await duplicate(source, session)).status).toBe(403); expect((await duplicate(session, owner)).status).toBe(403);
  const elevated = await child(owner, { team, management: true }); expect((await duplicate(elevated, admin)).status).toBe(403);
  expect((await duplicate(teamOwner, admin)).status).toBe(403);
  // Store-level recheck protects against stale principal objects after a concurrent role/expiry change.
  const stale = await row(admin.hash); await h.ctx.db.update(teamMembers).set({ role: "member" }).where(eq(teamMembers.keyHash, admin.hash));
  await expect(duplicateAgent(h.ctx, stale, source.hash)).rejects.toThrow(/owner or admin/);
  for (const change of [{ disabled: true }, { disabled: false, expiresAt: new Date(Date.now() - 1000) }]) {
    await h.ctx.db.update(keys).set(change).where(eq(keys.keyHash, teamOwner.hash)); expect((await duplicate(source, teamOwner)).status).toBe(401);
  }
});

test("strict name validation, team budget guard and unchanged existing reads", async () => {
  const { owner, source, team } = await fixture();
  const before = await (await h.request(`/api/v1/keys/${source.hash}`, { headers: owner.auth })).text();
  for (const body of [{ name: " " }, { name: "x".repeat(101) }, { name: 42 }, { management: true }]) expect((await duplicate(source, owner, body)).status).toBe(400);
  await h.ctx.db.update(teams).set({ budget: (await row(source.hash)).budget }).where(eq(teams.id, team));
  expect((await duplicate(source, owner)).status).toBe(409);
  expect(await (await h.request(`/api/v1/keys/${source.hash}`, { headers: owner.auth })).text()).toBe(before);
});

test("off/default cases: no writes with rulebooks disabled; no alerts while security alerts are off", async () => {
  const { owner, source } = await fixture();
  const count = (await h.ctx.db.select().from(keys)).length;
  const old = h.ctx.cfg.agentPolicyEnabled;
  h.ctx.cfg.agentPolicyEnabled = false;
  try { expect((await duplicate(source, owner)).status).toBe(404); } finally { h.ctx.cfg.agentPolicyEnabled = old; }
  expect((await h.ctx.db.select().from(keys)).length).toBe(count);
  const before = await h.ctx.db.select().from(kv).where(like(kv.key, "security-alerts:event:%"));
  expect((await duplicate(source, owner)).status).toBe(201);
  expect(await h.ctx.db.select().from(kv).where(like(kv.key, "security-alerts:event:%"))).toEqual(before);
});

test("Agent duplicated uses the existing security-alert recording and notification preference path", async () => {
  const { owner, source } = await fixture(), account = (await row(owner.hash)).accountId;
  h.ctx.cfg.securityAlertsEnabled = true;
  try {
    expect((await duplicate(source, owner)).status).toBe(201);
    const notices = await h.ctx.db.select().from(kv).where(like(kv.key, "security-alerts:event:%"));
    const notice = notices.find(r => (r.value as any).account === account && (r.value as any).title.startsWith("Agent duplicated"));
    expect(notice?.value).toMatchObject({ account, state: "pending" }); expect((notice?.value as any).title).toContain(keyActor("Research agent").slice(3));
    await runSecurityAlerts(h.ctx);
    expect((await (await h.request("/api/v1/inbox", { headers: owner.auth })).json()).data.some((n: any) => n.title.startsWith("Agent duplicated"))).toBe(true);
    const preferences = await readPreferences(h.ctx.db, account);
    preferences.channels.security_alerts = { inbox: false, telegram: false };
    expect((await h.request("/api/v1/account/notifications", { method: "PUT", headers: owner.auth, json: preferences })).status).toBe(200);
    expect((await (await h.request("/api/v1/inbox", { headers: owner.auth })).json()).data.some((n: any) => n.title.startsWith("Agent duplicated"))).toBe(false);
    const oldIds = new Set(notices.map(n => n.key));
    expect((await duplicate(source, owner)).status).toBe(201);
    const muted = (await h.ctx.db.select().from(kv).where(like(kv.key, "security-alerts:event:%"))).filter(n => !oldIds.has(n.key));
    expect(muted.some(n => (n.value as any).title.startsWith("Agent duplicated") && (n.value as any).state === "muted")).toBe(true);
  } finally { h.ctx.cfg.securityAlertsEnabled = false; }
});

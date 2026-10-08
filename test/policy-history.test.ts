// D144: runs with Postgres/Redis or plain Bun's single-connection PGlite.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { asc, eq, sql } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { agentPolicySha256, type AgentPolicy } from "../src/agents/policy.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { policyVersions } from "../src/agents/policy-versions-schema.ts";
import { policyHistory, rulebookDiff } from "../src/agents/policy-history.ts";
import { eventJson, setPolicy, verifyEventChain } from "../src/agents/store.ts";
import { keys } from "../src/db/schema.ts";

let h: Harness;
const base: AgentPolicy = { version: 1, models: {}, caps: { per_request_usd: 5 }, on_breach: "deny" };
type Key = { hash: string; auth: Record<string, string> };
const path = (key: Key) => `/api/v1/agents/${key.hash}/policy`;
const put = (owner: Key, key: Key, spec = base) => h.request(path(key), { method: "PUT", headers: owner.auth, json: spec });
const restore = (owner: Key, key: Key, sha256 = agentPolicySha256(base)) => h.request(path(key) + "/restore", { method: "POST", headers: owner.auth, json: { sha256 } });
const versions = async (key: Key) => h.ctx.db.select().from(policyVersions).where(eq(policyVersions.keyHash, key.hash)).orderBy(asc(policyVersions.id));
const events = async (key: Key) => h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, key.hash)).orderBy(asc(agentPolicyEvents.id));
async function child(owner: Key, extra = {}) {
  const r = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Rulebook agent", ...extra } });
  expect(r.status).toBe(201); const body = await r.json();
  return { hash: body.data.hash as string, auth: { authorization: `Bearer ${body.key}` } };
}
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });

test("sentence diffs preserve exact amounts, add/remove changed lines and omit unchanged ones", () => {
  expect(rulebookDiff(base, { ...base, caps: { per_request_usd: 0.005 }, models: { deny: ["model/one"] } })).toEqual({
    removed: ["Up to $5 a request"], added: ["Up to $0.005 a request", "Never uses these models: model/one"],
  });
  expect(rulebookDiff(base, base)).toEqual({ added: [], removed: [] });
  expect(rulebookDiff(null, base).added).toContain("Up to $5 a request");
});

test("every save, including identical saves, retains a version; restore round trip keeps Stop and verifies the chain", async () => {
  const owner = await h.fundedKey(), agent = await child(owner);
  expect((await put(owner, agent)).status).toBe(200);
  expect((await put(owner, agent)).status).toBe(200);
  const next = { ...base, models: { deny: ["model/two"] } };
  expect((await put(owner, agent, next)).status).toBe(200);
  expect((await h.request(`/api/v1/agents/${agent.hash}/kill`, { method: "POST", headers: owner.auth, json: { reason: "Review rules" } })).status).toBe(200);
  const restored = await restore(owner, agent); expect(restored.status).toBe(200);
  expect((await restored.json()).data.policy).toEqual(base);
  const rows = await versions(agent);
  expect(rows.map(row => row.source)).toEqual(["save", "save", "save", "restore"]);
  expect(rows.map(row => row.savedBy)).toEqual(Array(4).fill(owner.hash));
  expect(rows.at(-1)?.sha256).toBe(agentPolicySha256(base));
  for (const row of rows) expect(row.sha256).toBe(agentPolicySha256(row.spec));
  const [current] = await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, agent.hash));
  expect(current.killed).toBe(true); expect(current.killedReason).toBe("Review rules");
  expect(verifyEventChain((await events(agent)).map(eventJson))).toBe(true);
  const response = await h.request(path(agent) + "/versions", { headers: owner.auth });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const data = (await response.json()).data;
  expect(data.map((row: any) => row.id)).toEqual(rows.map(row => row.id).reverse());
  expect(data[0].diff.removed).toEqual(["Never uses these models: model/two"]);
});

test("approve-and-allow writes its exact revised spec and principal in the approval transaction", async () => {
  const owner = await h.fundedKey(), agent = await child(owner);
  const spec: AgentPolicy = { ...base, actions: { allow: ["payment.send"], approval_above_usd: 1, per_action_usd: 5 } };
  await put(owner, agent, spec);
  const check = await h.request("/api/v1/guard/decide", { method: "POST", headers: agent.auth, json: { action: "payment.send", amount_usd: "2.001" } });
  const decision = (await check.json()).data; expect(decision.decision).toBe("approval_required");
  const response = await h.request(`/api/v1/agents/approvals/${decision.approval_id}/approve-and-allow`, { method: "POST", headers: owner.auth, json: { policy_sha256: agentPolicySha256(spec) } });
  expect(response.status).toBe(200);
  const rows = await versions(agent); expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ savedBy: owner.hash, source: "approve_and_allow", spec: { ...spec, actions: { ...spec.actions, approval_above_usd: 2.01 } } });
  expect(rows[1].sha256).toBe(agentPolicySha256(rows[1].spec));
  expect(verifyEventChain((await events(agent)).map(eventJson))).toBe(true);
});

test("follow, playbook update, stop following and delete-copy each retain the copied rules", async () => {
  const owner = await h.fundedKey(), agent = await child(owner);
  const made = await h.request("/api/v1/playbooks", { method: "POST", headers: owner.auth, json: { name: "History rules", policy: base } });
  expect(made.status).toBe(201); const id = (await made.json()).data.id;
  const follow = (playbook_id: string | null) => h.request(`/api/v1/agents/${agent.hash}/playbook`, { method: "POST", headers: owner.auth, json: { playbook_id } });
  expect((await follow(id)).status).toBe(200);
  expect((await restore(owner, agent)).status).toBe(409);
  const next = { ...base, caps: { per_request_usd: 2 } };
  expect((await h.request(`/api/v1/playbooks/${id}`, { method: "PUT", headers: owner.auth, json: { policy: next } })).status).toBe(200);
  expect((await follow(null)).status).toBe(200);
  expect((await follow(id)).status).toBe(200);
  expect((await h.request(`/api/v1/playbooks/${id}?unlink=copy`, { method: "DELETE", headers: owner.auth })).status).toBe(200);
  const rows = await versions(agent); expect(rows).toHaveLength(5);
  expect(rows.map(row => row.source)).toEqual(Array(5).fill("playbook"));
  expect(rows.map(row => row.spec)).toEqual([base, next, next, next, next]);
  expect((await restore(owner, agent)).status).toBe(200);
  expect(verifyEventChain((await events(agent)).map(eventJson))).toBe(true);
});

test("unknown, foreign or corrupt versions are refused; deletion keeps history available for restore", async () => {
  const owner = await h.fundedKey(), agent = await child(owner), other = await child(owner);
  await put(owner, agent);
  expect((await restore(owner, other)).status).toBe(404);
  expect((await restore(owner, agent, "f".repeat(64))).status).toBe(404);
  expect((await h.request(path(agent) + "/restore", { method: "POST", headers: owner.auth, json: { sha256: "bad" } })).status).toBe(400);
  await h.ctx.db.update(policyVersions).set({ spec: { ...base, caps: {} } }).where(eq(policyVersions.keyHash, agent.hash));
  expect((await restore(owner, agent)).status).toBe(409);
  expect(await versions(agent)).toHaveLength(1); expect(await events(agent)).toHaveLength(1);
  await h.ctx.db.update(policyVersions).set({ spec: base }).where(eq(policyVersions.keyHash, agent.hash));
  expect((await h.request(path(agent), { method: "DELETE", headers: owner.auth })).status).toBe(200);
  expect(await versions(agent)).toHaveLength(1);
  expect((await restore(owner, agent)).status).toBe(200);
});

test("failed version insertion rolls back the policy and its already-appended event", async () => {
  const owner = await h.fundedKey(); await put(owner, owner);
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  await h.ctx.db.execute(sql`alter table policy_versions add constraint history_failure_check check (source <> 'save') not valid`);
  try {
    await expect(setPolicy(h.ctx.db, key.accountId, owner.hash, { ...base, caps: {} }, owner.hash)).rejects.toThrow();
    expect(await versions(owner)).toHaveLength(1); expect(await events(owner)).toHaveLength(1);
    const [current] = await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, owner.hash));
    expect(current.spec).toEqual(base);
  } finally { await h.ctx.db.execute(sql`alter table policy_versions drop constraint history_failure_check`); }
});

test("history caps at 50, orders repeated revisions by id, and compares the last with the hidden predecessor", async () => {
  const owner = await h.fundedKey();
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  for (let n = 1; n <= 52; n++) await setPolicy(h.ctx.db, key.accountId, owner.hash, { ...base, caps: { per_request_usd: n } }, owner.hash);
  const page = await policyHistory(h.ctx.db, owner.hash); expect(page).toHaveLength(50);
  expect(page[0].spec.caps.per_request_usd).toBe(52); expect(page[49].spec.caps.per_request_usd).toBe(3);
  expect(page[49].diff).toEqual({ added: ["Up to $3 a request"], removed: ["Up to $2 a request"] });
});

test("management and same-team admin permitted; absent auth, other accounts, teams, viewers, inference and sessions refused", async () => {
  const owner = await h.fundedKey(), stranger = await h.fundedKey();
  const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Rule reviewers" } })).json()).data.id;
  const otherTeam = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Other reviewers" } })).json()).data.id;
  const agent = await child(owner, { team, role: "agent" }), admin = await child(owner, { team, role: "admin" });
  const viewer = await child(owner, { team, role: "viewer" }), wrong = await child(owner, { team: otherTeam, role: "admin" });
  const inference = await child(owner, { scope: "inference" });
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  await put(owner, agent);
  for (const [auth, status] of [[undefined, 401], [stranger.auth, 404], [agent.auth, 403], [viewer.auth, 403], [wrong.auth, 403], [inference.auth, 403], [{ authorization: `Bearer ${session.key}` }, 403]] as const) {
    for (const suffix of ["/versions", "/restore"]) expect((await h.request(path(agent) + suffix, { method: suffix === "/restore" ? "POST" : "GET", headers: auth, json: suffix === "/restore" ? { sha256: agentPolicySha256(base) } : undefined })).status).toBe(status);
  }
  expect((await h.request(path(agent) + "/versions", { headers: admin.auth })).status).toBe(200);
  expect((await restore(admin, agent)).status).toBe(200);
  expect((await versions(agent)).at(-1)?.savedBy).toBe(admin.hash);
});

test("existing agent flag defaults off and hides both new routes", async () => {
  const off = await startRouter();
  try {
    expect(off.ctx.cfg.agentPolicyEnabled).toBe(false);
    const owner = await off.fundedKey();
    for (const suffix of ["/versions", "/restore"]) {
      expect((await off.request(path(owner) + suffix, { method: suffix === "/restore" ? "POST" : "GET", headers: owner.auth, json: suffix === "/restore" ? { sha256: agentPolicySha256(base) } : undefined })).status).toBe(404);
    }
  } finally { await off.close(); }
});

test("migration backfills each current rulebook, including playbook copies, with its original digest and update metadata", async () => {
  const isolated = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } });
  try {
    const owner = await isolated.fundedKey(), follower = await isolated.fundedKey();
    const bookResponse = await isolated.request("/api/v1/playbooks", { method: "POST", headers: follower.auth, json: { name: "Existing rules", policy: base } });
    expect(bookResponse.status).toBe(201); const bookId = (await bookResponse.json()).data.id;
    const at = new Date("2026-01-01T00:00:00.000Z");
    for (const [key, playbookId] of [[owner, null], [follower, bookId]] as const) await isolated.ctx.db.insert(agentPolicies).values({ keyHash: key.hash, version: 1, spec: base, sha256: agentPolicySha256(base), updatedAt: at, updatedBy: key.hash, playbookId });
    // Execute the migration's actual backfill statement against pre-existing current rows.
    const migration = readFileSync(new URL("../drizzle/0058_policy_versions.sql", import.meta.url), "utf8");
    await isolated.ctx.db.execute(sql.raw(migration.slice(migration.indexOf("INSERT INTO policy_versions"))));
    const rows = await isolated.ctx.db.select().from(policyVersions); expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ spec: base, sha256: agentPolicySha256(base), savedAt: at, savedBy: row.keyHash, source: row.keyHash === owner.hash ? "save" : "playbook" });
    }
  } finally { await isolated.close(); }
});

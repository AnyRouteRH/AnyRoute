import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { amountThresholdChange } from "../src/agents/approve-and-allow.ts";
import { agentPolicySchema, agentPolicySha256 } from "../src/agents/policy.ts";
import { eventJson, verifyEventChain } from "../src/agents/store.ts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });
const policy = agentPolicySchema.parse({ version: 1, models: {}, caps: { per_request_usd: 50, per_day_usd: 100, per_week_usd: 200 }, actions: { allow: ["payment.send"], per_action_usd: 50, per_day_usd: 100, max_per_hour: 10, approval_above_usd: 5 }, approval: { above_usd: 0.000000001 }, on_breach: "deny" });
type Key = { hash: string; auth: Record<string, string> };
const path = (id: string) => `/api/v1/agents/approvals/${id}/approve-and-allow`;
const preview = (k: Key, id: string) => h.request(path(id), { headers: k.auth });
const confirm = (k: Key, id: string, hash = agentPolicySha256(policy)) => h.request(path(id), { method: "POST", headers: k.auth, json: { policy_sha256: hash } });
async function setup(p = policy) {
  const owner = await h.fundedKey();
  const child = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Payment agent" } })).json();
  const agent = { hash: child.data.hash, auth: { authorization: `Bearer ${child.key}` } };
  expect((await h.request(`/api/v1/agents/${agent.hash}/policy`, { method: "PUT", headers: owner.auth, json: p })).status).toBe(200);
  return { owner, agent };
}
const action = (agent: Key, id?: string) => h.request("/api/v1/guard/decide", { method: "POST", headers: agent.auth, json: { action: "payment.send", amount_usd: "12.001", ...(id ? { approval_id: id } : {}) } });
async function waiting(agent: Key) {
  const response = await action(agent), data = (await response.json()).data;
  expect(data.decision).toBe("approval_required"); return data.approval_id as string;
}
const rowFor = async (hash: string) => (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, hash)))[0];
test("rounds up using integer cents and changes only the selected threshold", () => {
  const result = amountThresholdChange(policy, { kind: "action", action: "payment.send", amount_pico: "12001000000000" }, 12001000000000n);
  expect(result.after_usd).toBe("12.01");
  expect(result.policy).toEqual({ ...policy, actions: { ...policy.actions, approval_above_usd: 12.01 } });
  expect(amountThresholdChange(policy, { kind: "inference", model: "model/one", lane: "public", tools: [], est_cost_pico: "1001" }, 1001n).after_usd).toBe("0.01");
  expect(() => amountThresholdChange(policy, { kind: "mcp_tool", name: "read" }, 10n)).toThrow();
});
test("atomic approval, exact preview, caps preserved, concurrent confirm once and policy chain verifies", async () => {
  const { owner, agent } = await setup(), id = await waiting(agent);
  const before = await rowFor(agent.hash);
  const response = await preview(owner, id); expect(response.status).toBe(200);
  const change = (await response.json()).data;
  expect(change).toEqual({ field: "actions.approval_above_usd", before_usd: "5", after_usd: "12.01", amount_usd: "12.001", policy_sha256: before.sha256 });
  expect((await rowFor(agent.hash)).sha256).toBe(before.sha256);
  const results = await Promise.all([confirm(owner, id, change.policy_sha256), confirm(owner, id, change.policy_sha256)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  const saved = await rowFor(agent.hash);
  expect(saved.spec).toEqual({ ...policy, actions: { ...policy.actions, approval_above_usd: 12.01 } });
  expect(saved.version).toBe(policy.version); expect(saved.sha256).toBe(agentPolicySha256(saved.spec));
  const [approval] = await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id));
  expect(approval.status).toBe("approved"); expect(approval.decidedBy).toBe(owner.hash);
  expect((await (await action(agent, id)).json()).data.decision).toBe("allow");
  expect((await (await action(agent, id)).json()).data.decision).toBe("deny");
  expect((await confirm(owner, id, saved.sha256)).status).toBe(409);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, agent.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(events.filter(e => e.kind === "policy_set")).toHaveLength(2);
  expect(events.filter(e => e.kind === "approval_approved")).toHaveLength(1);
  expect(verifyEventChain(events.map(eventJson))).toBe(true);
});
test("model amount approval raises only approval.above_usd and subsequent calls need no approval", async () => {
  const { owner, agent } = await setup();
  const chat = (id?: string) => h.request("/api/v1/chat/completions", { method: "POST", headers: { ...agent.auth, ...(id ? { "x-agent-approval": id } : {}) }, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "Hello" }], max_tokens: 32 } });
  const response = await chat(); expect(response.status).toBe(403); const id = (await response.json()).error.metadata.approval_id;
  expect((await confirm(owner, id)).status).toBe(200);
  const saved = await rowFor(agent.hash);
  expect(saved.spec).toEqual({ ...policy, approval: { above_usd: 0.01 } });
  expect((await chat(id)).status).toBe(200); expect((await chat(id)).status).toBe(403);
  expect((await chat()).status).toBe(200);
});
test("expired, denied, already approved, stale confirmation, unrelated account and inference auth refused", async () => {
  const { owner, agent } = await setup(), stranger = await h.fundedKey(), id = await waiting(agent);
  expect((await confirm(agent, id)).status).toBe(403); expect((await preview(agent, id)).status).toBe(403);
  expect((await confirm(stranger, id)).status).toBe(404);
  expect((await h.request(path(id), { method: "POST", json: {} })).status).toBe(401);
  expect((await confirm(owner, id, "f".repeat(64))).status).toBe(409);
  expect((await rowFor(agent.hash)).spec).toEqual(policy);
  const inference = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Inference only", scope: "inference" } })).json();
  expect(inference.key).toBeDefined();
  expect((await confirm({ hash: inference.data.hash, auth: { authorization: `Bearer ${inference.key}` } }, id)).status).toBe(403);
  for (const values of [{ expiresAt: new Date(0) }, { status: "denied" as const, expiresAt: new Date(Date.now() + 900000) }, { status: "approved" as const }]) {
    await h.ctx.db.update(agentApprovals).set(values).where(eq(agentApprovals.id, id));
    expect((await confirm(owner, id)).status).toBe(409);
  }
});
test("call-count-only and mixed reasons refuse without changing policy or approval", async () => {
  for (const threshold of [1, 0.000000001]) {
    const p = agentPolicySchema.parse({ ...policy, approval: { above_usd: threshold, above_calls_per_hour: 1 } });
    const { owner, agent } = await setup(p);
    const call = () => h.request("/api/v1/chat/completions", { method: "POST", headers: agent.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "Hello" }], max_tokens: 32 } });
    const first = await call();
    if (first.status === 403) {
      const id = (await first.json()).error.metadata.approval_id;
      await h.request(`/api/v1/agents/approvals/${id}/approve`, { method: "POST", headers: owner.auth });
      await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...agent.auth, "x-agent-approval": id }, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "Hello" }], max_tokens: 32 } });
    } else expect(first.status).toBe(200);
    const response = await call(); expect(response.status).toBe(403); const id = (await response.json()).error.metadata.approval_id;
    expect((await preview(owner, id)).status).toBe(409); expect((await confirm(owner, id, agentPolicySha256(p))).status).toBe(409);
    expect((await rowFor(agent.hash)).spec).toEqual(p);
    expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0].status).toBe("pending");
  }
});
test("playbook followers get clear 409 with name and link id; neither rules nor approval changes", async () => {
  const { owner, agent } = await setup(), id = await waiting(agent);
  const book = await (await h.request("/api/v1/playbooks", { method: "POST", headers: owner.auth, json: { name: "Payment rules", policy } })).json();
  expect(book.data.id).toBeDefined();
  expect((await h.request(`/api/v1/agents/${agent.hash}/playbook`, { method: "POST", headers: owner.auth, json: { playbook_id: book.data.id } })).status).toBe(200);
  const response = await confirm(owner, id); expect(response.status).toBe(409);
  const error = (await response.json()).error;
  expect(error.message).toBe("This agent follows the playbook Payment rules; change it there.");
  expect(error.metadata.playbook_id).toBe(book.data.id);
  expect((await rowFor(agent.hash)).spec).toEqual(policy);
});
test("off/default hides both preview and confirmation", async () => {
  const off = await startRouter();
  try { const k = await off.fundedKey(); for (const method of ["GET", "POST"]) expect((await off.request(path("absent"), { method, headers: k.auth })).status).toBe(404); }
  finally { await off.close(); }
});

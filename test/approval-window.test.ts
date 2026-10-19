// K194: real routes in both external-services and single-connection CI modes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { approvalWindowKey, approvalWindowView, windowBinding, windowText } from "../src/agents/approval-window.ts";
import { agentPolicySchema } from "../src/agents/policy.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { eventJson, verifyEventChain } from "../src/agents/store.ts";
import { kv } from "../src/db/schema.ts";
import { consumeCode, readLink, removeLink } from "../src/telegram/linking.ts";
import { deliverTelegramApprovals, handleLinkedUpdate, notificationKey } from "../src/telegram/delivery.ts";
import { TelegramApi, type TgUpdate } from "../src/services/telegram.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
let h: Harness;
const token = "123456789:AAFixtureTokenFixtureToken0123456789";
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true", AGENT_TEAM_APPROVERS_ENABLED: "true", AGENT_APPROVAL_CONTEXT_ENABLED: "true", INFERENCE_KEYS_ENABLED: "true", SECURITY_ALERTS_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: token } }); });
afterAll(async () => { await h?.close(); });
type Key = { hash: string; auth: Record<string, string> };
const policy = agentPolicySchema.parse({ version: 1, models: {}, caps: { per_request_usd: 50 }, approval: { above_usd: 0.000000001 }, actions: { allow: ["payment.send", "payment.refund"], per_action_usd: 50, per_day_usd: 100, max_per_hour: 10, approval_above_usd: 5 }, on_breach: "deny" });
const path = (id: string) => `/api/v1/agents/approvals/${id}/approve-hour`;
const windowsPath = (hash: string) => `/api/v1/agents/${hash}/approval-windows`;
async function fixture(p = policy) {
  const owner = await h.fundedKey();
  const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Approval team" } })).json()).data.id;
  const create = async (role: string, extra = {}): Promise<Key> => {
    const res = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Review agent", team, role, ...extra } });
    expect(res.status).toBe(201); const { data, key } = await res.json(); return { hash: data.hash, auth: { authorization: `Bearer ${key}` } };
  };
  const agent = await create("agent");
  expect((await h.request(`/api/v1/agents/${agent.hash}/policy`, { method: "PUT", headers: owner.auth, json: p })).status).toBe(200);
  return { owner, agent, create };
}
const action = (agent: Key, extra = {}) => h.request("/api/v1/guard/decide", { method: "POST", headers: agent.auth, json: { action: "payment.send", amount_usd: "12", target: "supplier-one", ...extra } });
const actionData = async (agent: Key, extra = {}) => (await (await action(agent, extra)).json()).data;
async function waiting(agent: Key) { const row = await actionData(agent); expect(row.decision).toBe("approval_required"); return row.approval_id as string; }
async function grant(owner: Key, id: string) {
  const response = await h.request(path(id), { headers: owner.auth }); expect(response.status).toBe(200);
  const { confirmation } = (await response.json()).data;
  return h.request(path(id), { method: "POST", headers: owner.auth, json: { confirmation } });
}
async function setUntil(agent: Key, until: string) {
  const [saved] = await h.ctx.db.select().from(kv).where(eq(kv.key, approvalWindowKey(agent.hash)));
  const data = saved.value as { windows: { until: string }[] };
  await h.ctx.db.update(kv).set({ value: { windows: data.windows.map(w => ({ ...w, until })) } }).where(eq(kv.key, saved.key));
}
const chat = (agent: Key, extra = {}) => h.request("/api/v1/chat/completions", { method: "POST", headers: agent.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "Hello" }], max_tokens: 32, ...extra } });

test("binding matches model/lane/tool set or action/target; costs and action detail digests may vary", () => {
  const intent = { kind: "inference", model: "model/one", lane: "public", tools: ["search", "read"], max_output_tokens: 32, est_cost_pico: "20" };
  const binding = windowBinding(intent);
  expect(windowBinding({ ...intent, tools: ["read", "search", "read"], max_output_tokens: 64, est_cost_pico: "40" })).toBe(binding);
  for (const change of [{ model: "model/two" }, { lane: "attested" }, { tools: ["read"] }]) expect(windowBinding({ ...intent, ...change })).not.toBe(binding);
  const a = { kind: "action", action: "payment.send", target: "supplier-one", amount_pico: "20" };
  expect(windowBinding({ ...a, amount_pico: "40", details_sha256: "sha256:" + "a".repeat(64) })).toBe(windowBinding(a));
  expect(windowBinding({ ...a, target: "supplier-two" })).not.toBe(windowBinding(a));
  const now = new Date("2026-10-19T00:00:00Z");
  expect(windowText("2026-10-19T00:47:00Z", now)).toBe("Approved for the next 47 minutes");
});
test("opt-in grants exactly one hour without changing rules; repeated matches vary amount but not target/action/agent", async () => {
  const { owner, agent, create } = await fixture(), id = await waiting(agent);
  const before = (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, agent.hash)))[0];
  await h.ctx.db.update(agentApprovals).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(agentApprovals.id, id));
  const started = Date.now(), response = await grant(owner, id); expect(response.status).toBe(200);
  const result = (await response.json()).data, window = result.window;
  expect(result.approval.expires_at).toBe(window.until);
  expect(Date.parse(window.until) - started).toBeGreaterThanOrEqual(3_600_000);
  expect(Date.parse(window.until) - Date.now()).toBeLessThanOrEqual(3_600_000);
  expect((await actionData(agent)).decision).toBe("allow");
  expect((await actionData(agent, { approval_id: id, amount_usd: "13", details_sha256: "sha256:" + "b".repeat(64) })).decision).toBe("allow");
  for (const extra of [{ target: "supplier-two" }, { action: "payment.refund" }]) expect((await actionData(agent, extra)).decision).toBe("approval_required");
  const other = await create("agent");
  await h.request(`/api/v1/agents/${other.hash}/policy`, { method: "PUT", headers: owner.auth, json: policy });
  expect((await actionData(other)).decision).toBe("approval_required");
  const after = (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, agent.hash)))[0];
  expect(after).toEqual(before);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, agent.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(events.some(e => e.kind === "approval_window_started")).toBe(true);
  expect(events.filter(e => e.kind === "approval_used")).toHaveLength(2);
  expect(verifyEventChain(events.map(eventJson))).toBe(true);
  const [security] = await h.ctx.db.select().from(kv).where(eq(kv.key, `security-alerts:event:approval-window:${id}`));
  expect((security.value as { title: string }).title).toContain("next hour");
});
test("expiry is checked on admission and status/context show the remaining minutes only while active", async () => {
  const { owner, agent } = await fixture(), id = await waiting(agent); expect((await grant(owner, id)).status).toBe(200);
  const until = new Date(Date.now() + 46.5 * 60_000).toISOString(); await setUntil(agent, until);
  const status = (await (await h.request(`/api/v1/agents/${agent.hash}/status`, { headers: owner.auth })).json()).data;
  expect(status.approval_windows[0].text).toBe("Approved for the next 47 minutes");
  const approvals = (await (await h.request("/api/v1/agents/approvals?status=approved", { headers: owner.auth })).json()).data;
  expect(approvals.find((r: any) => r.id === id).approval_context.join(" ")).toContain("Approved for the next 47 minutes");
  expect(await approvalWindowView(h.ctx.db, agent.hash, new Date(until))).toEqual([]);
  await setUntil(agent, new Date(0).toISOString());
  expect((await actionData(agent)).decision).toBe("approval_required");
  expect((await (await h.request(windowsPath(agent.hash), { headers: owner.auth })).json()).data).toEqual([]);
  const expired = (await (await h.request(`/api/v1/agents/${agent.hash}/status`, { headers: owner.auth })).json()).data;
  expect(expired.approval_windows).toBeUndefined();
});
test("ending early withdraws the unused original approval and records a security change", async () => {
  const { owner, agent } = await fixture(), id = await waiting(agent); expect((await grant(owner, id)).status).toBe(200);
  expect((await h.request(windowsPath(agent.hash) + '/' + id, { method: "DELETE", headers: owner.auth })).status).toBe(200);
  expect((await actionData(agent)).decision).toBe("approval_required");
  expect((await actionData(agent, { approval_id: id })).decision).toBe("deny");
  expect((await h.request(windowsPath(agent.hash) + '/' + id, { method: "DELETE", headers: owner.auth })).status).toBe(404);
  const [security] = await h.ctx.db.select().from(kv).where(eq(kv.key, `security-alerts:event:approval-window-ended:${id}`));
  expect((security.value as { title: string }).title).toContain("early");
});
test("per-action amount, daily amount, action-count caps and Stop remain enforced", async () => {
  for (const actions of [{ per_action_usd: 15 }, { per_day_usd: 24 }, { max_per_hour: 1 }]) {
    const { owner, agent } = await fixture(agentPolicySchema.parse({ ...policy, actions: { ...policy.actions, ...actions } }));
    const id = await waiting(agent); expect((await grant(owner, id)).status).toBe(200);
    expect((await actionData(agent)).decision).toBe("allow");
    expect((await actionData(agent, { amount_usd: "16" })).decision).toBe("deny");
  }
  const { owner, agent } = await fixture(), id = await waiting(agent); await grant(owner, id);
  expect((await h.request(`/api/v1/agents/${agent.hash}/kill`, { method: "POST", headers: owner.auth, json: {} })).status).toBe(200);
  expect((await actionData(agent)).decision).toBe("deny");
});
test("model calls consume budgets and rolling call-count caps during a window", async () => {
  const p = agentPolicySchema.parse({ ...policy, approval: { ...policy.approval, above_calls_per_hour: 1 } });
  const { owner, agent } = await fixture(p);
  const first = await chat(agent); expect(first.status).toBe(403); const id = (await first.json()).error.metadata.approval_id;
  expect((await grant(owner, id)).status).toBe(200);
  expect((await chat(agent)).status).toBe(200);
  const second = await chat(agent); expect(second.status).toBe(403);
  expect((await second.json()).error.metadata.reasons.some((r: any) => r.code === "approval_calls_per_hour")).toBe(true);
  const { owner: owner2, agent: agent2 } = await fixture(agentPolicySchema.parse({ ...policy, caps: { per_request_usd: 0.0001 } }));
  const pending = await chat(agent2); expect(pending.status).toBe(403); const pendingId = (await pending.json()).error.metadata.approval_id;
  expect((await grant(owner2, pendingId)).status).toBe(200);
  const over = await chat(agent2, { max_tokens: 10000 }); expect(over.status).toBe(403);
  expect((await over.json()).error.type).toBe("agent_policy_denied");
});
test("model and declared-tool changes ask again while a matching request stays allowed", async () => {
  const { owner, agent } = await fixture();
  const first = await chat(agent); const id = (await first.json()).error.metadata.approval_id;
  expect((await grant(owner, id)).status).toBe(200);
  expect((await chat(agent, { max_tokens: 33 })).status).toBe(200);
  expect((await chat(agent, { tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }] })).status).toBe(403);
  expect((await chat(agent, { model: MODELS.qwen.slug })).status).toBe(403);
});
test("stale confirmation, changed policy, duplicate grant and decided/expired approvals are refused", async () => {
  const { owner, agent } = await fixture(), id = await waiting(agent);
  const preview = (await (await h.request(path(id), { headers: owner.auth })).json()).data;
  expect((await h.request(path(id), { method: "POST", headers: owner.auth, json: { confirmation: "f".repeat(64) } })).status).toBe(409);
  const results = await Promise.all([1, 2].map(() => h.request(path(id), { method: "POST", headers: owner.auth, json: preview })));
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  await h.request(`/api/v1/agents/${agent.hash}/policy`, { method: "PUT", headers: owner.auth, json: { ...policy, caps: { per_request_usd: 40 } } });
  expect((await actionData(agent)).decision).toBe("approval_required");
  const fresh = await waiting(agent);
  await h.ctx.db.update(agentApprovals).set({ expiresAt: new Date(0) }).where(eq(agentApprovals.id, fresh));
  expect((await h.request(path(fresh), { headers: owner.auth })).status).toBe(409);
});
test("only owners/admins with current approval authority may grant; members keep approve-once", async () => {
  const { owner, agent, create } = await fixture(), member = await create("member"), admin = await create("admin"), stranger = await h.fundedKey(), id = await waiting(agent);
  const configure = (mode: string, member_ids: string[] = []) => h.request(`/api/v1/agents/${agent.hash}/approvers`, { method: "PUT", headers: owner.auth, json: { mode, member_ids } });
  expect((await h.request(path(id))).status).toBe(401);
  expect((await h.request(path(id), { headers: stranger.auth })).status).toBe(404);
  for (const key of [agent, member, admin]) expect((await h.request(path(id), { headers: key.auth })).status).toBe(403);
  await configure("specific_members", [member.hash]);
  expect((await h.request(path(id), { headers: member.auth })).status).toBe(403);
  expect((await h.request(`/api/v1/agents/approvals/${id}/approve`, { method: "POST", headers: member.auth })).status).toBe(200);
  const next = await waiting(agent); await configure("owners_and_admins");
  expect((await grant(admin, next)).status).toBe(200);
  expect((await h.request(windowsPath(agent.hash) + '/' + next, { method: "DELETE", headers: member.auth })).status).toBe(403);
  const readonly = (await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Read account", scope: "read" } })).json());
  const readAuth = { authorization: `Bearer ${readonly.key}` };
  for (const [method, route] of [["GET", path(next)], ["POST", path(next)], ["GET", windowsPath(agent.hash)], ["DELETE", windowsPath(agent.hash) + '/' + next]]) expect((await h.request(route, { method, headers: readAuth })).status).toBe(403);
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await h.request(path(next), { headers: { authorization: `Bearer ${session.key}` } })).status).toBe(403);
});
test("Telegram hour button uses the linked private message binding and rechecks role on click", async () => {
  const { owner, agent, create } = await fixture(), id = await waiting(agent), uid = 194001;
  const issued = await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth });
  await consumeCode(h.ctx, uid, (await issued.json()).data.code);
  const calls: { method: string; params: any }[] = []; let message = 1;
  const api = new TelegramApi(token, (async (input, init) => { calls.push({ method: String(input).split('/').at(-1)!, params: JSON.parse(init!.body as string) }); return Response.json({ ok: true, result: { message_id: message++ } }); }) as typeof fetch);
  await deliverTelegramApprovals(h.ctx, api);
  const sent = calls.find(c => c.method === "sendMessage" && c.params.chat_id === uid)!;
  const button = sent.params.reply_markup.inline_keyboard.flat().find((b: any) => b.text === "Approve for the next hour"); expect(button).toBeDefined();
  const link = (await readLink(h.ctx.db, uid))!;
  const [notice] = await h.ctx.db.select().from(kv).where(eq(kv.key, notificationKey(id, link)));
  const callback: TgUpdate = { update_id: 1, callback_query: { id: "hour-click", from: { id: uid }, data: button.callback_data, message: { message_id: (notice.value as any).message_id, chat: { id: uid, type: "private" } } } };
  callback.callback_query!.message!.message_id++;
  await handleLinkedUpdate(h.ctx, api, callback); expect(await approvalWindowView(h.ctx.db, agent.hash)).toEqual([]);
  callback.callback_query!.message!.message_id--;
  await handleLinkedUpdate(h.ctx, api, callback); expect((await actionData(agent)).decision).toBe("allow");
  expect(calls.some(c => c.method === "answerCallbackQuery" && c.params.text.includes("60 minutes"))).toBe(true);
  await handleLinkedUpdate(h.ctx, api, callback); expect(await approvalWindowView(h.ctx.db, agent.hash)).toHaveLength(1);
  await removeLink(h.ctx, uid);
  const member = await create("member"), uid2 = 194002;
  await h.request(`/api/v1/agents/${agent.hash}/approvers`, { method: "PUT", headers: owner.auth, json: { mode: "specific_members", member_ids: [member.hash] } });
  const another = await actionData(agent, { target: "supplier-two" });
  const code = await h.request("/api/v1/telegram/link", { method: "POST", headers: member.auth }); await consumeCode(h.ctx, uid2, (await code.json()).data.code);
  await deliverTelegramApprovals(h.ctx, api);
  const memberSent = calls.find(c => c.method === "sendMessage" && c.params.chat_id === uid2)!;
  expect(memberSent.params.reply_markup.inline_keyboard.flat().some((b: any) => b.text.includes("next hour"))).toBe(false);
  const memberLink = (await readLink(h.ctx.db, uid2))!, [memberNotice] = await h.ctx.db.select().from(kv).where(eq(kv.key, notificationKey(another.approval_id, memberLink)));
  callback.callback_query = { ...callback.callback_query!, from: { id: uid2 }, data: `tg:h:${another.approval_id}:${memberLink.generation}`, message: { message_id: (memberNotice.value as any).message_id, chat: { id: uid2, type: "private" } } };
  await handleLinkedUpdate(h.ctx, api, callback);
  expect((await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, another.approval_id)))[0].status).toBe("pending");
  await removeLink(h.ctx, uid2);
});
test("policy off hides every new route and unselected agents retain single-use approvals", async () => {
  const off = await startRouter();
  try {
    const owner = await off.fundedKey();
    for (const [method, route] of [["GET", path("absent")], ["POST", path("absent")], ["GET", windowsPath(owner.hash)], ["DELETE", windowsPath(owner.hash) + '/absent']]) expect((await off.request(route, { method, headers: owner.auth })).status).toBe(404);
  } finally { await off.close(); }
  const { owner, agent } = await fixture(), id = await waiting(agent);
  expect((await h.request(`/api/v1/agents/approvals/${id}/approve`, { method: "POST", headers: owner.auth })).status).toBe(200);
  expect((await actionData(agent, { approval_id: id })).decision).toBe("allow");
  expect((await actionData(agent, { approval_id: id })).decision).toBe("deny");
  expect(await approvalWindowView(h.ctx.db, agent.hash)).toEqual([]);
});

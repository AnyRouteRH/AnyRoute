// E153: same cases run against PostgreSQL/Redis and single-connection plain mode.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { canApprove, approversSchema } from "../src/agents/approvers.ts";
import { keys, kv, teamMembers, teamPrincipals } from "../src/db/schema.ts";
import { consumeCode, readLink } from "../src/telegram/linking.ts";
import { deliverTelegramApprovals, handleLinkedUpdate } from "../src/telegram/delivery.ts";
import { TelegramApi, type TgUpdate } from "../src/services/telegram.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
let h: Harness;
const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
type Key = { hash: string; auth: Record<string, string> };
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_TEAM_APPROVERS_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN, SECURITY_ALERTS_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });
const settings = (key: Key) => `/api/v1/agents/${key.hash}/approvers`;
const configure = (owner: Key, target: Key, mode: string, ids: string[] = []) => h.request(settings(target), { method: "PUT", headers: owner.auth, json: { mode, member_ids: ids } });
const decide = (key: Key, id: string, action = "approve") => h.request(`/api/v1/agents/approvals/${id}/${action}`, { method: "POST", headers: key.auth });
async function fixture() {
  const owner = await h.fundedKey(), stranger = await h.fundedKey();
  const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Review team" } })).json()).data.id;
  const create = async (role: string, name: string): Promise<Key> => {
    const res = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { team, role, name } });
    expect(res.status).toBe(201); const { data, key } = await res.json(); return { hash: data.hash, auth: { authorization: `Bearer ${key}` } };
  };
  return { owner, stranger, team, agent: await create("agent", "Research agent"), admin: await create("admin", "Review admin"), member: await create("member", "Review teammate"), other: await create("member", "Other teammate"), viewer: await create("viewer", "Read only"), create };
}
async function pending(key: Key, id = randomBytes(18).toString("base64url")) {
  await h.ctx.db.insert(agentApprovals).values({ id, keyHash: key.hash, intent: { kind: "inference", model: MODELS.llama.slug, lane: "public", tools: [], max_output_tokens: 32, est_cost_pico: "1000" }, intentHash: id, maxCostPico: 1000n, expiresAt: new Date(Date.now() + 900000) });
  return id;
}
async function row(id: string) { return (await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id)))[0]; }
async function list(key: Key) { return (await (await h.request("/api/v1/agents/approvals", { headers: key.auth })).json()).data; }
async function inbox(key: Key) { return (await (await h.request("/api/v1/inbox", { headers: key.auth })).json()); }

test("strict unit validation, default disabled flag and production dependency guard", () => {
  expect(loadConfig({ ANYROUTE_ENV: "test" }).agentTeamApproversEnabled).toBe(false);
  expect(() => loadConfig({ ANYROUTE_ENV: "test", AGENT_TEAM_APPROVERS_ENABLED: "true" })).toThrow(/requires AGENT_POLICY_ENABLED/);
  expect(approversSchema.parse({ mode: "owners" })).toEqual({ mode: "owners", member_ids: [] });
  for (const v of [{ mode: "unknown" }, { mode: "owners", member_ids: ["one"] }, { mode: "specific_members", member_ids: ["one", "one"] }, { mode: "owners", prompt: "not a setting" }]) expect(approversSchema.safeParse(v).success).toBe(false);
});
test("unset and owners mode exclude admins; owner/admin settings auth, cross-account/team and no-auth guards", async () => {
  const f = await fixture();
  const data = (await (await h.request(settings(f.agent), { headers: f.owner.auth })).json()).data;
  expect(data).toMatchObject({ mode: "owners", member_ids: [], configured: false });
  expect(data.members.some((m: any) => m.id === f.member.hash)).toBe(true);
  expect(data.members.some((m: any) => m.id === f.agent.hash || m.id === f.viewer.hash)).toBe(false);
  const id = await pending(f.agent);
  expect((await decide(f.admin, id)).status).toBe(403);
  expect((await list(f.admin)).some((r: any) => r.id === id)).toBe(false);
  expect((await inbox(f.admin)).data.find((r: any) => r.approval_id === id)?.can_decide).toBe(false);
  expect((await configure(f.admin, f.agent, "owners")).status).toBe(200);
  for (const key of [f.member, f.agent, f.viewer]) expect((await configure(key, f.agent, "owners_and_admins")).status).toBe(403);
  expect((await h.request(settings(f.agent))).status).toBe(401);
  expect((await configure(f.stranger, f.agent, "owners")).status).toBe(404);
  const team2 = (await (await h.request("/api/v1/teams", { method: "POST", headers: f.owner.auth, json: { name: "Other team" } })).json()).data.id;
  const child = (await (await h.request("/api/v1/keys", { method: "POST", headers: f.owner.auth, json: { team: team2, role: "admin" } })).json());
  expect((await configure({ hash: child.data.hash, auth: { authorization: `Bearer ${child.key}` } }, f.agent, "owners")).status).toBe(403);
  expect((await decide(f.owner, id)).status).toBe(200);
});
test("owners and admins can decide once, members cannot; activity and security name the decision maker", async () => {
  const f = await fixture();
  expect((await configure(f.owner, f.agent, "owners_and_admins")).status).toBe(200);
  const id = await pending(f.agent);
  expect((await decide(f.member, id)).status).toBe(403);
  const results = await Promise.all([decide(f.owner, id), decide(f.admin, id, "deny")]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  const stored = await row(id); expect([f.owner.hash, f.admin.hash]).toContain(stored.decidedBy!);
  const activity = await h.request("/api/v1/activity?kind=approval", { headers: f.owner.auth });
  expect(activity.status).toBe(200);
  const title = (await activity.json()).data.find((r: any) => r.id === `approval:${id}`).title;
  const [actor] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, stored.decidedBy!));
  expect(title).toContain(actor.name || "unnamed");
  const [security] = await h.ctx.db.select().from(kv).where(eq(kv.key, `security-alerts:event:approval:${id}`));
  expect((security.value as any).title).toContain(actor.name || "unnamed");
});
test("specific members see and decide only allowed agents in inbox and Agents; cannot change rules", async () => {
  const f = await fixture();
  expect((await configure(f.owner, f.agent, "specific_members", [f.member.hash])).status).toBe(200);
  const id = await pending(f.agent), hidden = await pending(f.other);
  expect((await decide(f.other, id)).status).toBe(403);
  expect((await decide(f.admin, id)).status).toBe(403);
  expect((await list(f.member)).map((r: any) => r.id)).toEqual([id]);
  expect((await list(f.member))[0].can_allow).toBe(false);
  const page = await inbox(f.member);
  expect(page.scope).toBe("team_approvals");
  expect(page.data.find((r: any) => r.approval_id === id)).toMatchObject({ can_decide: true });
  expect(page.data.some((r: any) => r.approval_id === hidden)).toBe(false);
  const agents = await h.request("/api/v1/agents", { headers: f.member.auth });
  expect(agents.status).toBe(200); expect((await agents.json()).data.map((r: any) => [r.key_hash, r.approval_only])).toEqual([[f.agent.hash, true]]);
  expect((await h.request(`/api/v1/agents/approvals/${id}`, { headers: f.member.auth })).status).toBe(200);
  for (const method of ["GET", "POST"]) expect((await h.request(`/api/v1/agents/approvals/${id}/approve-and-allow`, { method, headers: f.member.auth, json: method === "POST" ? { policy_sha256: "0".repeat(64) } : undefined })).status).toBe(403);
  expect((await decide(f.member, id, "deny")).status).toBe(200);
  expect((await row(id)).decidedBy).toBe(f.member.hash);
  expect((await configure(f.owner, f.agent, "specific_members", [f.other.hash])).status).toBe(200);
  expect((await list(f.member)).length).toBe(0);
});
test("selection refuses foreign, disabled, agent and self keys; self approval and same-principal approval refused", async () => {
  const f = await fixture();
  expect((await decide(f.owner, await pending(f.owner))).status).toBe(403);
  for (const hash of [f.stranger.hash, f.agent.hash, f.viewer.hash, "absent"]) expect((await configure(f.owner, f.agent, "specific_members", [hash])).status).toBe(400);
  expect((await configure(f.owner, f.member, "specific_members", [f.member.hash])).status).toBe(400);
  // Even old settings cannot grant self-approval.
  await h.ctx.db.insert(kv).values({ key: `agent-approvers:${f.member.hash}`, value: { mode: "specific_members", member_ids: [f.member.hash] } });
  expect((await decide(f.member, await pending(f.member))).status).toBe(403);
  const p = "principal_" + randomBytes(8).toString("hex");
  await h.ctx.db.insert(teamPrincipals).values({ id: p, teamId: f.team, kind: "wallet", subject: "0x" + "5".repeat(40), role: "member" });
  await h.ctx.db.update(teamMembers).set({ principalId: p }).where(eq(teamMembers.keyHash, f.member.hash));
  await h.ctx.db.update(teamMembers).set({ principalId: p }).where(eq(teamMembers.keyHash, f.other.hash));
  expect((await configure(f.owner, f.agent, "specific_members", [p])).status).toBe(200);
  expect((await configure(f.owner, f.other, "specific_members", [p])).status).toBe(400);
  await h.ctx.db.insert(kv).values({ key: `agent-approvers:${f.other.hash}`, value: { mode: "specific_members", member_ids: [p] } });
  expect((await decide(f.member, await pending(f.other))).status).toBe(403);
  const nextKey = await f.create("member", "New sign-in");
  await h.ctx.db.update(teamMembers).set({ principalId: p }).where(eq(teamMembers.keyHash, nextKey.hash));
  expect((await decide(nextKey, await pending(f.agent))).status).toBe(200);
  await h.ctx.db.update(teamPrincipals).set({ disabled: true }).where(eq(teamPrincipals.id, p));
  expect((await decide(nextKey, await pending(f.agent))).status).toBe(403);
});
test("disabled/expired keys, removed membership, changed role and sessions lose decision authority", async () => {
  const f = await fixture();
  await configure(f.owner, f.agent, "specific_members", [f.member.hash]);
  for (const change of [{ disabled: true }, { expiresAt: new Date(Date.now() - 1000) }]) {
    await h.ctx.db.update(keys).set(change).where(eq(keys.keyHash, f.member.hash));
    expect((await decide(f.member, await pending(f.agent))).status).toBe(401);
    await h.ctx.db.update(keys).set({ disabled: false, expiresAt: null }).where(eq(keys.keyHash, f.member.hash));
  }
  await h.ctx.db.update(teamMembers).set({ role: "agent" }).where(eq(teamMembers.keyHash, f.member.hash));
  expect((await decide(f.member, await pending(f.agent))).status).toBe(403);
  await h.ctx.db.delete(teamMembers).where(eq(teamMembers.keyHash, f.member.hash));
  expect((await decide(f.member, await pending(f.agent))).status).toBe(403);
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: f.owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await decide({ hash: "session", auth: { authorization: `Bearer ${session.key}` } }, await pending(f.agent))).status).toBe(403);
});
test("member Telegram uses real linking, scoped buttons, same decision and revocation guard", async () => {
  const f = await fixture(); await configure(f.owner, f.agent, "specific_members", [f.member.hash]);
  const issued = await h.request("/api/v1/telegram/link", { method: "POST", headers: f.member.auth }); expect(issued.status).toBe(200);
  const uid = 153000 + Math.floor(Math.random() * 10000);
  await consumeCode(h.ctx, uid, (await issued.json()).data.code);
  expect((await readLink(h.ctx.db, uid))?.key_hash).toBe(f.member.hash);
  const calls: { method: string; params: any }[] = []; let message = 1;
  const api = new TelegramApi(TOKEN, (async (input, init) => { calls.push({ method: String(input).split('/').at(-1)!, params: JSON.parse(init!.body as string) }); return Response.json({ ok: true, result: { message_id: message++ } }); }) as typeof fetch);
  // More than the delivery limit of unrelated rows must not starve this member's allowed request.
  for (let i = 0; i < 11; i++) await pending(f.other);
  const id = await pending(f.agent);
  await deliverTelegramApprovals(h.ctx, api);
  const sent = calls.find(c => c.method === "sendMessage" && c.params.chat_id === uid && c.params.reply_markup);
  expect(sent).toBeDefined(); expect(sent!.params.text).not.toContain("{\"kind\"");
  const callback: TgUpdate = { update_id: 1, callback_query: { id: "approval-click", from: { id: uid }, data: sent!.params.reply_markup.inline_keyboard[0][0].callback_data, message: { message_id: calls.filter(c => c.method === "sendMessage").findIndex(c => c === sent) + 1, chat: { id: uid, type: "private" } } } };
  const link = (await readLink(h.ctx.db, uid))!;
  const [marker] = await h.ctx.db.select().from(kv).where(eq(kv.key, `telegram-approval:${id}:${uid}:${link.generation}`));
  callback.callback_query!.message!.message_id = (marker.value as any).message_id;
  await handleLinkedUpdate(h.ctx, api, callback);
  expect(await row(id)).toMatchObject({ status: "approved", decidedBy: f.member.hash });
  const [security] = await h.ctx.db.select().from(kv).where(eq(kv.key, `security-alerts:event:approval:${id}`)); expect((security.value as any).title).toContain("Review teammate");
  await handleLinkedUpdate(h.ctx, api, callback); expect((await row(id)).status).toBe("approved");
  const second = await pending(f.agent); await deliverTelegramApprovals(h.ctx, api);
  const button = calls.filter(c => c.method === "sendMessage" && c.params.chat_id === uid && c.params.reply_markup).at(-1)!;
  const [secondMarker] = await h.ctx.db.select().from(kv).where(eq(kv.key, `telegram-approval:${second}:${uid}:${link.generation}`));
  callback.callback_query!.data = button.params.reply_markup.inline_keyboard[0][1].callback_data; callback.callback_query!.message!.message_id = (secondMarker.value as any).message_id;
  await configure(f.owner, f.agent, "owners"); await handleLinkedUpdate(h.ctx, api, callback); expect((await row(second)).status).toBe("pending");
});
test("disabled feature preserves legacy admin approval and hides settings; plain-mode CI needs no Redis", async () => {
  const off = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } });
  try {
    const owner = await off.fundedKey();
    const team = (await (await off.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Existing approvals" } })).json()).data.id;
    const create = async (role: string) => (await (await off.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { team, role } })).json());
    const agent = await create("agent"), admin = await create("admin"), id = randomBytes(18).toString("base64url");
    for (const method of ["GET", "PUT"]) expect((await off.request(`/api/v1/agents/${agent.data.hash}/approvers`, { method, headers: owner.auth, json: method === "PUT" ? { mode: "owners" } : undefined })).status).toBe(404);
    await off.ctx.db.insert(agentApprovals).values({ id, keyHash: agent.data.hash, intent: {}, intentHash: id, maxCostPico: 1n, expiresAt: new Date(Date.now() + 900000) });
    const auth = { authorization: `Bearer ${admin.key}` };
    const before = (await (await off.request("/api/v1/agents/approvals", { headers: auth })).json()).data[0]; expect(before.can_allow).toBeUndefined();
    expect((await off.request(`/api/v1/agents/approvals/${id}/approve`, { method: "POST", headers: auth })).status).toBe(200);
    expect((await off.ctx.db.select().from(kv)).some(r => r.key.startsWith("agent-approvers:"))).toBe(false);
  } finally { await off.close(); }
});

test("teammate approval preserves actual intent binding and exactly one successful retry", async () => {
  const f = await fixture();
  const policy = { version: 1, models: {}, caps: {}, approval: { above_usd: 0.000000001 }, on_breach: "deny" };
  expect((await h.request(`/api/v1/agents/${f.agent.hash}/policy`, { method: "PUT", headers: f.owner.auth, json: policy })).status).toBe(200);
  expect((await configure(f.owner, f.agent, "specific_members", [f.member.hash])).status).toBe(200);
  const body = { model: MODELS.llama.slug, messages: [{ role: "user", content: "Private approval content" }], max_tokens: 32, provider: { only: ["alpha"] } };
  const first = await h.request("/api/v1/chat/completions", { method: "POST", headers: f.agent.auth, json: body });
  expect(first.status).toBe(403); const id = (await first.json()).error.metadata.approval_id;
  expect((await decide(f.member, id)).status).toBe(200);
  const mismatched = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...f.agent.auth, "x-agent-approval": id }, json: { ...body, max_tokens: 33 } });
  expect(mismatched.status).toBe(403);
  const retries = await Promise.all([1, 2].map(() => h.request("/api/v1/chat/completions", { method: "POST", headers: { ...f.agent.auth, "x-agent-approval": id }, json: body })));
  expect(retries.map(r => r.status).sort()).toEqual([200, 403]);
  expect(await row(id)).toMatchObject({ status: "used", decidedBy: f.member.hash });
});

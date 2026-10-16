// J185: same feature tests run with service URLs and with single-connection plain mode.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { approvalContextLines, readApprovalContext } from "../src/agents/approval-context.ts";
import { plainApprovalText } from "../src/agents/rulebook-approval-text.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { appendEvent, policiesFor } from "../src/agents/store.ts";
import { keys, kv, ledger } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { utcWeekStart } from "../src/services/spend-watch.ts";
import { consumeCode } from "../src/telegram/linking.ts";
import { deliverTelegramApprovals } from "../src/telegram/delivery.ts";
import { sendApprovalNudge } from "../src/telegram/approval-nudges.ts";
import { TelegramApi } from "../src/services/telegram.ts";
import { startRouter, type Harness } from "./helpers.ts";
const USD = 1_000_000_000_000n, TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
let h: Harness, off: Harness;
type Key = { hash: string; auth: Record<string, string> };
beforeAll(async () => {
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_APPROVAL_CONTEXT_ENABLED: "true", AGENT_TEAM_APPROVERS_ENABLED: "true", APPROVAL_NUDGES_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: TOKEN } });
  off = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } });
}, 60_000);
afterAll(async () => { await h?.close(); await off?.close(); });
async function approval(key: Key, extra: Record<string, unknown> = {}, harness = h) {
  const id = randomBytes(18).toString("base64url");
  const [row] = await harness.ctx.db.insert(agentApprovals).values({ id, keyHash: key.hash, intent: { kind: "inference", model: "sample/model", lane: "public", tools: ["read"], prompt: "PRIVATE PROMPT", arguments: { value: "PRIVATE ARGUMENT" } }, intentHash: id, maxCostPico: USD, requestedAt: new Date(Date.now() - 720_000), expiresAt: new Date(Date.now() + 120_000), ...extra }).returning();
  return row;
}
async function child(owner: Key, extra = {}) {
  const r = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Review agent", ...extra } });
  expect(r.status).toBe(201); const data = await r.json(); return { hash: data.data.hash, auth: { authorization: `Bearer ${data.key}` } };
}
async function policy(owner: Key, key: Key, hours?: Record<string, unknown>) {
  expect((await h.request(`/api/v1/agents/${key.hash}/policy`, { method: "PUT", headers: owner.auth, json: { version: 1, models: {}, caps: { per_day_usd: 5 }, on_breach: "deny", ...(hours ? { work_hours: hours } : {}) } })).status).toBe(200);
}
const list = async (owner: Key, harness = h) => (await (await harness.request("/api/v1/agents/approvals", { headers: owner.auth })).json()).data;
const inbox = async (owner: Key) => (await (await h.request("/api/v1/inbox", { headers: owner.auth })).json()).data;

test("context skips missing fields, preserves zero/tiny money and uses at most two lines", () => {
  expect(approvalContextLines(USD, {})).toEqual([]);
  const lines = approvalContextLines(1n, { today: 0n, dailyCaps: [{ cap: 5n * USD, rolling: true }, { cap: 7n * USD, rolling: false }], insideWorkHours: false, weekly: { requested: 3, approved: 2 }, duplicated: true, rotatedFrom: true, rotatedTo: true });
  expect(lines).toHaveLength(2);
  for (const text of ["Spend today: $0", "daily cap: $5 (rolling 24 hours)", "daily cap: $7 (UTC day)", "$0.000000000001 today"]) expect(lines[0]).toContain(text);
  for (const text of ["Outside work hours now", "3 requested, 2 approved", "Duplicate agent", "Replacement key after rotation", "Rotated key; replacement exists"]) expect(lines[1]).toContain(text);
  expect(approvalContextLines(0n, { insideWorkHours: true })).toEqual(["Inside work hours now"]);
});
test("flag defaults off, dependency guard, default responses and no-policy routes stay guarded", async () => {
  expect(loadConfig({}).agentApprovalContextEnabled).toBe(false);
  expect(() => loadConfig({ AGENT_APPROVAL_CONTEXT_ENABLED: "true" })).toThrow(/requires AGENT_POLICY_ENABLED/);
  const owner = await off.fundedKey(), row = await approval(owner, {}, off);
  expect((await list(owner, off)).find((r: any) => r.id === row.id)).not.toHaveProperty("approval_context");
  expect((await (await off.request("/api/v1/inbox", { headers: owner.auth })).json()).data.find((r: any) => r.approval_id === row.id)).not.toHaveProperty("approval_context");
  expect((await h.request("/api/v1/agents/approvals")).status).toBe(401);
  expect((await h.request("/api/v1/inbox")).status).toBe(401);
});
test("metadata reader scopes charges and weekly history, evaluates work hours and reads retained lineage", async () => {
  const owner = await h.fundedKey(), agent = await child(owner), sibling = await child(owner), now = new Date("2026-10-14T12:00:00Z");
  await policy(owner, agent, { days: [3], start: "09:00", end: "17:00", time_zone: "UTC", outside: "ask_first" });
  const row = await approval(agent, { requestedAt: now });
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, agent.hash));
  for (const [hash, amount, at, kind] of [[agent.hash, -2n * USD, now, "usage"], [agent.hash, -1n, now, "data_tool"], [agent.hash, -10n * USD, new Date(now.getTime() + 1), "usage"], [agent.hash, USD, now, "refund"], [sibling.hash, -9n * USD, now, "usage"]] as const) {
    const id = randomBytes(12).toString("hex"); await h.ctx.db.insert(ledger).values({ id, ref: id, accountId: key.accountId, keyHash: hash, amount, createdAt: at, kind });
  }
  for (const [status, requestedAt, decidedAt] of [["used", now, now], ["expired", now, now], ["expired", now, null], ["denied", now, now], ["approved", new Date(utcWeekStart(now.getTime()) - 1), now], ["approved", new Date(now.getTime() + 1), now]] as const) await approval(agent, { status, requestedAt, decidedAt });
  await appendEvent(h.ctx.db, { keyHash: agent.hash, kind: "duplicated", policySha256: "", reasons: [{ code: "agent_duplicated", message: "Copied from PRIVATE SOURCE" }] });
  await h.ctx.db.insert(kv).values({ key: `key-rotation:${agent.hash}`, value: { from: sibling.hash, to: null } });
  const lines = await readApprovalContext(h.ctx.db, row, now);
  expect(lines[0]).toContain("Spend today: $2.000000000001"); expect(lines[0]).toContain("up to $3.000000000001 today");
  expect(lines[0]).toContain("daily cap: $5 (rolling 24 hours)");
  expect(lines[1]).toBe("Inside work hours now · Approvals this week (UTC): 5 requested, 2 approved · Duplicate agent · Replacement key after rotation");
  expect((await readApprovalContext(h.ctx.db, row, new Date("2026-10-14T18:00Z")))[1]).toContain("Outside work hours now");
  expect(await readApprovalContext(h.ctx.db, { ...row, keyHash: "absent" }, now)).toEqual([]);
  const noRules = await approval(sibling), absent = await readApprovalContext(h.ctx.db, noRules, now);
  expect(absent.join(" ")).not.toMatch(/daily cap|work hours|Duplicate|rotation/);
});
test("web list, inbox, Telegram and reminder share the words without prompts or arguments", async () => {
  const owner = await h.fundedKey(), agent = await child(owner); await policy(owner, agent);
  const row = await approval(agent), linkCode = await (await h.request("/api/v1/telegram/link", { method: "POST", headers: owner.auth })).json();
  const link = await consumeCode(h.ctx, 185001, linkCode.data.code);
  const lines = await readApprovalContext(h.ctx.db, row);
  expect((await list(owner)).find((r: any) => r.id === row.id).approval_context).toEqual(lines);
  expect((await inbox(owner)).find((r: any) => r.approval_id === row.id).approval_context).toEqual(lines);
  const calls: any[] = [], fetcher = (async (_url: any, init: any) => { calls.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: calls.length } }); }) as typeof fetch;
  await deliverTelegramApprovals(h.ctx, new TelegramApi(TOKEN, fetcher));
  expect(calls).toHaveLength(1);
  const policies = await policiesFor(h.ctx.db, agent.hash);
  const expected = plainApprovalText(row, policies.map(p => ({ policy: p.spec, inherited: false })), "Review agent", lines);
  expect(calls[0].text).toBe(expected);
  expect(await sendApprovalNudge(h.ctx, row.id, link, fetcher)).toBe(true);
  expect(calls[1].text).toEndWith(expected);
  for (const call of calls) {
    for (const line of lines) expect(call.text).toContain(line);
    expect(call.text).not.toMatch(/PRIVATE|arguments|prompt|\{/);
  }
  const stranger = await h.fundedKey();
  expect((await list(stranger)).some((r: any) => r.id === row.id)).toBe(false);
  expect((await inbox(stranger)).some((r: any) => r.approval_id === row.id)).toBe(false);
  const readKey = await child(owner, { scope: "read" });
  expect((await inbox(readKey)).every((r: any) => !r.approval_context)).toBe(true);
  expect((await h.request(`/api/v1/agents/approvals/${row.id}/approve`, { method: "POST", headers: readKey.auth })).status).toBe(403);
});
test("delegated approvers see context only on allowed agents; sessions cannot list approvals", async () => {
  const owner = await h.fundedKey();
  const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Review team" } })).json()).data.id;
  const agent = await child(owner, { team, role: "agent" }), member = await child(owner, { team, role: "member" }), other = await child(owner, { team, role: "agent" });
  expect((await h.request(`/api/v1/agents/${agent.hash}/approvers`, { method: "PUT", headers: owner.auth, json: { mode: "specific_members", member_ids: [member.hash] } })).status).toBe(200);
  const row = await approval(agent), hidden = await approval(other);
  expect((await list(member)).find((r: any) => r.id === row.id).approval_context).toEqual(await readApprovalContext(h.ctx.db, row));
  expect((await list(member)).some((r: any) => r.id === hidden.id)).toBe(false);
  expect((await inbox(member)).find((r: any) => r.approval_id === row.id).approval_context).toBeArray();
  const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  expect((await h.request("/api/v1/agents/approvals", { headers: { authorization: `Bearer ${session.key}` } })).status).toBe(403);
});

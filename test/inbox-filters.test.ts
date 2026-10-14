// H173
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { keys, ledger } from "../src/db/schema.ts";
import { agentApprovals } from "../src/agents/approval-schema.ts";
import { readInbox } from "../src/inbox/read.ts";
import { filterInboxPage, inboxGroup, inboxKinds, INBOX_GROUPS } from "../src/inbox/filters.ts";
import { inboxGroup as browserGroup } from "../web/lib/inbox-filters.js";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });
test("every retained kind has a group, unknown and object property names go to Other, browser mapping agrees", () => {
  const groups = {
    approvals: ["approval", "approval_reminder"], agents: ["alert", "quiet-agent", "playbook", "schedule"],
    money: ["deposit", "topup", "payment", "low_balance", "project_budget"], security: ["security"],
    models: ["price_notice", "model_watch"], other: ["agreement", "host", "weekly_summary", "future_notice", "constructor", "__proto__"],
  };
  for (const [group, kinds] of Object.entries(groups)) for (const kind of kinds) { expect(inboxGroup(kind)).toBe(group); expect(browserGroup(kind)).toBe(group); }
  const page = filterInboxPage({ data: Object.values(groups).flat().map(kind => ({ kind, unread: kind !== "deposit" })), count: 0 }, ["money"]);
  expect(page.data.map(item => item.kind)).toEqual(groups.money); expect(page.count).toBe(4);
  expect(page.kind_counts).toEqual({ approvals: 2, agents: 4, money: 5, security: 1, models: 2, other: 6 });
  expect(Object.keys(page.kind_counts)).toEqual([...INBOX_GROUPS]);
  expect(inboxKinds("approval,deposit,approval")).toEqual(["approval", "deposit"]);
  for (const value of ["", "approval,", "Money", "approval,,deposit", "x".repeat(513)]) expect(() => inboxKinds(value)).toThrow();
});
test("kinds is optional: default serialization and pending-approval semantics stay unchanged", async () => {
  const owner = await h.newKey(), [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  await h.ctx.db.insert(agentApprovals).values({ id: "h173-default", keyHash: owner.hash, requestedAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() + 600000), intent: {}, intentHash: "intent", maxCostPico: 0n });
  const expected = await readInbox(h.ctx, key), response = await h.request("/api/v1/inbox", { headers: owner.auth });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text(), actual = JSON.parse(text);
  expected.as_of = actual.as_of;
  expect(text).toBe(JSON.stringify(expected)); expect(actual.kind_counts).toBeUndefined();
  const seen = await (await h.request("/api/v1/inbox?since=" + encodeURIComponent(actual.as_of), { headers: owner.auth })).json();
  expect(seen.data[0]).toMatchObject({ kind: "approval", unread: true, status: "pending" });
});
test("filters preserve authorization, counts, scopes, source switches and seen validation", async () => {
  const owner = await h.newKey(), other = await h.newKey();
  const created = await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Inbox agent" } })).json();
  const child = { hash: created.data.hash, auth: { authorization: "Bearer " + created.key } };
  const [ownerRow] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  const at = new Date(Date.now() - 60000);
  await h.ctx.db.insert(agentApprovals).values([owner, child, other].map((key, i) => ({ id: "h173-scope-" + i, keyHash: key.hash, requestedAt: at, expiresAt: new Date(Date.now() + 600000), intent: {}, intentHash: "intent", maxCostPico: 0n })));
  await h.ctx.db.insert(ledger).values({ id: "h173-credit", accountId: ownerRow.accountId, keyHash: owner.hash, kind: "deposit", amount: 1n, ref: "h173-credit", createdAt: at });
  const read = async (key: typeof owner, query = "") => { const r = await h.request("/api/v1/inbox" + query, { headers: key.auth }); expect(r.status).toBe(200); return r.json(); };
  const full = await read(owner), filtered = await read(owner, "?kinds=money");
  expect(filtered.data.map((item: any) => item.kind)).toEqual(["deposit"]); expect(filtered.count).toBe(1);
  expect(filtered.kind_counts).toEqual({ approvals: 2, agents: 0, money: 1, security: 0, models: 0, other: 0 });
  expect(filtered.seen_scope).toBe(full.seen_scope);
  expect((await read(owner, "?kinds=approval,deposit")).data).toEqual(full.data);
  expect((await read(owner, "?kinds=future_notice")).data).toEqual([]);
  const childPage = await read(child, "?kinds=approvals,money"), otherPage = await read(other, "?kinds=approvals");
  expect(childPage.kind_counts.approvals).toBe(1); expect(childPage.kind_counts.money).toBe(0); expect(otherPage.kind_counts.approvals).toBe(1);
  expect(childPage.scope).toBe("key"); expect(childPage.seen_scope).not.toBe(full.seen_scope);
  for (const page of [full, childPage]) {
    const key = page === full ? owner : child;
    const r = await h.request("/api/v1/inbox/seen?through=" + encodeURIComponent(page.as_of), { method: "POST", headers: key.auth });
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ seen_at: page.as_of, seen_scope: page.seen_scope });
  }
  expect((await read(owner)).data).toEqual(full.data); // Seen is a browser bookmark, not server state.
  expect((await read(owner, "?kinds=money&since=" + encodeURIComponent(full.as_of))).count).toBe(0);
  for (const auth of [undefined, { authorization: "Bearer invalid" }]) expect((await h.request("/api/v1/inbox?kinds=money", { headers: auth })).status).toBe(401);
  for (const value of ["", "approval,", "Money", "approval%20deposit"]) expect((await h.request("/api/v1/inbox?kinds=" + value, { headers: owner.auth })).status).toBe(400);
  const enabled = h.ctx.cfg.agentPolicyEnabled;
  try { h.ctx.cfg.agentPolicyEnabled = false; expect((await read(owner, "?kinds=approvals")).data).toEqual([]); }
  finally { h.ctx.cfg.agentPolicyEnabled = enabled; }
  await h.ctx.db.update(keys).set({ scope: "read" }).where(eq(keys.keyHash, child.hash));
  expect((await read(child, "?kinds=approvals")).data[0].can_decide).toBe(false);
  expect((await h.request("/api/v1/inbox/seen?through=" + encodeURIComponent(childPage.as_of), { method: "POST", headers: child.auth })).status).toBe(403);
});

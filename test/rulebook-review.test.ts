// K189: the review UI reuses the existing authenticated read/replay/save routes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { agentPolicies, agentPolicyEvents } from "../src/agents/schema.ts";
import { policyVersions } from "../src/agents/policy-versions-schema.ts";
import { keys } from "../src/db/schema.ts";
let h: Harness;
const policy = { version: 1, models: {}, caps: { per_day_usd: 5 }, on_breach: "deny" };
const draft = { ...policy, caps: { per_day_usd: 10 } };
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_TEAM_APPROVERS_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });

test("reviewing a draft leaves saved policy, history, events and approvers unchanged until final Save", async () => {
  const owner = await h.fundedKey();
  const team = (await (await h.request("/api/v1/teams", { method: "POST", headers: owner.auth, json: { name: "Review team" } })).json()).data.id;
  const target = (await (await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { team, role: "agent", name: "Review agent" } })).json()).data.hash;
  const path = `/api/v1/agents/${target}`;
  expect((await h.request(path + "/policy", { method: "PUT", headers: owner.auth, json: policy })).status).toBe(200);
  const before = async () => ({
    policy: await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, target)),
    events: await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, target)),
    versions: await h.ctx.db.select().from(policyVersions).where(eq(policyVersions.keyHash, target)),
    approvers: await (await h.request(path + "/approvers", { headers: owner.auth })).json(),
  });
  const saved = await before();
  const replay = await h.request(path + "/replay", { method: "POST", headers: owner.auth, json: { policy: draft, days: 7 } });
  expect(replay.status).toBe(200); expect((await replay.json()).data).toMatchObject({ evaluated: 0, denied: 0, asked: 0 });
  expect(await before()).toEqual(saved);
  expect((await h.request(path + "/policy", { method: "PUT", headers: owner.auth, json: draft })).status).toBe(200);
  const after = await before(); expect(after.policy[0].spec.caps.per_day_usd).toBe(10);
  expect(after.versions.length).toBe(saved.versions.length + 1);
  expect((await h.request(path + "/approvers", { method: "PUT", headers: owner.auth, json: { mode: "owners_and_admins", member_ids: [] } })).status).toBe(200);
  expect((await before()).approvers.data.mode).toBe("owners_and_admins");
});

test("review's existing routes retain missing-auth, cross-account, inference-only and read-key guards", async () => {
  const owner = await h.fundedKey(), stranger = await h.fundedKey(), limited = await h.fundedKey(), read = await h.fundedKey();
  await h.ctx.db.update(keys).set({ management: false, scope: "inference" }).where(eq(keys.keyHash, limited.hash));
  await h.ctx.db.update(keys).set({ management: false, scope: "read" }).where(eq(keys.keyHash, read.hash));
  for (const [suffix, method, json] of [["/replay", "POST", { policy: draft, days: 7 }], ["/policy", "PUT", draft], ["/approvers", "PUT", { mode: "owners", member_ids: [] }]] as const) {
    const path = `/api/v1/agents/${owner.hash}${suffix}`;
    expect((await h.request(path, { method, json })).status).toBe(401);
    expect((await h.request(path, { method, headers: stranger.auth, json })).status).toBe(404);
    expect((await h.request(`/api/v1/agents/${limited.hash}${suffix}`, { method, headers: limited.auth, json })).status).toBe(403);
    expect((await h.request(`/api/v1/agents/${read.hash}${suffix}`, { method, headers: read.auth, json })).status).toBe(403);
  }
});

test("review cannot enable APIs whose existing flags default off", async () => {
  const off = await startRouter();
  try {
    expect(off.ctx.cfg.agentPolicyEnabled).toBe(false); expect(off.ctx.cfg.agentTeamApproversEnabled).toBe(false);
    const owner = await off.fundedKey();
    for (const [suffix, method, json] of [["/replay", "POST", { policy: draft }], ["/policy", "PUT", draft], ["/approvers", "PUT", { mode: "owners", member_ids: [] }]] as const) {
      expect((await off.request(`/api/v1/agents/${owner.hash}${suffix}`, { method, headers: owner.auth, json })).status).toBe(404);
    }
  } finally { await off.close(); }
});

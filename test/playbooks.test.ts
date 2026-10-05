// U115: team playbooks. One rulebook many keys follow: enforcement through the playbook, an edit reaching every follower at
// once, unlinking that keeps the rules, delete refused while followed, team roles, audit and inbox entries, version and digest.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { agentPolicies, agentPolicyEvents, playbookChanges } from "../src/agents/schema.ts";
import { agentPolicySha256, type AgentPolicy } from "../src/agents/policy.ts";
import { policiesFor, verifyEventChain } from "../src/agents/store.ts";

type Auth = Record<string, string>;
const open: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
const strict: AgentPolicy = { ...open, models: { allow: ["other/*"] } };
let h: Harness;
const call = async (path: string, auth: Auth | undefined, method = "GET", json?: unknown) => {
  const r = await h.request(path, { method, headers: auth, json });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const chat = (auth: Auth) => h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 32, provider: { only: ["alpha"] } } });
const child = async (root: { auth: Auth }, extra: Record<string, unknown> = {}) => {
  const r = await call("/api/v1/keys", root.auth, "POST", { name: "agent", ...extra });
  expect(r.status).toBe(201);
  return { auth: { authorization: `Bearer ${r.body.key}` }, hash: r.body.data.hash as string };
};
const follow = (auth: Auth, keyHash: string, playbookId: string | null) => call(`/api/v1/agents/${keyHash}/playbook`, auth, "POST", { playbook_id: playbookId });
const rowOf = async (keyHash: string) => (await h.ctx.db.select().from(agentPolicies).where(eq(agentPolicies.keyHash, keyHash)))[0];
const setEvents = async (keyHash: string) => (await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, keyHash)).orderBy(asc(agentPolicyEvents.id))).filter((e) => e.kind === "policy_set").map((e) => e.policySha256);

beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });

test("with rulebooks switched off, playbook routes and the follow route answer 404", async () => {
  const off = await startRouter();
  try {
    const k = await off.fundedKey();
    for (const [path, method] of [["/api/v1/playbooks", "GET"], ["/api/v1/playbooks", "POST"], ["/api/v1/playbooks/pb_x", "GET"], ["/api/v1/playbooks/pb_x", "PUT"], ["/api/v1/playbooks/pb_x", "DELETE"], [`/api/v1/agents/${k.hash}/playbook`, "POST"]]) {
      const r = await off.request(path, { method, headers: k.auth, json: method === "POST" || method === "PUT" ? {} : undefined });
      expect(r.status).toBe(404);
    }
  } finally { await off.close(); }
});

describe("one account", () => {
  let root: Awaited<ReturnType<Harness["fundedKey"]>>;
  let a: { auth: Auth; hash: string }, b: { auth: Auth; hash: string };
  let id = "";
  beforeAll(async () => {
    root = await h.fundedKey(20n);
    a = await child(root); b = await child(root);
  });

  test("create, follow and enforce through the playbook; an edit reaches every follower at its next request", async () => {
    const made = await call("/api/v1/playbooks", root.auth, "POST", { name: "Support bots", policy: strict });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ name: "Support bots", team_id: null, version: 1, sha256: agentPolicySha256(strict), followers: 0, keys: [], can_edit: true });
    id = made.body.data.id;
    const v1 = agentPolicySha256(strict);
    for (const k of [a, b]) {
      const r = await follow(root.auth, k.hash, id);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ key_hash: k.hash, changed: true, playbook: { id, name: "Support bots", version: 1 }, sha256: v1, playbook_id: id });
    }
    expect((await call(`/api/v1/playbooks/${id}`, root.auth)).body.data).toMatchObject({ followers: 2, keys: expect.arrayContaining([expect.objectContaining({ key_hash: a.hash }), expect.objectContaining({ key_hash: b.hash })]) });
    for (const k of [a, b]) {
      const r = await chat(k.auth);
      expect(r.status).toBe(403);
      const error = (await r.json()).error;
      expect(error.type).toBe("agent_policy_denied");
      expect(error.metadata.policy_sha256).toBe(v1);
      expect(error.metadata.reasons.map((x: any) => x.code)).toContain("model_not_allowed");
    }
    // One change; both keys follow it on their very next request, with no other step.
    const edited = await call(`/api/v1/playbooks/${id}`, root.auth, "PUT", { policy: open });
    expect(edited.status).toBe(200);
    const v2 = agentPolicySha256(open);
    expect(edited.body.data).toMatchObject({ version: 2, sha256: v2, changed: true, followers: 2 });
    for (const k of [a, b]) {
      expect((await chat(k.auth)).status).toBe(200);
      const row = await rowOf(k.hash);
      expect({ sha256: row!.sha256, playbookId: row!.playbookId, spec: row!.spec }).toEqual({ sha256: v2, playbookId: id, spec: open });
      expect((await policiesFor(h.ctx.db, k.hash)).map((p) => p.sha256)).toEqual([v2]);
      expect(await setEvents(k.hash)).toEqual([v1, v2]);
      const events = (await call(`/api/v1/agents/${k.hash}/events`, root.auth)).body.data;
      expect(verifyEventChain([...events].reverse())).toBe(true);
    }
    const listed = (await call("/api/v1/agents", root.auth)).body.data.find((x: any) => x.key_hash === a.hash);
    expect(listed.playbook).toEqual({ id, name: "Support bots", version: 2 });
    expect((await call("/api/v1/agents/me", a.auth)).body.data.playbook).toEqual({ id, name: "Support bots", version: 2 });
  });

  test("version counts rule changes and every change is recorded with its digest", async () => {
    const same = await call(`/api/v1/playbooks/${id}`, root.auth, "PUT", { policy: open });
    expect(same.body.data).toMatchObject({ version: 2, changed: false });
    const renamed = await call(`/api/v1/playbooks/${id}`, root.auth, "PUT", { name: "Support" });
    expect(renamed.body.data).toMatchObject({ name: "Support", version: 2, sha256: agentPolicySha256(open), changed: true });
    expect((await call(`/api/v1/playbooks/${id}`, root.auth, "PUT", {})).status).toBe(400);
    expect((await call(`/api/v1/playbooks/${id}`, root.auth, "PUT", { policy: { ...open, extra: true } })).status).toBe(400);
    const changes = (await call(`/api/v1/playbooks/${id}`, root.auth)).body.data.changes;
    expect(changes.map((c: any) => [c.action, c.version, c.sha256, c.followers])).toEqual([
      ["rename", 2, agentPolicySha256(open), 2], ["update", 2, agentPolicySha256(open), 2], ["create", 1, agentPolicySha256(strict), 0],
    ]);
    const second = await call("/api/v1/playbooks", root.auth, "POST", { name: "support", policy: open });
    expect([second.status, second.body.error.type]).toEqual([409, "playbook_name_taken"]);
    // An account with no team gets no inbox item and no team entry for these changes.
    expect((await h.ctx.db.select().from(playbookChanges).where(eq(playbookChanges.playbookId, id))).every((c) => !c.notify)).toBe(true);
    expect((await call("/api/v1/inbox", root.auth)).body.data.filter((x: any) => x.kind === "playbook")).toEqual([]);
  });

  test("a key follows a playbook or keeps its own rules, not both; unlinking keeps the rules and the stop", async () => {
    for (const method of ["PUT", "DELETE"]) {
      const r = await call(`/api/v1/agents/${a.hash}/policy`, root.auth, method, method === "PUT" ? open : undefined);
      expect([r.status, r.body.error.type, r.body.error.metadata.playbook_id]).toEqual([409, "playbook_linked", id]);
    }
    expect((await call(`/api/v1/playbooks/${id}`, root.auth, "PUT", { policy: strict })).body.data.version).toBe(3);
    // Stop is per key and survives a playbook change.
    expect((await call(`/api/v1/agents/${b.hash}/kill`, root.auth, "POST", {})).status).toBe(200);
    const off = await follow(root.auth, a.hash, null);
    expect(off.body.data).toMatchObject({ changed: true, playbook: null, playbook_id: null, sha256: agentPolicySha256(strict), policy: strict });
    expect((await follow(root.auth, a.hash, null)).body.data.changed).toBe(false);
    expect((await chat(a.auth)).status).toBe(403); // the copied rules still apply
    expect((await call(`/api/v1/playbooks/${id}`, root.auth, "PUT", { policy: open })).body.data).toMatchObject({ version: 4, followers: 1 });
    expect((await chat(a.auth)).status).toBe(403); // no longer follows, so the change does not reach it
    expect((await rowOf(a.hash))!.sha256).toBe(agentPolicySha256(strict));
    const stopped = await chat(b.auth);
    expect([stopped.status, (await stopped.json()).error.type]).toEqual([403, "agent_killed"]);
    expect((await rowOf(b.hash))).toMatchObject({ killed: true, sha256: agentPolicySha256(open), playbookId: id });
    expect((await call(`/api/v1/agents/${b.hash}/resume`, root.auth, "POST", {})).status).toBe(200);
    expect((await chat(b.auth)).status).toBe(200);
    expect((await call(`/api/v1/agents/${a.hash}/policy`, root.auth, "PUT", open)).status).toBe(200);
  });

  test("deleting a followed playbook is refused with the count unless each key keeps its rules", async () => {
    const refused = await call(`/api/v1/playbooks/${id}`, root.auth, "DELETE");
    expect([refused.status, refused.body.error.type, refused.body.error.metadata.followers]).toEqual([409, "playbook_followed", 1]);
    expect((await call(`/api/v1/playbooks/${id}?unlink=drop`, root.auth, "DELETE")).status).toBe(400);
    const gone = await call(`/api/v1/playbooks/${id}?unlink=copy`, root.auth, "DELETE");
    expect(gone.body.data).toEqual({ id, deleted: true, unlinked: 1 });
    expect(await rowOf(b.hash)).toMatchObject({ playbookId: null, sha256: agentPolicySha256(open), spec: open });
    expect((await call(`/api/v1/playbooks/${id}`, root.auth)).status).toBe(404);
    const last = (await h.ctx.db.select().from(playbookChanges).where(eq(playbookChanges.playbookId, id)).orderBy(asc(playbookChanges.id))).at(-1)!;
    expect([last.action, last.followers, last.version]).toEqual(["delete", 1, 4]);
    // An unfollowed playbook deletes without the flag.
    const spare = (await call("/api/v1/playbooks", root.auth, "POST", { name: "Spare", policy: open })).body.data.id;
    expect((await call(`/api/v1/playbooks/${spare}`, root.auth, "DELETE")).body.data).toEqual({ id: spare, deleted: true, unlinked: 0 });
  });
});

describe("teams", () => {
  let root: Awaited<ReturnType<Harness["fundedKey"]>>;
  let team = "", other = "";
  const as: Record<string, { auth: Auth; hash: string }> = {};
  let teamBook = "", accountBook = "";
  beforeAll(async () => {
    root = await h.fundedKey(20n);
    team = (await call("/api/v1/teams", root.auth, "POST", { name: "ops" })).body.data.id;
    other = (await call("/api/v1/teams", root.auth, "POST", { name: "lab" })).body.data.id;
    for (const role of ["admin", "dev", "viewer", "agent"]) as[role] = await child(root, { name: role, team, role });
    as.otherAdmin = await child(root, { name: "lab admin", team: other, role: "admin" });
    as.otherAgent = await child(root, { name: "lab agent", team: other, role: "agent" });
  });

  test("owners and admins edit their team's playbooks; viewers, devs and other teams cannot", async () => {
    const made = await call("/api/v1/playbooks", as.admin.auth, "POST", { name: "Ops agents", policy: strict });
    expect([made.status, made.body.data.team_id, made.body.data.can_edit]).toEqual([201, team, true]);
    teamBook = made.body.data.id;
    accountBook = (await call("/api/v1/playbooks", root.auth, "POST", { name: "Everyone", policy: open })).body.data.id;
    expect((await call("/api/v1/playbooks", as.admin.auth, "POST", { name: "Elsewhere", policy: open, team_id: other })).status).toBe(403);
    for (const role of ["viewer", "dev"]) {
      for (const [path, method, body] of [["/api/v1/playbooks", "GET"], ["/api/v1/playbooks", "POST", { name: "Mine", policy: open }], [`/api/v1/playbooks/${teamBook}`, "GET"], [`/api/v1/playbooks/${teamBook}`, "PUT", { policy: open }], [`/api/v1/playbooks/${teamBook}`, "DELETE"], [`/api/v1/agents/${as.agent.hash}/playbook`, "POST", { playbook_id: teamBook }]] as const)
        expect([role, path, method, (await call(path, as[role].auth, method, body)).status]).toEqual([role, path, method, 403]);
    }
    expect((await call(`/api/v1/playbooks/${teamBook}`, as.agent.auth, "PUT", { policy: open })).status).toBe(403);
    // An admin reads the account-wide playbook but cannot change it; another team cannot see this team's playbook.
    const listed = (await call("/api/v1/playbooks", as.admin.auth)).body.data;
    expect(listed.map((p: any) => [p.id, p.can_edit]).sort()).toEqual([[accountBook, false], [teamBook, true]].sort());
    expect((await call(`/api/v1/playbooks/${accountBook}`, as.admin.auth, "PUT", { policy: strict })).status).toBe(403);
    expect((await call(`/api/v1/playbooks/${accountBook}`, as.admin.auth, "DELETE")).status).toBe(403);
    expect((await call(`/api/v1/playbooks/${teamBook}`, as.otherAdmin.auth)).status).toBe(404);
    expect((await call(`/api/v1/playbooks/${teamBook}`, as.otherAdmin.auth, "PUT", { policy: open })).status).toBe(404);
    // Following: the team admin moves its own keys only, and a team playbook takes keys of that team only.
    expect((await follow(as.admin.auth, as.agent.hash, teamBook)).status).toBe(200);
    expect((await follow(as.otherAdmin.auth, as.agent.hash, null)).status).toBe(403);
    const mismatch = await follow(root.auth, as.otherAgent.hash, teamBook);
    expect([mismatch.status, mismatch.body.error.type]).toEqual([409, "playbook_team_mismatch"]);
    expect((await follow(as.otherAdmin.auth, as.otherAgent.hash, accountBook)).status).toBe(200);
    expect((await chat(as.agent.auth)).status).toBe(403);
    // The management key sees every follower; a team admin sees the count and only its own team's keys.
    const forAdmin = (await call(`/api/v1/playbooks/${accountBook}`, as.admin.auth)).body.data;
    expect([forAdmin.followers, forAdmin.keys]).toEqual([1, []]);
    expect((await call(`/api/v1/playbooks/${accountBook}`, root.auth)).body.data.keys.map((k: any) => k.key_hash)).toEqual([as.otherAgent.hash]);
  });

  test("a change to a team playbook is in the team audit log and the inbox of those who manage it", async () => {
    const before = agentPolicySha256(strict), after = agentPolicySha256(open);
    const edited = await call(`/api/v1/playbooks/${teamBook}`, as.admin.auth, "PUT", { policy: open });
    expect(edited.body.data).toMatchObject({ version: 2, sha256: after, followers: 1 });
    expect((await chat(as.agent.auth)).status).toBe(200);
    const audit = (await call(`/api/v1/teams/${team}/audit?limit=500`, as.viewer.auth)).body.data as any[];
    const entries = audit.filter((e) => e.target === `playbook:${teamBook}`).map((e) => [e.action, e.detail.version, e.detail.sha256, e.detail.keys]);
    expect(entries).toEqual([["playbook.create", 1, before, 0], ["playbook.follow", 1, before, 1], ["playbook.update", 2, after, 1]]);
    expect(audit.find((e) => e.action === "playbook.update").detail.previous_sha256).toBe(before);
    expect((await call(`/api/v1/teams/${other}/audit?limit=500`, as.otherAdmin.auth)).body.data.some((e: any) => e.target === `playbook:${teamBook}`)).toBe(false);
    const item = { kind: "playbook", title: "Playbook Ops agents changed; 1 key follows it", status: "version 2", href: "/dashboard/#playbooks" };
    for (const who of [root, as.admin]) expect((await call("/api/v1/inbox", who.auth)).body.data.filter((x: any) => x.kind === "playbook")).toEqual([expect.objectContaining(item)]);
    for (const who of [as.viewer, as.otherAdmin]) expect((await call("/api/v1/inbox", who.auth)).body.data.filter((x: any) => x.kind === "playbook")).toEqual([]);
    // An account-wide playbook in an account with teams: every team's log, and the inbox of each team's owners and admins.
    await call(`/api/v1/playbooks/${accountBook}`, root.auth, "PUT", { policy: strict });
    for (const t of [team, other]) expect((await call(`/api/v1/teams/${t}/audit?limit=500`, root.auth)).body.data.filter((e: any) => e.target === `playbook:${accountBook}` && e.action === "playbook.update").length).toBe(1);
    expect((await call("/api/v1/inbox", as.otherAdmin.auth)).body.data.filter((x: any) => x.kind === "playbook").map((x: any) => x.title)).toEqual(["Playbook Everyone changed; 1 key follows it"]);
  });
});

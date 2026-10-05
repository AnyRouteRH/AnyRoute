// U115: team playbooks. One named rulebook that many agents and API keys follow; change it once and every following key
// follows the change at its next request. Same switch, roles and validation as a key's own rulebook (src/api/agents.ts):
// AGENT_POLICY_ENABLED, management keys or team owners/admins, and agentPolicySchema. Storage and propagation live in
// src/agents/playbooks.ts.
import type { Context, Hono } from "hono";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { keys, teams } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { agentPolicySchema } from "../agents/policy.ts";
import { agentPolicies, playbookChanges, playbooks } from "../agents/schema.ts";
import { auditPlaybook, createPlaybook, deletePlaybook, followPlaybook, MAX_PLAYBOOKS_PER_ACCOUNT, updatePlaybook, type PlaybookChangeRow, type PlaybookRow } from "../agents/playbooks.ts";
import { actorOf } from "../teams/audit.ts";
import type { KeyRow } from "./auth.ts";
import { readJson } from "./common.ts";
import { ownedKey, principal } from "./agents.ts";

const name = z.string().trim().min(1).max(100);
const id = z.string().min(1).max(64);
const createBody = z.strictObject({ name, policy: agentPolicySchema, team_id: id.nullable().optional() });
const updateBody = z.strictObject({ name: name.optional(), policy: agentPolicySchema.optional() }).refine((v) => v.name !== undefined || v.policy !== undefined, "Send a name, a policy or both.");
const followBody = z.strictObject({ playbook_id: id.nullable() });

/** Management keys see every playbook of the account; a team owner or admin sees its team's and the account-wide ones. */
const visible = (caller: KeyRow, row: PlaybookRow) => row.accountId === caller.accountId && (caller.management || row.teamId === null || row.teamId === caller.teamId);
/** Account-wide playbooks change only with a management key; a team's own, also with that team's owners and admins. */
const editable = (caller: KeyRow, row: PlaybookRow) => caller.management || (row.teamId !== null && row.teamId === caller.teamId);

type Follower = { keyHash: string; name: string | null; teamId: string | null; playbookId: string | null };
const changeJson = (row: PlaybookChangeRow) => ({ action: row.action, version: row.version, sha256: row.sha256, name: row.name, followers: row.followers, at: row.at.toISOString() });
function playbookJson(caller: KeyRow, row: PlaybookRow, followers: Follower[]) {
  const mine = followers.filter((f) => f.playbookId === row.id);
  return {
    id: row.id, name: row.name, team_id: row.teamId, policy: row.spec, sha256: row.sha256, version: row.version,
    created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(), updated_by: row.updatedBy,
    followers: mine.length,
    // Only keys the caller may manage are named; the count covers every key that follows.
    keys: mine.filter((f) => caller.management || f.teamId === caller.teamId).map((f) => ({ key_hash: f.keyHash, name: f.name })),
    can_edit: editable(caller, row),
  };
}

export function playbooksRoutes(app: Hono, ctx: Ctx) {
  for (const path of ["/api/v1/playbooks", "/api/v1/playbooks/*"]) app.use(path, async (_c, next) => { if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found"); await next(); });
  const followersOf = (ids: string[]) => ids.length
    ? ctx.db.select({ keyHash: keys.keyHash, name: keys.name, teamId: keys.teamId, playbookId: agentPolicies.playbookId }).from(agentPolicies).innerJoin(keys, eq(keys.keyHash, agentPolicies.keyHash)).where(inArray(agentPolicies.playbookId, ids)).orderBy(asc(keys.keyHash))
    : Promise.resolve([] as Follower[]);
  const load = async (caller: KeyRow, playbookId: string) => {
    const [row] = await ctx.db.select().from(playbooks).where(and(eq(playbooks.id, playbookId), eq(playbooks.accountId, caller.accountId)));
    if (!row || !visible(caller, row)) fail(404, "Playbook not found.", "not_found");
    return row;
  };
  const loadEditable = async (caller: KeyRow, playbookId: string) => {
    const row = await load(caller, playbookId);
    if (!editable(caller, row)) fail(403, "This playbook covers the whole account; only a management key can change it.", "forbidden");
    return row;
  };
  const describe = async (caller: KeyRow, row: PlaybookRow) => playbookJson(caller, row, await followersOf([row.id]));
  const audit = async (caller: KeyRow, row: Pick<PlaybookRow, "id" | "accountId" | "teamId">, action: Parameters<typeof auditPlaybook>[3], detail: Parameters<typeof auditPlaybook>[4]) =>
    auditPlaybook(ctx.db, row, await actorOf(ctx.db, caller), action, detail);

  app.get("/api/v1/playbooks", async (c: Context) => {
    const caller = await principal(ctx, c);
    const rows = (await ctx.db.select().from(playbooks).where(eq(playbooks.accountId, caller.accountId)).orderBy(asc(playbooks.name), asc(playbooks.id))).filter((row) => visible(caller, row));
    const followers = await followersOf(rows.map((row) => row.id));
    return c.json({ data: rows.map((row) => playbookJson(caller, row, followers)), limit: MAX_PLAYBOOKS_PER_ACCOUNT });
  });

  app.post("/api/v1/playbooks", async (c: Context) => {
    const caller = await principal(ctx, c);
    const body = createBody.parse(await readJson(c));
    // A team owner or admin makes playbooks for its own team; a management key for the account or for one of its teams.
    let teamId: string | null;
    if (caller.management) {
      teamId = body.team_id ?? null;
      if (teamId && !(await ctx.db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.ownerAccount, caller.accountId)))).length) fail(404, "Team not found.", "not_found");
    } else {
      if (body.team_id !== undefined && body.team_id !== caller.teamId) fail(403, "A team key makes playbooks for its own team only.", "forbidden");
      teamId = caller.teamId;
    }
    const { row } = await createPlaybook(ctx.db, { accountId: caller.accountId, teamId, name: body.name, policy: body.policy, actor: caller.keyHash });
    await audit(caller, row, "playbook.create", { name: row.name, version: row.version, sha256: row.sha256, keys: 0 });
    return c.json({ data: await describe(caller, row) }, 201);
  });

  app.get("/api/v1/playbooks/:id", async (c: Context) => {
    const caller = await principal(ctx, c);
    const row = await load(caller, c.req.param("id")!);
    const changes = await ctx.db.select().from(playbookChanges).where(eq(playbookChanges.playbookId, row.id)).orderBy(desc(playbookChanges.id)).limit(50);
    return c.json({ data: { ...(await describe(caller, row)), changes: changes.map(changeJson) } });
  });

  app.put("/api/v1/playbooks/:id", async (c: Context) => {
    const caller = await principal(ctx, c);
    const before = await loadEditable(caller, c.req.param("id")!);
    const body = updateBody.parse(await readJson(c));
    const { row, followers, change, rules } = await updatePlaybook(ctx.db, caller.accountId, before.id, body, caller.keyHash);
    if (change) await audit(caller, row, rules ? "playbook.update" : "playbook.rename", { name: row.name, ...(row.name !== before.name ? { previous_name: before.name } : {}), version: row.version, sha256: row.sha256, previous_sha256: before.sha256, keys: followers.length });
    return c.json({ data: { ...(await describe(caller, row)), changed: !!change } });
  });

  app.delete("/api/v1/playbooks/:id", async (c: Context) => {
    const caller = await principal(ctx, c);
    const unlink = c.req.query("unlink");
    if (unlink !== undefined && unlink !== "copy") fail(400, "`unlink` is copy: each following key keeps the playbook's rules as its own.", "invalid_request");
    const before = await loadEditable(caller, c.req.param("id")!);
    const { row, followers } = await deletePlaybook(ctx.db, caller.accountId, before.id, unlink === "copy", caller.keyHash);
    await audit(caller, row, "playbook.delete", { name: row.name, version: row.version, sha256: row.sha256, keys: followers.length });
    return c.json({ data: { id: row.id, deleted: true, unlinked: followers.length } });
  });

  // Follow a playbook, or stop following one with { playbook_id: null } (the key keeps those rules as its own rulebook).
  app.post("/api/v1/agents/:key_hash/playbook", async (c: Context) => {
    const caller = await principal(ctx, c);
    const key = await ownedKey(ctx, caller, c.req.param("key_hash")!);
    const body = followBody.parse(await readJson(c));
    if (body.playbook_id !== null) {
      const book = await load(caller, body.playbook_id);
      if (book.teamId !== null && key.teamId !== book.teamId) fail(409, "That playbook belongs to another team; only keys in that team can follow it.", "playbook_team_mismatch");
    }
    const result = await followPlaybook(ctx.db, key, body.playbook_id, caller.keyHash);
    if (result.changed && result.playbook) {
      const keysNow = (await followersOf([result.playbook.id])).length;
      await audit(caller, result.playbook, body.playbook_id === null ? "playbook.unfollow" : "playbook.follow", { key_hash: key.keyHash, name: result.playbook.name, version: result.playbook.version, sha256: result.playbook.sha256, previous_sha256: result.previous?.sha256 ?? null, keys: keysNow });
    }
    const row = result.row;
    return c.json({ data: {
      key_hash: key.keyHash, changed: result.changed,
      playbook: row?.playbookId && result.playbook ? { id: result.playbook.id, name: result.playbook.name, version: result.playbook.version } : null,
      policy: row?.spec ?? null, sha256: row?.sha256 ?? null, killed: row?.killed ?? false, playbook_id: row?.playbookId ?? null,
    } });
  });
}

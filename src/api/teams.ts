import { recordMemberKeySecurity, recordDisabledSecurity } from "../security-alerts/records.ts"; // D138
import { accountDefaultScope } from "../provisioning/keys.ts"; // ZK6
import type { Context, Hono } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { keys, kv, teamMembers, teamPrincipals, teams } from "../db/schema.ts";
import { deriveKey, generateApiKey } from "../chain/keys.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import { randomHex, sha256, uid } from "../lib/util.ts";
import { actorOf, appendAudit, auditAll, auditHead, auditPage, entryJson, exportCsv, exportJsonl, GENESIS, hourlyRoots } from "../teams/audit.ts";
import { allocated, assertFitsOrgBudget, ORG_ADMIN, ORG_READ, requireTeamRole, unlimitedKeys, verifyWalletMessage, type TeamRow } from "../teams/org.ts";
import { toB64u, verifyAssertion, verifyRegistration, WebAuthnError } from "../teams/webauthn.ts";
import { addressBucket, readJson } from "./common.ts";
import { requireKey, ROLE_RANK, type KeyRow, type Role } from "./auth.ts";
import { keyJson } from "./keys.ts";

// Anonymous organisations on top of teams: an owner that is an account, a wallet or a Safe (EIP-1271), members who join by
// passkey (WebAuthn) or wallet with an invite (no email, no name), roles, an org budget and a hash-chained audit log.

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const B64U = z.string().max(16_384).regex(/^[A-Za-z0-9_-]*={0,2}$/);
const CHALLENGE_TTL_MS = 300_000;
const SIGN_IN_KEY_TTL_MS = 12 * 3_600_000;
const INVITE_ROLES = ["admin", "dev", "viewer"] as const; // agents are API keys (POST /api/v1/keys with role agent), not people
const MEMBER_ROLES = ["owner", "admin", "dev", "member", "viewer", "agent"] as const;

type Principal = typeof teamPrincipals.$inferSelect;
type Challenge = { purpose: "join" | "sign-in" | "owner"; team: string; method: "passkey" | "wallet"; challenge?: string; message?: string; address?: string; invite?: string; expires: number };
type Invite = { team: string; role: (typeof INVITE_ROLES)[number]; method: "passkey" | "wallet" | "any"; expires: number; by: string };

const principalJson = (p: Principal) => ({
  id: p.id,
  kind: p.kind,
  subject: p.kind === "passkey" ? p.subject.slice(0, 16) : p.subject,
  role: p.role,
  disabled: p.disabled,
  created_at: p.createdAt.toISOString(),
  last_used: p.lastUsed?.toISOString() ?? null,
});

async function teamJson(ctx: Ctx, t: TeamRow, yourRole: Role | null) {
  const members = await ctx.db
    .select({ keyHash: teamMembers.keyHash, role: teamMembers.role, principal: teamMembers.principalId, name: keys.name, disabled: keys.disabled })
    .from(teamMembers)
    .leftJoin(keys, eq(keys.keyHash, teamMembers.keyHash))
    .where(eq(teamMembers.teamId, t.id))
    .orderBy(asc(teamMembers.createdAt));
  const principals = await ctx.db.select().from(teamPrincipals).where(eq(teamPrincipals.teamId, t.id)).orderBy(asc(teamPrincipals.createdAt));
  const head = await auditHead(ctx.db, t.id);
  return {
    id: t.id,
    name: t.name,
    created_at: t.createdAt.toISOString(),
    owner: { account: t.ownerAccount, address: t.ownerAddress, kind: t.ownerKind, verified_at: t.ownerVerifiedAt?.toISOString() ?? null },
    budget_usd: t.budget == null ? null : picoToUsd(t.budget),
    allocated_usd: picoToUsd(await allocated(ctx.db, t.id)),
    your_role: yourRole,
    members: members.map((m) => ({ key_hash: m.keyHash, role: m.role, principal: m.principal, name: m.name ?? "", disabled: m.disabled ?? false })),
    principals: principals.map(principalJson),
    audit: { entries: head.seq, head: head.hash },
  };
}

function walletMessage(ctx: Ctx, action: string, address: string, nonce: string, expires: number) {
  const origin = new URL(ctx.cfg.publicUrl).origin;
  return `Anyroute organisation\nAction: ${action}\nOrigin: ${origin}\nChain ID: ${ctx.cfg.chain.id}\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}`;
}

async function saveChallenge(ctx: Ctx, ch: Challenge) {
  const id = randomHex(24);
  await ctx.db.delete(kv).where(sql`${kv.key} LIKE 'team-challenge:%' AND ${kv.updatedAt} < now() - interval '10 minutes'`);
  await ctx.db.insert(kv).values({ key: `team-challenge:${id}`, value: ch });
  return id;
}

async function loadChallenge(ctx: Ctx, id: string, purpose: Challenge["purpose"], team?: string) {
  if (!/^[0-9a-f]{48}$/.test(id)) fail(401, "The challenge is invalid, expired or already used.", "invalid_challenge");
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, `team-challenge:${id}`));
  const ch = row?.value as Challenge | undefined;
  if (!ch || ch.purpose !== purpose || ch.expires < Date.now() || (team && ch.team !== team)) fail(401, "The challenge is invalid, expired or already used.", "invalid_challenge");
  return ch;
}

/** Consume a challenge inside the transaction that acts on it, so it works once. */
async function consume(tx: Tx, key: string) {
  const used = await tx.delete(kv).where(eq(kv.key, key)).returning({ key: kv.key });
  if (!used.length) fail(401, "The challenge is invalid, expired or already used.", "invalid_challenge");
}

async function loadInvite(ctx: Ctx, invite: string) {
  const [row] = await ctx.db.select().from(kv).where(eq(kv.key, `team-invite:${sha256(invite)}`));
  const inv = row?.value as Invite | undefined;
  if (!inv || inv.expires < Date.now()) fail(401, "This invite is invalid, expired or already used.", "invalid_invite");
  return inv;
}

const passkeyPolicy = (ctx: Ctx, challenge: string) => ({ rpId: ctx.cfg.webauthn.rpId, origins: ctx.cfg.webauthn.origins, challenge });

/** A short-lived key for a member who signed in: it manages the org within the member's role and has a limit of 0. */
async function issueMemberKey(ctx: Ctx, tx: Tx, team: TeamRow, principal: Principal, via: string) {
  const secret = generateApiKey();
  const d = deriveKey(secret);
  await tx.insert(keys).values({
    keyHash: d.keyHash,
    chainKeyHash: d.chainKeyHash,
    keyAddress: d.keyAddress,
    scope: await accountDefaultScope(ctx, tx, team.ownerAccount), // ZK6
    accountId: team.ownerAccount,
    label: d.label,
    name: `${principal.kind} sign-in`,
    teamId: team.id,
    management: false,
    budget: 0n,
    expiresAt: new Date(Date.now() + SIGN_IN_KEY_TTL_MS),
    rpm: ctx.cfg.limits.defaultRpm || null,
  });
  await tx.insert(teamMembers).values({ teamId: team.id, keyHash: d.keyHash, role: principal.role, principalId: principal.id });
  const actor = principal.kind === "wallet" ? `wallet:${principal.subject}` : `passkey:${principal.id}`;
  await appendAudit(tx, team.id, actor, "key.create", d.keyHash, { via, role: principal.role, expires_at: new Date(Date.now() + SIGN_IN_KEY_TTL_MS).toISOString(), limit_usd: 0 });
  const [row] = await tx.select().from(keys).where(eq(keys.keyHash, d.keyHash));
  await recordMemberKeySecurity(ctx, tx, row, principal.kind); // D138
  return { row: row!, secret };
}

const signedIn = (team: TeamRow, p: Principal, k: { row: KeyRow; secret: string }) => ({
  data: { team: team.id, principal: { id: p.id, kind: p.kind, role: p.role }, key: keyJson(k.row) },
  key: k.secret,
});

const rank = (r: string) => ROLE_RANK[r as Role] ?? -1;

export function teamsRoutes(app: Hono, ctx: Ctx) {
  const caller = (c: Context) => requireKey(ctx, c.req.header("authorization"));
  const limitAuth = async (c: Context) => {
    const from = addressBucket(c, ctx.cfg);
    const r = await ctx.limiter.take(`team-auth:${from.id}`, 1, from.scale(ctx.cfg.limits.unauthRpm), 60_000);
    if (!r.ok) fail(429, "Too many organisation sign-in attempts. Try again in a minute.", "rate_limited");
  };

  app.post("/api/v1/teams", async (c) => {
    const k = await caller(c);
    if (!k.management) fail(403, "Only a management key can create teams.", "forbidden");
    const v = z.object({ name: z.string().min(1).max(100), budget_usd: z.number().nonnegative().nullable().optional() }).parse(await readJson(c));
    const id = uid("team_");
    // A team made by a wallet-signed-in account is owned by that wallet: the sign-in already proved the key to it.
    const wallet = /^w_[0-9a-f]{40}$/.test(k.accountId) ? "0x" + k.accountId.slice(2) : null;
    await ctx.db.transaction(async (tx) => {
      await tx.insert(teams).values({ id, name: v.name, ownerAccount: k.accountId, budget: v.budget_usd == null ? null : usdToPico(v.budget_usd), ...(wallet ? { ownerAddress: wallet, ownerKind: "eoa", ownerVerifiedAt: new Date() } : {}) });
      if (wallet) await tx.insert(teamPrincipals).values({ id: uid("tp_"), teamId: id, kind: "wallet", subject: wallet, role: "owner" });
      await appendAudit(tx, id, await actorOf(tx, k), "team.create", id, { name: v.name, budget_usd: v.budget_usd ?? null, owner: wallet ?? k.accountId });
    });
    const [t] = await ctx.db.select().from(teams).where(eq(teams.id, id));
    return c.json({ data: await teamJson(ctx, t!, "owner") }, 201);
  });

  app.get("/api/v1/teams", async (c) => {
    const k = await caller(c);
    if (k.management) {
      const rows = await ctx.db.select().from(teams).where(eq(teams.ownerAccount, k.accountId)).orderBy(asc(teams.createdAt));
      return c.json({ data: await Promise.all(rows.map((t) => teamJson(ctx, t, "owner"))) });
    }
    if (!k.teamId) return c.json({ data: [] });
    const { team, role } = await requireTeamRole(ctx, k, k.teamId, ORG_READ);
    return c.json({ data: [await teamJson(ctx, team, role)] });
  });

  app.get("/api/v1/teams/:id", async (c) => {
    const { team, role } = await requireTeamRole(ctx, await caller(c), c.req.param("id"), ORG_READ);
    return c.json({ data: await teamJson(ctx, team, role) });
  });

  app.patch("/api/v1/teams/:id", async (c) => {
    const k = await caller(c);
    const { team, role } = await requireTeamRole(ctx, k, c.req.param("id"), ORG_ADMIN);
    const v = z.object({ name: z.string().min(1).max(100).optional(), budget_usd: z.number().nonnegative().nullable().optional() }).parse(await readJson(c));
    const actor = await actorOf(ctx.db, k);
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM teams WHERE id = ${team.id} FOR UPDATE`);
      if (v.name !== undefined && v.name !== team.name) {
        await tx.update(teams).set({ name: v.name }).where(eq(teams.id, team.id));
        await appendAudit(tx, team.id, actor, "team.rename", team.id, { name: v.name, previous: team.name });
      }
      if (v.budget_usd !== undefined) {
        const budget = v.budget_usd == null ? null : usdToPico(v.budget_usd);
        if (budget != null) {
          const open = await unlimitedKeys(tx, team.id);
          if (open.length) fail(409, `Give every key in the team a limit before setting an org budget (${open.length} without one).`, "org_budget_unlimited_keys", { key_hashes: open });
          const used = await allocated(tx, team.id);
          if (used > budget) fail(409, `The team's keys already have ${picoToUsd(used)} USD of limits, more than that budget.`, "org_budget_exceeded", { allocated_usd: picoToUsd(used) });
        }
        await tx.update(teams).set({ budget }).where(eq(teams.id, team.id));
        await appendAudit(tx, team.id, actor, "budget.set", team.id, { budget_usd: v.budget_usd, previous_usd: team.budget == null ? null : picoToUsd(team.budget) });
      }
    });
    const [t] = await ctx.db.select().from(teams).where(eq(teams.id, team.id));
    return c.json({ data: await teamJson(ctx, t!, role) });
  });

  // Add a key to the team or change its role. Admins manage keys in their team only, and never grant at or above their own role.
  app.put("/api/v1/teams/:id/members/:hash", async (c) => {
    const k = await caller(c);
    const { team, role: myRole } = await requireTeamRole(ctx, k, c.req.param("id"), ORG_ADMIN);
    const myRank = k.management ? ROLE_RANK.owner + 1 : ROLE_RANK[myRole];
    const v = z.object({ role: z.enum(MEMBER_ROLES) }).parse(await readJson(c));
    const [target] = await ctx.db.select().from(keys).where(and(eq(keys.keyHash, c.req.param("hash")), eq(keys.accountId, k.accountId)));
    if (!target) fail(404, "Key not found.", "not_found");
    const [current] = await ctx.db.select().from(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.keyHash, target.keyHash)));
    if (!k.management) {
      if (target.management || (target.teamId && target.teamId !== team.id)) fail(403, "That key is outside this team.", "forbidden");
      if (ROLE_RANK[v.role] >= myRank && !(ROLE_RANK[v.role] === myRank && myRank === ROLE_RANK.owner)) fail(403, "You cannot grant a role at or above your own.", "forbidden");
      if (current && rank(current.role) >= myRank && myRank !== ROLE_RANK.owner) fail(403, "You cannot change a member at or above your role.", "forbidden");
    }
    // A key moving into a team with an org budget must fit in it, like a key created there.
    if (target.teamId !== team.id && !target.disabled) await assertFitsOrgBudget(ctx.db, team.id, target.budget);
    await ctx.db.transaction(async (tx) => {
      await tx.update(keys).set({ teamId: team.id }).where(eq(keys.keyHash, target.keyHash));
      await tx.insert(teamMembers).values({ teamId: team.id, keyHash: target.keyHash, role: v.role }).onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.keyHash], set: { role: v.role } });
      await appendAudit(tx, team.id, await actorOf(tx, k), "member.role", target.keyHash, { kind: "key", role: v.role, previous: current?.role ?? null });
    });
    return c.json({ data: { team: team.id, key_hash: target.keyHash, role: v.role } });
  });

  // Bind the team to a wallet or a Safe: the owner signs a one-time message with it. EOAs are checked by recovery, contract
  // wallets by EIP-1271 isValidSignature on chain. The bound address can then sign in as the team's owner.
  app.post("/api/v1/teams/:id/owner/challenge", async (c) => {
    const { team } = await requireTeamRole(ctx, await caller(c), c.req.param("id"), ["owner"]);
    const v = z.object({ address: ADDRESS }).parse(await readJson(c));
    const address = v.address.toLowerCase();
    const nonce = randomHex(24);
    const expires = Date.now() + CHALLENGE_TTL_MS;
    const message = walletMessage(ctx, `own team ${team.id}`, address, nonce, expires);
    const id = await saveChallenge(ctx, { purpose: "owner", team: team.id, method: "wallet", message, address, expires });
    return c.json({ data: { nonce: id, challenge_id: id, message, expires_at: new Date(expires).toISOString() } });
  });

  app.post("/api/v1/teams/:id/owner", async (c) => {
    const k = await caller(c);
    const { team } = await requireTeamRole(ctx, k, c.req.param("id"), ["owner"]);
    const v = z.object({ address: ADDRESS, nonce: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(20_000) }).parse(await readJson(c));
    const ch = await loadChallenge(ctx, v.nonce, "owner", team.id);
    const address = v.address.toLowerCase();
    if (ch.address !== address) fail(401, "The challenge was made for a different address.", "invalid_challenge");
    const kind = await verifyWalletMessage(ctx, address, ch.message!, v.signature as Hex);
    if (!kind) fail(401, "The signature is not valid for that address (EOA signature or EIP-1271 isValidSignature).", "invalid_signature");
    const actor = await actorOf(ctx.db, k);
    await ctx.db.transaction(async (tx) => {
      await consume(tx, `team-challenge:${v.nonce}`);
      await tx.update(teams).set({ ownerAddress: address, ownerKind: kind, ownerVerifiedAt: new Date() }).where(eq(teams.id, team.id));
      // The owner's wallet signs in like a wallet member, as owner; an earlier owner wallet stops being one.
      await tx.update(teamPrincipals).set({ disabled: true }).where(and(eq(teamPrincipals.teamId, team.id), eq(teamPrincipals.role, "owner")));
      await tx
        .insert(teamPrincipals)
        .values({ id: uid("tp_"), teamId: team.id, kind: "wallet", subject: address, role: "owner" })
        .onConflictDoUpdate({ target: [teamPrincipals.teamId, teamPrincipals.kind, teamPrincipals.subject], set: { role: "owner", disabled: false } });
      await appendAudit(tx, team.id, actor, "owner.bind", address, { kind, previous: team.ownerAddress });
    });
    const [t] = await ctx.db.select().from(teams).where(eq(teams.id, team.id));
    return c.json({ data: await teamJson(ctx, t!, "owner") });
  });

  // Invites are single-use codes shown once; only their SHA-256 is stored.
  app.post("/api/v1/teams/:id/invites", async (c) => {
    const k = await caller(c);
    const { team, role: myRole } = await requireTeamRole(ctx, k, c.req.param("id"), ORG_ADMIN);
    const v = z.object({ role: z.enum(INVITE_ROLES), method: z.enum(["passkey", "wallet", "any"]).default("any"), ttl_hours: z.number().int().min(1).max(168).default(72) }).parse(await readJson(c));
    if (myRole !== "owner" && ROLE_RANK[v.role] >= ROLE_RANK[myRole]) fail(403, "You cannot invite a member at or above your own role.", "forbidden");
    const invite = `ar-inv-${randomHex(24)}`;
    const expires = Date.now() + v.ttl_hours * 3_600_000;
    await ctx.db.delete(kv).where(sql`${kv.key} LIKE 'team-invite:%' AND (${kv.value}->>'expires')::bigint < ${Date.now()}`);
    await ctx.db.insert(kv).values({ key: `team-invite:${sha256(invite)}`, value: { team: team.id, role: v.role, method: v.method, expires, by: k.keyHash } satisfies Invite });
    await appendAudit(ctx.db, team.id, await actorOf(ctx.db, k), "invite.create", sha256(invite).slice(0, 16), { role: v.role, method: v.method, expires_at: new Date(expires).toISOString() });
    return c.json({ data: { invite, team: team.id, role: v.role, method: v.method, expires_at: new Date(expires).toISOString() } }, 201);
  });

  // Joining: the invite plus a passkey registration or a wallet signature. No email, no name.
  app.post("/api/v1/teams/join/challenge", async (c) => {
    await limitAuth(c);
    const v = z.object({ invite: z.string().max(100), method: z.enum(["passkey", "wallet"]), address: ADDRESS.optional() }).parse(await readJson(c));
    const inv = await loadInvite(ctx, v.invite);
    if (inv.method !== "any" && inv.method !== v.method) fail(400, `This invite is for joining with a ${inv.method}.`, "invalid_request");
    const expires = Date.now() + CHALLENGE_TTL_MS;
    const invite = sha256(v.invite);
    if (v.method === "wallet") {
      if (!v.address) fail(400, "Joining with a wallet needs its `address`.", "invalid_request");
      const address = v.address.toLowerCase();
      const message = walletMessage(ctx, `join team ${inv.team} as ${inv.role}`, address, randomHex(24), expires);
      const id = await saveChallenge(ctx, { purpose: "join", team: inv.team, method: "wallet", message, address, invite, expires });
      return c.json({ data: { challenge_id: id, method: "wallet", message, expires_at: new Date(expires).toISOString() } });
    }
    const challenge = toB64u(randomBytes(32));
    const id = await saveChallenge(ctx, { purpose: "join", team: inv.team, method: "passkey", challenge, invite, expires });
    return c.json({
      data: {
        challenge_id: id,
        method: "passkey",
        expires_at: new Date(expires).toISOString(),
        publicKey: {
          challenge,
          rp: { id: ctx.cfg.webauthn.rpId, name: "Anyroute" },
          // A random handle and a generic name: the passkey carries nothing that identifies the member.
          user: { id: toB64u(randomBytes(16)), name: `anyroute-${randomHex(4)}`, displayName: "Anyroute organisation member" },
          pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: "public-key", alg })),
          timeout: CHALLENGE_TTL_MS,
          attestation: "none",
          authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        },
      },
    });
  });

  app.post("/api/v1/teams/join", async (c) => {
    await limitAuth(c);
    const v = z
      .object({
        invite: z.string().max(100),
        challenge_id: z.string(),
        passkey: z.object({ id: B64U, rawId: B64U.optional(), type: z.literal("public-key").optional(), response: z.object({ clientDataJSON: B64U, attestationObject: B64U }) }).optional(),
        wallet: z.object({ address: ADDRESS, signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(20_000) }).optional(),
      })
      .parse(await readJson(c));
    const ch = await loadChallenge(ctx, v.challenge_id, "join");
    const inv = await loadInvite(ctx, v.invite);
    if (ch.invite !== sha256(v.invite) || ch.team !== inv.team) fail(401, "The challenge was made for a different invite.", "invalid_challenge");
    let kind: "passkey" | "wallet";
    let subject: string;
    let cred: { publicKey: string; alg: number; signCount: number } | null = null;
    if (ch.method === "passkey") {
      if (!v.passkey) fail(400, "Send the passkey registration as `passkey`.", "invalid_request");
      try {
        const r = verifyRegistration(v.passkey.response, passkeyPolicy(ctx, ch.challenge!));
        if (v.passkey.id.replace(/=+$/, "") !== r.credentialId) throw new WebAuthnError("The credential id does not match the one in authenticatorData.");
        cred = r;
        subject = r.credentialId;
      } catch (e) {
        if (e instanceof WebAuthnError) fail(401, `Passkey registration rejected: ${e.message}`, "invalid_passkey");
        throw e;
      }
      kind = "passkey";
    } else {
      if (!v.wallet) fail(400, "Send the wallet signature as `wallet`.", "invalid_request");
      const address = v.wallet.address.toLowerCase();
      if (address !== ch.address) fail(401, "The challenge was made for a different address.", "invalid_challenge");
      if (!(await verifyWalletMessage(ctx, address, ch.message!, v.wallet.signature as Hex))) fail(401, "The signature is not valid for that address.", "invalid_signature");
      kind = "wallet";
      subject = address;
    }
    const [team] = await ctx.db.select().from(teams).where(eq(teams.id, inv.team));
    if (!team) fail(404, "Team not found.", "not_found");
    const out = await ctx.db.transaction(async (tx) => {
      await consume(tx, `team-challenge:${v.challenge_id}`);
      const used = await tx.delete(kv).where(eq(kv.key, `team-invite:${sha256(v.invite)}`)).returning({ key: kv.key });
      if (!used.length) fail(401, "This invite is invalid, expired or already used.", "invalid_invite");
      const [p] = await tx
        .insert(teamPrincipals)
        .values({ id: uid("tp_"), teamId: team.id, kind, subject, role: inv.role, publicKey: cred?.publicKey ?? null, alg: cred?.alg ?? null, signCount: cred?.signCount ?? 0, lastUsed: new Date() })
        .onConflictDoNothing()
        .returning();
      if (!p) fail(409, `That ${kind} is already a member of this team.`, "already_member");
      const actor = kind === "wallet" ? `wallet:${subject}` : `passkey:${p.id}`;
      await appendAudit(tx, team.id, actor, "member.join", p.id, { kind, role: inv.role, invite: sha256(v.invite).slice(0, 16) });
      return { p, k: await issueMemberKey(ctx, tx, team, p, kind) };
    });
    return c.json(signedIn(team, out.p, out.k), 201);
  });

  // Signing in: a passkey assertion (discoverable credentials, so the server never lists a team's passkeys) or a wallet
  // signature (EOA or EIP-1271). The owner's bound wallet or Safe signs in as owner.
  app.post("/api/v1/teams/:id/sign-in/challenge", async (c) => {
    await limitAuth(c);
    const teamId = c.req.param("id");
    const v = z.object({ method: z.enum(["passkey", "wallet"]), address: ADDRESS.optional() }).parse(await readJson(c));
    const [team] = await ctx.db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId));
    if (!team) fail(404, "Team not found.", "not_found");
    const expires = Date.now() + CHALLENGE_TTL_MS;
    if (v.method === "wallet") {
      if (!v.address) fail(400, "Signing in with a wallet needs its `address`.", "invalid_request");
      const address = v.address.toLowerCase();
      const message = walletMessage(ctx, `sign in to team ${teamId}`, address, randomHex(24), expires);
      const id = await saveChallenge(ctx, { purpose: "sign-in", team: teamId, method: "wallet", message, address, expires });
      return c.json({ data: { challenge_id: id, method: "wallet", message, expires_at: new Date(expires).toISOString() } });
    }
    const challenge = toB64u(randomBytes(32));
    const id = await saveChallenge(ctx, { purpose: "sign-in", team: teamId, method: "passkey", challenge, expires });
    return c.json({ data: { challenge_id: id, method: "passkey", expires_at: new Date(expires).toISOString(), publicKey: { challenge, rpId: ctx.cfg.webauthn.rpId, allowCredentials: [], userVerification: "preferred", timeout: CHALLENGE_TTL_MS } } });
  });

  app.post("/api/v1/teams/:id/sign-in", async (c) => {
    await limitAuth(c);
    const teamId = c.req.param("id");
    const v = z
      .object({
        challenge_id: z.string(),
        passkey: z.object({ id: B64U, rawId: B64U.optional(), type: z.literal("public-key").optional(), response: z.object({ clientDataJSON: B64U, authenticatorData: B64U, signature: B64U, userHandle: B64U.nullable().optional() }) }).optional(),
        wallet: z.object({ address: ADDRESS, signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(20_000) }).optional(),
      })
      .parse(await readJson(c));
    const ch = await loadChallenge(ctx, v.challenge_id, "sign-in", teamId);
    const denied = () => fail(401, "Sign-in failed: not a member of this team, or the signature is not valid.", "sign_in_failed");
    let principal: Principal | undefined;
    let signCount: number | null = null;
    if (ch.method === "passkey") {
      if (!v.passkey) fail(400, "Send the passkey assertion as `passkey`.", "invalid_request");
      [principal] = await ctx.db.select().from(teamPrincipals).where(and(eq(teamPrincipals.teamId, teamId), eq(teamPrincipals.kind, "passkey"), eq(teamPrincipals.subject, v.passkey.id.replace(/=+$/, ""))));
      if (!principal || principal.disabled || !principal.publicKey || principal.alg == null) denied();
      try {
        signCount = verifyAssertion(v.passkey.response, passkeyPolicy(ctx, ch.challenge!), { publicKey: principal!.publicKey!, alg: principal!.alg!, signCount: principal!.signCount }).signCount;
      } catch (e) {
        if (e instanceof WebAuthnError) fail(401, `Passkey sign-in rejected: ${e.message}`, "invalid_passkey");
        throw e;
      }
    } else {
      if (!v.wallet) fail(400, "Send the wallet signature as `wallet`.", "invalid_request");
      const address = v.wallet.address.toLowerCase();
      if (address !== ch.address) fail(401, "The challenge was made for a different address.", "invalid_challenge");
      [principal] = await ctx.db.select().from(teamPrincipals).where(and(eq(teamPrincipals.teamId, teamId), eq(teamPrincipals.kind, "wallet"), eq(teamPrincipals.subject, address)));
      if (!principal || principal.disabled) denied();
      if (!(await verifyWalletMessage(ctx, address, ch.message!, v.wallet.signature as Hex))) denied();
    }
    const [team] = await ctx.db.select().from(teams).where(eq(teams.id, teamId));
    const p = principal!;
    const k = await ctx.db.transaction(async (tx) => {
      await consume(tx, `team-challenge:${v.challenge_id}`);
      await tx.update(teamPrincipals).set({ lastUsed: new Date(), ...(signCount !== null ? { signCount } : {}) }).where(eq(teamPrincipals.id, p.id));
      return issueMemberKey(ctx, tx, team!, p, p.kind);
    });
    return c.json(signedIn(team!, p, k), 201);
  });

  const principalRoute = async (c: Context) => {
    const k = await caller(c);
    const { team, role } = await requireTeamRole(ctx, k, c.req.param("id")!, ORG_ADMIN);
    const [p] = await ctx.db.select().from(teamPrincipals).where(and(eq(teamPrincipals.teamId, team.id), eq(teamPrincipals.id, c.req.param("pid")!)));
    if (!p) fail(404, "Member not found.", "not_found");
    if (p.role === "owner") fail(403, "The owner's wallet changes only by binding a new owner (POST /api/v1/teams/:id/owner).", "forbidden");
    if (role !== "owner" && rank(p.role) >= ROLE_RANK[role]) fail(403, "You cannot change a member at or above your role.", "forbidden");
    return { k, team, role, p };
  };

  async function revoke(tx: Tx | Db, teamId: string, pid: string) {
    await tx.update(teamPrincipals).set({ disabled: true }).where(eq(teamPrincipals.id, pid));
    const issued = await tx.select({ h: teamMembers.keyHash }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.principalId, pid)));
    await recordDisabledSecurity(ctx, tx, issued.map(r => r.h)); // D138
    if (issued.length) await tx.update(keys).set({ disabled: true }).where(inArray(keys.keyHash, issued.map((r) => r.h)));
    return issued.length;
  }

  app.patch("/api/v1/teams/:id/principals/:pid", async (c) => {
    const { k, team, role, p } = await principalRoute(c);
    const v = z.object({ role: z.enum(INVITE_ROLES).optional(), disabled: z.boolean().optional() }).parse(await readJson(c));
    if (v.role && role !== "owner" && ROLE_RANK[v.role] >= ROLE_RANK[role]) fail(403, "You cannot grant a role at or above your own.", "forbidden");
    const actor = await actorOf(ctx.db, k);
    await ctx.db.transaction(async (tx) => {
      if (v.role && v.role !== p.role) {
        await tx.update(teamPrincipals).set({ role: v.role }).where(eq(teamPrincipals.id, p.id));
        // Keys already issued to the member follow the new role.
        await tx.update(teamMembers).set({ role: v.role }).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.principalId, p.id)));
        await appendAudit(tx, team.id, actor, "member.role", p.id, { kind: p.kind, role: v.role, previous: p.role });
      }
      if (v.disabled === true && !p.disabled) {
        const n = await revoke(tx, team.id, p.id);
        await appendAudit(tx, team.id, actor, "member.revoke", p.id, { kind: p.kind, keys_disabled: n });
      }
      if (v.disabled === false && p.disabled) {
        await tx.update(teamPrincipals).set({ disabled: false }).where(eq(teamPrincipals.id, p.id));
        await appendAudit(tx, team.id, actor, "member.restore", p.id, { kind: p.kind });
      }
    });
    const [row] = await ctx.db.select().from(teamPrincipals).where(eq(teamPrincipals.id, p.id));
    return c.json({ data: principalJson(row!) });
  });

  app.delete("/api/v1/teams/:id/principals/:pid", async (c) => {
    const { k, team, p } = await principalRoute(c);
    const actor = await actorOf(ctx.db, k);
    const n = await ctx.db.transaction(async (tx) => {
      const n = await revoke(tx, team.id, p.id);
      if (!p.disabled) await appendAudit(tx, team.id, actor, "member.revoke", p.id, { kind: p.kind, keys_disabled: n });
      return n;
    });
    return c.json({ data: { id: p.id, revoked: true, keys_disabled: n } });
  });

  // The audit log: paginated, hourly Merkle roots, and an export with the whole chain for offline verification.
  app.get("/api/v1/teams/:id/audit", async (c) => {
    const { team } = await requireTeamRole(ctx, await caller(c), c.req.param("id"), ORG_READ);
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? 0)) || 0);
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(c.req.query("limit") ?? 100)) || 100));
    const rows = await auditPage(ctx.db, team.id, after, limit + 1);
    const page = rows.slice(0, limit);
    return c.json({ data: page.map(entryJson), head: await auditHead(ctx.db, team.id), next_after: rows.length > limit ? page.at(-1)!.seq : null, genesis: GENESIS });
  });

  app.get("/api/v1/teams/:id/audit/roots", async (c) => {
    const { team } = await requireTeamRole(ctx, await caller(c), c.req.param("id"), ORG_READ);
    return c.json({ data: hourlyRoots((await auditAll(ctx.db, team.id)).map(entryJson)) });
  });

  app.get("/api/v1/teams/:id/audit/export", async (c) => {
    const { team } = await requireTeamRole(ctx, await caller(c), c.req.param("id"), ORG_READ);
    const format = c.req.query("format") ?? "jsonl";
    if (format !== "jsonl" && format !== "csv") fail(400, "`format` is jsonl or csv.", "invalid_request");
    const entries = (await auditAll(ctx.db, team.id)).map(entryJson);
    const body = format === "csv" ? exportCsv(entries) : exportJsonl(team.id, entries);
    return c.body(body, 200, {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="anyroute-audit-${team.id}.${format}"`,
      "cache-control": "no-store",
    });
  });
}

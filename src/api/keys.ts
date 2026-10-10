import { recordBrowserSession } from "../browser-sessions/labels.ts"; // E147
import { readScopeInput, readKeyFields } from "../read-only/keys.ts"; // E149
import { allowedIpsInput } from "../key-ip/allowlist.ts"; // E148
import { recordKeySecurity } from "../security-alerts/records.ts"; // D138
import { projectInput, projectJson } from "../projects/tags.ts"; // C134
import { compatibilityFields, keyPagination, provisionedScope } from "../provisioning/keys.ts"; // ZK6
import type { Context, Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { encodeFunctionData, formatUnits, parseUnits, recoverMessageAddress, type Hex } from "viem";
import { CreditsAbi, erc20Abi } from "../chain/abis.ts";
import { withdrawableFor } from "../services/settlement.ts";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { agentSessions, byokKeys, generations, keys, kv, ledger, spentRoots, teamMembers, teams } from "../db/schema.ts";
import { deriveKey, generateApiKey } from "../chain/keys.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import { fastCreditFields } from "../pay/fast-credit-state.ts"; // V97
import { depositTiming } from "../pay/deposit-progress.ts"; // V97B
import { balanceOf, ensureAccount } from "../ledger/ledger.ts";
import { encrypt, uid, randomHex } from "../lib/util.ts";
import { SENTINEL_NEIGHBOUR, SpentTree, type SpentNeighbour } from "../receipts/merkle.ts";
import { addressBucket, readJson } from "./common.ts";
import { parseStoredTracing, sealTracing, tracingInput, tracingJson } from "../services/tracing.ts";
import { bearer, registerRootKey, requireKey, requireRole, ROLE_RANK, walletAccountId, type KeyRow, type Role } from "./auth.ts";
import { actorOf, appendAudit, type AuditDetail } from "../teams/audit.ts";
import { assertFitsOrgBudget } from "../teams/org.ts";
import { topupInput, topupJson, topupsThisWeek } from "../ledger/topup.ts";

const keySpec = z.object({
  allowed_ips: allowedIpsInput.optional(), // E148: PATCH only
  project: projectInput.nullable().optional(), // C134: PATCH only
  include_byok_in_limit: z.boolean().optional(), // ZK6
  scope: z.enum(readScopeInput).optional(), // ZK6: create only
  name: z.string().max(100).optional(),
  limit: z.number().nonnegative().nullable().optional(), // USD (OpenRouter provisioning API name)
  budget_usd: z.number().nonnegative().nullable().optional(), // alias of limit
  limit_reset: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
  rpm: z.number().int().positive().nullable().optional(),
  tpm: z.number().int().positive().nullable().optional(),
  allowed_models: z.array(z.string()).nullable().optional(),
  team: z.string().nullable().optional(),
  pay_with_default: z.string().max(16).nullable().optional(),
  disabled: z.boolean().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  guardrails: z
    .object({ pii: z.enum(["redact", "block"]).optional(), deny_patterns: z.array(z.string()).max(50).optional(), max_input_chars: z.number().int().positive().optional(), redact_output: z.boolean().optional() })
    .nullable()
    .optional(),
  routing: z.record(z.string(), z.unknown()).nullable().optional(),
  management: z.boolean().optional(),
  // Trace export for this key's public-lane calls; null removes it. Secrets are sealed and never returned.
  tracing: tracingInput.nullable().optional(),
  role: z.enum(["admin", "dev", "member", "viewer", "agent"]).optional(), // the key's role in its team (default member)
  // Auto top-up of the key's limit from the account's credits (src/ledger/topup.ts); null clears it. PATCH only.
  topup: topupInput.nullable().optional(),
});

export function keyJson(k: KeyRow) {
  return {
    ...projectJson(k), // C134: omit when unset
    ...compatibilityFields(k), // ZK6: additive exact counters and issuer fields
    hash: k.keyHash,
    name: k.name,
    label: k.label,
    disabled: k.disabled,
    limit: k.budget != null ? picoToUsd(k.budget) : null,
    limit_reset: k.budgetReset,
    limit_remaining: k.budget != null ? picoToUsd(k.budget - k.spent > 0n ? k.budget - k.spent : 0n) : null,
    usage: picoToUsd(k.spentTotal),
    usage_period: picoToUsd(k.spent),
    rpm: k.rpm,
    tpm: k.tpm,
    allowed_models: k.allowedModels,
    allowed_ips: k.allowedIps, // E148
    team: k.teamId,
    pay_with_default: k.payWithDefault,
    management: k.management,
    guardrails: k.guardrails,
    tracing: tracingJson(k.tracing),
    topup: topupJson(k.topup),
    chain_key_hash: k.chainKeyHash,
    key_address: k.keyAddress,
    created_at: k.createdAt.toISOString(),
    last_used: k.lastUsed?.toISOString() ?? null,
    expires_at: k.expiresAt?.toISOString() ?? null,
    ...readKeyFields(k), // E149: do not expose the read-visibility projection as management rights.
  };
}

function depositInfo(ctx: Ctx, k: Pick<KeyRow, "chainKeyHash" | "keyAddress">) {
  return {
    chain: ctx.cfg.chain.id,
    token: ctx.cfg.chain.usdg,
    credits_contract: ctx.cfg.chain.credits ?? null,
    key_hash: k.chainKeyHash,
    key_address: k.keyAddress,
    how: `Approve USDG to the Credits contract, then call deposit(key_hash, amount). USDG is credited after ${ctx.cfg.chain.confirmations} block confirmations, usually seconds. Withdraw by signing with the key address.`,
  };
}

async function sub(ctx: Ctx, c: Context): Promise<KeyRow> {
  return requireKey(ctx, c.req.header("authorization"));
}

async function ownedKey(ctx: Ctx, caller: KeyRow, hash: string) {
  const [k] = await ctx.db.select().from(keys).where(and(eq(keys.keyHash, hash), eq(keys.accountId, caller.accountId)));
  if (!k) fail(404, "Key not found.", "not_found");
  if (!caller.management) {
    // Team admins manage keys in their own team only.
    if (!caller.teamId || k.teamId !== caller.teamId) fail(403, "This key cannot manage that key.", "forbidden");
  }
  return k;
}

/** The keys.tracing update for a spec: sealed with APP_SECRET; a secret left out keeps the stored one (same type). */
function tracingPatch(ctx: Ctx, v: z.infer<typeof keySpec>, prev: unknown) {
  if (v.tracing === undefined) return {};
  return { tracing: v.tracing === null ? null : sealTracing(ctx.cfg.appSecret, v.tracing, parseStoredTracing(prev)) };
}

/** keyJson plus this router's export counters for the key's tracing destination and this UTC week's auto top-ups. */
const keyJsonWithTracing = async (ctx: Ctx, k: KeyRow) => ({ ...keyJson(k), tracing: tracingJson(k.tracing, ctx.tracing.stats(k.keyHash)), topups_this_week_usd: picoToUsd(await topupsThisWeek(ctx.db, k.keyHash)) });

/** An auto top-up rule raises a total limit: the key needs a limit, and one that does not reset each period. */
function assertTopupFits(topup: unknown, budget: bigint | null, reset: string | null) {
  if (!topup) return;
  if (budget == null) fail(400, "Auto top-up raises the key's total limit, so set `limit` too, or clear the rule with `topup: null`.", "invalid_request");
  if (reset) fail(400, "Auto top-up works with a total limit that does not reset. Set `limit_reset: null`, or clear the rule with `topup: null`.", "invalid_request");
}

function applySpec(v: z.infer<typeof keySpec>) {
  const budget = v.budget_usd !== undefined ? v.budget_usd : v.limit;
  return {
    ...(v.include_byok_in_limit !== undefined ? { includeByokInLimit: v.include_byok_in_limit } : {}), // ZK6
    ...(v.project !== undefined ? { project: v.project } : {}), // C134
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(budget !== undefined ? { budget: budget == null ? null : usdToPico(budget) } : {}),
    ...(v.limit_reset !== undefined ? { budgetReset: v.limit_reset } : {}),
    ...(v.rpm !== undefined ? { rpm: v.rpm } : {}),
    ...(v.tpm !== undefined ? { tpm: v.tpm } : {}),
    ...(v.allowed_models !== undefined ? { allowedModels: v.allowed_models } : {}),
    ...(v.allowed_ips !== undefined ? { allowedIps: v.allowed_ips } : {}), // E148
    ...(v.pay_with_default !== undefined ? { payWithDefault: v.pay_with_default } : {}),
    ...(v.disabled !== undefined ? { disabled: v.disabled } : {}),
    ...(v.expires_at !== undefined ? { expiresAt: v.expires_at ? new Date(v.expires_at) : null } : {}),
    ...(v.guardrails !== undefined ? { guardrails: v.guardrails } : {}),
    ...(v.routing !== undefined ? { routing: v.routing } : {}),
  };
}

/** What an audit entry says about a key change: the fields that changed, the new limit and the lane, never guardrail
 *  phrases or other text the owner typed. */
function keyChange(spec: z.infer<typeof keySpec>, patch: ReturnType<typeof applySpec> & { management?: boolean }): AuditDetail {
  const out: AuditDetail = { fields: Object.keys(patch).sort() };
  if (patch.budget !== undefined) out.limit_usd = patch.budget == null ? null : picoToUsd(patch.budget);
  if (patch.disabled !== undefined) out.disabled = patch.disabled;
  if (patch.management !== undefined) out.management = patch.management;
  const provider = (spec.routing as { provider?: { lane?: unknown } } | null | undefined)?.provider;
  if (typeof provider?.lane === "string") out.lane = provider.lane;
  return out;
}

/** Create a virtual sub-key under `caller` (same account and balance, parent = caller). The secret is
 *  returned once; only its hash is stored. Shared by POST /api/v1/keys and Agent Sessions. */
export async function createSubKey(ctx: Ctx, caller: KeyRow, spec: z.infer<typeof keySpec>, db: Db | Tx = ctx.db) {
  if (spec.allowed_ips !== undefined) fail(400, "Set allowed IP addresses with PATCH /api/v1/keys/:hash.", "invalid_request"); // E148
  if (spec.project !== undefined) fail(400, "Set a default project with PATCH /api/v1/keys/:hash.", "invalid_request"); // C134
  const scope = await provisionedScope(ctx, caller, spec, db); // ZK6
  if (spec.management && !caller.management) fail(403, "Only a management key can create management keys.", "forbidden");
  const teamId = spec.team ?? (caller.management ? null : caller.teamId);
  // A non-management key creates keys only in its own team, and never with a role above its own.
  if (!caller.management && teamId !== caller.teamId) fail(403, "This key can create keys only in its own team.", "forbidden");
  const role = spec.role ?? "member";
  const limit = applySpec(spec).budget;
  if (teamId) {
    const [t] = await db.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.ownerAccount, caller.accountId)));
    if (!t) fail(404, "Team not found.", "not_found");
    if (!caller.management) {
      // Read through `db`: an agent session creates its key inside a transaction.
      const [me] = await db.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.keyHash, caller.keyHash)));
      if (ROLE_RANK[role] > ROLE_RANK[(me?.role ?? "member") as Role]) fail(403, "You cannot create a key with a role above your own.", "forbidden");
    }
    await assertFitsOrgBudget(db, teamId, limit ?? null);
  } else if (spec.role) fail(400, "`role` applies to a key in a team; set `team` too.", "invalid_request");
  const secret = generateApiKey();
  const d = deriveKey(secret);
  await db.insert(keys).values({
    keyHash: d.keyHash,
    chainKeyHash: d.chainKeyHash,
    keyAddress: d.keyAddress,
    accountId: caller.accountId,
    scope, // ZK6
    parentHash: caller.keyHash,
    label: d.label,
    teamId,
    management: !!spec.management,
    rpm: ctx.cfg.limits.defaultRpm || null,
    tpm: ctx.cfg.limits.defaultTpm || null,
    ...applySpec(spec),
    ...tracingPatch(ctx, spec, null),
  });
  if (teamId) {
    await db.insert(teamMembers).values({ teamId, keyHash: d.keyHash, role }).onConflictDoNothing();
    await appendAudit(db, teamId, await actorOf(db, caller), "key.create", d.keyHash, { role, limit_usd: limit == null ? null : picoToUsd(limit) });
  }
  const [row] = await db.select().from(keys).where(eq(keys.keyHash, d.keyHash));
  await recordKeySecurity(ctx, db, row, caller); // D138
  return { row, secret };
}

async function pendingWithdrawal(ctx: Ctx, chainKeyHash: string) {
  const credits = ctx.chain.address("credits");
  if (!credits) return null;
  try {
    const [amount, to, requestedAt] = (await ctx.chain.client.readContract({ address: credits, abi: CreditsAbi, functionName: "pendingWithdrawal", args: [chainKeyHash as Hex] })) as [bigint, Hex, bigint];
    return amount > 0n ? { amount_usdg_units: amount.toString(), to, requested_at: new Date(Number(requestedAt) * 1000).toISOString() } : null;
  } catch {
    return null;
  }
}

export function keysRoutes(app: Hono, ctx: Ctx) {
  // Create a key. Without auth: a new root key with its own (empty) balance — no account needed.
  // With a management/admin key: a virtual sub-key sharing that account's balance.
  app.post("/api/v1/keys", async (c) => {
    const spec = keySpec.parse(await readJson(c));
    if (spec.allowed_ips !== undefined) fail(400, "Set allowed IP addresses with PATCH /api/v1/keys/:hash.", "invalid_request"); // E148
    if (spec.project !== undefined) fail(400, "Set a default project with PATCH /api/v1/keys/:hash.", "invalid_request"); // C134
    if (spec.topup !== undefined) fail(400, "Set auto top-up with PATCH /api/v1/keys/:hash once the key has a limit.", "invalid_request");
    const auth = c.req.header("authorization");
    const secret = generateApiKey();
    if (!auth) {
      if (spec.scope !== undefined) fail(403, "Only a management key can set key scope.", "forbidden"); // ZK6
      const from = addressBucket(c, ctx.cfg);
      const r = await ctx.limiter.take(`newkey:${from.id}`, 1, from.scale(ctx.cfg.limits.newKeysPerHour), 3_600_000);
      if (!r.ok) fail(429, "Too many new keys from this address. Try again later.", "rate_limited");
      const k = await registerRootKey(ctx, secret, spec.name ?? "");
      const patch = { ...applySpec({ ...spec, management: undefined, team: undefined }), ...tracingPatch(ctx, spec, null) };
      if (Object.keys(patch).length) await ctx.db.update(keys).set(patch).where(eq(keys.keyHash, k.keyHash));
      const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, k.keyHash));
      await recordKeySecurity(ctx, ctx.db, row, row); // D138
      return c.json({ data: keyJson(row), key: secret, deposit: depositInfo(ctx, row) }, 201);
    }
    const caller = await sub(ctx, c);
    // Devs create keys too, in their own team and within its org budget (createSubKey checks both).
    await requireRole(ctx, caller, ["owner", "admin", "dev"]);
    const created = await createSubKey(ctx, caller, spec);
    return c.json({ data: keyJson(created.row), key: created.secret, deposit: depositInfo(ctx, created.row) }, 201);
  });

  app.get("/api/v1/keys", async (c) => {
    const caller = await sub(ctx, c);
    await requireRole(ctx, caller, ["owner", "admin", "viewer"]);
    const { offset, limit } = keyPagination(c.req.query()); // ZK6: disabled rows remain visible
    const rows = await ctx.db.select().from(keys).where(and(eq(keys.accountId, caller.accountId), ...(caller.management ? [] : [eq(keys.teamId, caller.teamId ?? "")]))).orderBy(desc(keys.createdAt), desc(keys.keyHash)).offset(offset).limit(limit);
    return c.json({ data: rows.map(keyJson) });
  });
  app.get("/api/v1/keys/:hash", async (c) => {
    const caller = await sub(ctx, c);
    await requireRole(ctx, caller, ["owner", "admin", "viewer"]);
    return c.json({ data: await keyJsonWithTracing(ctx, await ownedKey(ctx, caller, c.req.param("hash"))) });
  });
  app.patch("/api/v1/keys/:hash", async (c) => {
    const caller = await sub(ctx, c);
    await requireRole(ctx, caller, ["owner", "admin"]);
    const k = await ownedKey(ctx, caller, c.req.param("hash"));
    // An agent session's key is managed only through /api/v1/sessions: re-enabling it or changing its
    // budget or expiry here would contradict the session's recorded state.
    const [session] = await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, k.keyHash));
    if (session) fail(409, "This key belongs to an agent session; manage it with /api/v1/sessions.", "session_key");
    const spec = keySpec.parse(await readJson(c));
    if (spec.scope !== undefined) fail(400, "Scope is fixed at creation; mint a new key to change it.", "invalid_request"); // ZK6
    if (k.scope === "read" && spec.management === true) fail(403, "A read-only key cannot gain management rights.", "forbidden"); // E149
    if (k.scope === "inference" && spec.management === true) fail(403, "An inference-only key cannot gain management rights.", "forbidden"); // ZK6
    if (spec.management !== undefined && !caller.management) fail(403, "Only a management key can change management rights.", "forbidden");
    if (spec.role !== undefined) fail(400, "Change a key's role with PUT /api/v1/teams/:id/members/:hash.", "invalid_request");
    const patch = { ...applySpec(spec), ...(spec.management !== undefined ? { management: spec.management } : {}), ...tracingPatch(ctx, spec, k.tracing), ...(spec.topup !== undefined ? { topup: spec.topup } : {}) };
    assertTopupFits(patch.topup !== undefined ? patch.topup : k.topup, patch.budget !== undefined ? patch.budget : k.budget, patch.budgetReset !== undefined ? patch.budgetReset : k.budgetReset);
    // In a team with an org budget, a new limit (or a key coming back) must still fit.
    if (k.teamId && (patch.budget !== undefined || patch.disabled === false || patch.expiresAt !== undefined))
      await assertFitsOrgBudget(ctx.db, k.teamId, patch.budget !== undefined ? patch.budget : k.budget, k.keyHash);
    if (Object.keys(patch).length) await ctx.db.update(keys).set(patch).where(eq(keys.keyHash, k.keyHash));
    if (k.teamId && Object.keys(patch).length) await appendAudit(ctx.db, k.teamId, await actorOf(ctx.db, caller), "key.update", k.keyHash, keyChange(spec, patch));
    const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, k.keyHash));
    await recordKeySecurity(ctx, ctx.db, row, caller, k); // D138
    return c.json({ data: await keyJsonWithTracing(ctx, row) });
  });
  app.delete("/api/v1/keys/:hash", async (c) => {
    const caller = await sub(ctx, c);
    await requireRole(ctx, caller, ["owner", "admin"]);
    const k = await ownedKey(ctx, caller, c.req.param("hash"));
    if (k.keyHash === caller.keyHash) fail(400, "A key cannot delete itself; disable it with PATCH instead.", "invalid_request");
    // Keys are disabled rather than removed: generations and on-chain balances reference them.
    await ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, k.keyHash));
    if (!k.disabled) await recordKeySecurity(ctx, ctx.db, { ...k, disabled: true }, caller, k); // D138
    if (k.teamId && !k.disabled) await appendAudit(ctx.db, k.teamId, await actorOf(ctx.db, caller), "key.disable", k.keyHash, {});
    return c.json({ deleted: true, data: { hash: k.keyHash, deleted: true } }); // ZK6
  });

  // Current key (OpenRouter GET /api/v1/key shape).
  app.get("/api/v1/key", async (c) => {
    const k = await sub(ctx, c);
    const bal = await balanceOf(ctx.db, k.accountId);
    return c.json({
      data: {
        ...keyJson(k),
        is_free_tier: false,
        rate_limit: { requests: k.rpm ?? ctx.cfg.limits.defaultRpm, interval: "1m" },
        balance: picoToUsd(bal.available),
        deposit: depositInfo(ctx, k),
      },
    });
  });

  app.get("/api/v1/credits", async (c) => {
    const k = await sub(ctx, c);
    // A session key sees its own budget, not the account's balance or deposits.
    const [session] = await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, k.keyHash));
    if (session) {
      const budget = k.budget ?? 0n;
      const left = budget - k.spentTotal > 0n ? budget - k.spentTotal : 0n;
      return c.json({ data: { total_credits: picoToUsd(budget), total_usage: picoToUsd(k.spentTotal), balance: picoToUsd(left), available: picoToUsd(left), currency: "USD", session: session.id } });
    }
    const bal = await balanceOf(ctx.db, k.accountId);
    const [dep] = await ctx.db
      .select({ n: sql<string>`coalesce(sum(${ledger.amount}), 0)` })
      .from(ledger)
      .where(and(eq(ledger.accountId, k.accountId), sql`${ledger.amount} > 0`));
    const [use] = await ctx.db
      .select({ n: sql<string>`coalesce(sum(${generations.cost}), 0)` })
      .from(generations)
      .where(eq(generations.accountId, k.accountId));
    return c.json({
      data: {
        ...await fastCreditFields(ctx, k.accountId), // V97
        ...await depositTiming(ctx), // V97D: USDG confirmation threshold and block numbers.
        total_credits: picoToUsd(BigInt(dep?.n ?? 0)),
        total_usage: picoToUsd(BigInt(use?.n ?? 0)),
        balance: picoToUsd(bal.balance),
        held: picoToUsd(bal.held),
        available: picoToUsd(bal.available),
        currency: "USDG",
        deposit: depositInfo(ctx, k),
        pending_withdrawal: await pendingWithdrawal(ctx, k.chainKeyHash),
      },
    });
  });

  // This key's spend in the latest posted root, proven either way: its leaf (inclusion) for
  // Credits.finalizeWithdrawal, or the adjacent leaves around it (absence: spend 0) for
  // Credits.finalizeWithdrawalAbsent. A root can never leave a funded key without a proof.
  app.get("/api/v1/credits/withdrawal-proof", async (c) => {
    const k = await sub(ctx, c);
    // Only roots that landed on-chain (or local-only roots without a chain) can back a proof.
    const [root] = await ctx.db.select().from(spentRoots).where(inArray(spentRoots.status, ["confirmed", "local"])).orderBy(desc(spentRoots.epoch)).limit(1);
    if (!root) fail(404, "No spent root has been posted yet.", "not_found");
    const tree = new SpentTree((root.leaves as [string, string][]).map(([h, s]) => [h, BigInt(s)] as const));
    if (tree.root.toLowerCase() !== root.root.toLowerCase()) fail(503, "The latest spent root cannot be reproduced from its stored leaves; proofs are unavailable until it is reconciled.", "root_mismatch");
    const p = tree.prove(k.chainKeyHash);
    const credits = ctx.chain.address("credits");
    const neighbour = (n: SpentNeighbour | null) => (n ? { key_hash: n.keyHash, cumulative_spent_usdg: n.cumulativeSpent.toString(), proof: n.proof } : null);
    const call =
      p.kind === "inclusion"
        ? encodeFunctionData({ abi: CreditsAbi, functionName: "finalizeWithdrawal", args: [p.keyHash, p.cumulativeSpent, BigInt(p.index), BigInt(p.leafCount), p.proof] })
        : encodeFunctionData({ abi: CreditsAbi, functionName: "finalizeWithdrawalAbsent", args: [p.keyHash, BigInt(p.leafCount), BigInt(p.gap), p.below ?? SENTINEL_NEIGHBOUR, p.above ?? SENTINEL_NEIGHBOUR] });
    return c.json({
      data: {
        epoch: root.epoch,
        root: root.root,
        as_of: root.asOf.toISOString(),
        status: root.status,
        key_hash: k.chainKeyHash,
        kind: p.kind,
        cumulative_spent_usdg: p.cumulativeSpent.toString(),
        leaf_count: p.leafCount,
        index: p.kind === "inclusion" ? p.index : null,
        proof: p.kind === "inclusion" ? p.proof : null,
        gap: p.kind === "absence" ? p.gap : null,
        below: p.kind === "absence" ? neighbour(p.below) : null,
        above: p.kind === "absence" ? neighbour(p.above) : null,
        pending: await pendingWithdrawal(ctx, k.chainKeyHash),
        transactions: credits ? [{ to: credits, data: call, description: p.kind === "inclusion" ? "Finalize the pending withdrawal" : "Finalize the pending withdrawal (this key has no leaf in the latest root, so it counts as unspent)" }] : [],
        note: p.kind === "inclusion" ? null : "The latest root has no leaf for this key; the adjacent leaves prove it, and Credits counts its spend for that root as 0.",
      },
    });
  });

  // Unsigned transactions for the user's wallet: approve USDG, then deposit to this key's hash.
  app.post("/api/v1/credits/deposit-tx", async (c) => {
    const k = await sub(ctx, c);
    const v = z.object({ amount: z.string().regex(/^\d+(\.\d{1,6})?$/, "amount must be a USDG amount with up to 6 decimals") }).parse(await readJson(c));
    const credits = ctx.chain.require("credits");
    const units = parseUnits(v.amount, 6);
    if (units <= 0n) fail(400, "Deposit a positive amount.", "invalid_request");
    return c.json({
      data: {
        chain: ctx.cfg.chain.id,
        amount_usdg_units: units.toString(),
        key_hash: k.chainKeyHash,
        transactions: [
          { to: ctx.cfg.chain.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [credits, units] }), description: `Approve ${v.amount} USDG for Credits` },
          { to: credits, data: encodeFunctionData({ abi: CreditsAbi, functionName: "deposit", args: [k.chainKeyHash as Hex, units] }), description: `Deposit ${v.amount} USDG to this key` },
        ],
      },
    });
  });

  // Step 1 of a self-custodial withdrawal: the router signs the EIP-712 request with the key's derived
  // address (it only ever sees the key the caller presents) and returns the transaction any wallet
  // can submit. Step 2 (after the next spent root) uses /credits/withdrawal-proof.
  app.post("/api/v1/credits/withdraw-request", async (c) => {
    const secret = bearer(c.req.header("authorization"));
    const k = await sub(ctx, c);
    const v = z.object({ amount: z.string().regex(/^\d+(\.\d{1,6})?$/), to: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await readJson(c));
    const credits = ctx.chain.require("credits");
    const units = parseUnits(v.amount, 6);
    if (units <= 0n) fail(400, "Withdraw a positive amount.", "invalid_request");
    const d = deriveKey(secret!);
    if (d.chainKeyHash !== k.chainKeyHash) fail(403, "Sign in with the key that holds the deposit.", "forbidden");
    const withdrawable = await withdrawableFor(ctx, k.accountId, k.chainKeyHash);
    if (units > withdrawable) fail(400, `At most ${formatUnits(withdrawable, 6)} USDG can be withdrawn from this key right now.`, "withdrawal_too_large", { withdrawable_usdg: formatUnits(withdrawable, 6) });
    const nonce = (await ctx.chain.client.readContract({ address: credits, abi: CreditsAbi, functionName: "nonces", args: [k.chainKeyHash as Hex] })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await d.account.signTypedData({
      domain: { name: "Anyroute Credits", version: "1", chainId: ctx.cfg.chain.id, verifyingContract: credits },
      types: { WithdrawRequest: [{ name: "keyHash", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "WithdrawRequest",
      message: { keyHash: k.chainKeyHash as Hex, amount: units, to: v.to as Hex, nonce, deadline },
    });
    return c.json({
      data: {
        chain: ctx.cfg.chain.id,
        amount_usdg_units: units.toString(),
        deadline: Number(deadline),
        transactions: [{ to: credits, data: encodeFunctionData({ abi: CreditsAbi, functionName: "requestWithdrawal", args: [d.keyAddress, units, v.to as Hex, deadline, sig] }), description: `Request a ${v.amount} USDG withdrawal to ${v.to}` }],
        next: "After the next spent root is posted (hourly), finalize with the proof from GET /api/v1/credits/withdrawal-proof.",
      },
    });
  });

  // Cancel a pending withdrawal: the key signs a zero-amount request (Credits.cancelWithdrawal), which
  // releases the locked amount back to the balance once indexed.
  app.post("/api/v1/credits/withdraw-cancel", async (c) => {
    const secret = bearer(c.req.header("authorization"));
    const k = await sub(ctx, c);
    const credits = ctx.chain.require("credits");
    const d = deriveKey(secret!);
    if (d.chainKeyHash !== k.chainKeyHash) fail(403, "Sign in with the key that holds the deposit.", "forbidden");
    if (!(await pendingWithdrawal(ctx, k.chainKeyHash))) fail(409, "This key has no pending withdrawal.", "no_pending_withdrawal");
    const nonce = (await ctx.chain.client.readContract({ address: credits, abi: CreditsAbi, functionName: "nonces", args: [k.chainKeyHash as Hex] })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const zero = "0x0000000000000000000000000000000000000000" as Hex;
    const sig = await d.account.signTypedData({
      domain: { name: "Anyroute Credits", version: "1", chainId: ctx.cfg.chain.id, verifyingContract: credits },
      types: { WithdrawRequest: [{ name: "keyHash", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "WithdrawRequest",
      message: { keyHash: k.chainKeyHash as Hex, amount: 0n, to: zero, nonce, deadline },
    });
    return c.json({
      data: {
        chain: ctx.cfg.chain.id,
        deadline: Number(deadline),
        transactions: [{ to: credits, data: encodeFunctionData({ abi: CreditsAbi, functionName: "cancelWithdrawal", args: [d.keyAddress, deadline, sig] }), description: "Cancel the pending withdrawal" }],
      },
    });
  });

  // Local development faucet (DEV_FAUCET): mock USDG deposited straight to this key, no wallet needed.
  const faucetUse = new Map<string, number[]>();
  app.post("/api/v1/dev/faucet", async (c) => {
    if (!ctx.chain.devFaucet) fail(404, "The test USDG faucet is only available on a local development chain.", "not_found");
    const k = await sub(ctx, c);
    const v = z.object({ amount: z.string().regex(/^\d+(\.\d{1,6})?$/).default("10") }).parse(await readJson(c));
    const units = parseUnits(v.amount, 6);
    if (units <= 0n || units > 1000_000000n) fail(400, "Request between 0.000001 and 1000 test USDG.", "invalid_request");
    const now = Date.now();
    const recent = (faucetUse.get(k.chainKeyHash) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= 20) fail(429, "Faucet limit reached for this key; try again within the hour.", "rate_limited");
    faucetUse.set(k.chainKeyHash, [...recent, now]);
    const { hash } = await ctx.chain.faucetDeposit(k.chainKeyHash as Hex, units);
    await ctx.jobs.run("chain-indexer").catch(() => undefined); // credit it now rather than on the next tick
    return c.json({ data: { amount_usdg_units: units.toString(), tx: hash, test_funds: true } }, 201);
  });

  // BYOK: store an upstream provider key (encrypted at rest). Calls routed to that provider use it.
  app.post("/api/v1/byok", async (c) => {
    const k = await sub(ctx, c);
    await requireRole(ctx, k, ["owner", "admin"]);
    const v = z.object({ provider: z.string().min(1), key: z.string().min(8).max(500) }).parse(await readJson(c));
    if (!(await ctx.catalog.provider(v.provider))) fail(404, `Unknown provider ${v.provider}.`, "not_found");
    await ctx.db
      .insert(byokKeys)
      .values({ id: uid("byok_"), accountId: k.accountId, providerId: v.provider, keyEnc: encrypt(ctx.cfg.appSecret, v.key), label: `${v.key.slice(0, 4)}…${v.key.slice(-4)}` })
      .onConflictDoUpdate({ target: [byokKeys.accountId, byokKeys.providerId], set: { keyEnc: encrypt(ctx.cfg.appSecret, v.key), label: `${v.key.slice(0, 4)}…${v.key.slice(-4)}` } });
    return c.json({ data: { provider: v.provider, stored: true } }, 201);
  });
  app.get("/api/v1/byok", async (c) => {
    const k = await sub(ctx, c);
    const rows = await ctx.db.select().from(byokKeys).where(eq(byokKeys.accountId, k.accountId));
    return c.json({ data: rows.map((r) => ({ provider: r.providerId, label: r.label, created_at: r.createdAt.toISOString() })) });
  });
  app.delete("/api/v1/byok/:provider", async (c) => {
    const k = await sub(ctx, c);
    await requireRole(ctx, k, ["owner", "admin"]);
    await ctx.db.delete(byokKeys).where(and(eq(byokKeys.accountId, k.accountId), eq(byokKeys.providerId, c.req.param("provider"))));
    return c.json({ data: { provider: c.req.param("provider"), deleted: true } });
  });

  // Teams, organisations and their audit log: src/api/teams.ts.

  // Server-issued, single-use wallet login challenges. Origin, action and chain are signed.
  app.post("/api/v1/auth/wallet/challenge", async (c) => {
    const v = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await readJson(c));
    const from = addressBucket(c, ctx.cfg);
    const limit = await ctx.limiter.take(`wallet-login:${from.id}`, 1, from.scale(30), 60_000);
    if (!limit.ok) fail(429, "Too many wallet challenges.", "rate_limit");
    const nonce = randomHex(24);
    const expires = Date.now() + 300_000;
    const address = v.address.toLowerCase();
    const origin = new URL(ctx.cfg.publicUrl).origin;
    const message = `Anyroute wallet sign-in\nAction: create management API key\nOrigin: ${origin}\nChain ID: ${ctx.cfg.chain.id}\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}`;
    await ctx.db.delete(kv).where(sql`${kv.key} LIKE 'wallet-login:%' AND ${kv.updatedAt} < now() - interval '10 minutes'`);
    await ctx.db.insert(kv).values({ key: `wallet-login:${nonce}`, value: { address, origin, chainId: ctx.cfg.chain.id, expires, message } });
    return c.json({ data: { nonce, message, expires_at: new Date(expires).toISOString() } });
  });
  app.post("/api/v1/auth/wallet", async (c) => {
    const v = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), nonce: z.string().regex(/^[0-9a-f]{48}$/), signature: z.string().regex(/^0x[0-9a-fA-F]+$/), name: z.string().max(100).optional() }).parse(await readJson(c));
    const [challenge] = await ctx.db.select().from(kv).where(eq(kv.key, `wallet-login:${v.nonce}`));
    const value = challenge?.value as { address: string; origin: string; chainId: number; expires: number; message: string } | undefined;
    if (!value || value.expires < Date.now() || value.address !== v.address.toLowerCase() || value.origin !== new URL(ctx.cfg.publicUrl).origin || value.chainId !== ctx.cfg.chain.id)
      fail(401, "Wallet challenge is invalid, expired, or already consumed.", "invalid_wallet_auth");
    const who = await recoverMessageAddress({ message: value.message, signature: v.signature as Hex }).catch(() => null);
    if (!who || who.toLowerCase() !== value.address) fail(401, "Signature does not match the challenge.", "invalid_wallet_auth");
    const secret = generateApiKey();
    const d = deriveKey(secret);
    const accountId = walletAccountId(value.address);
    const row = await ctx.db.transaction(async (tx) => {
      const used = await tx.delete(kv).where(eq(kv.key, challenge.key)).returning({ key: kv.key });
      if (!used.length || value.expires < Date.now()) fail(401, "Wallet challenge is expired or already consumed.", "invalid_wallet_auth");
      await ensureAccount(tx, accountId, "wallet", value.address);
      const [key] = await tx.insert(keys).values({ keyHash: d.keyHash, chainKeyHash: d.chainKeyHash, keyAddress: d.keyAddress, accountId, label: d.label, name: v.name ?? "wallet", management: true, rpm: ctx.cfg.limits.defaultRpm || null }).returning();
      await recordKeySecurity(ctx, tx, key, key, undefined, value.address); // D138
      await recordBrowserSession(tx, key.keyHash, c.req.header("user-agent")); // E147
      return key;
    });
    return c.json({ data: keyJson(row), key: secret }, 201);
  });
}

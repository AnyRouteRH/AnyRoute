import { recordDisabledSecurity } from "../security-alerts/records.ts"; // D138
import { and, count, desc, eq, inArray, isNull, lt, max, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { agentSessions, generations, holds, keys, presetVersions, savedRoutes } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico, type Pico } from "../lib/money.ts";
import { uid } from "../lib/util.ts";
import type { KeyRow } from "../api/auth.ts";
import { createSubKey } from "../api/keys.ts";

// Agent Sessions: a short-lived, budget-capped sub-key for one agent run. Enforcement is the key's own:
// the budget (no reset) by the ledger's reserve/settle checks, the expiry by key resolution, the end by
// `keys.disabled`. This module only creates them, reports on them and ends them. Settings and billing
// data only: no prompt or completion text is read or stored here.

export type SessionRow = typeof agentSessions.$inferSelect;
export type SessionStatus = "active" | "ended" | "expired" | "budget_exhausted";
export type EndReason = "ended" | "expired" | "budget";

export const LIMITS = { maxBudgetUsd: 1000, minTtlMinutes: 1, maxTtlMinutes: 1440, defaultTtlMinutes: 60, metadataBytes: 2048, maxModels: 50 } as const;

const ROUTE_PREFIX = "@route/";
const PRESET_PREFIX = "@preset/";
const PRESET_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Metadata labels a run (ticket, repo, agent version). Keys that name prompt or completion text are refused.
const PROMPT_KEYS = /^(prompts?|messages?|content|completions?|input|output|system|instructions?|text|response)$/i;

const metadataValue = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);
export const createSpec = z.object({
  name: z.string().trim().max(80).optional(),
  budget_usd: z.number().positive().max(LIMITS.maxBudgetUsd),
  ttl_minutes: z.number().int().min(LIMITS.minTtlMinutes).max(LIMITS.maxTtlMinutes).default(LIMITS.defaultTtlMinutes),
  allowed_models: z.array(z.string().trim().min(1).max(200)).max(LIMITS.maxModels).optional(),
  metadata: z.record(z.string().min(1).max(64), metadataValue).optional(),
});
export type CreateSpec = z.input<typeof createSpec>;

const toStatus = (reason: string | null): SessionStatus => (reason === "expired" ? "expired" : reason === "budget" ? "budget_exhausted" : "ended");

/**
 * A session's status from its row and its key.
 * - ended:            ended by its owner (DELETE, or the key was disabled through the keys API)
 * - expired:          its time ran out (key resolution refuses the key from `expires_at` on)
 * - budget_exhausted: the key has spent its whole budget (spent >= budget)
 * - active:           none of the above. A request can still be refused earlier when its worst-case cost
 *                     does not fit in what remains (402 key_budget_exceeded).
 * Once `ended_at` is recorded the status is final. `persist` is the end to record for a status first
 * observed now (expired, budget_exhausted).
 */
export function sessionStatus(
  s: Pick<SessionRow, "endedAt" | "endReason" | "expiresAt">,
  k: Pick<KeyRow, "disabled" | "budget" | "spentTotal" | "lastUsed"> | null,
  now = Date.now(),
): { status: SessionStatus; persist?: { endedAt: Date; endReason: EndReason } } {
  if (s.endedAt) return { status: toStatus(s.endReason) };
  if (!k || k.disabled) return { status: "ended" };
  if (s.expiresAt.getTime() <= now) return { status: "expired", persist: { endedAt: s.expiresAt, endReason: "expired" } };
  const budget = k.budget; // the limit the ledger enforces
  if (budget != null && k.spentTotal >= budget) return { status: "budget_exhausted", persist: { endedAt: k.lastUsed ?? new Date(now), endReason: "budget" } };
  return { status: "active" };
}

type Stats = { calls: number; lastCallAt: Date | null; reserved: Pico };

export function sessionJson(s: SessionRow, k: KeyRow | null, stats: Stats, status: SessionStatus, now = Date.now(), createdBy: string | null = null) {
  const budget = k?.budget ?? s.budget;
  const spent = k?.spentTotal ?? 0n;
  const remaining = budget == null ? null : budget - spent > 0n ? budget - spent : 0n;
  return {
    id: s.id,
    name: s.name,
    status,
    key_label: k?.label ?? null,
    key_hash: s.keyHash,
    created_by: createdBy,
    budget_usd: budget == null ? null : picoToUsd(budget),
    spent_usd: picoToUsd(spent),
    reserved_usd: picoToUsd(stats.reserved),
    remaining_usd: remaining == null ? null : picoToUsd(status === "active" ? remaining : 0n),
    calls: stats.calls,
    last_call_at: stats.lastCallAt?.toISOString() ?? null,
    allowed_models: k?.allowedModels ?? [],
    metadata: s.metadata ?? null,
    created_at: s.createdAt.toISOString(),
    expires_at: s.expiresAt.toISOString(),
    time_left_s: status === "active" ? Math.max(0, Math.floor((s.expiresAt.getTime() - now) / 1000)) : 0,
    ended_at: s.endedAt?.toISOString() ?? null,
    end_reason: s.endReason ?? null,
  };
}
export type SessionJson = ReturnType<typeof sessionJson>;

/** The session a key belongs to, if it is a session key. */
export async function sessionForKey(ctx: Ctx, keyHash: string) {
  const [s] = await ctx.db.select().from(agentSessions).where(eq(agentSessions.keyHash, keyHash));
  return s ?? null;
}

async function checkMetadata(meta: Record<string, unknown> | undefined) {
  if (!meta) return null;
  const bad = Object.keys(meta).find((k) => PROMPT_KEYS.test(k));
  if (bad) fail(400, `metadata.${bad} looks like prompt or completion text; session metadata holds labels only.`, "invalid_request");
  if (Object.keys(meta).length > 32) fail(400, "metadata holds at most 32 keys.", "invalid_request");
  const bytes = new TextEncoder().encode(JSON.stringify(meta)).length;
  if (bytes > LIMITS.metadataBytes) fail(400, `metadata is ${bytes} bytes as JSON; the limit is ${LIMITS.metadataBytes}.`, "invalid_request");
  return meta;
}

/** Canonical allowlist: catalog model ids (routing suffixes dropped) and the account's saved routes and presets. */
async function checkModels(ctx: Ctx, caller: KeyRow, requested: string[] | undefined) {
  const parent = caller.allowedModels?.length ? caller.allowedModels : null;
  if (!requested?.length) return parent; // inherit the creating key's allowlist, if any
  await ctx.catalog.ensureFresh();
  const out: string[] = [];
  const routes = requested.filter((m) => m.startsWith(ROUTE_PREFIX)).map((m) => m.slice(ROUTE_PREFIX.length));
  for (const slug of routes) if (!SLUG_RE.test(slug)) fail(400, `${ROUTE_PREFIX}${slug} is not a valid saved route name.`, "invalid_request");
  const known = routes.length
    ? new Set((await ctx.db.select({ slug: savedRoutes.slug }).from(savedRoutes).where(and(eq(savedRoutes.accountId, caller.accountId), inArray(savedRoutes.slug, routes)))).map((r) => r.slug))
    : new Set<string>();
  // A preset is allowed by name (every version of it); a pinned `@preset/<name>@<version>` is not an allowlist entry.
  const presets = requested.filter((m) => m.startsWith(PRESET_PREFIX)).map((m) => m.slice(PRESET_PREFIX.length));
  for (const name of presets) if (!PRESET_RE.test(name)) fail(400, `${PRESET_PREFIX}${name} is not a valid preset name (allow the preset by name, without a version).`, "invalid_request");
  const knownPresets = presets.length
    ? new Set((await ctx.db.selectDistinct({ name: presetVersions.name }).from(presetVersions).where(and(eq(presetVersions.accountId, caller.accountId), inArray(presetVersions.name, presets)))).map((r) => r.name))
    : new Set<string>();
  for (const m of requested) {
    let id: string;
    if (m.startsWith(ROUTE_PREFIX)) {
      if (!known.has(m.slice(ROUTE_PREFIX.length))) fail(400, `No saved route ${m} on this account.`, "invalid_request");
      id = m;
    } else if (m.startsWith(PRESET_PREFIX)) {
      if (!knownPresets.has(m.slice(PRESET_PREFIX.length))) fail(400, `No preset ${m} on this account.`, "invalid_request");
      id = m;
    } else {
      const r = ctx.catalog.resolve(m);
      if (!r) fail(400, `Unknown model ${m}. See GET /api/v1/models.`, "invalid_request");
      id = r.model.id;
    }
    if (parent && !parent.includes(id)) fail(403, `The creating key may not use ${id}, so its sessions may not either.`, "model_not_allowed");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Create a session: a sub-key of `caller` with the budget (no reset), expiry and allowlist, plus its row. */
export async function createSession(ctx: Ctx, caller: KeyRow, body: unknown) {
  const v = createSpec.parse(body);
  const metadata = await checkMetadata(v.metadata);
  const budget = usdToPico(v.budget_usd);
  // A session never outgrows the key that creates it.
  if (caller.budget != null) {
    const left = caller.budget - caller.spent;
    if (budget > left) fail(400, `The creating key has $${picoToUsd(left > 0n ? left : 0n)} of budget left; a session cannot exceed it.`, "invalid_request");
  }
  const expiresAt = new Date(Date.now() + v.ttl_minutes * 60_000);
  if (caller.expiresAt && expiresAt > caller.expiresAt) fail(400, `The creating key expires at ${caller.expiresAt.toISOString()}; a session cannot outlive it.`, "invalid_request");
  const allowed = await checkModels(ctx, caller, v.allowed_models);
  const id = uid("as_");
  const name = v.name ?? "";
  const created = await ctx.db.transaction(async (tx) => {
    const made = await createSubKey(
      ctx,
      caller,
      {
        name: `session: ${name || id}`.slice(0, 100),
        budget_usd: v.budget_usd,
        limit_reset: null,
        expires_at: expiresAt.toISOString(),
        allowed_models: allowed,
        ...(caller.rpm ? { rpm: caller.rpm } : {}),
        ...(caller.tpm ? { tpm: caller.tpm } : {}),
        // The agent's key keeps the creating key's guardrails and routing presets.
        guardrails: (caller.guardrails ?? null) as never,
        routing: (caller.routing ?? null) as Record<string, unknown> | null,
      },
      tx,
    );
    await tx.insert(agentSessions).values({ id, accountId: caller.accountId, parentKeyHash: caller.keyHash, keyHash: made.row.keyHash, name, budget, expiresAt, metadata });
    return made;
  });
  return {
    id,
    key: created.secret,
    key_label: created.row.label,
    key_hash: created.row.keyHash,
    name,
    budget_usd: picoToUsd(budget),
    ttl_minutes: v.ttl_minutes,
    expires_at: expiresAt.toISOString(),
    allowed_models: created.row.allowedModels ?? [],
    metadata,
    status: "active" as const,
  };
}

async function statsFor(ctx: Ctx, keyHashes: string[]) {
  const out = new Map<string, Stats>(keyHashes.map((h) => [h, { calls: 0, lastCallAt: null, reserved: 0n }]));
  if (!keyHashes.length) return out;
  const [calls, held] = await Promise.all([
    ctx.db
      .select({ keyHash: generations.keyHash, calls: count(), last: max(generations.ts) })
      .from(generations)
      .where(inArray(generations.keyHash, keyHashes))
      .groupBy(generations.keyHash),
    ctx.db
      .select({ keyHash: holds.keyHash, amount: sql<string>`coalesce(sum(${holds.amount}), 0)` })
      .from(holds)
      .where(and(inArray(holds.keyHash, keyHashes), eq(holds.status, "held")))
      .groupBy(holds.keyHash),
  ]);
  for (const c of calls) {
    const s = out.get(c.keyHash!);
    if (s) Object.assign(s, { calls: Number(c.calls), lastCallAt: c.last ? new Date(c.last) : null });
  }
  for (const h of held) {
    const s = out.get(h.keyHash!);
    if (s) s.reserved = BigInt(h.amount ?? 0);
  }
  return out;
}

/** Record an end first observed on read. Idempotent: only a session with no end yet is updated. */
async function persistEnd(ctx: Ctx, s: SessionRow, end: { endedAt: Date; endReason: EndReason }) {
  const [row] = await ctx.db
    .update(agentSessions)
    .set(end)
    .where(and(eq(agentSessions.id, s.id), isNull(agentSessions.endedAt)))
    .returning();
  return row ?? (await ctx.db.select().from(agentSessions).where(eq(agentSessions.id, s.id)))[0] ?? s;
}

/** Status, lazy end persistence and JSON for a page of session rows. */
export async function describe(ctx: Ctx, rows: SessionRow[], now = Date.now()) {
  const hashes = rows.map((s) => s.keyHash);
  const parents = [...new Set(rows.map((s) => s.parentKeyHash))];
  const [keyRows, parentRows, stats] = await Promise.all([
    hashes.length ? ctx.db.select().from(keys).where(inArray(keys.keyHash, hashes)) : Promise.resolve([] as KeyRow[]),
    parents.length ? ctx.db.select({ keyHash: keys.keyHash, label: keys.label }).from(keys).where(inArray(keys.keyHash, parents)) : Promise.resolve([]),
    statsFor(ctx, hashes),
  ]);
  const byHash = new Map(keyRows.map((k) => [k.keyHash, k]));
  const labels = new Map(parentRows.map((p) => [p.keyHash, p.label]));
  const out: { row: SessionRow; key: KeyRow | null; json: SessionJson }[] = [];
  for (let s of rows) {
    const k = byHash.get(s.keyHash) ?? null;
    const st = sessionStatus(s, k, now);
    let status = st.status;
    if (st.persist) {
      s = await persistEnd(ctx, s, st.persist);
      status = sessionStatus(s, k, now).status;
    }
    out.push({ row: s, key: k, json: sessionJson(s, k, stats.get(s.keyHash)!, status, now, labels.get(s.parentKeyHash) ?? null) });
  }
  return out;
}

/** Where a page starts: strictly older than `at` (in whole milliseconds), or, given `id`, older than that exact (at, id) position. */
export type SessionCursor = { at: Date; id?: string };

const CURSOR_PREFIX = "c_";
const CURSOR_MSG = "`before` must be the `next` value of the previous page (a plain ISO timestamp is also accepted).";

export function encodeSessionCursor(at: Date, id: string): string {
  return CURSOR_PREFIX + Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

/** Parse the `before` query value: an opaque compound cursor, or (legacy) a plain ISO timestamp. 400 on anything else. */
export function parseSessionCursor(raw: string): SessionCursor {
  if (raw.startsWith(CURSOR_PREFIX)) {
    const decoded = /^[A-Za-z0-9_-]+$/.test(raw.slice(CURSOR_PREFIX.length)) ? Buffer.from(raw.slice(CURSOR_PREFIX.length), "base64url").toString("utf8") : "";
    const bar = decoded.indexOf("|");
    const at = new Date(decoded.slice(0, Math.max(bar, 0)));
    const id = decoded.slice(bar + 1);
    if (bar < 0 || Number.isNaN(at.getTime()) || !/^[\w-]{1,64}$/.test(id)) fail(400, CURSOR_MSG, "invalid_request");
    return { at, id };
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) fail(400, CURSOR_MSG, "invalid_request");
  return { at };
}

export async function listSessions(ctx: Ctx, accountId: string, opts: { limit: number; before?: SessionCursor }) {
  // Keyset order (created_at desc, id desc) at millisecond precision: Postgres stores microseconds but the cursor
  // carries a JS Date, so both the order and the comparison use the same truncated value and ties break on id.
  const at = sql`date_trunc('milliseconds', ${agentSessions.createdAt})`;
  const b = opts.before;
  const bt = b && sql`${b.at.toISOString()}::timestamptz`; // an ISO string: drivers differ on how they bind a raw Date inside sql``
  const after = !b ? [] : b.id === undefined ? [sql`${at} < ${bt}`] : [or(sql`${at} < ${bt}`, and(sql`${at} = ${bt}`, lt(agentSessions.id, b.id)))!];
  const rows = await ctx.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.accountId, accountId), ...after))
    .orderBy(desc(at), desc(agentSessions.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { data: (await describe(ctx, page)).map((d) => d.json), next: rows.length > opts.limit ? encodeSessionCursor(last.createdAt, last.id) : null };
}

export async function getSession(ctx: Ctx, accountId: string, id: string) {
  const [s] = await ctx.db.select().from(agentSessions).where(and(eq(agentSessions.id, id), eq(agentSessions.accountId, accountId)));
  if (!s) fail(404, "Session not found.", "not_found");
  return (await describe(ctx, [s]))[0];
}

/** The session key's recent calls: metadata only (never content). */
export async function recentCalls(ctx: Ctx, keyHash: string, limit: number) {
  const rows = await ctx.db
    .select({
      id: generations.id,
      ts: generations.ts,
      model: generations.modelId,
      provider: generations.providerId,
      tokensIn: generations.tokensIn,
      tokensOut: generations.tokensOut,
      cost: generations.cost,
      latencyMs: generations.latencyMs,
      finishReason: generations.finishReason,
      receiptSig: generations.receiptSig,
      anchorIndex: generations.anchorIndex,
    })
    .from(generations)
    .where(eq(generations.keyHash, keyHash))
    .orderBy(desc(generations.ts))
    .limit(limit);
  return rows.map((g) => ({
    id: g.id,
    ts: g.ts.toISOString(),
    model: g.model,
    provider: g.provider,
    tokens_in: g.tokensIn,
    tokens_out: g.tokensOut,
    cost_usd: picoToUsd(g.cost),
    latency_ms: g.latencyMs,
    finish_reason: g.finishReason,
    receipt: !!g.receiptSig,
    anchored: g.anchorIndex != null,
  }));
}

/** End a session now: disable its key and record the end. Idempotent; an earlier end is kept. */
export async function endSession(ctx: Ctx, s: SessionRow) {
  await ctx.db.transaction(async (tx) => {
    await recordDisabledSecurity(ctx, tx, [s.keyHash]); // D138
    await tx.update(keys).set({ disabled: true }).where(eq(keys.keyHash, s.keyHash));
    await tx.update(agentSessions).set({ endedAt: new Date(), endReason: "ended" }).where(and(eq(agentSessions.id, s.id), isNull(agentSessions.endedAt)));
  });
}

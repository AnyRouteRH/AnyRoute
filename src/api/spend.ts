import { signingForRule } from "../webhooks/store.ts"; // V86: reveal new signing keys once.
import type { Context, Hono } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { accounts, keys, spendAlerts } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, usdToPico } from "../lib/money.ts";
import { decrypt, encrypt, uid } from "../lib/util.ts";
import {
  cancelPending,
  DEFAULT_ANOMALY_PCT,
  firingJson,
  HISTORY_LIMIT,
  MAX_DELIVERY_ATTEMPTS,
  MAX_RULES_PER_ACCOUNT,
  maskWebhookUrl,
  normalizeWebhookUrl,
  parseAlertState,
  ruleWindow,
  spendReport,
  type SpendAlertRow,
} from "../services/spend-watch.ts";
import { readJson } from "./common.ts";
import { requireKey, requireRole, type KeyRow } from "./auth.ts";

// Spend Watch: spend breakdowns and alert rules. Billing metadata only; never content.
//
// Visibility: a management key sees every key of its account; any other key sees its own spend and
// the rules on its own key. Writing rules needs the owner/admin role (management keys are owners);
// a non-management admin can only watch its own key, so a rule can never report spend its author
// could not read.

const PERIODS = { "7d": 7, "30d": 30, "90d": 90 } as const;

const query = z.object({
  period: z.enum(["7d", "30d", "90d"]).default("30d"),
  group_by: z.enum(["day", "model", "key", "provider"]).default("day"),
});

const usd = z.number().positive().max(10_000_000);
const ruleFields = {
  window: z.enum(["day", "week", "month"]).optional(),
  threshold_usd: usd.optional(),
  pct: z.number().int().min(1).max(1000).optional(),
  multiplier: z.number().min(1.1).max(100).optional(),
  key_hash: z.string().regex(/^[0-9a-f]{64}$/, "key_hash must be a key hash from /api/v1/keys").nullable().optional(),
  webhook_url: z.string().max(2048).nullable().optional(),
  enabled: z.boolean().optional(),
};
const createBody = z.object({ kind: z.enum(["threshold", "budget_pct", "anomaly"]), ...ruleFields }).strict();
const patchBody = z.object({ kind: z.enum(["threshold", "budget_pct", "anomaly"]).optional(), ...ruleFields }).strict();

type Draft = { kind: string; window: string; keyHash: string | null; thresholdUsd: bigint | null; pct: number | null };

/** Cross-field rules per kind; returns the stored columns. `given` holds the fields the caller sent. */
function shape(kind: string, v: z.infer<typeof patchBody>, base?: Draft): Draft {
  const keyHash = v.key_hash !== undefined ? v.key_hash : (base?.keyHash ?? null);
  const unexpected = (names: (keyof typeof v)[]) => {
    const extra = names.filter((n) => v[n] !== undefined && v[n] !== null);
    if (extra.length) fail(400, `${extra.join(", ")} ${extra.length === 1 ? "does" : "do"} not apply to ${kind} rules.`, "invalid_request");
  };
  if (kind === "threshold") {
    unexpected(["pct", "multiplier"]);
    const thresholdUsd = v.threshold_usd !== undefined ? usdToPico(v.threshold_usd) : (base?.thresholdUsd ?? null);
    if (thresholdUsd == null || thresholdUsd <= 0n) fail(400, "threshold rules need threshold_usd (the spend that triggers the alert).", "invalid_request");
    return { kind, window: v.window ?? base?.window ?? "day", keyHash, thresholdUsd, pct: null };
  }
  if (kind === "budget_pct") {
    unexpected(["threshold_usd", "multiplier", "window"]);
    const pct = v.pct ?? base?.pct ?? null;
    if (!keyHash) fail(400, "budget_pct rules watch one key: set key_hash.", "invalid_request");
    if (!pct) fail(400, "budget_pct rules need pct (percent of the key's budget, 1-1000).", "invalid_request");
    return { kind, window: "day", keyHash, thresholdUsd: null, pct };
  }
  unexpected(["threshold_usd", "pct"]);
  if (v.window && v.window !== "day") fail(400, "anomaly rules compare whole days; window must be day.", "invalid_request");
  const pct = v.multiplier !== undefined ? Math.round(v.multiplier * 100) : (base?.pct ?? DEFAULT_ANOMALY_PCT);
  return { kind, window: "day", keyHash, thresholdUsd: null, pct };
}

export function spendRoutes(app: Hono, ctx: Ctx) {
  const caller = (c: Context) => requireKey(ctx, c.req.header("authorization"));
  const canSee = (k: KeyRow, r: Pick<SpendAlertRow, "accountId" | "keyHash">) => r.accountId === k.accountId && (k.management || r.keyHash === k.keyHash);

  async function keyRows(accountId: string, hashes: (string | null)[]) {
    const list = [...new Set(hashes.filter((h): h is string => !!h))];
    if (!list.length) return new Map<string, KeyRow>();
    const rows = await ctx.db.select().from(keys).where(and(eq(keys.accountId, accountId), inArray(keys.keyHash, list)));
    return new Map(rows.map((k) => [k.keyHash, k]));
  }

  function ruleJson(r: SpendAlertRow, key: KeyRow | undefined) {
    let webhook: string | null = null;
    if (r.webhookUrlEnc) {
      try {
        webhook = maskWebhookUrl(decrypt(ctx.cfg.appSecret, r.webhookUrlEnc));
      } catch {
        webhook = "https://…"; // stored under an earlier APP_SECRET; set it again to deliver
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      window: ruleWindow(r, key),
      key_hash: r.keyHash,
      key_name: key?.name ?? null,
      key_label: key?.label ?? null,
      threshold_usd: r.thresholdUsd != null ? picoToUsd(r.thresholdUsd) : null,
      pct: r.kind === "budget_pct" ? r.pct : null,
      multiplier: r.kind === "anomaly" ? (r.pct ?? DEFAULT_ANOMALY_PCT) / 100 : null,
      webhook_url: webhook,
      enabled: r.enabled,
      last_fired_at: r.lastFiredAt?.toISOString() ?? null,
      last_period: r.lastPeriod,
      created_at: r.createdAt.toISOString(),
      history: parseAlertState(r.state).history.map((f) => firingJson(r.id, f)),
    };
  }

  /** A rule may only watch a key of the caller's account, and a non-management caller only its own key. */
  async function checkTarget(k: KeyRow, d: Draft) {
    if (!k.management && d.keyHash !== k.keyHash)
      fail(403, "Only a management key can watch the whole account or another key. Set key_hash to this key's hash.", "forbidden");
    if (!d.keyHash) return;
    const target = (await keyRows(k.accountId, [d.keyHash])).get(d.keyHash);
    if (!target) fail(404, "Key not found in this account.", "not_found");
    if (d.kind === "budget_pct" && target.budget == null) fail(400, "That key has no budget. Set one in API keys first.", "invalid_request");
  }

  async function visibleRule(k: KeyRow, id: string) {
    const [r] = await ctx.db.select().from(spendAlerts).where(and(eq(spendAlerts.id, id), eq(spendAlerts.accountId, k.accountId)));
    if (!r || !canSee(k, r)) fail(404, "Alert rule not found.", "not_found");
    return r;
  }

  const sealWebhook = (raw: string | null | undefined) => (raw ? encrypt(ctx.cfg.appSecret, normalizeWebhookUrl(raw)) : null);

  app.get("/api/v1/spend", async (c) => {
    const k = await caller(c);
    const q = query.parse({ period: c.req.query("period") || undefined, group_by: c.req.query("group_by") || undefined });
    const data = await spendReport(ctx.db, { accountId: k.accountId, keyHash: k.management ? null : k.keyHash }, { periodDays: PERIODS[q.period], groupBy: q.group_by, now: Date.now() });
    c.header("cache-control", "no-store");
    return c.json({ data });
  });

  app.get("/api/v1/spend/alerts", async (c) => {
    const k = await caller(c);
    const rows = (await ctx.db.select().from(spendAlerts).where(eq(spendAlerts.accountId, k.accountId)).orderBy(asc(spendAlerts.createdAt), asc(spendAlerts.id))).filter((r) => canSee(k, r));
    const keyMap = await keyRows(k.accountId, rows.map((r) => r.keyHash));
    c.header("cache-control", "no-store");
    return c.json({
      data: rows.map((r) => ruleJson(r, r.keyHash ? keyMap.get(r.keyHash) : undefined)),
      limits: { max_rules: MAX_RULES_PER_ACCOUNT, history: HISTORY_LIMIT, delivery_attempts: MAX_DELIVERY_ATTEMPTS },
    });
  });

  app.post("/api/v1/spend/alerts", async (c) => {
    const k = await caller(c);
    await requireRole(ctx, k, ["owner", "admin"]);
    const v = createBody.parse(await readJson(c));
    const d = shape(v.kind, v);
    await checkTarget(k, d);
    const webhookUrlEnc = sealWebhook(v.webhook_url);
    const id = uid("sa_");
    let signing = {}; // V86: creation-only signing response.
    await ctx.db.transaction(async (tx) => {
      // Serialize rule creation per account so concurrent requests cannot pass the cap together.
      await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, k.accountId)).for("update");
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(spendAlerts).where(eq(spendAlerts.accountId, k.accountId));
      if (Number(n) >= MAX_RULES_PER_ACCOUNT)
        fail(409, `An account can have at most ${MAX_RULES_PER_ACCOUNT} alert rules. Delete one first.`, "too_many_rules");
      await tx.insert(spendAlerts).values({ id, accountId: k.accountId, keyHash: d.keyHash, kind: d.kind, window: d.window, thresholdUsd: d.thresholdUsd, pct: d.pct, webhookUrlEnc, enabled: v.enabled ?? true, state: { v: 1, history: [] }, createdBy: k.keyHash });
      signing = await signingForRule(ctx, tx, { id, accountId: k.accountId, createdBy: k.keyHash, keyHash: d.keyHash, webhookUrlEnc }); // V86.
    });
    const [row] = await ctx.db.select().from(spendAlerts).where(eq(spendAlerts.id, id));
    if (ctx.cfg.webhookSigningEnabled) c.header("cache-control", "no-store"); return c.json({ data: ruleJson(row, d.keyHash ? (await keyRows(k.accountId, [d.keyHash])).get(d.keyHash) : undefined), ...signing }, 201); // V86.
  });

  app.patch("/api/v1/spend/alerts/:id", async (c) => {
    const k = await caller(c);
    await requireRole(ctx, k, ["owner", "admin"]);
    const current = await visibleRule(k, c.req.param("id"));
    const v = patchBody.parse(await readJson(c));
    if (v.kind !== undefined && v.kind !== current.kind) fail(400, "A rule's kind cannot change; create a new rule instead.", "invalid_request");
    const d = shape(current.kind, v, { kind: current.kind, window: current.window, keyHash: current.keyHash, thresholdUsd: current.thresholdUsd, pct: current.pct });
    await checkTarget(k, d);
    const webhookUrlEnc = v.webhook_url === undefined ? undefined : sealWebhook(v.webhook_url);
    let signing = {}; // V86: changed destinations reveal a fresh secret once.
    await ctx.db.transaction(async (tx) => {
      const [row] = await tx.select().from(spendAlerts).where(eq(spendAlerts.id, current.id)).for("update");
      if (!row) fail(404, "Alert rule not found.", "not_found");
      const conditionChanged = row.window !== d.window || row.keyHash !== d.keyHash || row.thresholdUsd !== d.thresholdUsd || row.pct !== d.pct;
      const enabled = v.enabled ?? row.enabled;
      const state = parseAlertState(row.state);
      if (!enabled || webhookUrlEnc === null) cancelPending(state);
      await tx
        .update(spendAlerts)
        .set({
          window: d.window,
          keyHash: d.keyHash,
          thresholdUsd: d.thresholdUsd,
          pct: d.pct,
          enabled,
          state,
          ...(webhookUrlEnc !== undefined ? { webhookUrlEnc } : {}),
          // A changed condition is a new rule: it may fire again in the current period.
          ...(conditionChanged ? { lastPeriod: null } : {}),
        })
        .where(eq(spendAlerts.id, row.id));
      signing = await signingForRule(ctx, tx, { ...row, createdBy: row.createdBy ?? k.keyHash, keyHash: d.keyHash, webhookUrlEnc: webhookUrlEnc === undefined ? row.webhookUrlEnc : webhookUrlEnc }, webhookUrlEnc !== undefined); // V86.
    });
    const [row] = await ctx.db.select().from(spendAlerts).where(eq(spendAlerts.id, current.id));
    if (ctx.cfg.webhookSigningEnabled) c.header("cache-control", "no-store"); return c.json({ data: ruleJson(row, d.keyHash ? (await keyRows(k.accountId, [d.keyHash])).get(d.keyHash) : undefined), ...signing }); // V86.
  });

  app.delete("/api/v1/spend/alerts/:id", async (c) => {
    const k = await caller(c);
    await requireRole(ctx, k, ["owner", "admin"]);
    const r = await visibleRule(k, c.req.param("id"));
    await ctx.db.delete(spendAlerts).where(and(eq(spendAlerts.id, r.id), eq(spendAlerts.accountId, k.accountId)));
    return c.json({ data: { id: r.id, deleted: true } });
  });
}

import { filterNotificationInbox, weeklyInbox } from "../notifications/inbox.ts"; // E146
import { securityInbox } from "../security-alerts/worker.ts"; // D138
import { scheduleInbox } from "../schedules/inbox.ts"; // D136
import { depositPingItems } from "./deposit-pings.ts"; // B123
import { lowBalanceInbox } from "../account/low-balance.ts"; // B119
import { quietInboxItems } from "../agents/quiet-alerts.ts"; // D141
import { priceNoticeItems } from "../catalog/price-notices.ts"; // C133
import { projectBudgetInbox } from "../projects/budget-notices.ts"; // D139
import { createHmac } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { roleOf, type KeyRow } from "../api/auth.ts";
import { accounts, agentSessions, keys, providers } from "../db/schema.ts";
import { agentApprovals } from "../agents/approval-schema.ts";
import { playbookChanges } from "../agents/schema.ts";
import { playbookChangedTitle } from "../agents/playbooks.ts";
import { readActivity } from "../activity/read.ts";
import { activityQuery } from "../activity/query.ts";
import { picoToUsdString } from "../lib/money.ts";
import { agentPayments } from "../agents/pay-schema.ts";
import { unitsToUsd } from "../agents/pay.ts";
// Keep approval scope visible without returning unexpected stored fields.
export function inboxIntent(value: unknown): { intents: Record<string, unknown>[] } {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const intents = Array.isArray(object.intents) ? object.intents : [object];
  return { intents: intents.map(value => {
    const intent = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(intent).filter(([name]) => ["kind", "model", "lane", "name", "tools", "max_output_tokens", "est_cost_pico"].includes(name)));
  }) };
}
const micros = (value: string) => BigInt(Date.parse(value)) * 1000n + BigInt((value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6));
export async function inboxScope(ctx: Ctx, key: KeyRow) {
  const role = await roleOf(ctx, key);
  const session = (await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash)).limit(1)).length > 0;
  const whole = !session && (key.management || role === "owner" || role === "admin");
  const canDecide = !session && (key.management || (!!key.teamId && (role === "owner" || role === "admin")));
  // Separate bookmarks for different visibility: an ordinary/session key cannot mark its owner's inbox seen.
  const seenScope = createHmac("sha256", ctx.cfg.appSecret).update(JSON.stringify([key.accountId, whole ? "account" : key.keyHash, whole && !key.management ? key.teamId : null, key.management])).digest("hex");
  return { whole, canDecide, seenScope };
}
export async function readInbox(ctx: Ctx, key: KeyRow, since?: string) {
  const asOf = new Date().toISOString();
  const scope = await inboxScope(ctx, key);
  type Item = { id: string; at: string; kind: string; title: string; status: string | null; href: string; amount?: string; key_label?: string | null; model?: string | null; approval_id?: string; approval_limit?: string; expires_at?: string; can_decide?: boolean; intent?: ReturnType<typeof inboxIntent>; unread: boolean };
  const items: Item[] = [];
  let capped = false;
  { const notices = await securityInbox(ctx, key, scope.whole, since, asOf); capped ||= notices.length > 100; items.push(...notices.slice(0, 100)); } // D138
  if (scope.whole && key.management) { const notices = await projectBudgetInbox(ctx, key.accountId, asOf, since); capped ||= notices.length > 100; items.push(...notices.slice(0, 100)); } // D139
  if (scope.whole && key.management) { const notices = await priceNoticeItems(ctx, key.accountId, asOf, since); capped ||= notices.length > 100; items.push(...notices.slice(0, 100)); } // C133
  if (scope.whole) { const notices = await depositPingItems(ctx, key.accountId, asOf, since); capped ||= notices.length > 100; items.push(...notices.slice(0, 100)); } // B123
  if (scope.whole) { const notices = await quietInboxItems(ctx, key, asOf, since); capped ||= notices.length > 100; items.push(...notices.slice(0, 100)); } // D141
  const unread = (at: string) => !since || micros(at) > micros(since);
  if (ctx.cfg.agentPolicyEnabled) {
    const pending = await ctx.db.select({ id: agentApprovals.id, at: agentApprovals.requestedAt, expires: agentApprovals.expiresAt, limit: agentApprovals.maxCostPico, intent: agentApprovals.intent, label: keys.name }).from(agentApprovals).innerJoin(keys, eq(keys.keyHash, agentApprovals.keyHash)).where(and(
      eq(keys.accountId, key.accountId), scope.whole ? undefined : eq(keys.keyHash, key.keyHash),
      scope.whole && !key.management ? eq(keys.teamId, key.teamId!) : undefined,
      eq(agentApprovals.status, "pending"), gt(agentApprovals.expiresAt, new Date(asOf)),
    )).orderBy(desc(agentApprovals.requestedAt), desc(agentApprovals.id)).limit(101);
    capped ||= pending.length > 100;
    items.push(...pending.slice(0, 100).map(row => ({ id: `approval:${row.id}`, at: row.at.toISOString(), kind: "approval", title: "Approve an agent request", status: "pending", href: "/agents/", key_label: row.label, intent: inboxIntent(row.intent), approval_id: row.id, approval_limit: picoToUsdString(row.limit), expires_at: row.expires.toISOString(), can_decide: scope.canDecide, unread: true })));
  }
  if (ctx.cfg.agentPayEnabled) {
    // Pay another agent: the payer's keys see what they sent; the owner of an agent whose published wallet was paid sees
    // what it received. Only confirmed transfers appear, with their current status (seen, final or reversed).
    const p = agentPayments;
    const titles = { sent: { seen: "Payment sent, waiting for finality", final: "Payment sent and final", reversed: "Sent payment reversed: it left the chain" }, received: { seen: "Payment received, waiting for finality", final: "Payment received and final", reversed: "Received payment reversed: it left the chain" } } as const;
    for (const side of ["sent", "received"] as const) {
      const owner = side === "sent" ? p.keyHash : p.recipientKeyHash;
      const rows = await ctx.db.select({ id: p.decisionId, at: p.statusAt, status: p.status, paid: p.paidUnits, label: keys.name }).from(p).innerJoin(keys, eq(keys.keyHash, owner)).where(and(
        eq(keys.accountId, key.accountId), scope.whole ? undefined : eq(keys.keyHash, key.keyHash),
        scope.whole && !key.management ? eq(keys.teamId, key.teamId!) : undefined,
        inArray(p.status, ["seen", "final", "reversed"]), since ? gt(p.statusAt, new Date(since)) : undefined,
      )).orderBy(desc(p.statusAt), desc(p.decisionId)).limit(101);
      capped ||= rows.length > 100;
      for (const row of rows.slice(0, 100)) {
        const at = row.at.toISOString(), status = row.status as "seen" | "final" | "reversed";
        if (unread(at)) items.push({ id: `payment:${side}:${row.id}`, at, kind: "payment", title: titles[side][status], status, amount: row.paid === null ? undefined : unitsToUsd(row.paid), key_label: row.label, href: "/agents/#pay-agent", unread: true });
      }
    }
  }
  if (ctx.cfg.agentPolicyEnabled && scope.whole) {
    // U115: a changed team playbook, for whoever manages rulebooks there: management keys, and the team's owners and admins.
    const changes = await ctx.db.select().from(playbookChanges).where(and(
      eq(playbookChanges.accountId, key.accountId), eq(playbookChanges.action, "update"), eq(playbookChanges.notify, true),
      key.management ? undefined : or(isNull(playbookChanges.teamId), eq(playbookChanges.teamId, key.teamId!)),
      since ? gt(playbookChanges.at, new Date(since)) : undefined,
    )).orderBy(desc(playbookChanges.at), desc(playbookChanges.id)).limit(101);
    capped ||= changes.length > 100;
    items.push(...changes.slice(0, 100).map(row => ({ id: `playbook:${row.id}`, at: row.at.toISOString(), kind: "playbook", title: playbookChangedTitle(row.name, row.followers), status: `version ${row.version}`, href: "/dashboard/#playbooks", unread: unread(row.at.toISOString()) })));
  }
  for (const kind of ["alert", "deposit", "agreement", "topup"] as const) {
    // Reuse Activity's account, team, session, wallet-party and spending-alert guards.
    const eligible = kind === "deposit" ? sql`status = 'posted'` : kind === "agreement" ? sql`status in ('DisputeOpened','RulingPosted')` : undefined;
    const page = await readActivity(ctx, key, activityQuery({ kind, limit: "100", ...(since ? { from: since } : {}), to: asOf }), eligible);
    capped ||= !!page.next_cursor;
    for (const row of page.data) {
      if (!unread(row.at)) continue;
      if (kind === "deposit" && row.status !== "posted") continue;
      if (kind === "agreement" && !["DisputeOpened", "RulingPosted"].includes(row.status)) continue;
      items.push({ id: row.id, at: row.at, kind, title: row.title, status: row.status, amount: row.amount, key_label: row.key_label, href: kind === "agreement" || row.id.startsWith("alert:") ? "/agents/" : kind === "deposit" ? "/dashboard/#payments" : kind === "topup" ? "/dashboard/#api-keys" : "/dashboard/#spend-watch", unread: unread(row.at) });
    }
  }
  if (scope.whole && ctx.cfg.networkHosts.enabled) {
    // updated_at describes the record, not a dedicated status-transition time; no history is invented.
    const hosts = await ctx.db.select({ id: providers.id, at: providers.updatedAt, status: providers.status }).from(providers).innerJoin(accounts, and(eq(accounts.id, key.accountId), sql`lower(${providers.operator}) = lower(${accounts.wallet})`)).where(and(eq(providers.networkHost, true), since ? gt(providers.updatedAt, new Date(since)) : undefined)).orderBy(desc(providers.updatedAt), desc(providers.id)).limit(101);
    capped ||= hosts.length > 100;
    items.push(...hosts.slice(0, 100).map(row => ({ id: `host:${row.id}:${row.at.toISOString()}`, at: row.at.toISOString(), kind: "host", title: "Host record updated", status: row.status, href: `/hosts/?id=${encodeURIComponent(row.id)}`, unread: unread(row.at.toISOString()) })));
  }
  if (scope.whole) { const alerts = await lowBalanceInbox(ctx, key.accountId, since, asOf); capped ||= alerts.length > 100; items.push(...alerts.slice(0, 100)); } // B119
  if (scope.canDecide) { const notices = await scheduleInbox(ctx, key, asOf, since); capped ||= notices.length > 100; items.push(...notices.slice(0, 100)); } // D136
  items.push(...await weeklyInbox(ctx, key, scope.whole, since)); // E146
  await filterNotificationInbox(ctx, key.accountId, items); // E146
  items.sort((a, b) => micros(a.at) === micros(b.at) ? (a.id > b.id ? -1 : a.id < b.id ? 1 : 0) : micros(a.at) > micros(b.at) ? -1 : 1);
  return { data: items, count: items.filter(item => item.unread).length, capped, as_of: asOf, seen_scope: scope.seenScope, scope: scope.whole ? "account" : "key" };
}

import { deferTelegram } from "../notifications/telegram.ts"; // E146
import { timedAlertText } from "./stop-text.ts"; // B117
import { sendRuleWebhook } from "../webhooks/delivery.ts"; // V86: shared signed transport.
import { linkedAlertTargets } from "../telegram/delivery.ts";
import { and, eq, isNotNull, like, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { agentSessions, keys, kv, spendAlerts } from "../db/schema.ts";
import { decrypt, sha256 } from "../lib/util.ts";
import { roleOf } from "../api/auth.ts";
import { type SpendWatchOptions } from "../services/spend-watch.ts";
import { TelegramApi } from "../services/telegram.ts";
import { lockAccount, policyState } from "./store.ts";
import { agentPolicies } from "./schema.ts";
import { captureAgentCaps, ALERT_RATE, pruneAgentAlerts, readAlertState, saveAlertState, type AgentAlert } from "./alerts.ts";

export type AlertDeliveryOptions = Pick<SpendWatchOptions, "send" | "resolve"> & { now?: () => number; telegramFetch?: typeof fetch };
const nowTime = Date.now;
type Target = { id: string; send: () => Promise<boolean> };
export const agentAlertPayload = (alert: AgentAlert) => ({ source: "anyroute", type: "agent_alert", id: alert.id, key_hash: alert.key_hash, at: alert.at, kind: alert.kind, ...(alert.stopped_until ? { stopped_until: alert.stopped_until } : {}), ...(alert.window ? { window: alert.window, percent: alert.percent } : {}), ...(alert.count ? { count: alert.count } : {}) });
// V86: legacy destinations stay unsigned until their owner rotates; egress remains guarded.
async function targets(ctx: Ctx, account: string, alert: AgentAlert, opts: AlertDeliveryOptions): Promise<Target[]> {
  const out: Target[] = [];
  if (alert.channels.includes("webhook")) {
    const rules = await ctx.db.select().from(spendAlerts).where(and(eq(spendAlerts.accountId, account), eq(spendAlerts.enabled, true), isNotNull(spendAlerts.webhookUrlEnc)));
    const seen = new Set<string>();
    for (const rule of rules.filter(r => r.keyHash === null || r.keyHash === alert.key_hash).slice(0, 20)) {
      try {
        const url = decrypt(ctx.cfg.appSecret, rule.webhookUrlEnc!);
        if (!ctx.cfg.webhookSigningEnabled && seen.has(url)) continue; // V86: each signed destination owns its secret.
        seen.add(url);
        out.push({ id: `webhook:${rule.id}`, send: async () => (await sendRuleWebhook(ctx, rule.id, url, { id: alert.id, event: "agent.alert", reference: alert.id, at: new Date(alert.at) }, agentAlertPayload(alert), opts)).ok });
      } catch { /* An unreadable destination is not linked. */ }
    }
  }
  if (alert.channels.includes("telegram") && ctx.cfg.telegram.botToken) {
    out.push(...await linkedAlertTargets(ctx, account, alert.key_hash, timedAlertText(alert) ?? `AnyRoute agent alert: ${alert.kind}${alert.window ? ` (${alert.window}, ${alert.percent}%)` : ""}. Key ${alert.key_hash}. Open /agents for details.`, opts.telegramFetch));
    const [agent] = await ctx.db.select().from(keys).where(eq(keys.keyHash, alert.key_hash));
    const links = await ctx.db.select().from(kv).where(like(kv.key, "telegram:user:%"));
    for (const link of links) {
      if (out.filter(t => t.id.startsWith("telegram:")).length >= 20) break;
      const id = link.key.slice("telegram:user:".length);
      if (!/^\d+$/.test(id) || out.some(t => t.id === `telegram:${id}`)) continue;
      try {
        const sealed = (link.value as { key?: string })?.key;
        if (!sealed) continue;
        const plain = decrypt(ctx.cfg.appSecret, sealed), prefix = `tg:${id}:`;
        if (!plain.startsWith(prefix)) continue;
        const [key] = await ctx.db.select().from(keys).where(eq(keys.keyHash, sha256(plain.slice(prefix.length))));
        if (!key || key.disabled || (key.expiresAt && key.expiresAt.getTime() <= nowTime())) continue;
        if (key.accountId !== account || (!key.management && (!key.teamId || key.teamId !== agent?.teamId))) continue;
        if ((await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash)).limit(1)).length) continue;
        if (!["owner", "admin"].includes(await roleOf(ctx, key))) continue;
        out.push({ id: `telegram:${id}`, send: async () => {
          if (await deferTelegram(ctx, { account, key_hash: key.keyHash, uid: Number(id), generation: key.keyHash, linked_at: new Date().toISOString() }, alert.key_hash, timedAlertText(alert) ?? `AnyRoute agent alert: ${alert.kind}${alert.window ? ` (${alert.window}, ${alert.percent}%)` : ""}. Key ${alert.key_hash}. Open /agents for details.`, "agent_alerts", key, new Date(), true)) return true; // E146
          try { await new TelegramApi(ctx.cfg.telegram.botToken!, opts.telegramFetch).call("sendMessage", { chat_id: Number(id), text: timedAlertText(alert) ?? `AnyRoute agent alert: ${alert.kind}${alert.window ? ` (${alert.window}, ${alert.percent}%)` : ""}. Key ${alert.key_hash}. Open /agents for details.`, link_preview_options: { is_disabled: true } }, AbortSignal.timeout(5_000)); return true; } catch { return false; }
        } });
        if (out.filter(t => t.id.startsWith("telegram:")).length >= 20) break;
      } catch { /* Forgotten, disabled or invalid principal links are ignored. */ }
    }
  }
  // No account email destination exists. Selecting email alone yields feed_only.
  return out;
}
export async function runAgentAlerts(ctx: Ctx, opts: AlertDeliveryOptions = {}) {
  if (!ctx.cfg.agentPolicyEnabled) return { skipped: "disabled", attempted: 0 };
  const now = opts.now ?? Date.now;
  const policies = await ctx.db.select({ keyHash: agentPolicies.keyHash, account: keys.accountId }).from(agentPolicies).innerJoin(keys, eq(keys.keyHash, agentPolicies.keyHash)).where(sql`${agentPolicies.spec} ? 'alerts'`);
  for (const policy of policies) await ctx.db.transaction(async tx => {
    await lockAccount(tx, policy.account);
    const [row] = await tx.select().from(agentPolicies).where(eq(agentPolicies.keyHash, policy.keyHash));
    if (row?.spec.alerts) await captureAgentCaps(tx, [row], policy.account, r => policyState(tx, r, new Date(now())), now());
  });
  await pruneAgentAlerts(ctx, now());
  const rows = await ctx.db.select({ key: kv.key }).from(kv).where(like(kv.key, "agent-alerts:%"));
  let attempted = 0;
  for (const row of rows) {
    const account = row.key.slice("agent-alerts:".length);
    for (let i = 0; i < ALERT_RATE; i++) {
      const claim = await ctx.db.transaction(async tx => {
        await lockAccount(tx, account);
        const state = await readAlertState(tx, account), time = now(), minute = Math.floor(time / 60_000);
        if (state.rate.minute !== minute) state.rate = { minute, count: 0 };
        if (state.rate.count >= ALERT_RATE) return null;
        const alert = state.feed.find(a => a.delivery === "pending" && a.next_attempt <= time);
        if (!alert) return null;
        if (alert.attempts >= 3) { alert.delivery = "failed"; await saveAlertState(tx, account, state, time); return null; }
        alert.attempts++; alert.next_attempt = time + 300_000; state.rate.count++;
        await saveAlertState(tx, account, state, time);
        return { ...alert };
      });
      if (!claim) break;
      attempted++;
      const destinations = await targets(ctx, account, claim, opts);
      const done = new Set(claim.delivered_targets ?? []);
      for (const target of destinations) if (!done.has(target.id) && await target.send()) done.add(target.id);
      await ctx.db.transaction(async tx => {
        await lockAccount(tx, account);
        const state = await readAlertState(tx, account), alert = state.feed.find(a => a.id === claim.id);
        if (!alert || alert.attempts !== claim.attempts) return;
        alert.delivered_targets = [...done];
        alert.delivery = !destinations.length ? "feed_only" : destinations.every(t => done.has(t.id)) ? "delivered" : alert.attempts >= 3 ? "failed" : "pending";
        await saveAlertState(tx, account, state, now());
      });
    }
  }
  return { attempted };
}

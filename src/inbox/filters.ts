// H173: filters apply after the existing authorization and notice preferences.
import { z } from "zod";
export const INBOX_GROUPS = ["approvals", "agents", "money", "security", "models", "other"] as const;
export type InboxGroup = typeof INBOX_GROUPS[number];
const groups: Record<string, InboxGroup> = {
  approval: "approvals", approval_reminder: "approvals",
  alert: "agents", "quiet-agent": "agents", playbook: "agents", schedule: "agents",
  deposit: "money", topup: "money", payment: "money", low_balance: "money", project_budget: "money",
  security: "security", price_notice: "models", model_watch: "models", status_incidents: "models", // H169 incidents sit with model notices
  agreement: "other", host: "other", weekly_summary: "other",
};
groups.low_balance_pause = "agents"; // K195
export const inboxGroup = (kind: string): InboxGroup => Object.hasOwn(groups, kind) ? groups[kind]! : "other";
const query = z.string().max(512).regex(/^[a-z][a-z_-]*(?:,[a-z][a-z_-]*)*$/);
export function inboxKinds(value: string): string[] { return [...new Set(query.parse(value).split(","))]; }
export function filterInboxPage<T extends { kind: string; unread: boolean }, P extends { data: T[]; count: number }>(page: P, kinds: string[]) {
  const kind_counts = Object.fromEntries(INBOX_GROUPS.map(group => [group, 0])) as Record<InboxGroup, number>;
  for (const item of page.data) kind_counts[inboxGroup(item.kind)]++;
  const data = page.data.filter(item => kinds.includes(item.kind) || kinds.includes(inboxGroup(item.kind)));
  return { ...page, data, count: data.filter(item => item.unread).length, kind_counts };
}

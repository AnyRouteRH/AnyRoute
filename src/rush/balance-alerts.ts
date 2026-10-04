import type { AlertState, CheckState, Transition } from "../services/alerts.ts";

export const EXHAUSTED_REMINDER_MS = 6 * 60 * 60_000;
const balanceCheck = /^upstream_[a-f0-9]{12}_(warning|critical|exhausted)$/;

/** Balance state changes are immediate; other operations checks retain their existing sustain window. */
export function planBalanceAlerts(state: AlertState, transitions: Transition[], prev: AlertState | null | undefined, observed: Record<string, boolean>, now: number) {
  for (const [name, ok] of Object.entries(observed)) {
    if (!balanceCheck.test(name)) continue;
    const before = prev?.checks[name];
    const check = state.checks[name];
    if (!check) continue;
    check.firing = !ok;
    check.delivered_at = before?.delivered_at;
    if (transitions.some(t => t.check === name)) continue;
    const reminder = name.endsWith("_exhausted") && !ok && before?.notified === "failing" &&
      now - Date.parse(before.delivered_at ?? before.since) >= EXHAUSTED_REMINDER_MS;
    if (!ok && (before?.notified !== "failing" || reminder)) transitions.push({ check: name, state: "failing", since: check.since });
  }
}

export function deliveredBalanceTime(check: CheckState, name: string, at: string) {
  if (balanceCheck.test(name)) check.delivered_at = at;
}

import type { HealthEvent } from "../services/health.ts";
const counts = (e: HealthEvent) => e.ok || e.errorKind !== "rejected";
const hardFailure = (e: HealthEvent) => !e.ok && e.errorKind !== "rejected";
// G159: the router and persisted worker replay use the same outage rule.
export function routeOutage(list: HealthEvent[] | undefined, now: number, windowMs = 30_000) {
    if (!list?.length) return false;
    const since = now - windowMs;
    let fails = 0;
    let oks = 0;
    let empties = 0;
    const emptyCallers = new Set<string>();
    for (let i = list.length - 1; i >= 0 && list[i].at! >= since; i--) {
      const e = list[i];
      if (!counts(e)) continue;
      if (e.ok) oks++;
      else if (e.errorKind === "empty200") {
        // A single caller can provoke empty answers; only count them once two callers (or a probe) see them.
        empties++;
        emptyCallers.add(e.caller ?? `src:${e.source}`);
      } else fails++;
    }
    if (emptyCallers.size >= 2) fails += empties;
    if (fails >= 2 && fails >= oks) return true;
    const last = [...list].reverse().find(counts);
    return !!last && last.at! >= since && hardFailure(last) && last.source === "probe";
}

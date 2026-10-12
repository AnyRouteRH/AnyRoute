import type { HealthEvent } from "../services/health.ts";
import { routeOutage } from "./outage.ts";
// Health checks reach each model every few minutes, so a route's state is its latest check within FRESH_MS.
export const HOLD_MS = 5 * 60_000, PAIR_MS = 60 * 60_000, FRESH_MS = 10 * 60_000;
export type Observation = "down" | "up" | null;
export type WatchNotice = { id: string; at: string; title: string; model: string };
export type WatchState = { candidate: Observation; since: number; down: boolean; lastDown: number | null; checkedAt: number; notices: WatchNotice[] };
export const initialState = (now: number): WatchState => ({ candidate: null, since: now, down: false, lastDown: null, checkedAt: now, notices: [] });
export function observe(state: WatchState, value: Observation, now: number): "down" | "up" | null {
  if (value !== state.candidate) { state.candidate = value; state.since = now; }
  if (!value || now - state.since < HOLD_MS) return null;
  if (value === "down" && !state.down && (state.lastDown === null || now - state.lastDown >= PAIR_MS)) {
    state.down = true; state.lastDown = now; return "down";
  }
  if (value === "up" && state.down) { state.down = false; return "up"; }
  return null;
}
// A route is down when the router's outage rule says so or its latest fresh check failed, up when its latest fresh check
// succeeded, unknown otherwise. Stale or missing observations never prove recovery.
const counted = (e: HealthEvent) => e.ok || e.errorKind !== "rejected";
function routeState(list: HealthEvent[], at: number): Observation {
  if (routeOutage(list, at)) return "down";
  const last = list.findLast(e => e.at! >= at - FRESH_MS && counted(e));
  return !last ? null : last.ok ? "up" : "down";
}
export function availability(routes: string[], events: HealthEvent[], at: number): Observation {
  if (!routes.length) return null;
  const states = routes.map(provider => routeState(events.filter(e => e.providerId === provider && e.at! <= at), at));
  if (states.every(s => s === "down")) return "down";
  return states.includes("up") ? "up" : null;
}
// Replay events AND window expiries since the prior tick, so a brief recovery or a stale gap resets the hold.
export function replay(state: WatchState, routes: string[], events: HealthEvent[], now: number) {
  const start = Math.max(state.checkedAt, now - HOLD_MS);
  if (start > state.checkedAt) { state.candidate = null; state.since = start; }
  const times = new Set([start, now]);
  for (const e of events) for (const at of [e.at!, e.at! + 30_001, e.at! + FRESH_MS + 1]) if (at >= start && at <= now) times.add(at);
  let transition: "down" | "up" | null = null;
  // Only current notices are emitted after a stalled worker; history still resets the candidate accurately.
  for (const at of [...times].sort((a, b) => a - b)) {
    const value = availability(routes, events, at);
    if (at === now) transition = observe(state, value, at);
    else if (value !== state.candidate) { state.candidate = value; state.since = at; }
  }
  state.checkedAt = now; return transition;
}

import type { Candidate } from "../catalog/catalog.ts";
import type { RouteFailure, RouteSuccess, RouteTarget } from "./execute.ts";
import type { ProviderPrefs, Selection } from "./select.ts";
import { isNetworkHost } from "../network/routing.ts";

// V84: per-request selection evidence only. Never read bodies, URLs, keys or error messages here.
export const ROUTE_REASONS = ["lowest_price", "lowest_latency", "highest_throughput", "weighted_choice", "provider_order", "preferred_performance", "byok_priority", "only_eligible", "only_parameter_support", "fallback"] as const;
export const SKIP_REASONS = ["health", "lane", "disclosure", "attestation", "parameters", "price", "context", "preferences", "availability", "other"] as const;
export const ERROR_CLASSES = ["http_5xx", "timeout", "connection", "rate_limited", "provider_auth", "rejected", "empty200", "unreadable", "interrupted", "other"] as const;
export const ROUTE_PARAMETERS = ["tools", "tool_choice", "response_format", "temperature", "seed", "max_tokens", "stop", "top_p", "top_k", "reasoning", "include_reasoning", "modalities", "audio"] as const;
type Counts = Partial<Record<(typeof SKIP_REASONS)[number], number>>;
export type RouteExplanation = {
  v: 1;
  provider: string;
  reason: (typeof ROUTE_REASONS)[number];
  eligible: number;
  skipped: Counts;
  lane: "public" | "attested" | "unlinkable";
  parameters: string[];
  network_host: boolean;
  fallback?: Partial<Record<(typeof ERROR_CLASSES)[number], number>>;
};
type Plan = Omit<RouteExplanation, "provider" | "network_host" | "fallback">;
const plans = new WeakMap<Candidate[], Plan>();
type ServingResult = Pick<RouteSuccess, "candidate" | "model" | "attempts">;
const results = new WeakMap<ServingResult, RouteExplanation>();
const safeProvider = (id: string) => /^[A-Za-z0-9_-]{1,96}$/.test(id) ? id : "provider";

// Map arbitrary source strings to a closed vocabulary; never return the strings themselves.
export function skipClass(reason: string): (typeof SKIP_REASONS)[number] {
  if (/outage|unhealthy/i.test(reason)) return "health";
  if (/lane|restricted|classifier|not approved/i.test(reason)) return "lane";
  if (/attestation|TEE/i.test(reason)) return "attestation";
  if (/disclosure|retention|data_collection|zdr/i.test(reason)) return "disclosure";
  if (/parameters|does not support/i.test(reason)) return "parameters";
  if (/price|free/i.test(reason)) return "price";
  if (/context length/i.test(reason)) return "context";
  if (/provider\.only|provider\.ignore|quantization/i.test(reason)) return "preferences";
  if (/^(provider|offer) /i.test(reason)) return "availability";
  return "other";
}

/** Called after the existing parameter filter and BYOK ordering, without selecting again. */
export function rememberRoutePlan(enabled: boolean, selection: Selection, ordered: Candidate[], notes: { reason: string }[], prefs: ProviderPrefs, modifiers: Set<string>, params: string[], byok: Map<string, string>) {
  if (!enabled) return;
  const skipped: Counts = {};
  for (const note of notes) { const k = skipClass(note.reason); skipped[k] = (skipped[k] ?? 0) + 1; }
  const sort = modifiers.has("nitro") ? "throughput" : modifiers.has("floor") ? "price" : typeof prefs.sort === "string" ? prefs.sort : prefs.sort?.by;
  let reason: Plan["reason"] = sort === "price" ? "lowest_price" : sort === "latency" ? "lowest_latency" : sort === "throughput" ? "highest_throughput" : "weighted_choice";
  if (prefs.preferred_min_throughput != null || prefs.preferred_max_latency != null) reason = "preferred_performance";
  if (prefs.order?.some(id => id.toLowerCase() === ordered[0]?.providerId.toLowerCase())) reason = "provider_order";
  else if (!prefs.order?.length && ordered[0] && byok.has(ordered[0].providerId)) reason = "byok_priority";
  const required = prefs.require_parameters ? params : params.filter(p => p === "tools" || p === "tool_choice" || p === "response_format");
  if (ordered.length === 1) reason = skipped.parameters && required.length > 0 && required.every(p => ordered[0].supportedParameters?.includes(p)) ? "only_parameter_support" : "only_eligible";
  const plan: Plan = { v: 1, reason, eligible: ordered.length, skipped, lane: prefs.lane ?? "public", parameters: ROUTE_PARAMETERS.filter(p => required.includes(p)) };
  // selection identity ties evidence to this call, even when catalog candidates are reused concurrently.
  if (selection.ordered !== ordered) plans.set(selection.ordered, plan);
  plans.set(ordered, plan);
}

/** A dual-verification leg partitions an existing plan; it does not run another selection. */
export function inheritRoutePlan(from: Candidate[], ordered: Candidate[]): Candidate[] {
  const plan = plans.get(from);
  if (plan) plans.set(ordered, { ...plan, eligible: ordered.length });
  return ordered;
}

/** Called with the actual serving result, including all failures before success. */
export function rememberRouteResult<T extends ServingResult>(result: T, targets: RouteTarget[]): T {
  const target = targets.find(t => t.model.id === result.model.id && t.ordered.includes(result.candidate));
  const plan = target && plans.get(target.ordered);
  if (!plan || safeProvider(result.candidate.providerId) !== result.candidate.providerId) return result;
  const fallback: NonNullable<RouteExplanation["fallback"]> = {};
  for (const attempt of result.attempts) if (!attempt.ok) {
    const kind = ERROR_CLASSES.includes(attempt.error_kind as never) ? attempt.error_kind as keyof typeof fallback : "other";
    fallback[kind] = (fallback[kind] ?? 0) + 1;
  }
  results.set(result, { ...plan, provider: safeProvider(result.candidate.providerId), network_host: isNetworkHost(result.candidate.provider), ...(Object.keys(fallback).length ? { reason: "fallback", fallback } : {}) });
  return result;
}

export function routeReceiptFields(enabled: boolean, result: ServingResult): { route?: RouteExplanation } {
  const route = enabled ? results.get(result) : undefined;
  return route ? { route } : {};
}

export function routeResponseHeaders(enabled: boolean, result: ServingResult): Record<string, string> {
  const { route } = routeReceiptFields(enabled, result);
  return route ? { "x-anyroute-route": JSON.stringify(route) } : {};
}

/** With explanations on, wait for the same buffered routing attempt before sending stream headers. */
type RouteRun = () => Promise<RouteSuccess | RouteFailure>;
export async function explainedStream(enabled: boolean, run: RouteRun, respond: (savedRun: RouteRun, headers?: Record<string, string>) => Response): Promise<Response> {
  if (!enabled) return respond(run);
  let result: Awaited<ReturnType<typeof run>>;
  try { result = await run(); }
  catch (error) { return respond(async () => { throw error; }); }
  return respond(async () => result, result.ok ? routeResponseHeaders(true, result) : undefined);
}

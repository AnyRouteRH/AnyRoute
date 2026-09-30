import type { TableDoc } from "./types.ts";
/** Additive inventory descriptions for metadata stored in the existing rulebook tables. */
export function describeAutonomy(tables: Record<string, TableDoc>) {
  const policies = tables.agent_policies, events = tables.agent_policy_events;
  const spec = policies.columns.spec;
  if (typeof spec !== "string") spec.purpose += " Optional autonomy stores bounded rung requirements, spending multipliers and selected reset event kinds; it contains no prompt fields.";
  events.retention += " For active autonomy rulebooks, the latest autonomy_state checkpoint and following suffix remain until superseded or the rulebook is removed, even beyond 90 days, to preserve earned progress.";
  events.columns.kind += " Autonomy also records autonomy_clean once per allowed reservation or cache/tool authorization, autonomy_state for derived progress, and breaker for an agent breaker event.";
  const intent = events.columns.intent;
  if (typeof intent !== "string") intent.purpose += " An autonomy_state checkpoint stores only rung number, rung since timestamp, clean request count and last clean timestamp. Autonomy clean and breaker events have null intent; none stores prompt text.";
}

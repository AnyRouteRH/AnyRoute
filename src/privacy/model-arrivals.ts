// C131
import type { TableDoc } from "./types.ts";
export function describeModelArrivals(docs: Record<string, TableDoc>) {
  docs.kv!.notes!.push("model-first-seen:<public model id>: the first catalogue observation in Unix seconds and a seeded flag. model-arrivals:seed: initialization marker and baseline time. Recorded during catalogue refresh only when MODEL_ARRIVALS_ENABLED is on (default false), retained until operator deletion including removed model IDs so reintroduction does not reset dates. Baseline model arrival dates are unknown and published as null; later observations are published as added_at and in the public models feed. No account, request, prompt, answer or address data, new Redis keys or log fields.");
}

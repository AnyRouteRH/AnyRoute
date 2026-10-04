import { orderIntentHash } from "./decision-receipt.ts";
/** Rules apply to actions your agent checks first. Wired into your code before the order function, the model can't skip
 * the check; it doesn't stop whoever holds the brokerage or wallet keys. Amounts traded count what your agent reports. */
export class GuardDenied extends Error {
  constructor(public reasons: unknown) { super(`Action denied: ${JSON.stringify(reasons)}`); }
}
export type GuardOptions<T> = {
  apiKey: string; baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number;
  target?: string; amount_usd: string; executedAmountUsd: (result: T) => string;
};
/** Wrap the developer's order function. Keep this wrapper outside the model's control. Never retry fn after a reporting error. */
export async function guarded<T>(opts: GuardOptions<T>, action: string, describe: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const fetchImpl = opts.fetch ?? fetch, base = (opts.baseUrl ?? "https://anyroute.tech").replace(/\/$/, "");
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 900_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 900_000);
  const request = async (path: string, body?: unknown) => {
    const response = await fetchImpl(base + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    const value = await response.json() as { data: Record<string, any>; error?: unknown };
    if (!response.ok) throw new Error(`Guard request failed (${response.status}): ${JSON.stringify(value.error)}`);
    return value.data;
  };
  const body = { action, ...(opts.target === undefined ? {} : { target: opts.target }), amount_usd: opts.amount_usd, details_sha256: orderIntentHash(describe) };
  let decision = await request("/api/v1/guard/decide", body);
  if (decision.decision === "approval_required") {
    const id = decision.approval_id as string;
    for (;;) {
      const approval = await request(`/api/v1/agents/approvals/${encodeURIComponent(id)}`);
      if (approval.status === "approved") break;
      if (approval.status !== "pending") throw new GuardDenied([{ code: `approval_${approval.status}` }]);
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
    }
    decision = await request("/api/v1/guard/decide", { ...body, approval_id: id });
  }
  if (decision.decision !== "allow") throw new GuardDenied(decision.reasons);
  const report = (status: string, amount_usd?: string) => request(`/api/v1/guard/decisions/${encodeURIComponent(decision.decision_id)}/outcome`, { status, ...(amount_usd === undefined ? {} : { amount_usd }) });
  let result: T;
  try { result = await fn(); } catch (error) {
    try { await report("failed"); } catch (reportError) { throw new AggregateError([error, reportError], "Action failed and its outcome could not be reported."); }
    throw error;
  }
  try { await report("executed", opts.executedAmountUsd(result)); } catch (error) { throw new Error(`Action completed; report for decision ${decision.decision_id} needs reconciliation. Do not retry the action.`, { cause: error }); }
  return result;
}

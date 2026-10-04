import type { Context } from "hono";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { guardDecideInput } from "../agents/guard-input.ts";
const limit = "Rules apply to actions your agent checks first. Wired into your code before the order function, the model can't skip the check; it doesn't stop whoever holds the brokerage or wallet keys. Amounts traded count what your agent reports.";
export const guardMcpArgs = {
  anyroute_guard_decide: guardDecideInput,
  anyroute_guard_wait: z.strictObject({ approval_id: z.string().min(1).max(64), timeout_s: z.number().int().min(1).max(50).default(25) }),
  anyroute_guard_report: z.strictObject({ decision_id: z.string().min(1).max(64), status: z.enum(["executed", "skipped", "failed"]), amount_usd: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).optional() }).refine(v => v.status !== "executed" || v.amount_usd !== undefined),
};
const tool = (name: string, title: string, description: string, schema: z.ZodType, readOnly: boolean) => ({ name, title, description: `${description} ${limit}`, inputSchema: z.toJSONSchema(schema), annotations: { readOnlyHint: readOnly, openWorldHint: false } });
export const guardMcpTools = [
  tool("anyroute_guard_decide", "Ask before an action", "Ask your owner's rulebook before an action with money or side effects. Returns allow, deny or approval_required. Never retry a denial unchanged. Rules apply only to actions you check first.", guardMcpArgs.anyroute_guard_decide, false),
  tool("anyroute_guard_wait", "Wait for approval", "After approval_required, wait for the owner. On approved, call anyroute_guard_decide again with the same fields plus approval_id.", guardMcpArgs.anyroute_guard_wait, true),
  tool("anyroute_guard_report", "Report an action outcome", "Report what happened after an allowed action, so daily limits count the real amount.", guardMcpArgs.anyroute_guard_report, false),
];
type Internal = (path: string, init?: RequestInit, c?: Context) => Promise<Record<string, unknown>>;
export async function callGuardMcp(name: string, args: unknown, c: Context, internal: Internal) {
  const headers = { authorization: c.req.header("authorization")!, "content-type": "application/json" }, signal = c.req.raw.signal;
  if (name === "anyroute_guard_wait") {
    const a = args as z.infer<typeof guardMcpArgs.anyroute_guard_wait>, deadline = Date.now() + a.timeout_s * 1000;
    for (;;) {
      const result = (await internal(`/api/v1/agents/approvals/${encodeURIComponent(a.approval_id)}`, { headers, signal }, c)).data as Record<string, unknown>;
      if (result.status !== "pending" || Date.now() >= deadline) return result;
      await delay(Math.min(2000, deadline - Date.now()), undefined, { signal });
    }
  }
  const a = args as Record<string, unknown>, { decision_id, ...outcome } = a;
  const path = name === "anyroute_guard_decide" ? "/api/v1/guard/decide" : `/api/v1/guard/decisions/${encodeURIComponent(String(decision_id))}/outcome`;
  return (await internal(path, { method: "POST", headers, signal, body: JSON.stringify(name === "anyroute_guard_decide" ? a : outcome) }, c)).data as Record<string, unknown>;
}

import { expect, test } from "bun:test";
import { guarded, GuardDenied } from "../integrations/robinhood-agents/guard.ts";
import { orderIntentHash } from "../integrations/robinhood-agents/decision-receipt.ts";
const order = { symbol: "NVDA", quantity: "2", limit_price: "180.00" };
function transport(responses: unknown[]) {
  const calls: { path: string; body?: any }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return Response.json({ data: response });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const options = { apiKey: "fixture-only-agent-key", amount_usd: "360", target: "NVDA", executedAmountUsd: (result: { amount: string }) => result.amount };
test("guard wrapper waits, redeems the same hashed intent, executes once and reports real amount", async () => {
  const t = transport([{ decision: "approval_required", approval_id: "approval" }, { status: "approved" }, { decision: "allow", decision_id: "decision" }, { status: "executed" }]);
  let executions = 0;
  expect(await guarded({ ...options, fetch: t.fetch }, "trade.order", order, async () => { executions++; return { amount: "359.50" }; })).toEqual({ amount: "359.50" });
  expect(executions).toBe(1);
  expect(t.calls[0]!.body.details_sha256).toBe(orderIntentHash(order));
  expect(t.calls[2]!.body).toEqual({ ...t.calls[0]!.body, approval_id: "approval" });
  expect(t.calls[3]!.body).toEqual({ status: "executed", amount_usd: "359.50" });
});
test("guard wrapper fails closed on denial or owner denial and never executes", async () => {
  for (const responses of [[{ decision: "deny", reasons: [{ code: "action_not_allowed" }] }], [{ decision: "approval_required", approval_id: "approval" }, { status: "denied" }]]) {
    const t = transport(responses); let executions = 0;
    await expect(guarded({ ...options, fetch: t.fetch }, "trade.order", order, async () => { executions++; return { amount: "360" }; })).rejects.toBeInstanceOf(GuardDenied);
    expect(executions).toBe(0);
  }
});
test("guard wrapper reports failed only for a thrown order, never for a report failure after execution", async () => {
  const t = transport([{ decision: "allow", decision_id: "decision" }, { status: "failed" }]);
  await expect(guarded({ ...options, fetch: t.fetch }, "trade.order", order, async () => { throw new Error("Order refused"); })).rejects.toThrow("Order refused");
  expect(t.calls[1]!.body).toEqual({ status: "failed" });
  const lost = transport([{ decision: "allow", decision_id: "retained-decision" }, new Error("Connection interrupted")]); let executions = 0;
  await expect(guarded({ ...options, fetch: lost.fetch }, "trade.order", order, async () => { executions++; return { amount: "360" }; })).rejects.toThrow("retained-decision");
  expect(executions).toBe(1); expect(lost.calls).toHaveLength(2);
});
test("Python helper hashes the same order, redeems once and reports outcomes without dependencies", () => {
  const script = `import sys\nsys.path.insert(0, 'integrations/robinhood-agents')\nfrom guard import guarded, GuardDenied\nfrom decision_receipt import order_intent_hash\norder = {'symbol':'NVDA','quantity':'2','limit_price':'180.00'}\ncalls=[]\nresponses=iter([{'decision':'approval_required','approval_id':'approval'}, {'status':'approved'}, {'decision':'allow','decision_id':'decision'}, {'status':'executed'}])\ndef request(path, body):\n    calls.append((path, body))\n    return next(responses)\nopts={'api_key':'fixture-only-agent-key','amount_usd':'360','target':'NVDA','request':request,'executed_amount_usd':lambda r:r['amount']}\nassert guarded(opts, 'trade.order', order, lambda: {'amount':'359.50'}) == {'amount':'359.50'}\nassert calls[0][1]['details_sha256'] == '${orderIntentHash(order)}'\nassert calls[2][1] == dict(calls[0][1], approval_id='approval')\nassert calls[3][1] == {'status':'executed','amount_usd':'359.50'}\nopts['request']=lambda p,b:{'decision':'deny','reasons':[{'code':'no_rulebook'}]}\ntry:\n    guarded(opts, 'trade.order', order, lambda: (_ for _ in ()).throw(AssertionError('must not execute')))\n    raise AssertionError('denial must throw')\nexcept GuardDenied: pass\n`;
  const result = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
});

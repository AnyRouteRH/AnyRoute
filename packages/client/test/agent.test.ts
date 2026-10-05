import { expect, test } from "bun:test";
import { AnyRoute, AnyRouteError, AgentPolicyDenied, AgentKilled, AgentApprovalRequired, type AgentIntent, type AgentPolicy, type AgentRulebook, type AgentDecision, type AgentReplay, type Fetch } from "../src/index.js";
import { json, stubFetch } from "./helpers.js";
const intent: AgentIntent = { kind: "inference", model: "example/model", lane: "public", est_cost_pico: "1000000000", max_output_tokens: 32, tools: [] };
const policy: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
test("agent methods authenticate and return REST data unchanged", async () => {
  const rules: AgentRulebook = { name: null, sha256: null, key_hash: "hash", policy, killed: true, remaining: { hour: 1, day: null, week: null }, policies: [] };
  const decision: AgentDecision = { decision: "deny", reasons: [{ code: "killed", message: "Agent is killed." }] };
  const f = stubFetch({
    "/api/v1/agents/me": ({ init }) => { const headers = new Headers(init?.headers); expect(headers.get("authorization")).toBe("Bearer key"); expect(headers.get("x-extra")).toBe("value"); return json({ data: rules }); },
    "POST /api/v1/agents/check": ({ init }) => { expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key"); expect(JSON.parse(init?.body as string)).toEqual(intent); return json({ data: decision }); },
  });
  const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "key", headers: { "x-extra": "value" }, fetch: f.fetch });
  expect(await c.agent.rules()).toEqual(rules);
  expect(await c.agent.check(intent)).toEqual(decision);
  expect(f.calls).toHaveLength(2);
});
for (const [code, kind] of [["agent_policy_denied", AgentPolicyDenied], ["agent_killed", AgentKilled], ["agent_approval_required", AgentApprovalRequired]] as const) {
  for (const method of ["create", "stream", "rules", "check"] as const) test(`${method} surfaces ${code} without retries`, async () => {
    const metadata = { reasons: [{ code: "approval_required", message: "Owner approval required." }], policy_sha256: "digest", approval_id: "approval-1", poll: { url: "/api/v1/approvals/approval-1", after_ms: 1000 } };
    let calls = 0;
    const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "key", fetch: (async () => { calls++; return json({ error: { type: code, message: "Router reason verbatim.", metadata } }, 403); }) as Fetch });
    const pending = method === "rules" ? c.agent.rules() : method === "check" ? c.agent.check(intent) : c.chat.completions[method]({ model: "example/model", messages: [{ role: "user", content: "hi" }] });
    const e = await pending.catch(e => e);
    expect(e).toBeInstanceOf(kind); expect(e).toBeInstanceOf(AnyRouteError);
    expect(e.message).toBe("Router reason verbatim."); expect(e.status).toBe(403); expect(e.code).toBe(code);
    expect(e.details).toEqual(metadata); expect(e.reasons).toEqual(metadata.reasons); expect(e.policy_sha256).toBe("digest");
    if (e instanceof AgentApprovalRequired) { expect(e.approval_id).toBe("approval-1"); expect(e.poll).toEqual(metadata.poll); }
    expect(calls).toBe(1);
  });
}
test("approval fields can be absent; disabled policy routes remain ordinary errors", async () => {
  expect(new AgentApprovalRequired("Approval required.").approval_id).toBeUndefined();
  const c = new AnyRoute({ baseUrl: "https://router.test", fetch: (async () => json({ error: { type: "not_found", message: "Not found." } }, 404)) as Fetch });
  const e = await c.agent.rules().catch(e => e);
  expect(e.constructor).toBe(AnyRouteError); expect(e.status).toBe(404);
});
test("replay posts the draft to the key's replay route and returns REST data unchanged", async () => {
  const draft: AgentPolicy = { ...policy, models: { deny: ["beta/*"] }, caps: { per_day_usd: 5 } };
  const result: AgentReplay = { window: { from: "2026-09-21T00:00:00.000Z", to: "2026-09-28T00:00:00.000Z", days: 7 }, evaluated: 2, allowed: 1, denied: 1, asked: 0, by_reason: { model_not_allowed: 1 }, actual: { allowed: 2, denied: 0, asked: 0, not_recorded: 0 }, changed: 1, examples: [{ time: "2026-09-22T10:00:00.000Z", kind: "call", model: "beta/model", lane: "public", action: null, cost_usd: 0.01, decision: "deny", reason: { code: "model_not_allowed", message: "The model is outside the rulebook." }, actual: "allow" }], truncated: false, notes: [] };
  const bodies: unknown[] = [];
  const f = stubFetch({ "POST /api/v1/agents/hash%2Fone/replay": ({ init }) => { expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key"); bodies.push(JSON.parse(init?.body as string)); return json({ data: result }); } });
  const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "key", fetch: f.fetch });
  expect(await c.agent.replay("hash/one", draft)).toEqual(result);
  expect(await c.agent.replay("hash/one", draft, { days: 2 })).toEqual(result);
  expect(bodies).toEqual([{ policy: draft }, { policy: draft, days: 2 }]);
});
test("replay refusals surface as errors without retries", async () => {
  let calls = 0;
  const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "key", fetch: (async () => { calls++; return json({ error: { type: "rate_limited", message: "Too many replays from this key. Try again within a minute." } }, 429); }) as Fetch });
  const e = await c.agent.replay("hash", policy).catch(e => e);
  expect(e).toBeInstanceOf(AnyRouteError); expect(e.status).toBe(429); expect(calls).toBe(1);

});
test("pay asks the rulebook and confirmPay sends the transaction hash, both with the agent's key", async () => {
  const decision = { decision: "allow", reasons: [], decision_id: "decision-1", policy_sha256: "digest", signed: { payload: {}, alg: "Ed25519", key_id: "kid", sig: "sig" }, payment: { decision_id: "decision-1", status: "awaiting_transfer", to: "0xabababababababababababababababababababab", amount_units: "20000000" } };
  const payment = { decision_id: "decision-1", status: "seen", status_text: "Seen, waiting for finality", tx_hash: "0x" + "1".repeat(64), receipt: { payload: { type: "anyroute.agent.payment.v1" }, alg: "Ed25519", key_id: "kid", sig: "sig", verify: "/api/v1/receipts/verify" } };
  const f = stubFetch({
    "POST /api/v1/agents/pay": ({ init }) => { expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key"); expect(JSON.parse(init?.body as string)).toEqual({ to: "profile-id", amount_usd: "20" }); return json({ data: decision }); },
    "POST /api/v1/agents/pay/decision%2F1/confirm": ({ init }) => { expect(JSON.parse(init?.body as string)).toEqual({ tx_hash: "0x" + "1".repeat(64) }); return json({ data: payment }); },
  });
  const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "key", fetch: f.fetch });
  expect(await c.agent.pay({ to: "profile-id", amount_usd: "20" })).toEqual(decision as never);
  expect(await c.agent.confirmPay("decision/1", "0x" + "1".repeat(64))).toEqual(payment as never);
  const refused = new AnyRoute({ baseUrl: "https://router.test", apiKey: "key", fetch: (async () => json({ error: { type: "pay_wallet_not_linked", message: "Not linked." } }, 403)) as Fetch });
  const e = await refused.agent.confirmPay("decision-1", "0x" + "1".repeat(64)).catch(e => e);
  expect(e).toBeInstanceOf(AnyRouteError); expect(e.code).toBe("pay_wallet_not_linked"); expect(e.status).toBe(403);
});

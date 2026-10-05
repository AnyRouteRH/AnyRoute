# @anyroute/client

The SDK code is in this repository; an npm release is not published yet.

Give an agent a rulebook, then have it read and check that rulebook before expensive calls. Use the calling agent's API key.

```ts
import { AnyRoute, AgentPolicyDenied, AgentKilled, AgentApprovalRequired } from "@anyroute/client";

const client = new AnyRoute({ baseUrl: routerUrl, apiKey });
const rules = await client.agent.rules();
const decision = await client.agent.check({
  kind: "inference", model: modelId, lane: "public",
  est_cost_pico: "1000000000", max_output_tokens: 32, tools: [],
});
if (decision.decision === "allow") {
  try {
    await client.chat.completions.create({
      model: modelId, messages: [{ role: "user", content: "Hello" }], max_tokens: 32,
    });
  } catch (error) {
    if (error instanceof AgentPolicyDenied || error instanceof AgentKilled ||
        error instanceof AgentApprovalRequired) {
      console.error(error.message, error.reasons);
      // Never retry the denied call unchanged.
    } else { throw error; }
  }
} else { console.error(decision.reasons); }
```

`rules()` returns own and inherited policies, stop state, and remaining rolling hour/day/week caps in USD. `check(intent)` returns the router's decision and reasons. Costs are decimal strings in pico USD (10^12 per USD). Exported types include `AgentPolicy`, `AgentIntent`, `AgentRulebook` and `AgentDecision`.

Dry runs send no prompt, record no policy event, and reserve no budget. A later call is evaluated again and may be refused. Typed refusals preserve the router's message, `reasons`, `policy_sha256`, status and complete metadata in `details`. `AgentApprovalRequired` exposes `approval_id` and `poll` when present; no automatic retries or polling occur. Chat streaming refusals use the same error types.

The operator must enable `AGENT_POLICY_ENABLED` (default false); disabled routes return 404. Switched on at anyroute.tech. Rulebook reads and checks remain available when the key is stopped. Anyroute's router reads ordinary chat text in memory; these methods do not alter that path.

Before saving a rulebook change, an owner or admin key can replay the draft on a key's recorded activity: `await client.agent.replay(keyHash, policy, { days: 7 })` returns how many calls and Agent Guard checks from those days would have been allowed, refused (`denied`) or sent to ask first (`asked`), `by_reason`, up to 20 `examples` beside what happened at the time, `stopped_at` when the draft would have stopped the key, `truncated` past 5,000, and `notes` for what the record cannot tell. Nothing is saved, charged or changed. Exported as `AgentReplay`.

### Pay another agent

Anyroute never holds the money. The agent's rulebook decides first; your own wallet then sends USDG on Robinhood Chain straight to the recipient; the router checks that transfer and signs a receipt.

```ts
const asked = await client.agent.pay({ to: profileIdOrWallet, amount_usd: "20" });
if (asked.decision === "allow" && asked.payment) {
  const txHash = await sendFromYourWallet(asked.payment.transfer_call); // your wallet signs and sends it
  const paid = await client.agent.confirmPay(asked.decision_id, txHash);
  console.log(paid.status, paid.receipt); // "seen" until final; call confirmPay again to read it later
}
```

`pay()` returns Agent Guard's decision for action `pay.agent` (allow, deny or approval_required with `approval_id` and `poll`); send `approval_id` with the same fields once approved. `confirmPay()` fails with the router's reason when the transfer is missing, short, from a wallet not linked to the account, or to another wallet. Verify `receipt` at `POST /api/v1/receipts/verify`. The operator must enable `AGENT_PAY_ENABLED` (default false), which needs `AGENT_GUARD_ENABLED`; while off the routes return 404. Not switched on at anyroute.tech yet.

These methods call `GET /api/v1/agents/me`, `POST /api/v1/agents/check`, `POST /api/v1/agents/:key_hash/replay`, `POST /api/v1/agents/pay` and `POST /api/v1/agents/pay/:decision_id/confirm`. Manage rulebooks, single-use approvals, activity, alerts and certificates on [/agents](https://anyroute.tech/agents/); see the [agent API documentation](https://anyroute.tech/docs/#agent-rulebook).

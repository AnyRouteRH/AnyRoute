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

`pay()` returns Agent Guard's decision for action `pay.agent` (allow, deny or approval_required with `approval_id` and `poll`); send `approval_id` with the same fields once approved. `confirmPay()` fails with the router's reason when the transfer is missing, short, from a wallet not linked to the account, or to another wallet. Verify `receipt` at `POST /api/v1/receipts/verify`. The operator must enable `AGENT_PAY_ENABLED` (default false), which needs `AGENT_GUARD_ENABLED`; while off the routes return 404. It is switched on at anyroute.tech.

These methods call `GET /api/v1/agents/me`, `POST /api/v1/agents/check`, `POST /api/v1/agents/:key_hash/replay`, `POST /api/v1/agents/pay` and `POST /api/v1/agents/pay/:decision_id/confirm`. Manage rulebooks, single-use approvals, activity, alerts and certificates on [/agents](https://anyroute.tech/agents/); see the [agent API documentation](https://anyroute.tech/docs/#agent-rulebook).

Playbooks share one rulebook across many keys. With a management key or a team owner/admin key, `client.playbooks` has `list()`, `get(id)`, `create({ name, policy })`, `update(id, { name, policy })`, `delete(id, { unlink: "copy" })` and `follow(keyHash, playbookId | null)`. A change applies to every key that follows the playbook from its next request; stopping following keeps the playbook's rules as the key's own. While a key follows one, `rules()` includes `playbook`. See [Playbooks](https://anyroute.tech/docs/#playbooks).

## Decision tags

Tag the model call that informs an order with the SHA-256 of that order. The router signs the hash into the call's receipt, so the order and the receipt together show which model answered before the decision; the router never sees the order. Decision tags are switched on at anyroute.tech; a router records them only when `DECISION_TAGS_ENABLED` is on (`GET /api/v1/status` reports `decision_tags.enabled`), and ignores the header while it is off.

```ts
import { AnyRoute, checkDecisionTag, decisionTag, withDecisionTag } from "@anyroute/client";

const client = new AnyRoute({ baseUrl: routerUrl, apiKey });
const order = { symbol: "STOCK_A", side: "buy", quantity: "2", limit_price: "180.00", client_order_id: "7f3c" };
const reply = await client.chat.completions.create({ model: modelId, messages }, await withDecisionTag(order));
const check = await checkDecisionTag(reply.receipt, order); // { matches, tag, expected }
// Give Agent Guard the same hash, and its decision names this call in informed_by.
const details_sha256 = await decisionTag(order);
```

`withDecisionTag(order, options?)` returns request options with the `X-Anyroute-Decision-Tag` header added; the OpenAI SDK's `create` accepts the same object as its second argument. The hash is SHA-256 of the order's canonical JSON (keys sorted, no spaces), the same bytes the Python SDK and the helpers in `integrations/robinhood-agents` hash. Write prices and quantities as strings. `checkDecisionTag` compares hashes only; `reply.anyroute.receiptVerification` checks the signature. See the [decision tag documentation](https://anyroute.tech/docs/#decision-tags).

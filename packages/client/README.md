# @anyroute/client

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

`rules()` returns own and inherited policies, kill state, and remaining rolling hour/day/week caps in USD. `check(intent)` returns the router's decision and reasons. Costs are decimal strings in pico USD (10^12 per USD). Exported types include `AgentPolicy`, `AgentIntent`, `AgentRulebook` and `AgentDecision`.

Dry runs send no prompt, record no policy event, and reserve no budget. A later call is evaluated again and may be refused. Typed refusals preserve the router's message, `reasons`, `policy_sha256`, status and complete metadata in `details`. `AgentApprovalRequired` exposes `approval_id` and `poll` when present; no automatic retries or polling occur. Chat streaming refusals use the same error types.

The operator must enable `AGENT_POLICY_ENABLED` (default false); disabled routes return 404. Rulebook reads and checks remain available when killed. AnyRoute's router reads inference text in memory; these methods do not alter that path.

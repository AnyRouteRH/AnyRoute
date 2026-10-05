# anyroute-client

The SDK code is in this repository; a PyPI release is not published yet.

Read the calling agent's own and inherited rulebook before expensive calls.

```python
from anyroute_client import (AnyRoute, AgentPolicyDenied,
    AgentKilled, AgentApprovalRequired)

with AnyRoute(router_url, api_key) as client:
    rules = client.agent.rules()
    decision = client.agent.check({
        "kind": "inference", "model": model_id, "lane": "public",
        "est_cost_pico": "1000000000", "max_output_tokens": 32, "tools": [],
    })
    if decision["decision"] == "allow":
        try:
            client.chat({"model": model_id, "messages": [
                {"role": "user", "content": "Hello"}], "max_tokens": 32})
        except (AgentPolicyDenied, AgentKilled, AgentApprovalRequired) as error:
            print(str(error), error.reasons)
            # Never retry the denied call unchanged.
    else:
        print(decision["reasons"])
```

`rules()` returns policies, kill state and remaining rolling hour/day/week caps in USD. `check(intent)` returns the router's decision and reasons. `AgentPolicy`, `AgentIntent`, `AgentRulebook` and `AgentDecision` are exported typing definitions. Costs are decimal strings in pico USD (10^12 per USD).

Dry runs send no prompt, record no policy event, and reserve no budget. A later call is evaluated again and may be refused. Typed refusals preserve the router's message, `reasons`, `policy_sha256`, status and metadata in `details`. Approval refusals expose `approval_id` and `poll` when supplied. There are no automatic retries or approval polling.

The operator must enable `AGENT_POLICY_ENABLED` (default false); disabled routes return 404. Switched on at anyroute.tech. Rulebook reads and checks remain available when killed. Anyroute's router reads ordinary chat text in memory; these methods do not alter that path.

These methods call `GET /api/v1/agents/me` and `POST /api/v1/agents/check`. Manage rulebooks, single-use approvals, activity, alerts and certificates on [/agents](https://anyroute.tech/agents/); see the [agent API documentation](https://anyroute.tech/docs/#agent-rulebook).

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

`rules()` returns policies, stop state and remaining rolling hour/day/week caps in USD. `check(intent)` returns the router's decision and reasons. `AgentPolicy`, `AgentIntent`, `AgentRulebook` and `AgentDecision` are exported typing definitions. Costs are decimal strings in pico USD (10^12 per USD).

Dry runs send no prompt, record no policy event, and reserve no budget. A later call is evaluated again and may be refused. Typed refusals preserve the router's message, `reasons`, `policy_sha256`, status and metadata in `details`. Approval refusals expose `approval_id` and `poll` when supplied. There are no automatic retries or approval polling.

The operator must enable `AGENT_POLICY_ENABLED` (default false); disabled routes return 404. Switched on at anyroute.tech. Rulebook reads and checks remain available when the key is stopped. Anyroute's router reads ordinary chat text in memory; these methods do not alter that path.

Before saving a rulebook change, an owner or admin key can replay the draft on a key's recorded activity: `client.agent.replay(key_hash, policy, days=7)` returns how many calls and Agent Guard checks from those days would have been allowed, refused (`denied`) or sent to ask first (`asked`), `by_reason`, up to 20 `examples` beside what happened at the time, `stopped_at` when the draft would have stopped the key, `truncated` past 5,000, and `notes` for what the record cannot tell. Nothing is saved, charged or changed. `AgentReplay` is the exported typing definition.

### Pay another agent

Anyroute never holds the money. The agent's rulebook decides first; your own wallet then sends USDG on Robinhood Chain straight to the recipient; the router checks that transfer and signs a receipt.

```python
asked = client.agent.pay(profile_id_or_wallet, "20")
if asked["decision"] == "allow":
    tx_hash = send_from_your_wallet(asked["payment"]["transfer_call"])  # your wallet signs and sends it
    paid = client.agent.confirm_pay(asked["decision_id"], tx_hash)
    print(paid["status"], paid["receipt"])  # "seen" until final; call confirm_pay again to read it later
```

`pay()` returns Agent Guard's decision for action `pay.agent` (allow, deny or approval_required with `approval_id` and `poll`); pass `approval_id=` with the same fields once approved. `confirm_pay()` raises with the router's reason when the transfer is missing, short, from a wallet not linked to the account, or to another wallet. Verify `receipt` at `POST /api/v1/receipts/verify`. The operator must enable `AGENT_PAY_ENABLED` (default false), which needs `AGENT_GUARD_ENABLED`; while off the routes return 404. Not switched on at anyroute.tech yet.

These methods call `GET /api/v1/agents/me`, `POST /api/v1/agents/check`, `POST /api/v1/agents/pay`, `POST /api/v1/agents/pay/{decision_id}/confirm` and `POST /api/v1/agents/{key_hash}/replay`. Manage rulebooks, single-use approvals, activity, alerts and certificates on [/agents](https://anyroute.tech/agents/); see the [agent API documentation](https://anyroute.tech/docs/#agent-rulebook).

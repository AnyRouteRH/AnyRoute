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

`pay()` returns Agent Guard's decision for action `pay.agent` (allow, deny or approval_required with `approval_id` and `poll`); pass `approval_id=` with the same fields once approved. `confirm_pay()` raises with the router's reason when the transfer is missing, short, from a wallet not linked to the account, or to another wallet. Verify `receipt` at `POST /api/v1/receipts/verify`. The operator must enable `AGENT_PAY_ENABLED` (default false), which needs `AGENT_GUARD_ENABLED`; while off the routes return 404. It is switched on at anyroute.tech.

These methods call `GET /api/v1/agents/me`, `POST /api/v1/agents/check`, `POST /api/v1/agents/pay`, `POST /api/v1/agents/pay/{decision_id}/confirm` and `POST /api/v1/agents/{key_hash}/replay`. Manage rulebooks, single-use approvals, activity, alerts and certificates on [/agents](https://anyroute.tech/agents/); see the [agent API documentation](https://anyroute.tech/docs/#agent-rulebook).

Playbooks share one rulebook across many keys. With a management key or a team owner/admin key, `client.playbooks` has `list()`, `get(id)`, `create(name, policy)`, `update(id, name=..., policy=...)`, `delete(id, unlink="copy")` and `follow(key_hash, playbook_id_or_None)`. A change applies to every key that follows the playbook from its next request; stopping following keeps the playbook's rules as the key's own. See [Playbooks](https://anyroute.tech/docs/#playbooks).

## Decision tags

Tag the model call that informs an order with the SHA-256 of that order. The router signs the hash into the call's receipt, so the order and the receipt together show which model answered before the decision; the router never sees the order. Decision tags are switched on at anyroute.tech; a router records them only when `DECISION_TAGS_ENABLED` is on (`GET /api/v1/status` reports `decision_tags.enabled`), and ignores the header while it is off.

```python
from anyroute_client import AnyRoute, check_decision_tag, decision_tag, with_decision_tag

order = {"symbol": "STOCK_A", "side": "buy", "quantity": "2", "limit_price": "180.00", "client_order_id": "7f3c"}
with AnyRoute(router_url, api_key) as client:
    reply = client.chat({"model": model_id, "messages": messages}, headers=with_decision_tag(order))
    check = check_decision_tag(reply["receipt"], order)  # {"matches", "tag", "expected"}
    # Give Agent Guard the same hash, and its decision names this call in informed_by.
    details_sha256 = decision_tag(order)
```

`with_decision_tag(order, headers=None)` returns the headers with `X-Anyroute-Decision-Tag` added; pass it to the OpenAI SDK as `extra_headers=`. The hash is SHA-256 of the order's canonical JSON (keys sorted, no spaces), the same bytes the TypeScript SDK and the helpers in `integrations/robinhood-agents` hash. Write prices and quantities as strings. `check_decision_tag` compares hashes only; `reply["anyroute"]["receipt_verification"]` checks the signature. See the [decision tag documentation](https://anyroute.tech/docs/#decision-tags).

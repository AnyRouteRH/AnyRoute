# Anyroute for trading agents

Anyroute works with any OpenAI-compatible agent, including agents you run on Robinhood. Point the agent's model endpoint at Anyroute and every model call it makes goes through one key, under a rulebook you set, with a signed receipt.

Anyroute is independent. It has no partnership with Robinhood, is not endorsed by Robinhood, and does not connect to Robinhood's systems: it only sees the model requests your agent sends to it.

## What Anyroute does not do

- It never places, changes or cancels orders.
- It never asks for, stores or uses brokerage credentials. Nothing in this folder needs them.
- The data tools below are read-only public market data.

## 1. Base URL and an inference-only key

| Setting | Value |
| --- | --- |
| Base URL | `https://anyroute.tech/api/v1` |
| API key | an inference-only Anyroute key (below) |
| Model | any id from `GET https://anyroute.tech/api/v1/models`, for example `openai/gpt-5.4` |

Use these wherever your agent setup asks for an OpenAI-compatible base URL, API key and model.

An inference-only key can call models, list models, read its own generations and receipts, and call the data tools. It cannot manage keys, read balances or change rulebooks, so a leaked agent key cannot be used to move your settings. Create one with your management key:

```sh
curl -s https://anyroute.tech/api/v1/keys \
  -H "Authorization: Bearer $ANYROUTE_MANAGEMENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "trading-agent", "scope": "inference", "limit": 10, "limit_reset": "daily"}'
```

The reply holds the key once (`key`) and its hash (`data.hash`). `limit` with `limit_reset` is a plain USD budget on the key itself, separate from the rulebook.

## 2. Import a rulebook

Three starter rulebooks for trading agents are in [`rulebooks/`](rulebooks/). Each file is the exact body for `PUT /api/v1/agents/:key_hash/policy`, and the same three appear as starters on the Agents page (`/agents/#rulebook-templates`).

| File | What it does |
| --- | --- |
| [`trading-allowlist.json`](rulebooks/trading-allowlist.json) | Only `anthropic/*`, `openai/*` and `google/*` models. Edit the list to the exact models you rely on, so the agent cannot switch to one you never checked. |
| [`trading-budget.json`](rulebooks/trading-budget.json) | Model spending stops at $5 a rolling day and $1.50 a rolling hour; a call estimated above $0.10 asks you first. |
| [`trading-ask-first.json`](rulebooks/trading-ask-first.json) | After 60 model calls in a rolling hour, each further call waits for your approval, so a looping agent pauses instead of running on. Spending stops at $3 a rolling day. |

All three leave declared tools unrestricted (your agent platform names its own tools, such as quote or order tools), allow the public and attested lanes, cap output at 4,096 tokens, and stop the agent until you resume it if it makes more than 30 calls a minute or is refused 5 times in ten minutes.

```sh
curl -s -X PUT "https://anyroute.tech/api/v1/agents/$AGENT_KEY_HASH/policy" \
  -H "Authorization: Bearer $ANYROUTE_MANAGEMENT_KEY" \
  -H "Content-Type: application/json" \
  --data @rulebooks/trading-ask-first.json
```

When a call needs approval the agent receives HTTP 403 `agent_approval_required` with `metadata.approval_id`. Approve it on `/agents` (or in Telegram once linked); the agent then retries the same call with `X-Agent-Approval: <approval_id>`. The ask-first count is `approval.above_calls_per_hour`: model calls the rulebook admitted in the rolling hour, plus calls you approved. Rulebooks only cover calls made through Anyroute and need `AGENT_POLICY_ENABLED` on the router.

## 3. Decision receipts

Every Anyroute call already returns a signed receipt (`receipt` in the reply): model, provider, cost, and the SHA-256 of the request and of the answer. A decision tag adds one more signed field: the SHA-256 of the order intent the call informed. Later you can show which model said what before a trade, from the receipt alone.

```ts
import OpenAI from "openai";
import { decisionHeaders, verifyDecisionReceipt } from "./decision-receipt.ts";

const client = new OpenAI({ baseURL: "https://anyroute.tech/api/v1", apiKey: process.env.ANYROUTE_KEY });
const intent = { symbol: "STOCK_A", side: "buy", quantity: "2", limit_price: "180.00", client_order_id: "7f3c" };
const reply = await client.chat.completions.create({ model: "openai/gpt-5.4", messages }, { headers: decisionHeaders(intent) });
const receipt = (reply as any).receipt; // store it next to the intent

const check = await verifyDecisionReceipt(receipt, intent, { baseUrl: "https://anyroute.tech" });
// check.ok: the router's signature verifies and receipt.payload.decision_tag is this intent's hash
```

```python
from decision_receipt import decision_headers, verify_decision_receipt

reply = client.chat.completions.create(model="openai/gpt-5.4", messages=messages, extra_headers=decision_headers(intent))
receipt = reply.model_extra["receipt"]
check = verify_decision_receipt(receipt, intent)  # pip install cryptography
```

- The header is `X-Anyroute-Decision-Tag: sha256:<64 hex>`. The helpers hash the intent as canonical JSON (keys sorted, no spaces). Write prices and quantities as strings so every language hashes the same bytes. Known vector: the intent above hashes to `sha256:c6a5490500b12be3787fadaa8d87982c369b158af7f5cdfdc8643b5177477c8d`.
- The router signs the tag into the v1 receipt (`payload.decision_tag`) and the v2 COSE receipt (`claims.decision_tag`). It never sees the intent, only the hash you chose.
- A malformed tag is refused with 400 before anything is charged. The unlinkable lane refuses tags, because a reused tag joins calls together.
- Receipts are anchored hourly; `GET /api/v1/receipts/:id/proof` returns the Merkle path once a receipt's hour is rooted.
- Off unless the router sets `DECISION_TAGS_ENABLED`; `GET /api/v1/status` shows `decision_tags.enabled`. While it is off the header is ignored, so check `payload.decision_tag` in the first receipt you store.

## 4. Market-data tools (per call)

Anyroute serves a few read-only data tools itself, priced per call (`DATA_TOOLS_PRICE_USD`, default $0.001):

| Request | Returns |
| --- | --- |
| `GET /api/v1/data` | free: the tools, price, symbols, index classes and how to pay |
| `GET /api/v1/data/stock/{symbol}` | price of one whole Stock Token in USD from its Chainlink feed on Robinhood Chain, with the feed's age |
| `GET /api/v1/data/stock/{symbol}/actions` | the token's `uiMultiplier` (splits and other corporate actions), a scheduled change and its effective time, and whether the token reports paused |
| `GET /api/v1/data/ipx/{class}` | the inference price index for a model class |

- With an Anyroute key (inference-only keys included) the price comes out of the key's balance. A rulebook sees the call as the tool `data_tool`: a rulebook with a `tools.allow` list must include it.
- Without a key the call answers 402 with an x402 `exact` offer for that exact resource (USDG on Robinhood Chain), once the router has per-call payment configured. Check `per_call.x402.configured` in `GET /api/v1/status` before relying on it.
- A stale feed (older than 84 hours, the limit the router already uses for Stock Token prices), a paused token, an unknown symbol or an index with no fills is refused before any payment is asked for. Nothing is charged for a refusal.
- Chainlink's Stock Token feeds already include the token's multiplier. The price is served as the feed gives it and the multiplier is never applied twice; it is reported beside the price for reference.
- Off unless the router sets `DATA_TOOLS_ENABLED`; `GET /api/v1/status` shows `data_tools`.

## Status

Nothing in this folder is published or submitted anywhere. Inference-only keys and agent rulebooks follow the router's own switches; decision tags and data tools are new and off by default. Check `GET /api/v1/status` for what a router has switched on.

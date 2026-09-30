# llama-index-llms-anyroute

Anyroute for [LlamaIndex](https://www.llamaindex.ai). 350+ models behind one key, a signed receipt on every call, and attested and unlinkable lanes. Built on LlamaIndex's own `OpenAILike`, so chat, completion, streaming, async and tool calling work as usual.

## Install

Not on PyPI yet. Install from this repo:

```sh
pip install -e sdks/llamaindex-python      # or: uv pip install -e sdks/llamaindex-python
export ANYROUTE_API_KEY=sk-ar-v1-...
```

## Use

```python
from llama_index.core.llms import ChatMessage
from llama_index.llms.anyroute import Anyroute, receipt_of

llm = Anyroute(model="meta-llama/llama-3.3-70b-instruct")
resp = llm.chat([ChatMessage(role="user", content="Say hello in five words.")])
print(resp.message.content)
print(receipt_of(resp))
# {"receipt_id": "gen-...", "lane": "public", "disclosure": "...", "receipt": {"id", "sig", "key_id", "alg", "payload", "v2", ...}}

from llama_index.core import Settings
Settings.llm = llm    # use it everywhere in LlamaIndex
```

Any id from `GET /api/v1/models` works as the model, including the `:nitro`, `:floor` and `:free` variants and presets (`@preset/<name>`).

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `api_key` | `ANYROUTE_API_KEY` | Your Anyroute key. Construction fails with a clear message when neither is set. |
| `api_base` | `ANYROUTE_BASE_URL`, then `https://api-production-70da.up.railway.app/api/v1` | Router URL including `/api/v1`. |
| `lane` | none (public) | `"public"`, `"attested"` or `"unlinkable"`. |
| `disclosure` | none (any) | Disclosure ceiling: `"any"`, `"policy"` or `"none"`. |
| `provider` | none | Routing preferences for the body: `only`, `order`, `allow_fallbacks`, and `lane` / `disclosure`. |
| `context_window` | `131072` | Set it to the model's real window for better prompt packing. |

`is_chat_model=True` and `is_function_calling_model=True` are the defaults. Everything else (`temperature`, `max_tokens`, `http_client`, `additional_kwargs`, ...) is passed to `OpenAILike` unchanged.

## Lanes

```python
attested = Anyroute(model="meta-llama/llama-3.3-70b-instruct", lane="attested", disclosure="policy")
```

- `public`: any provider.
- `attested`: only providers whose enclave the router has verified. If none can answer, the router refuses the call, sends nothing and charges nothing.
- `unlinkable`: served only through an independent relay or the onion service and paid with a blind token, not a key. A normal API key call on this lane is refused.

The lane is sent twice: as the `X-Anyroute-Lane` header (`default_headers`) and as `provider.lane` in the body (`additional_kwargs["extra_body"]`); the disclosure ceiling likewise as `X-Anyroute-Disclosure-Max` and `provider.disclosure`. The router applies the stricter of the two, and when `lane`, `provider` and an existing `extra_body` disagree this package also keeps the stricter value, so a merge never loosens what you asked for.

## The receipt

The raw OpenAI-shaped response lands in `ChatResponse.raw`, and the router's `receipt` field rides along in it. This package copies it to `ChatResponse.additional_kwargs["anyroute"]`:

- `receipt_id`: the id of the signed receipt.
- `lane`: the lane the router used (from the signed claims).
- `disclosure`: how much the provider could learn: `attested`, `policy` or `vendor-forwarded`.
- `receipt`: the full signed receipt.

`receipt_of(response)` returns that dict or `None`, and also works on a `CompletionResponse` from `complete()`. When streaming, the router sends the receipt as the last event, so read it from the last response: `receipt_of(responses[-1])`. Check a receipt later with `GET /api/v1/receipts/<id>`.

Streaming note: the router's receipt event has no `choices`, which the stock OpenAI stream reader in LlamaIndex cannot handle. `Anyroute` wraps the OpenAI client so that event reaches you as an empty chunk carrying the receipt.

## Test

```sh
cd sdks/llamaindex-python
uv venv && uv pip install -e '.[test]'
.venv/bin/pytest -q   # offline: an httpx MockTransport plays the router
```

License: Apache-2.0.

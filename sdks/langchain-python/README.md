# langchain-anyroute

Anyroute for [LangChain](https://python.langchain.com). 350+ models behind one key, a signed receipt on every call, and attested and unlinkable lanes. Built on LangChain's own `ChatOpenAI` and `OpenAIEmbeddings`, so chat, streaming, async, tools, structured output and embeddings work as usual.

## Install

Not on PyPI yet. Install from this repo:

```sh
pip install -e sdks/langchain-python      # or: uv pip install -e sdks/langchain-python
export ANYROUTE_API_KEY=sk-ar-v1-...
export ANYROUTE_BASE_URL=https://anyroute.tech/api/v1
```

## Use

```python
from langchain_anyroute import ChatAnyroute, AnyrouteEmbeddings

llm = ChatAnyroute(model="meta-llama/llama-3.3-70b-instruct")
msg = llm.invoke("Say hello in five words.")
print(msg.content)
print(msg.response_metadata["anyroute"])
# {"receipt_id": "gen-...", "lane": "public", "disclosure": "...", "receipt": {"id", "sig", "key_id", "alg", "payload", ...}}

embeddings = AnyrouteEmbeddings(model="qwen/qwen3-embedding-8b")
vector = embeddings.embed_query("hello")
```

Any id from `GET /api/v1/models` works as the model, including the `:nitro`, `:floor` and `:free` variants and presets (`@preset/<name>`).

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `api_key` | `ANYROUTE_API_KEY` | Your Anyroute key. Construction fails with a clear message when neither is set. |
| `base_url` | `ANYROUTE_BASE_URL`, then the built-in router URL | Router URL including `/api/v1`; set it to `https://anyroute.tech/api/v1`. |
| `lane` | none (public) | `"public"`, `"attested"` or `"unlinkable"`. |
| `disclosure` | none (any) | Disclosure ceiling: `"any"`, `"policy"` or `"none"`. |
| `provider` | none | Routing preferences for the body: `only`, `order`, `allow_fallbacks`, and `lane` / `disclosure`. |
| `include_response_headers` | off | Also keep every response header in `response_metadata["headers"]`. |

Everything else (`temperature`, `max_tokens`, `http_client`, `extra_body`, ...) is passed to `ChatOpenAI` / `OpenAIEmbeddings` unchanged. `AnyrouteEmbeddings` turns off the local tokenizer (`check_embedding_ctx_length=False`), since it only knows one vendor's models.

## Lanes

```python
attested = ChatAnyroute(model="meta-llama/llama-3.3-70b-instruct", lane="attested", disclosure="policy")
```

- `public`: any provider.
- `attested`: only providers whose enclave the router has verified. If none can answer, the router refuses the call, sends nothing and charges nothing.
- `unlinkable`: served only through an independent relay or the onion service and paid with a blind token, not a key. A normal API key call on this lane is refused.

The lane is sent twice: as the `X-Anyroute-Lane` header and as `provider.lane` in the chat body (through `extra_body`; the disclosure ceiling as `X-Anyroute-Disclosure-Max` and `provider.disclosure`). The router applies the stricter of the two, and when `lane`, `provider` and `extra_body` disagree this package also keeps the stricter value, so a merge never loosens what you asked for. Embeddings send the headers only.

## The receipt

Every chat response carries `response_metadata["anyroute"]`:

- `receipt_id`: the id of the signed receipt (from the `x-receipt-id` header or the body).
- `lane`: the lane the router actually used (`x-anyroute-lane`).
- `disclosure`: how much the provider could learn: `attested`, `policy` or `vendor-forwarded` (`x-anyroute-disclosure`).
- `receipt`: the full Ed25519-signed receipt from the response body.

`receipt_of(message)` returns the same dict or `None`. It is also in `llm_output["anyroute"]` of `generate()`. With `stream()` / `astream()` the receipt arrives as the last event, so it is on the final chunk and on the summed message. Check a receipt later with `GET /api/v1/receipts/<id>`.

How it works: `ChatAnyroute` always asks the OpenAI client for the raw response headers, lifts `receipt` out of the raw response body in `_create_chat_result`, and picks the receipt event out of the stream. The raw headers are dropped from the metadata again unless you passed `include_response_headers=True`.

## Test

```sh
cd sdks/langchain-python
uv venv && uv pip install -e '.[test]'
.venv/bin/pytest -q   # offline: an httpx MockTransport plays the router
```

License: Apache-2.0.

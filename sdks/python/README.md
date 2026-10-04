# anyroute (Python SDK)

The official Python SDK for Anyroute, an OpenRouter compatible AI router. Every answer comes with a signed receipt you
can check yourself, and you choose how private each request is with lanes.

- Sync (`Anyroute`) and async (`AsyncAnyroute`) clients on `httpx`
- Chat (plain and streamed), embeddings, rerank, batches at half price, presets, models
- Receipt verification that runs on your machine: v1 (Ed25519 over canonical JSON), v2 (COSE_Sign1) and the streamed
  chunk hash chain
- Lanes (`public`, `attested`, `unlinkable`) and disclosure ceilings as one keyword argument
- Typed errors with `retry_after` taken from the `Retry-After` header

Python 3.10 or newer. Two dependencies: `httpx` and `cryptography`.

## Install

The package is not on PyPI yet. Install it from a checkout of this repository:

```bash
pip install -e sdks/python
# or
uv pip install -e sdks/python
```

## Quickstart

```python
from anyroute import Anyroute

client = Anyroute(base_url="https://anyroute.tech")  # reads ANYROUTE_API_KEY

reply = client.chat.completions.create(
    model="meta-llama/llama-3.3-70b-instruct",
    messages=[{"role": "user", "content": "Explain Merkle trees in one sentence."}],
    temperature=0.3,
)
print(reply.content)

meta = reply.anyroute
print(meta.generation_id, meta.lane, meta.disclosure, meta.policy_hash)

check = client.receipts.verify(reply.receipt)
print("receipt valid:", check.valid)
```

A response is a plain `dict` holding the JSON the router sent, so `reply["choices"][0]["message"]["content"]` works as
well as `reply.content`. Top level keys are also attributes (`reply.usage`, `reply.model`). `reply.anyroute` holds what
the router adds: `generation_id`, `receipt_id`, `lane`, `disclosure`, `policy_hash` and the `receipt` itself.

Constructor options:

| Option | Default | Meaning |
| --- | --- | --- |
| `api_key` | `$ANYROUTE_API_KEY` | Sent as `Authorization: Bearer ...` |
| `base_url` | `$ANYROUTE_BASE_URL`, else the built-in router URL | Set `base_url="https://anyroute.tech"`; a trailing `/api/v1` is fine |
| `lane`, `disclosure` | none | Applied to every request (see Lanes) |
| `timeout` | 120 seconds | Any `httpx` timeout value |
| `http_client` | a new `httpx.Client` | Bring your own client (proxies, custom transports, tests) |
| `default_headers` | none | Extra headers on every request |

Both clients are context managers (`with Anyroute() as client:` and `async with AsyncAnyroute() as client:`).

## Streaming, with chain verification

While streaming, the router sends a running SHA-256 chain value after every event and signs the final value in the v2
receipt. If anything cuts, reorders or edits the stream on the way to you, the chain no longer matches.

```python
with client.chat.completions.stream(
    model="meta-llama/llama-3.3-70b-instruct",
    messages=[{"role": "user", "content": "Write a haiku about routers."}],
) as stream:
    for chunk in stream:
        delta = chunk["choices"][0]["delta"].get("content") or ""
        print(delta, end="", flush=True)

print()
print(stream.text)                 # the whole answer
chain = stream.verify_chain()      # every per-event value and the signed head
print("chain ok:", chain.ok)

result = stream.verify()           # receipt signatures (v1 and v2) plus the chain, in one call
print("receipt and stream valid:", result.valid)
```

`create(..., stream=True)` returns the same stream object. The receipt event is not yielded as a chunk; read it from
`stream.receipt` after the loop. `stream.chunks` holds the exact data text of every event, which is what the chain
covers.

Async works the same way:

```python
import asyncio
from anyroute import AsyncAnyroute

async def main() -> None:
    async with AsyncAnyroute() as client:
        stream = await client.chat.completions.stream(model="meta-llama/llama-3.3-70b-instruct", messages=[{"role": "user", "content": "Hi"}])
        async for chunk in stream:
            pass
        print(stream.text, stream.verify_chain().ok)

asyncio.run(main())
```

## Embeddings

```python
out = client.embeddings.create(model="qwen/qwen3-embedding-8b", input=["first text", "second text"])
print(len(out.vectors), len(out.vectors[0]))
```

## Rerank

Find the rerank models first, then score documents against a query. Results come back sorted by relevance.

```python
rerankers = client.models.list(output_modalities="rerank")
ranked = client.rerank.create(
    model=rerankers[0]["id"],
    query="How do I rotate an API key?",
    documents=["Billing FAQ", "Rotating keys: open Settings, then Keys", "Release notes"],
    top_n=2,
    return_documents=True,
)
for r in ranked.results:
    print(r["index"], round(r["relevance_score"], 3))
```

Model variants work anywhere a model id does: `:nitro` (throughput first), `:floor` (price first), `:free` and
`:private` (an attested endpoint).

## Batches (50% off)

Send many chat or embedding requests at once; they run within 24 hours at half the list price. Requests go inline:
there is no files endpoint.

```python
batch = client.batches.create(
    [
        {"custom_id": "q1", "body": {"model": "meta-llama/llama-3.3-70b-instruct", "messages": [{"role": "user", "content": "2+2?"}]}},
        {"custom_id": "q2", "body": {"model": "meta-llama/llama-3.3-70b-instruct", "messages": [{"role": "user", "content": "3+3?"}]}},
    ],
    metadata={"job": "nightly-eval"},
)

done = client.batches.wait(batch.id, poll_interval=10, timeout=3600)   # raises TimeoutError after an hour
results = client.batches.results(batch.id)
for custom_id, body in results.bodies().items():
    print(custom_id, body["choices"][0]["message"]["content"])
for failed in results.errors:
    print(failed["custom_id"], failed["error"]["message"])
```

`method` defaults to `POST` and `url` to `/v1/chat/completions` (or the `endpoint` you pass). You can also send
`input_jsonl="..."` instead of `requests`. Also available: `retrieve`, `list(limit=, after=)`, `cancel`, `output` and
`errors` (both return parsed JSONL lines).

## Presets

A preset is a named, versioned routing config. Call it as the model: `@preset/<name>` (latest) or
`@preset/<name>@<version>`.

```python
client.presets.put(
    "support",
    models=["meta-llama/llama-3.3-70b-instruct"],
    system_prompt="Answer in two sentences.",
    provider={"lane": "attested"},
)
reply = client.chat.completions.create(model="@preset/support", messages=[{"role": "user", "content": "Where is my order?"}])

client.presets.list()
client.presets.get("support", version=1)
client.presets.versions("support")
client.presets.diff("support", from_=1, to=2)
client.presets.rollback("support", 1)
client.presets.delete("support")
```

`upsert` is an alias of `put`. A `put` that changes nothing returns `changed: False` and keeps the version.

## Models and lanes

| Lane | What it means |
| --- | --- |
| `public` | Any endpoint that serves the model |
| `attested` | Only endpoints running in attested hardware |
| `unlinkable` | Attested, and the request cannot be linked to your account |

A disclosure ceiling caps what the serving endpoint may reveal: `any`, `policy` or `none`.

```python
from anyroute import LANES

private_models = client.models.list(lane="attested")
for m in private_models:
    print(m["id"], m.lanes, m.supports_lane("unlinkable"))

# per call
reply = client.chat.completions.create(model="meta-llama/llama-3.3-70b-instruct", messages=[{"role": "user", "content": "Hi"}], lane="attested", disclosure="policy")

# for a whole client (a copy that shares the connection pool)
private = client.with_lane("unlinkable", disclosure="none")
```

The lane goes out as the `X-Anyroute-Lane` header and as `provider.lane` in the body (the disclosure as
`X-Anyroute-Disclosure-Max` and `provider.disclosure`). The router applies the stricter value, and the SDK does the
same when it merges: a stricter value already in your `provider` object is never loosened, and a per call value can
only tighten the client's default.

## Receipts

Every generation is signed. A receipt carries two independent signatures by the same Ed25519 key:

- v1: Ed25519 over the canonical JSON of `payload`, plus an anchor leaf `keccak256(keccak256(canonical || sig))`
- v2: a COSE_Sign1 (CBOR tag 18) over a CBOR claim set; for streams the claims include the chain head

```python
result = client.receipts.verify(reply.receipt)   # fetches and caches the published keys
print(result.valid, result.key_id)
for check in result.checks:
    print(check.id, check.status, check.detail)

result.raise_if_invalid()                         # raises ReceiptInvalid
```

`verify` picks v1, v2 or both from what the receipt carries, and is valid only if every part present verifies. Keys
come from `/.well-known/anyroute-receipt-keys.json` and are cached for an hour; a receipt naming an unknown key
triggers one refetch. To pin a key instead, pass `public_key_hex=`.

Stored receipts and inclusion proofs (roots are built hourly):

```python
stored = client.receipts.get(meta.receipt_id)
proof = client.receipts.proof(meta.receipt_id)
print(client.receipts.verify(stored, proof=proof).valid)

client.receipts.verify_id(meta.receipt_id)        # the same, in one call
```

The pure functions need no client and no network:

```python
from anyroute.receipts import verify_receipt_v1, verify_receipt_v2, check_chain, chunk_chain, verify_merkle_proof

keys = client.receipts.keys()
verify_receipt_v1(reply.receipt, keys)
verify_receipt_v2(reply.receipt["v2"]["cose"], keys, chunks=stream.chunks, proof=proof)
verify_receipt_v1(reply.receipt, "d75a9801...")   # or a pinned public key as hex
```

`not_checked` in a report means nothing was compared (for example, no proof yet); it is never a pass.

## Errors

```python
import time
from anyroute import AnyrouteError, RateLimitError, AuthenticationError

try:
    client.chat.completions.create(model="meta-llama/llama-3.3-70b-instruct", messages=[{"role": "user", "content": "Hi"}])
except RateLimitError as e:
    time.sleep(e.retry_after or 1)
except AuthenticationError:
    raise SystemExit("check ANYROUTE_API_KEY")
except AnyrouteError as e:
    print(e.status, e.type, e.message, e.metadata)
```

| Class | When |
| --- | --- |
| `BadRequestError` | 400, 422 |
| `AuthenticationError` | 401, 403 |
| `NotFoundError` | 404 |
| `RateLimitError` | 429 |
| `APIError` | any other HTTP error |
| `APIConnectionError`, `APITimeoutError` | no HTTP response at all |
| `ReceiptInvalid` | a receipt failed verification (`e.result` has the report) |

All of them subclass `AnyrouteError`, which carries `status`, `type` (a stable machine reason such as
`rate_limited` or `model_not_found`), `message`, `metadata` and `retry_after` (seconds as a float, read from
`Retry-After` whether it holds seconds or an HTTP date).

## Running the tests

The tests run fully offline against a fake router built on `httpx.MockTransport`.

```bash
cd sdks/python
uv venv && uv pip install -e '.[test]'
uv run pytest -q
```

Or with the standard library tools:

```bash
cd sdks/python
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[test]'
pytest -q
```

## License

Apache-2.0

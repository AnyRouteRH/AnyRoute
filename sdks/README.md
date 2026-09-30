# SDKs

Official Anyroute SDKs and framework packages. Every one of them speaks the same router API (the OpenAI-compatible one, plus lanes, receipts, batches, presets and rerank), and every one surfaces the signed receipt of each call. **Nothing here is published to a registry yet**: install from source as each README shows.

| Folder | Package | Language | What it covers | Install from source | Tests (offline) |
| --- | --- | --- | --- | --- | --- |
| [`typescript/`](typescript/) | `@anyroute/sdk` | TypeScript (ESM + CJS) | chat, streaming with chunk chain, embeddings, rerank, batches, presets, models with lanes, receipts v1 + v2, errors with Retry-After | `npm install ./sdks/typescript` | `bun test` against a local fake router |
| [`python/`](python/) | `anyroute` | Python 3.10+ (sync + async, httpx) | same surface; receipts v1 (Ed25519) and v2 (COSE) via `cryptography` | `pip install -e sdks/python` | `pytest` with `httpx.MockTransport` |
| [`go/`](go/) | `anyroute-go` | Go 1.22+ (net/http) | chat, streaming, embeddings, rerank, batches, models, receipt verify (ed25519, COSE) | `go get` with a local `replace` | `go test ./...` with `httptest` |
| [`langchain-js/`](langchain-js/) | `@anyroute/langchain` | TypeScript | `ChatAnyroute` and `AnyrouteEmbeddings` over `@langchain/openai`; receipt in `response_metadata` | `npm install ./sdks/langchain-js` | `bun test` with a fake fetch |
| [`langchain-python/`](langchain-python/) | `langchain-anyroute` | Python | `ChatAnyroute` and `AnyrouteEmbeddings` over `langchain-openai`; receipt in `response_metadata` | `pip install -e sdks/langchain-python` | `pytest` with `httpx.MockTransport` |
| [`llamaindex-python/`](llamaindex-python/) | `llama-index-llms-anyroute` | Python | `Anyroute` LLM over `OpenAILike`; `receipt_of(response)` | `pip install -e sdks/llamaindex-python` | `pytest` with `httpx.MockTransport` |

The TypeScript SDK is a façade over [`packages/client`](../packages/client) (`@anyroute/client`), which holds the receipt, attestation and blind-token cryptography; its build bundles that package in. The Python and Go SDKs implement the same checks natively and are tested against the same receipt v2 test vector (`packages/client/test/fixtures/receipt-v2.json`, signed with the public RFC 8032 test key).

## The same ideas in every SDK

- **Base URL and key**: `ANYROUTE_BASE_URL` (default: the public router) and `ANYROUTE_API_KEY`.
- **Lanes**: `public`, `attested` (only providers whose enclave the router verified; refused rather than downgraded) and `unlinkable` (only through an Oblivious HTTP relay with a blind token). Sent as `X-Anyroute-Lane` and `provider.lane`; a lane option never loosens a stricter lane already in the request. The lane that served a call comes back in `X-Anyroute-Lane`.
- **Receipts**: every call returns a signed receipt. v1 is an Ed25519 signature over the canonical JSON payload; v2 is a COSE_Sign1 (EdDSA) over a CBOR claim set. A streamed answer carries an `: anyroute-chain <i> <hex>` comment after each event, and the v2 receipt signs the chain head, so a cut or altered stream is detectable. Keys: `/.well-known/anyroute-receipt-keys.json`.
- **Errors**: the router's `{ error: { code, message, type, metadata } }` becomes a typed error with the status, the machine-readable `type` and `Retry-After` in seconds.

## Run every suite

```sh
bash sdks/check.sh                     # typescript python go langchain-js langchain-python llamaindex-python
bash sdks/check.sh typescript go       # a subset
```

Needs bun, uv (Python 3.10+) and Go 1.22+. The router's own CI does not run these yet; each suite is self-contained and offline, so adding `bash sdks/check.sh` as a CI step is enough.

License: Apache-2.0 for every package here.

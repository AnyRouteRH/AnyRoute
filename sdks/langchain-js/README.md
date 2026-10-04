# @anyroute/langchain

Anyroute for [LangChain.js](https://js.langchain.com). 350+ models behind one key, a signed receipt on every call, and attested and unlinkable lanes. Built on LangChain's own `@langchain/openai` classes, so chat, streaming, tools, structured output and embeddings work as with `ChatOpenAI` and `OpenAIEmbeddings`.

## Install

Not on npm yet. Install from this repo:

```sh
bun add ./sdks/langchain-js @langchain/core     # or: npm install ./sdks/langchain-js @langchain/core
export ANYROUTE_API_KEY=sk-ar-v1-...
export ANYROUTE_BASE_URL=https://anyroute.tech/api/v1
```

## Use

```ts
import { ChatAnyroute, AnyrouteEmbeddings } from "@anyroute/langchain";

const llm = new ChatAnyroute({ model: "meta-llama/llama-3.3-70b-instruct" });
const msg = await llm.invoke("Say hello in five words.");
console.log(msg.content);
console.log(msg.response_metadata.anyroute);
// { receipt_id: "gen-...", lane: "public", disclosure: "...", receipt: { id, sig, key_id, alg, payload, ... } }

const embeddings = new AnyrouteEmbeddings({ model: "qwen/qwen3-embedding-8b" });
const vector = await embeddings.embedQuery("hello");
```

Any id from `GET /api/v1/models` works as the model, including the `:nitro`, `:floor` and `:free` variants and presets (`@preset/<name>`).

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `apiKey` | `ANYROUTE_API_KEY` | Your Anyroute key. Construction fails with a clear message when neither is set. |
| `baseURL` | `ANYROUTE_BASE_URL`, then the built-in router URL | Router URL including `/api/v1`; set it to `https://anyroute.tech/api/v1`. |
| `lane` | none (public) | `"public"`, `"attested"` or `"unlinkable"`. |
| `disclosure` | none (any) | Disclosure ceiling: `"any"`, `"policy"` or `"none"`. |
| `provider` | none | Routing preferences for the body: `only`, `order`, `allow_fallbacks`, and `lane` / `disclosure`. |

Everything else (`temperature`, `maxTokens`, `streaming`, `configuration`, ...) is passed to `ChatOpenAI` / `OpenAIEmbeddings` unchanged.

## Lanes

```ts
const attested = new ChatAnyroute({ model: "meta-llama/llama-3.3-70b-instruct", lane: "attested", disclosure: "policy" });
```

- `public`: any provider.
- `attested`: only providers whose enclave the router has verified. If none can answer, the router refuses the call, sends nothing and charges nothing.
- `unlinkable`: served only through an independent relay or the onion service and paid with a blind token, not a key. A normal API key call on this lane is refused.

The lane is sent twice: as the `X-Anyroute-Lane` header and as `provider.lane` in the chat body (the disclosure ceiling as `X-Anyroute-Disclosure-Max` and `provider.disclosure`). The router applies the stricter of the two, and when `lane` and `provider.lane` differ this package also keeps the stricter one, so a merge never loosens what you asked for. Embeddings send the headers only.

## The receipt

Every chat response carries `response_metadata.anyroute`:

- `receipt_id`: the id of the signed receipt (from the `x-receipt-id` header or the body).
- `lane`: the lane the router actually used (`x-anyroute-lane`).
- `disclosure`: how much the provider could learn: `attested`, `policy` or `vendor-forwarded` (`x-anyroute-disclosure`).
- `receipt`: the full Ed25519-signed receipt from the response body.

`receiptOf(message)` returns the same object or `undefined`. With `.stream()` the receipt arrives as the last event of the stream, so it is on the final chunk and on the concatenated message. Check a receipt later with `GET /api/v1/receipts/<id>`.

How it works: the OpenAI client inside `ChatOpenAI` gets a small `fetch` wrapper that reads the receipt headers and the `receipt` field of each response. `AsyncLocalStorage` keeps one store per call, so concurrent calls never mix receipts. Your own `configuration.fetch` still runs underneath it.

Not covered yet: the new `streamEvents()` protocol (it streams, but without `anyroute` metadata).

## Develop

```sh
cd sdks/langchain-js
bun install
bun test             # offline: a fake fetch plays the router
bun run typecheck    # tsc --noEmit
bun run build        # emits dist/
```

License: Apache-2.0.

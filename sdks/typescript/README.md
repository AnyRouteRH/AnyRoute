# @anyroute/sdk

The official TypeScript SDK for Anyroute. One typed client for chat (plain and streamed), embeddings, rerank, batches at half price, presets, models with their lanes, and receipts you can check offline: the v1 Ed25519 signature, the v2 COSE_Sign1 receipt and the hash chain over a streamed answer.

It is a thin layer over [`@anyroute/client`](../../packages/client), which keeps every piece of cryptography (receipt checks, attestation, blind tokens, the transparency log). The build bundles that package in, so `@anyroute/sdk` has no runtime dependencies. ESM and CommonJS builds, with type declarations.

## Install (from source until it is published)

```sh
cd sdks/typescript
bun install          # dev tools only: typescript, @types/bun
bun run build        # dist/index.js (ESM), dist/index.cjs (CJS), dist/types/
# in your app:
npm install /path/to/AnyRoute/sdks/typescript
```

```sh
export ANYROUTE_API_KEY=sk-ar-v1-...
# optional, defaults to the public router
export ANYROUTE_BASE_URL=https://anyroute.tech
```

## Chat

```ts
import { Anyroute } from "@anyroute/sdk";

const ar = new Anyroute(); // reads ANYROUTE_API_KEY and ANYROUTE_BASE_URL

const r = await ar.chat.completions.create({
  model: "meta-llama/llama-3.3-70b-instruct",
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log(r.choices?.[0]);
console.log(r.anyroute.receipt?.id);                   // the signed receipt for this call
console.log(r.anyroute.receiptVerification?.valid);    // v1 Ed25519, checked against the published keys
console.log(r.anyroute.receiptV2Verification?.valid);  // v2 COSE_Sign1, when the router signed one
```

### Streaming, with the chunk chain

```ts
const stream = await ar.chat.completions.stream({ model: "example/model", messages });
for await (const chunk of stream) process.stdout.write((chunk as any).choices?.[0]?.delta?.content ?? "");

const meta = await stream.meta();          // receipt (sent as the last event) and its verification
const chain = await stream.verifyChain();  // { ok, head, signedHead, firstMismatch }
```

Every streamed event is followed by an `: anyroute-chain <i> <hex>` comment. `verifyChain()` recomputes the SHA-256 chain over the events you received and compares it with each value and with the head signed in the v2 receipt. A cut, dropped or altered event fails, and `firstMismatch` says which one.

## Lanes

| Lane | What it means |
| --- | --- |
| `public` | any provider that serves the model |
| `attested` | only providers whose enclave the router verified; refused rather than downgraded |
| `unlinkable` | only through an Oblivious HTTP relay with a blind token |

```ts
const attested = new Anyroute({ lane: "attested" });           // every request
await ar.chat.completions.create(body, { lane: "attested" });  // one request
const strict = ar.withLane("attested", "none");                // a copy with a lane and a disclosure ceiling

const models = await ar.models.list({ lane: "attested" });     // only models servable on that lane now
```

The lane is sent as `X-Anyroute-Lane` and merged into `provider.lane`. A lane option never loosens a stricter one already in the body. The lane that served the call is on `r.anyroute.lane`.

For verify-before-send against a specific provider, pass `attested: { providerId, attestUrl }` to `chat.completions.create` (see `@anyroute/client`).

## Embeddings and rerank

```ts
const e = await ar.embeddings.create({ model: "qwen/qwen3-embedding-8b", input: ["a", "b"] });
const rr = await ar.rerank.create({ model: "example/rerank", query: "cats", documents: ["dogs", "cats are great"], top_n: 1 });
rr.results[0]; // { index: 1, relevance_score: ... }
e.anyroute.receiptId; rr.anyroute.lane;
```

## Batches (50% off)

```ts
const batch = await ar.batches.create({
  requests: [
    { custom_id: "q1", method: "POST", url: "/v1/chat/completions", body: { model: "example/model", messages } },
  ],
});
const { ok, failed, byCustomId } = await ar.batches.results(batch.id, { pollIntervalMs: 10_000 });
```

Also `retrieve`, `list`, `cancel`, `output`, `errors` and `wait`.

## Presets

```ts
await ar.presets.put("support-bot", { models: ["example/model"], system_prompt: "Be brief." });
await ar.chat.completions.create({ model: ar.presets.model("support-bot"), messages });
await ar.presets.versions("support-bot");
await ar.presets.diff("support-bot", 1, 2);
await ar.presets.rollback("support-bot", 1);
```

## Receipts

```ts
const receipt = await ar.receipts.get("gen-...");       // v1 envelope with v2 beside it
const check = await ar.receipts.verify(receipt);       // { valid, v1, v2 }, each with a list of checks
const full = await ar.receipts.fetchAndVerify("gen-..."); // also checks the Merkle proof once rooted
```

Offline primitives are exported too: `verifyReceipt`, `verifyReceiptV2`, `decodeReceiptV2`, `checkChain`, `chunkChain`, `verifyMerkleProof`, `receiptLeafV2`.

## Errors and retries

A non-2xx answer throws `AnyrouteAPIError` (or `RateLimitError`, `AuthenticationError`, `NotFoundError`, `BadRequestError`) with `status`, `type` (the router's reason, such as `rate_limited` or `model_not_found`), `details` and `retryAfter` in seconds from `Retry-After`. Requests are retried on 408, 409, 429 and 5xx up to `maxRetries` (default 2), waiting for `Retry-After` when the router sends it.

## Develop

```sh
cd sdks/typescript
bun install
bun run typecheck
bun test             # offline: a local fake router on a random port
bun run build
```

License: Apache-2.0.

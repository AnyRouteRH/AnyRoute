# anyroute-go

The official Go SDK for the Anyroute router: an OpenRouter-compatible AI router that signs a receipt for every
response, routes by privacy lane, and runs batches at half price.

- Standard library only. No third-party modules.
- Go 1.22 or newer.
- Every call takes a `context.Context`.
- Receipts (v1 Ed25519 over canonical JSON, v2 COSE_Sign1) verify offline.

## Install

The module is not published to a tagged release yet. Once it is:

```sh
go get github.com/AnyRouteRH/AnyRoute/sdks/go
```

Until then, use it from a checkout of this repository with a `replace` directive in your own `go.mod`:

```
require github.com/AnyRouteRH/AnyRoute/sdks/go v0.0.0

replace github.com/AnyRouteRH/AnyRoute/sdks/go => /path/to/AnyRoute/sdks/go
```

Import it as:

```go
import anyroute "github.com/AnyRouteRH/AnyRoute/sdks/go"
```

## Quick start

```go
c := anyroute.NewClient(anyroute.WithBaseURL("https://anyroute.tech")) // reads ANYROUTE_API_KEY

res, err := c.Chat(ctx, anyroute.ChatRequest{
	Model:    "meta-llama/llama-3.3-70b-instruct",
	Messages: []anyroute.Message{anyroute.UserMessage("Say hello")},
})
if err != nil {
	log.Fatal(err)
}
fmt.Println(res.Text())
fmt.Println(res.Meta.GenerationID, res.Meta.Lane, res.Meta.Disclosure)
```

Client options:

| Option | Default |
| --- | --- |
| `WithAPIKey(key)` | `ANYROUTE_API_KEY` |
| `WithBaseURL(url)` | `ANYROUTE_BASE_URL`, then the built-in router URL; set `WithBaseURL("https://anyroute.tech")` |
| `WithHTTPClient(*http.Client)` | `http.DefaultClient` |
| `WithLane(lane)` | none |
| `WithDisclosure(ceiling)` | none |
| `WithHeader(key, value)` | none |
| `WithReceiptKeys(*KeySet)` | fetched on first use |

Fields the request structs do not name go in `Extra`, which is merged into the JSON body as it is.

## Streaming and chain verification

The router follows every streamed event with a comment `: anyroute-chain <i> <hex>`, a running SHA-256 over the
events, and sends the signed receipt as the last event. `VerifyChain` recomputes the chain and compares every step
and the head signed in the receipt, so a cut, reordered or altered stream fails.

```go
s, err := c.ChatStream(ctx, anyroute.ChatRequest{
	Model:    "meta-llama/llama-3.3-70b-instruct",
	Messages: []anyroute.Message{anyroute.UserMessage("Count to five")},
})
if err != nil {
	log.Fatal(err)
}
defer s.Close()
for s.Next() {
	ch := s.Chunk()
	if len(ch.Choices) > 0 {
		fmt.Print(ch.Choices[0].Delta.Content)
	}
}
if err := s.Err(); err != nil {
	log.Fatal(err)
}

chain := s.VerifyChain()
fmt.Println("chain ok:", chain.OK, chain.Head)

// Check the v2 receipt and the chain head it signs in one step.
keys, _ := c.ReceiptKeys(ctx, false)
v := anyroute.VerifyReceiptV2(s.Receipt().V2.COSE, anyroute.VerifyV2Options{Keys: keys, Chunks: s.Chunks()})
fmt.Println("receipt valid:", v.Valid)
```

## Lanes and disclosure

Lanes are `public`, `attested` and `unlinkable`. The disclosure ceiling is `any`, `policy` or `none`. Set a default on
the client, or override per call:

```go
c := anyroute.NewClient(anyroute.WithLane(anyroute.LaneAttested))

res, err := c.Chat(ctx, req,
	anyroute.WithRequestLane(anyroute.LaneAttested),
	anyroute.WithRequestDisclosure(anyroute.DisclosureNone),
)
```

The SDK sends `X-Anyroute-Lane` and `X-Anyroute-Disclosure-Max` and merges the same values into `provider.lane` and
`provider.disclosure` in the body. A stricter value already in the body is kept: an option never loosens a request.
The router applies the stricter of header and body too. `CreateBatch` merges the lane into every request body.

List the models a lane can serve:

```go
models, err := c.Models(ctx, anyroute.ModelsQuery{Lane: anyroute.LaneAttested})
for _, m := range models {
	fmt.Println(m.ID, m.SupportsLane(anyroute.LaneAttested), m.RoutingVariants)
}
rerankers, err := c.Models(ctx, anyroute.ModelsQuery{OutputModalities: []string{"rerank"}})
```

Model suffixes work as the model id: `:nitro` (fastest first), `:floor` (cheapest first), `:free` and `:private`
(attested endpoint). Presets are `@preset/<name>`.

## Embeddings and rerank

```go
emb, err := c.Embeddings(ctx, anyroute.EmbeddingsRequest{Model: "qwen/qwen3-embedding-8b", Input: []string{"a", "b"}})
fmt.Println(len(emb.Data[0].Embedding))

rr, err := c.Rerank(ctx, anyroute.RerankRequest{
	Model:     "example/rerank",
	Query:     "capital of France",
	Documents: []any{"Berlin is in Germany", anyroute.RerankDocument{Text: "Paris is in France"}},
})
fmt.Println(rr.Results[0].Index, rr.Results[0].RelevanceScore)
```

## Batches

OpenAI-compatible batches at 50% off. There is no files endpoint: requests go inline.

```go
b, err := c.CreateBatch(ctx, anyroute.CreateBatchRequest{Requests: []anyroute.BatchRequestItem{
	{CustomID: "q1", Method: "POST", URL: "/v1/chat/completions", Body: anyroute.ChatRequest{
		Model: "meta-llama/llama-3.3-70b-instruct", Messages: []anyroute.Message{anyroute.UserMessage("2+2?")},
	}},
}})

wctx, cancel := context.WithTimeout(ctx, time.Hour)
defer cancel()
b, err = c.WaitBatch(wctx, b.ID, 10*time.Second)

lines, err := c.BatchOutput(ctx, b.ID) // successful lines
failed, err := c.BatchErrors(ctx, b.ID) // failed, cancelled and expired lines
for _, l := range lines {
	r, _ := l.ChatResponse()
	fmt.Println(l.CustomID, r.Text())
}
```

`GetBatch`, `ListBatches` and `CancelBatch` cover the rest.

## Receipts

Every response carries `Receipt`. Verify it against the router's published keys, or against a key you pin:

```go
v, err := c.VerifyReceipt(ctx, res.Receipt) // fetches and caches the key set, checks v1 and v2
fmt.Println(v.Valid)

for _, check := range v.Checks {
	fmt.Println(check.ID, check.Status, check.Detail)
}
```

Offline, with no client:

```go
v1 := anyroute.VerifyReceiptV1(receipt, anyroute.VerifyOptions{Keys: keys})         // or PublicKeyHex / PublicKey
v2 := anyroute.VerifyReceiptV2(receipt.V2.COSE, anyroute.VerifyV2Options{Keys: keys}) // base64 string or raw []byte
```

What each check means:

- `key`: the key id is the first 16 hex characters of sha256(public key), and the key is one you trust.
- `signature`: v1 is Ed25519 over the canonical JSON of the payload; v2 is Ed25519 over the COSE Sig_structure.
- `key_window`: the receipt is dated inside its key's validity window (v1).
- `leaf`: `keccak256(keccak256(canonical || sig))` for v1, `keccak256(keccak256(cose))` for v2.
- `chain`: the streamed events hash to the head the v2 receipt signs (pass `Chunks`).
- `anchor_proof`: the leaf is under a Merkle root (sorted-pair keccak256). Fetch the proof with `ReceiptProof`.

A `not_checked` status is never a pass; it means the step did not run.

`GetReceipt(ctx, id)` fetches a stored receipt, `ReceiptProof(ctx, id)` its anchor proof, and `ReceiptKeys(ctx,
refresh)` the key set at `/.well-known/anyroute-receipt-keys.json`. Lower level helpers: `CanonicalJSON`, `KeyID`,
`Keccak256`, `ReceiptLeafV1`, `ReceiptLeafV2`, `DecodeReceiptV2`, `SigStructure`, `ChunkChain`, `CheckChain` and
`VerifyMerkleProof`.

Canonical JSON matches the router byte for byte: keys sorted recursively (integer keys first, as in any JavaScript
object), no whitespace, and numbers and strings written as JavaScript's `JSON.stringify` writes them. Keep a receipt
payload as the raw JSON you received (the `Payload` field is a `json.RawMessage`) so nothing is lost before checking.

## Errors

A non-2xx answer is an `*anyroute.APIError`:

```go
_, err := c.Chat(ctx, req)
var e *anyroute.APIError
if errors.As(err, &e) {
	fmt.Println(e.StatusCode, e.Type, e.Message, e.Metadata)
}
if anyroute.IsRateLimited(err) {
	d, _ := anyroute.RetryAfter(err) // parsed from Retry-After, seconds or an HTTP date
	time.Sleep(d)
}
```

`Type` is the stable machine reason, for example `rate_limited`, `model_not_found`, `invalid_request` or
`preset_not_found`. The SDK does not retry on its own.

## Running the tests

The tests run fully offline against an `httptest` server and shared cross-language fixtures in `testdata/`
(canonical JSON vectors and a synthetic v2 receipt signed with the RFC 8032 test key).

```sh
cd sdks/go
go vet ./...
go test ./...
```

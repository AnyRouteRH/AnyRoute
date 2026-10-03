# SEAL 0004: Receipts and verification

| | |
| :--- | :--- |
| Status | Draft |
| Version | 0.1.0 |
| Updated | 2026-09-29 |
| License | Apache-2.0 |
| Related | [0001](0001-attestation.md), [0002](0002-transport.md), [0003](0003-credits.md), [0005](0005-policy.md) |

## Status of this document

This is a working draft of the SEAL protocol. It is not an IETF document. Sections marked **(implemented)** describe formats that exist in this repository and are frozen under their version string. Sections marked **(planned)** describe the target design and may change before 1.0.0.

## Abstract

Every response served under SEAL carries a receipt: a signed statement of which attested node answered, with which weights and policy, over which exact request and response bytes. Receipts name no payer, address or content. Receipt digests are collected into Merkle trees whose roots are anchored on chain, so a receipt can be shown to have existed at a time without trusting the server that issued it. This document defines the receipt claims, their two encodings, the hash chain over streamed chunks, anchoring, and the order in which a verifier checks everything from the hardware quote to the receipt.

## 1. Conventions and terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

* **Receipt**: a signed claim set about one request and its response.
* **Node receipt**: signed inside the enclave by the key its attestation binds. **Router receipt**: signed by the router's own rotating key.
* **Leaf**: the digest of a signed receipt that goes into an anchor tree.
* **Anchor**: an on-chain record of a Merkle root over leaves for a time window.
* **Canonical JSON** is as defined in [0001](0001-attestation.md) Section 1 (equivalent to JCS [RFC8785] for JSON values).
* `keccak256` is Keccak-256 as used by Ethereum (not FIPS 202 SHA3-256). `||` is byte concatenation.

## 2. Claims

Whatever the encoding, a receipt makes these claims. The table shows where each one lives in each encoding.

| Claim | Node receipt v1 (implemented) | Router receipt v1 (implemented) | Router receipt v2 (implemented) | Node receipt v2 (planned) |
| :--- | :--- | :--- | :--- | :--- |
| Receipt id | `id` | `id` | `rid` | `rid` |
| Time | `ts` (ms) | `issued` (RFC 3339) | `iat` (s) | `iat` (s) |
| Node identity | `attestation_ref` | `attestation` (provider's attestation hash) | `node.provider`, `node.quote_ref` | `node.kid`, `node.quote_ref` |
| Weights | `model_digest` | `model` (catalog id) | `model.id` | `model.weights`, `model.tokenizer` |
| Request bytes | `req_hash` | `request_sha256` | `req.h` | `req.h` |
| Response bytes | `resp_hash` | `response_sha256` | `resp.h`, `resp.chain` (streams) | `resp.h`, `resp.chain` |
| Policy | `classifier` (one bit) | `disclosure`, `lane` | `disclosure`, `lane`, `node.policy_hash` and `policy` when known | `policy.enforced`, `policy.blocked`, `node.policy_hash` |
| Execution profile | | | | `node.exec_profile_id`, `req.seed`, `req.temp` |
| Usage | `usage` (exact) | `tokens`, `cost` | `req.n_in_bucket`, `resp.n_out_bucket`, `credit.cost_units` | same |
| Payment | `nullifier` (reserved, empty) | `payer` or, for a blind token, `nullifier` and `token_key_id` | `credit.mode`, `credit.keyset` (blind token key) | `credit.keyset` only |

## 3. Receipt v1 (implemented)

### 3.1 Signature and envelope

The signer computes the canonical JSON of the payload and signs those bytes with Ed25519 [RFC8032]. The envelope is:

```json
{ "payload": { }, "sig": "<base64>", "key_id": "<16 hex>", "alg": "Ed25519", "leaf": "0x<64 hex>" }
```

```
leaf = keccak256(keccak256(canonical_json(payload) || signature))
```

The leaf is double-hashed so it cannot be confused with an inner node of the anchor tree. Node and router receipts use the same scheme and the same leaf.

### 3.2 Node receipt payload

```json
{
  "v": 1, "type": "anyroute.sidecar.receipt", "id": "rcpt_<24 hex>", "ts": 1700000000000,
  "path": "/v1/chat/completions", "status": 200, "stream": false, "complete": true,
  "req_hash": "sha256:<hex>", "resp_hash": "sha256:<hex>",
  "model_digest": "sha256:<hex>", "attestation_ref": "<64 hex>", "nullifier": "",
  "usage": { "prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7 },
  "dev": false,
  "classifier": { "enabled": true, "digest": "sha256:<hex>", "blocked": false },
  "e2ee": "anyroute-hpke-v1"
}
```

The key is the enclave's `bindings.receipt_pubkey` ([0001](0001-attestation.md) Section 3.1). `classifier` is present only when the classifier runs and `e2ee` only for an encrypted exchange.

* `req_hash` and `resp_hash` cover the exact bytes exchanged. For an encrypted exchange they cover the ciphertext on the wire, which the client can recompute; for a stream, `resp_hash` covers everything before the final frame, which carries the receipt.
* `complete: false` means the stream ended without its terminator, errored, stalled or was abandoned by the client. Such receipts are still signed.
* A classifier refusal carries a receipt with `status: 400` and `classifier.blocked: true` ([0005](0005-policy.md)). Model-server errors are passed through without a receipt.

**Delivery.** For JSON responses, the envelope is in the `x-anyroute-receipt` header (base64url JSON) and its id in `x-anyroute-receipt-id`. For event streams, the id is in `x-anyroute-receipt-id` from the start and, after the final `data: [DONE]`, one more event `event: anyroute.receipt` carries the envelope. `GET /v1/receipts/{id}` returns it later to the key that earned it.

### 3.3 Router receipt payload

The router signs its own receipt for every generation it settles. It carries `v`, `id`, `issued`, `router`, `model`, `provider`, `tokens`, `cost` and its breakdown, `latency_ms`, `quant`, `mode`, `attestation`, `disclosure`, `lane`, `payer`, `payment_tx`, `request_sha256`, `response_sha256` and, when the provider is an attested gateway, `upstream_attestation`. When the request was paid with a blind token, `payer` is null and the receipt carries the token's `nullifier` and `token_key_id` instead ([0003](0003-credits.md)). Where the router records decision tags (`DECISION_TAGS_ENABLED`), a call sent with `X-Anyroute-Decision-Tag: sha256:<hex>` also carries `decision_tag`, that caller-computed digest (for example of an order intent), in v1 and as the v2 claim `decision_tag`; a call without the header carries neither.

Router keys rotate weekly by default. Every public key ever used stays published at `GET /.well-known/anyroute-receipt-keys.json` and, where the router runs with a configured chain, is registered in `ReceiptAnchor` (`registerSigningKey(bytes8 keyId, bytes32 ed25519PublicKey, uint64 validFrom)`); keys are never overwritten there. `key_id` is the first 8 bytes of SHA-256 of the raw public key, in hex. `POST /api/v1/receipts/verify` checks a receipt, `GET /api/v1/receipts/{id}` returns one (its v2 encoding beside the v1 fields, Section 4.4), and `GET /api/v1/receipts/{id}/proof` returns its Merkle path once its hour is rooted (Section 5.1).

## 4. Receipt v2

Router receipts v2 are **(implemented)**: every chat and completion call the router settles gets a v2 receipt next to its v1 receipt, signed with the same key. Node receipts v2, signed inside the enclave, are **(planned)**; Section 4.5 lists what differs.

### 4.1 Encoding (implemented)

A v2 receipt is a `COSE_Sign1` structure [RFC9052], tagged (CBOR tag 18), whose payload is a claim set in the style of the Entity Attestation Token [RFC9711]:

* **Protected header**: the map `{1: -8, 4: kid}`, that is `alg` EdDSA [RFC8032] and `kid` the router key id's 8 bytes (the same `key_id` as v1, as a byte string). The unprotected header is an empty map.
* **Payload**: the claim map in deterministic CBOR [RFC8949] Section 4.2.1: shortest-form integers, definite lengths, map keys sorted by their encoded bytes. Keys are text strings equal to the JSON member names below. Values are text, integers, booleans and maps only; there are no floats and no nulls (an unknown member is omitted).
* **Signature**: Ed25519 over `Sig_structure = ["Signature1", protected, h'', payload]` in CBOR, with the router's receipt key.

A verifier decodes the payload to get the JSON view; the server also returns that view as `claims`, and it MUST equal the decoded payload. The JSON view of a router v2 receipt is:

```json
{
  "v": 2, "rid": "gen-1790000000-...", "iat": 1790000000, "iss": "https://<router>",
  "model":  { "id": "<catalog id>" },
  "node":   { "provider": "<provider id>", "quote_ref": "sha256:<attestation hash>", "policy_hash": "sha256:..." },
  "req":    { "h": "sha256:...", "n_in_bucket": "512-1024" },
  "resp":   { "h": "sha256:...", "chain": "sha256:...", "n_out_bucket": "128-256", "finish": "stop", "stream": true, "complete": true },
  "lane": "public", "disclosure": "vendor-forwarded",
  "policy": { "enforced": true, "blocked": false },
  "credit": { "mode": "prepaid", "cost_units": 812, "keyset": "<blind token key id>" }
}
```

* `req.h` is `"sha256:" || hex(SHA-256(canonical JSON of the request body without stream and stream_options))`, the same digest as v1 `request_sha256`.
* `resp.h` is `"sha256:" || hex(SHA-256(UTF-8 output text))`, the output text being the concatenated `content` of the choices; the same digest as v1 `response_sha256`, recomputable from a stream or a whole response.
* `n_in_bucket` and `n_out_bucket` are power-of-two buckets of the prompt and completion token counts: `"0"`, else `"lo-hi"` with `lo = 2^floor(log2 n)` and `hi = 2 lo` (lower bound inclusive). The exact counts stay in the account's own view (`GET /api/v1/generation?id=`).
* `credit.cost_units` is the amount charged in millionths of a US dollar, rounded up; `credit.mode` is how it was paid (`prepaid`, `per_call`, `paywith`, `byok`, `blind`); `credit.keyset` is present only for a blind token.
* `node.quote_ref` is present only for an attested provider; `node.policy_hash` and `policy` only when the serving endpoint's fresh, verified attestation bound a classifier policy. `policy.blocked` is true when the call finished with `content_filter`.
* `resp.chain` is present only for a streamed response (Section 4.2). `resp.complete` is false when the stream was cancelled by the client or ended in a provider error.
* A v2 receipt MUST NOT contain a payer, an address, an IP or content. Member names beyond those in Section 2 are provisional until 1.0.0.

A byte-exact test vector (the RFC 8032 Section 7.1 test 1 key, fixed claims, the streamed events and every `c_i`) is in [`packages/client/test/fixtures/receipt-v2.json`](../packages/client/test/fixtures/receipt-v2.json); Ed25519 is deterministic, so an implementation MUST reproduce the `cose` bytes exactly.

### 4.2 Chunk hash chain (implemented for router streams)

For a streamed response the signer commits to every event as it is sent:

```
c_0 = SHA-256(UTF-8(rid))
c_i = SHA-256(c_{i-1} || UTF-8(chunk_i))         for i = 1..n
resp.chain = "sha256:" || hex(c_n)
```

`chunk_i` is the data of the i-th server-sent event: the value of its `data` lines joined with LF, before any encryption. Every event before the one that carries the receipt is chained, including an error event; comments and the final `data: [DONE]` are not. Right after the i-th event the router sends one comment line in its own block:

```
data: {"id":"gen-1790000000-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}

: anyroute-chain 1 90011613b9e8d06ed2164476b7910a8907453981f9baed026ddbaf86e6abf01d

```

SSE parsers discard comment lines, so OpenAI-compatible clients are unaffected, and clients that split on blank lines and read only blocks that start with `data:` keep working (an `id` field inside the event block would break those). A client that checks the chain MUST recompute it, MUST compare each `c_i` it receives, and MUST check that `resp.chain` in the receipt equals the last value. A head that does not match proves the stream was cut or altered; a mismatch first seen at `i` locates the change at the i-th event. Only events the router actually enqueued are chained, so a stream the client abandons still has a correct head for what was sent. The chain covers the OpenAI-compatible stream (`/api/v1/chat/completions` and `/api/v1/completions`); the Anthropic Messages endpoint re-encodes those events into its own format, so a client of that endpoint gets the v2 receipt but cannot check the chain against what it received.

### 4.3 Anchor leaf (implemented)

```
leaf_v2 = keccak256(keccak256(COSE_Sign1 bytes))
```

The v2 leaf goes into the same hourly tree as the v1 leaf (Section 5.1).

### 4.4 Delivery (implemented)

The inline receipt (`receipt` in a JSON response and in the final stream event) carries `v2`: `{ alg: "EdDSA", kid, content_type, cose (base64), claims, leaf }`. `GET /api/v1/receipts/{id}` returns the v1 fields unchanged plus `version: 2` and the same `v2` object with its anchor path. `?format=cose` returns the COSE bytes as `application/cose; cose-type="cose-sign1"` (`&encoding=base64` for base64 text). Receipts issued before v2, cache hits and embeddings keep v1 only (`version: 1`, `v2: null`).

### 4.5 Node receipts v2 (planned)

A node signs inside the enclave with ES256K (`-47`, secp256k1 with SHA-256 [RFC8812]); its `kid` is `"sha256:" || hex(SHA-256(receipt public key))` and that key is bound in the enclave's `report_data` ([0001](0001-attestation.md) Section 3.4). Node claims add `node.kid`, `node.exec_profile_id`, `model.weights`, `model.tokenizer`, `req.seed`, `req.temp`, `cnf.sig_alg` and a `nullifier`: `SHA-256(req.h || resp.h || node_epoch_secret)`, unique per exchange, so a receipt cannot be settled twice, and meaningless without the node's epoch secret. The chunk chain is the same as Section 4.2.

## 5. Anchoring

### 5.1 Router receipts (implemented)

Every hour the router builds a Merkle tree over the leaves of all receipts issued since the last root. Leaves are in receipt order, and a receipt with a v2 encoding contributes its v1 leaf and then its v2 leaf, so v1 proofs keep working and both encodings sit under one root; `count` is the number of leaves. Where the router runs with a configured chain it then calls `ReceiptAnchor.anchor(root, fromTs, toTs, count)`. Windows are half-open, non-overlapping and time-ordered. The tree is compatible with OpenZeppelin `MerkleProof`: pairs are hashed with keccak256 in sorted order, and an odd node is promoted to the next level. `verify(leaf, proof, index)` checks inclusion on chain and returns false, never reverting, for an unknown index. A root recorded without a configured chain has status `local`: it is kept off chain and can be posted later; the proofs do not change.

`GET /api/v1/receipts/{id}/proof` returns `rooted: false` until the receipt's hour has a root, then `{ rooted: true, leaf, leaf_version, root, anchor_index, leaf_index, proof, window, status, tx, anchored }` for the v2 leaf (`?v=1` for the v1 leaf). `anchored` is true only when the root was posted on chain and confirmed; for a `local` root it is false, and a verifier MUST NOT treat such a root as anchored.

Inclusion proves that a leaf was in a window's tree. It does not prove the leaf's timestamp or that it is unique.

### 5.2 Node receipts (implemented, off by default)

The sidecar offers its leaves in batches (`GET /anchor/leaves?after=&limit=`, `POST /anchor/ack`, off unless an anchor token is set). Where the router runs with `HOST_ANCHOR_ENABLED`, it collects them once an interval (an hour by default) from every provider whose sidecar certificate it has verified and pinned ([0001](0001-attestation.md) Section 3.2), over that pinned connection and with the host's anchor token:

1. It reads the host's boot evidence and takes `bindings.receipt_pubkey` only if SHA-256 of the served quote is the attestation reference it verified and the quote's `report_data` commits to those bindings.
2. It keeps a leaf only if the receipt's signature verifies under that key, `key_id` names that key, `attestation_ref` is that reference, `dev` is false and the leaf recomputes from the signed bytes (Section 3.1). Other leaves are discarded and counted.
3. It builds one tree per host, attestation reference and interval over the kept leaves, in the order the sidecar queued them, with the tree rules of Section 5.1, and then acknowledges everything it pulled. A leaf already rooted is not rooted again.
4. Where the router runs with a configured chain it calls `ReceiptAnchor.anchorAttested(keccak256(provider id), root, attestation reference)`. Attested anchors are a separate append-only list, and `verifyAttested(leaf, proof, index)` checks inclusion on chain. A root recorded without a configured chain has status `local`, as in Section 5.1.

A root's window is the half-open interval in which the router collected its leaves, from the end of the host's previous root to the moment the root was built. `GET /api/v1/host-anchors/proof/{leaf}`, or `POST /api/v1/host-anchors/proof` with the receipt or its leaf, returns `{ rid, leaf, rooted, anchored, status, provider, provider_id_hash, attestation_ref, receipt_key, root, leaf_index, proof, window, anchor_index, tx, block }`. `anchored` is true only once the root was posted on chain and confirmed, and `anchor_index` is then its index among the attested anchors; for a `local` root it is false, and a verifier MUST NOT treat such a root as anchored. `packages/client` checks a node receipt against this proof (`verifyHostAnchor`): the signature, the path to the root and, with a reader for `attestedAnchors`, the root, provider and attestation reference on chain. `GET /v1/receipts/{rid}/proof` on the node itself is planned.

## 6. Verification order

A verifier MUST implement these checks in this order and MUST stop at the first failure. Steps that depend on planned parts apply once those parts exist; Section 6.1 says what a verifier can check today.

1. **Quote.** The quote chains to an Intel root the verifier pins (never one fetched from the attester), with fresh collateral; `tee_type` is `0x81` (TDX); the debug bit of `TDATTRIBUTES` is 0; the TCB status is acceptable under the pinned policy's grace windows ([0001](0001-attestation.md) Section 8).
2. **Boot registers.** MRTD and RTMR0 to RTMR2 equal the manifest's values for the declared OS image, vCPU count and memory size.
3. **Runtime events.** Replaying the RTMR3 event log reproduces RTMR3. It contains exactly one `compose-hash`, one `policy-hash` and one `exec-profile-hash`, one `gpu-attestation` before `system-ready` naming at least one device, and the expected `key-provider`.
4. **Compose.** The compose hash is registered in `MeasurementRegistry` or on the verifier's allow-list, and every image in it is pinned by `@sha256` digest.
5. **Key binding.** `report_data` recomputes over the verifier's nonce, the key SPKIs and the GPU evidence hash; the live TLS handshake (or a signature) proves possession of the bound key.
6. **GPU evidence.** The GPU attestation token reports `measres = success`, `secboot = true`, `dbgstat = disabled`, `cc_mode = on`, `devtools = false`, the verifier's nonce, a certificate chain not revoked by OCSP, and driver and VBIOS reference measurements on the allow-list.
7. **Manifest.** The manifest's DSSE signature verifies, its inclusion in Rekor and in the Anyroute log verifies, the checkpoint carries the required witness cosignatures, and a checkpoint fetched over a second path is consistent with it.
8. **KMS chain.** The signature chain from the KMS root to the node's keys verifies against the KMS root public key registered on chain.
9. **Platform.** A host whose only CPU evidence is AMD SEV-SNP is refused for any confidential-GPU claim.
10. **Receipt.** The receipt's signature verifies under the key bound in step 5; for a stream, the chain head equals the last streamed `c_n`; if the verifier asked for it, the anchor proof verifies on chain.

### 6.1 What a verifier can check today

With version 1 evidence and receipts a verifier can perform step 1 (through a DCAP verifier of its choice), a partial step 4 (`MeasurementRegistry` records image, compose and model digests), step 5 with the version 1 binding ([0001](0001-attestation.md) Section 3.1), a partial step 7 (Rekor inclusion of the measurement bundle), and step 10 with Ed25519 signatures and, for router receipts, anchor proofs. `packages/client` (TypeScript) and `packages/client-py` (Python) implement the version 1 checks except the quote signature, which they delegate to a verifier the caller supplies. The sidecar's `doctor` command runs the same checks against a live endpoint.

For router receipts v2, step 10 runs in this order: COSE signature under the key named by `kid` (from the published key set or a key the verifier pins), then `req.h` and `resp.h` against what the client holds, then the chain head against the streamed events, then the Merkle path to the root and, if the verifier asks, that root on chain. `packages/client` implements it (`verifyReceiptV2`, `checkChain`, and `ChatStream.verifyChain()` over a live stream), as do the web verify page, `POST /api/v1/receipts/verify` with `cose`, and `bun packages/client/bin/verify-receipt.ts <id>`. `packages/client-py` checks v1 only.

## 7. Security considerations

* **What a receipt proves.** A valid node receipt proves that a process holding a key bound by a verified quote signed these hashes. It does not prove the model computed the output; that rests on the attestation and, where planned, deterministic re-execution.
* **Leakage.** v1 node receipts carry exact token counts; v2 buckets them. v1 router receipts carry the payer's key hash for key-paid requests; blind-token requests carry only a nullifier; v2 carries neither. No receipt carries an address or content. `credit.cost_units` together with a model's public prices can narrow a token count inside its bucket, so v2 bucketing hides less for expensive models. The router keeps serving v1 beside v2 for compatibility, so for now the public lookup by id still returns the v1 fields.
* **Key compromise.** Router keys are registered on chain where a chain is configured and never overwritten there, so a stolen key cannot rewrite history, but it can sign new false receipts until revoked. Node keys live only in enclave memory and change at every restart.
* **Anchor trust.** An anchor proves inclusion in a window's tree, as posted by the anchorer. Receipts issued but withheld from the tree are not covered; clients that care SHOULD request the proof for their own receipts. A `local` root is only the router's own statement until it is posted on chain.
* **Truncation.** With the chain (v2), a cut or altered stream fails the head check even when the receipt is fetched later by id. Without it (v1), a client detects a cut stream through `complete: false`, the missing receipt event, or, for encrypted streams, the missing final frame ([0002](0002-transport.md) Section 3.1). The chain covers the router's stream; it does not prove the upstream's own stream to the router was complete.

## 8. References

### Normative

* [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119.
* [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174.
* [RFC8032] Josefsson, S., Liusvaara, I., "Edwards-Curve Digital Signature Algorithm (EdDSA)", RFC 8032.
* [RFC8785] Rundgren, A., Jordan, B., Erdtman, S., "JSON Canonicalization Scheme (JCS)", RFC 8785.
* [RFC9052] Schaad, J., "CBOR Object Signing and Encryption (COSE): Structures and Process", RFC 9052.
* [RFC8949] Bormann, C., Hoffman, P., "Concise Binary Object Representation (CBOR)", RFC 8949.
* [RFC8812] Jones, M., "CBOR Object Signing and Encryption (COSE) and JSON Object Signing and Encryption (JOSE) Registrations for Web Authentication (WebAuthn) Algorithms", RFC 8812.

### Informative

* [RFC9711] Lundblade, L., et al., "The Entity Attestation Token (EAT)", RFC 9711.
* [RFC3339] Klyne, G., Newman, C., "Date and Time on the Internet: Timestamps", RFC 3339.
* [RFC9162] Laurie, B., et al., "Certificate Transparency Version 2.0", RFC 9162.
* [TLOG-TILES] C2SP, "tlog-tiles", https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md.
* WHATWG, "HTML Living Standard: Server-sent events", https://html.spec.whatwg.org/multipage/server-sent-events.html.
* OpenZeppelin, "MerkleProof", https://docs.openzeppelin.com/contracts/5.x/api/utils#MerkleProof.

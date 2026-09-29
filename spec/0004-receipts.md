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

| Claim | Node receipt v1 (implemented) | Router receipt v1 (implemented) | Receipt v2 (planned) |
| :--- | :--- | :--- | :--- |
| Receipt id | `id` | `id` | `rid` |
| Time | `ts` (ms) | `issued` (RFC 3339) | `iat` (s) |
| Node identity | `attestation_ref` | `attestation` (provider's attestation hash) | `node.kid`, `node.quote_ref` |
| Weights | `model_digest` | `model` (catalog id) | `model.weights`, `model.tokenizer` |
| Request bytes | `req_hash` | `request_sha256` | `req.h` |
| Response bytes | `resp_hash` | `response_sha256` | `resp.h`, `resp.chain` |
| Policy | `classifier` (one bit) | `disclosure`, `lane` | `policy.enforced`, `policy.blocked`, `node.policy_hash` |
| Execution profile | | | `node.exec_profile_id`, `req.seed`, `req.temp` |
| Usage | `usage` (exact) | `tokens`, `cost` | `n_in_bucket`, `n_out_bucket`, `credit.cost_units` |
| Payment | `nullifier` (reserved, empty) | `payer` or, for a blind token, `nullifier` and `token_key_id` | `credit.keyset` only |

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

The router signs its own receipt for every generation it settles. It carries `v`, `id`, `issued`, `router`, `model`, `provider`, `tokens`, `cost` and its breakdown, `latency_ms`, `quant`, `mode`, `attestation`, `disclosure`, `lane`, `payer`, `payment_tx`, `request_sha256`, `response_sha256` and, when the provider is an attested gateway, `upstream_attestation`. When the request was paid with a blind token, `payer` is null and the receipt carries the token's `nullifier` and `token_key_id` instead ([0003](0003-credits.md)).

Router keys rotate weekly by default. Every public key ever used stays published at `GET /.well-known/anyroute-receipt-keys.json` and is registered on chain in `ReceiptAnchor` (`registerSigningKey(bytes8 keyId, bytes32 ed25519PublicKey, uint64 validFrom)`); keys are never overwritten there. `key_id` is the first 8 bytes of SHA-256 of the raw public key, in hex. `POST /api/v1/receipts/verify` checks a receipt, and `GET /api/v1/receipts/{id}` returns one with its Merkle proof once anchored.

## 4. Receipt v2 (planned)

### 4.1 Encoding

A v2 receipt is a `COSE_Sign1` structure [RFC9052] whose payload is a claim set in the style of the Entity Attestation Token [RFC9711]. The algorithm is ES256K (`-47`, secp256k1 with SHA-256 [RFC8812]); the protected header carries `alg` and `kid`, where `kid` is `"sha256:" || hex(SHA-256(receipt public key))` and that key is bound in the enclave's `report_data` ([0001](0001-attestation.md) Section 3.4). The JSON view of the claims is:

```json
{
  "v": 1, "rid": "rcpt_...", "iat": 1790000000,
  "node":   { "kid": "sha256:...", "quote_ref": "sha256:<attestation bundle>",
              "policy_hash": "sha256:...", "exec_profile_id": "sha256:..." },
  "model":  { "id": "<catalog id>", "weights": "sha256:...", "tokenizer": "sha256:..." },
  "req":    { "h": "sha256:...", "seed": 42, "temp": 0.7, "n_in_bucket": "512-1024" },
  "resp":   { "h": "sha256:...", "chain": "sha256:...", "n_out_bucket": "128-256", "finish": "stop" },
  "policy": { "enforced": true, "blocked": false },
  "credit": { "cost_units": 812, "keyset": "..." },
  "nullifier": "sha256:...",
  "cnf": { "sig_alg": "ES256K" }
}
```

Member names inside `node`, `model` and `resp` beyond those shown in Section 2 are provisional until 1.0.0.

* Token counts are bucketed, not exact, to reduce what a receipt leaks.
* `nullifier` is `SHA-256(req.h || resp.h || node_epoch_secret)`: unique per exchange, so a receipt cannot be settled twice, and meaningless without the node's epoch secret.
* A v2 receipt MUST NOT contain a payer, an address or content.

### 4.2 Chunk hash chain

For a streamed response the node commits to every chunk as it is sent:

```
c_0 = SHA-256(UTF-8(rid))
c_i = SHA-256(c_{i-1} || chunk_i)         for i = 1..n
resp.chain = "sha256:" || hex(c_n)
```

`chunk_i` is the data of the i-th server-sent event: the value of its `data` lines joined with LF, as UTF-8, before any encryption. The node sends `c_i` in lowercase hex as the event's `id` field, which OpenAI-compatible clients ignore. A client MUST recompute the chain, MUST check each `id` it receives, and MUST check that `resp.chain` in the receipt equals the last value. A chain that stops early proves truncation; a mismatch at `i` proves the i-th chunk was altered.

## 5. Anchoring

### 5.1 Router receipts (implemented)

Every hour the router builds a Merkle tree over the leaves of all receipts issued since the last anchor and calls `ReceiptAnchor.anchor(root, fromTs, toTs, count)` on chain. Windows are half-open, non-overlapping and time-ordered. The tree is compatible with OpenZeppelin `MerkleProof`: pairs are hashed with keccak256 in sorted order, and an odd node is promoted to the next level. `verify(leaf, proof, index)` checks inclusion on chain and returns false, never reverting, for an unknown index. An anchor recorded without a configured chain has status `local` and can be posted later; the proofs do not change.

Inclusion proves that a leaf was in a window's tree. It does not prove the leaf's timestamp or that it is unique.

### 5.2 Node receipts (planned)

The sidecar already offers its leaves in batches (`GET /anchor/leaves`, `POST /anchor/ack`, off unless an anchor token is set), and `ReceiptAnchor.anchorAttested(providerId, root, attestationRef)` exists on chain. The service that collects each host's leaves hourly and anchors one root per host, and `GET /v1/receipts/{rid}/proof` on the node, are planned.

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

## 7. Security considerations

* **What a receipt proves.** A valid node receipt proves that a process holding a key bound by a verified quote signed these hashes. It does not prove the model computed the output; that rests on the attestation and, where planned, deterministic re-execution.
* **Leakage.** v1 node receipts carry exact token counts; v2 buckets them. v1 router receipts carry the payer's key hash for key-paid requests; blind-token requests carry only a nullifier. No receipt carries an address or content.
* **Key compromise.** Router keys are registered on chain and never overwritten, so a stolen key cannot rewrite history, but it can sign new false receipts until revoked. Node keys live only in enclave memory and change at every restart.
* **Anchor trust.** An anchor proves inclusion in a window's tree, as posted by the anchorer. Receipts issued but withheld from the tree are not covered; clients that care SHOULD request the proof for their own receipts.
* **Truncation.** Without the chain (v1), a client detects a cut stream through `complete: false`, the missing receipt event, or, for encrypted streams, the missing final frame ([0002](0002-transport.md) Section 3.1).

## 8. References

### Normative

* [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119.
* [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174.
* [RFC8032] Josefsson, S., Liusvaara, I., "Edwards-Curve Digital Signature Algorithm (EdDSA)", RFC 8032.
* [RFC8785] Rundgren, A., Jordan, B., Erdtman, S., "JSON Canonicalization Scheme (JCS)", RFC 8785.
* [RFC9052] Schaad, J., "CBOR Object Signing and Encryption (COSE): Structures and Process", RFC 9052.
* [RFC8812] Jones, M., "CBOR Object Signing and Encryption (COSE) and JSON Object Signing and Encryption (JOSE) Registrations for Web Authentication (WebAuthn) Algorithms", RFC 8812.

### Informative

* [RFC9711] Lundblade, L., et al., "The Entity Attestation Token (EAT)", RFC 9711.
* [RFC3339] Klyne, G., Newman, C., "Date and Time on the Internet: Timestamps", RFC 3339.
* [RFC9162] Laurie, B., et al., "Certificate Transparency Version 2.0", RFC 9162.
* [TLOG-TILES] C2SP, "tlog-tiles", https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md.
* WHATWG, "HTML Living Standard: Server-sent events", https://html.spec.whatwg.org/multipage/server-sent-events.html.
* OpenZeppelin, "MerkleProof", https://docs.openzeppelin.com/contracts/5.x/api/utils#MerkleProof.

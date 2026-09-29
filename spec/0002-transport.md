# SEAL 0002: Transport

| | |
| :--- | :--- |
| Status | Draft |
| Version | 0.1.0 |
| Updated | 2026-09-29 |
| License | Apache-2.0 |
| Related | [0001](0001-attestation.md), [0003](0003-credits.md), [0004](0004-receipts.md) |

## Status of this document

This is a working draft of the SEAL protocol. It is not an IETF document. Sections marked **(implemented)** describe formats that exist in this repository and are frozen under their version string. Sections marked **(planned)** describe the target design and may change before 1.0.0.

## Abstract

SEAL protects a request with two independent layers. The inner layer encrypts the request body with HPKE [RFC9180] to a key that the enclave's attestation binds, so the router, the host and anything in between see only ciphertext. The outer layer carries the request through an Oblivious HTTP [RFC9458] relay run by another operator, so the router does not learn the client's network address and the relay does not learn what was asked. This document defines both layers and the lanes that combine them.

## 1. Conventions and terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

* **Client (U)**: the user's SDK. **Relay (R)**: an Oblivious HTTP relay resource. **Gateway (G)**: the router's Oblivious HTTP gateway resource and the router behind it. **Enclave (E)**: the attested sidecar ([0001](0001-attestation.md)).
* **Inner layer**: HPKE between U and E. **Outer layer**: Oblivious HTTP between U and G through R.
* **Independent relay**: a relay whose operator is not the gateway's operator.
* HPKE identifiers are from [RFC9180] Section 7: DHKEM(X25519, HKDF-SHA256) is KEM `0x0020`, HKDF-SHA256 is KDF `0x0001`, AES-128-GCM is AEAD `0x0001`, AES-256-GCM is AEAD `0x0002`.
* `||` is byte concatenation. `XOR` is bitwise exclusive or. Integers are unsigned big-endian unless stated.

## 2. Layering

Target:

```
UNLINKABLE:  U --OHTTP--> R --OHTTP--> G --HPKE ciphertext--> E
ATTESTED:    U --TLS----------------> G --HPKE ciphertext--> E
PUBLIC:      U --TLS----------------> G --TLS--> any provider
DIRECT:      U --HPKE ciphertext over TLS pinned to E-------> E
```

The two layers are independent. The outer layer hides the client from G; the inner layer hides the content from G and from the host. Neither layer hides the size and timing of a request from the parties that carry it (Section 7).

Today (implemented): the inner layer runs between a client and a sidecar directly (the `DIRECT` row). On the `attested` and `unlinkable` lanes G connects to the enclave over TLS, pinned to the attested key when the evidence binds one, so the host outside the enclave cannot read the request but **G sees it in plaintext**. Carrying inner ciphertext through G, so that G sees only ciphertext, is planned.

## 3. Inner layer: HPKE to the enclave

In this repository the sidecar implements the enclave side and `packages/client` (`sealedPost`) the client side; the client sends the ciphertext to the sidecar's own endpoint. A client MUST take the enclave's HPKE public key only from evidence it verified ([0001](0001-attestation.md) Section 9): `bindings.hpke_pubkey` in version 1. It MUST NOT use a key from any other source.

### 3.1 `anyroute-hpke/v1` (implemented)

Suite: KEM `0x0020`, KDF `0x0001`, AEAD `0x0001`, base mode.

**Request.** Media type `application/anyroute-hpke`. The body is:

| Bytes | Content |
| :--- | :--- |
| 0 | Version, `0x01` |
| 1 to 8 | Client time, milliseconds since the Unix epoch, 64-bit |
| 9 to 40 | `enc`, the 32-byte encapsulated key |
| 41 to end | `ct`, the HPKE ciphertext of the JSON request body, including the 16-byte tag |

```
info = "anyroute-hpke/v1"
aad  = body[0..8] || ASCII(request path)          e.g. "/v1/chat/completions"
```

The path in `aad` stops a ciphertext from being replayed to another endpoint. The enclave MUST refuse a request whose time is outside its clock-skew window (`request_expired`) and a request whose `enc` it has already seen inside that window (`request_replayed`). It MUST NOT forward any outer request header to the model server in this mode, since headers are not covered by the encryption. Refusals are HTTP 400 with codes `request_expired`, `request_replayed`, `decryption_failed` and `invalid_encryption`, all before anything reaches the model server.

**Response.** Media type `application/anyroute-hpke` for a JSON body and `application/anyroute-hpke-stream` for an event stream; the model server's own type is in `x-anyroute-inner-content-type`. Following [RFC9180] Section 9.8 and [RFC9458] Section 4.4:

```
secret         = context.Export("anyroute-hpke/v1 response", 16)
response_nonce = random(16)                                  sent first
prk            = HKDF-Extract(salt = enc || response_nonce, ikm = secret)
key            = HKDF-Expand(prk, "key", 16)
base_nonce     = HKDF-Expand(prk, "nonce", 12)
```

After the nonce come frames:

```
frame   = flag (1 byte) || length (4 bytes) || ciphertext
nonce_i = base_nonce XOR i          (i, the frame index, in the last 4 bytes)
ciphertext = AES-128-GCM(key, nonce_i, aad = flag, plaintext_i)
```

`flag` is `0x01` on the last frame only. A client MUST reject a response that does not end with a `0x01` frame or that has bytes after it; this makes truncation detectable. A JSON response is one last frame. For a stream, each chunk from the model server becomes one frame as it arrives, and the last frame holds the receipt event ([0004](0004-receipts.md)). The response nonce is fresh for every response, so a replayed request never reuses a key stream.

### 3.2 `anyroute-seal/v1`: chunked requests (planned)

Version 1 encrypts the whole request in one message. The planned version streams both directions and moves the key to an RFC 9458 key configuration:

* E publishes its key at `GET /.well-known/hpke-keys` as `application/ohttp-keys` [RFC9458]; the key MUST also be bound in the attestation ([0001](0001-attestation.md) Section 3.4) and logged ([0001](0001-attestation.md) Section 6.2).
* Suite: KEM `0x0020`, KDF `0x0001`, AEAD `0x0002` (AES-256-GCM).
* Request: `SetupBaseS(pk_E, info = "anyroute-seal-req")`; the encapsulated key travels in the `Ehbp-Encapsulated-Key` header; the body is a sequence of length-prefixed AES-GCM chunks.
* Response: `key = Export("anyroute-seal-resp", Nk)`; the response nonce travels in `Ehbp-Response-Nonce`; chunk nonces are the base nonce XOR a counter; `aad` is the empty string for every chunk except the last, whose `aad` is `"final"`.
* E pads every event-stream chunk to 512 bytes and sends on a fixed tick of 50 to 100 ms.

## 4. Outer layer: Oblivious HTTP

### 4.1 Gateway (implemented)

G implements the gateway resource of [RFC9458] with Binary HTTP [RFC9292] inner messages, with one suite: KEM `0x0020`, KDF `0x0001`, AEAD `0x0001`.

| Method and path | Media type | Purpose |
| :--- | :--- | :--- |
| `GET /api/v1/ohttp/keys`, `GET /.well-known/ohttp-gateway` | `application/ohttp-keys` | Current key configurations |
| `POST /api/v1/ohttp/gateway`, `POST /.well-known/ohttp-gateway` | `message/ohttp-req` in, `message/ohttp-res` out | The gateway |
| `GET /api/v1/ohttp/key-list` | `application/json` | Signed key history (Section 4.3) |
| `GET /api/v1/relays` | `application/json` | Relays by operator, with `independent` |

The gateway decodes and bounds the Binary HTTP request before building anything from it, and dispatches only to an allow-list of routes (chat completions, completions, embeddings, blind-token purchase and keys, model lists). Anything else is a 404 inside the encapsulation. It keeps no log of requests. A request whose `enc` was already seen is refused (`replayed_request`, [RFC9458] Section 6.5); the cache is per process, and what makes a replay harmless everywhere is that a blind token spends once ([0003](0003-credits.md)). A key problem is answered with HTTP 422 and `application/problem+json` of type `https://iana.org/assignments/http-problem-types#ohttp-key`.

Responses are encapsulated whole. A streaming request through the gateway is refused with `stream_unsupported` until chunked Oblivious HTTP (Section 4.5) is implemented.

### 4.2 Gateway keys and epochs (implemented)

Epoch `e` covers `[e * epoch_seconds, (e + 1) * epoch_seconds)` since the Unix epoch. The key identifier of a configuration is `e mod 256`, so replicas agree without coordination. The next epoch's key is created and listed as `upcoming` before any client is told to use it. G opens requests to a key until a grace period after its epoch ends, then destroys the private half; the public half and its configuration stay in the history forever. Status values: `upcoming`, `current`, `grace`, `expired`, `revoked`.

### 4.3 Key history (implemented)

The key list is a JSON document signed with Ed25519 by the router's receipt key, carrying every key ever used and a hash chain over them:

```
entry_0 = 32 zero bytes
entry_n = SHA-256("ohttp-key-log/v1" || 0x00 || entry_{n-1} || epoch (8) || key_id (1) || kem_id (2)
                  || SHA-256(key_config) (32) || valid_from_ms (8) || accept_until_ms (8))
```

A client MUST pin the signer's public key out of band rather than trust it on first use, MUST recompute the chain, and MUST refuse a key configuration that is not in the chain. Until the witnessed log of [0001](0001-attestation.md) Section 6.2 exists, this signed chain is the defence against key substitution: it makes a forked history detectable by anyone who compares heads, but it is not witnessed.

### 4.4 Relays (implemented)

A relay accepts `POST` of `message/ohttp-req` on one fixed path, forwards the body unchanged to a gateway on its allow-list, and returns the `message/ohttp-res`. It MUST build the forwarded request from scratch: no client header, cookie, address or query string is copied. It authenticates itself to the gateway with `Authorization: Bearer <key_id>:<secret>`; the gateway holds only the secret's SHA-256. It MUST NOT log requests, bodies or client addresses, and keeps only aggregate counters. It never follows redirects. It MAY reach an onion-service gateway through a local SOCKS5 proxy.

The gateway MUST mark relays run by its own operator as not independent, and MUST NOT serve the `unlinkable` lane through them. A production gateway MUST list relays from a configured minimum number of operators other than its own before it enables the lane.

### 4.5 Chunked Oblivious HTTP (planned)

For streaming, G and the relays implement chunked Oblivious HTTP [CHUNKED-OHTTP] (`message/ohttp-chunked-req`, `message/ohttp-chunked-res`) with chunks of at least 16 KiB. Gateway key configurations MUST carry an inclusion proof in the witnessed log, and the SDK MUST refuse any configuration without one. Relays run on at least two independent infrastructure providers, and the client chooses. The client randomizes its `Date` header, pads chunks to a fixed size on a fixed tick, and normalizes its TLS and HTTP fingerprint. A two-hop MASQUE path is a documented alternative, not part of version 1.

### 4.6 Onion service (implemented)

The router MAY also be reached as a Tor v3 onion service. The proxy in front of it removes every header that names an address, marks onion requests with a secret header that clients cannot forge, and logs nothing; the router publishes the address in `GET /api/v1/status` and an `Onion-Location` header. Onion requests carry no client address, so per-address limits for unkeyed calls fall back to one shared bucket for all onion clients.

## 5. Lanes (implemented)

A request names its lane in `provider.lane` or the `X-Anyroute-Lane` header; responses echo the lane that was enforced in `X-Anyroute-Lane`, and the signed receipt records it. Lanes `attested` and `unlinkable` imply disclosure `none`: only endpoints whose retention is declared attested and whose attestation the router verified recently (a fresh, verified attestation) are eligible.

### 5.1 Choosing a lane (implemented)

G resolves the lane of a request in this order:

1. If the body or the header names a lane, the stricter of the two (`public` < `attested` < `unlinkable`). A key's default (`routing.provider.lane`) and a saved route's `provider.lane` fill in the body field when the request leaves it unset, so a lane the request names itself wins over both. A saved route MAY set only `public` or `attested`, since it is called with an API key.
2. Otherwise, if G runs the gateway and blind tokens, the request arrived through the gateway from an independent relay, and it presents a blind token and no API key, wallet or per-call payment: `unlinkable`.
3. Otherwise `public`.

### 5.2 Enforcement (implemented)

On `attested` and `unlinkable`, G MUST NOT send a request to an endpoint without a fresh, verified attestation, and MUST NOT retry it on one: there is no fallback to a lower lane. `provider.order`, `only` and `ignore` apply inside the lane and cannot bring back an excluded endpoint. When no eligible endpoint remains, G answers before pricing the request or spending a token:

| Condition | Refusal |
| :--- | :--- |
| No endpoint of the model that fits the request has a fresh, verified attestation | 503 `no_attested_endpoint`, `error.metadata.reason` = `none_attested` |
| Such endpoints exist but are all in an outage | 503 `no_attested_endpoint`, `error.metadata.reason` = `attested_endpoints_down`, with `Retry-After` |
| No endpoint would serve the request on any lane | 404 `no_providers` |

A request with only `provider.disclosure` (no lane) keeps the disclosure codes: 409 `disclosure_unavailable` and 503 `disclosure_provider_unavailable`.

### 5.3 Selection weight (implemented)

Within a lane, G orders eligible endpoints by weighted random sampling without replacement, with

```
weight = uptime_30d * quality * attested_bonus / price_rel^2
price_rel = max(price, cheapest / 10) / cheapest        (blended 3:1 prompt:completion price)
attested_bonus = bonus[lane] for an endpoint served under the attested class, else 1
```

`bonus` defaults to 1.25 on `public` and 1 on `attested` and `unlinkable`, where every eligible endpoint is attested; it is configurable per lane and never below 1. Equal draws are broken by the higher weight, then by the provider's stake, then by provider id, so the order never depends on the order of the catalog. `sort`, `order` and the preferred latency and throughput settings apply on top as before.

### 5.4 Availability (implemented)

`GET /api/v1/models` lists `lanes` for each model and each endpoint: `public` whenever it has a live endpoint, `attested` while one endpoint is served under the attested class, and `unlinkable` as well where G runs the gateway and blind tokens. `GET /api/v1/models?lane=` keeps the models that list that lane. `GET /api/v1/status` has a `lanes` section with `available`, `models`, `endpoints` and `attested_bonus` for each lane.

### 5.5 Transport and payment per lane

| Lane | Outer transport | Inner transport | Payment |
| :--- | :--- | :--- | :--- |
| `public` | TLS to G | TLS to any provider | Key, credits, per-call payment or blind token |
| `attested` | TLS to G | TLS from G to E, pinned where the evidence binds a key (today); HPKE from U to E (planned) | Key, credits, per-call payment or blind token |
| `unlinkable` | Oblivious HTTP through an independent relay | TLS from G to E, pinned where the evidence binds a key (today); HPKE from U to E (planned) | Blind token only |

G MUST refuse lane `unlinkable` unless all of the following hold, checked in this order, and MUST do so before pricing the request or spending a token:

| Condition | Refusal |
| :--- | :--- |
| The router runs the gateway and blind tokens at all | 501 `lane_not_available` |
| It carries no API key, wallet or per-call payment, all of which name the payer | 403 `lane_requires_anonymous_auth` |
| The request arrived through the gateway from a relay | 403 `unlinkable_requires_relay` |
| That relay is independent | 403 `unlinkable_requires_independent_relay` |
| It is paid with `Authorization: PrivateToken` | 401 `unlinkable_requires_token`, with the token challenge |

A client MAY allow a downgrade with `provider.lane_downgrade: "attested"` or `X-Anyroute-Lane-Downgrade: attested`. A request for `unlinkable` that carries an identity-bearing credential is then served on `attested`, and `X-Anyroute-Lane` and the receipt say `attested`. G MUST NOT downgrade by default, and MUST NOT downgrade to `public`. On `unlinkable`, G records no application attribution (`HTTP-Referer`, `X-Title`) for the request, and the receipt names no payer: it carries the spent token's nullifier and the issuing key.

**Limit today.** On `attested` and `unlinkable`, G terminates TLS and sees the request in plaintext before forwarding it to the enclave over TLS pinned to the attested key (Section 2). The host outside the enclave cannot read it; G can. Carrying inner ciphertext through G is planned (Section 3.2).

The gateway records that it dispatched a request, and for which relay, in memory keyed by the request object it constructed. Nothing a client sends (header, query, body) can set or forge that record.

## 6. Planned end state for `unlinkable`

```
0  U verifies from the log: credit keyset, gateway key configuration, E's HPKE key and manifest
1  U -> R -> G -> M   quote {amount, rail}            -> quote_id           (M learns the amount only)
2  U pays on the rail
3  U -> R -> G -> M   mint {quote_id, blinded outputs} -> signatures + DLEQ  (U unblinds)
4  U -> R -> G        HPKE(request), credit proofs >= max cost, blinded change outputs
5  G -> M             verify and nullify proofs atomically, reserve
6  E                  decrypt, policy check, generate, hash-chain chunks
7  G -> M             settle; M signs change; U unblinds
8  E -> U             receipt with no payer information
```

Credits are specified in [0003](0003-credits.md) and receipts in [0004](0004-receipts.md).

## 7. Security considerations

* **Sender authentication.** HPKE base mode does not authenticate the client. The inner layer protects confidentiality and integrity of the body; who may call is decided by the credential.
* **Response key.** The response key derives from the request's HPKE context, so a response is exactly as private as the client's copy of that context.
* **Metadata.** Neither layer hides request size or timing from the parties that carry it. Version 1 does no padding. Planned padding and a fixed send tick reduce, and do not remove, timing correlation.
* **Collusion.** A relay and the gateway together can link address to request. A single relay operator that is also the gateway operator hides nothing, which is why such relays are refused. A global passive observer is out of scope.
* **Key substitution.** A client that encrypts to an unverified key loses every guarantee. The HPKE key MUST come from verified evidence, and gateway keys MUST come from the signed history (today) or the witnessed log (planned).
* **Replay.** Inner replay protection is per enclave process and bounded by the clock window; outer replay protection is per gateway process. Credits spend once, which makes cross-replica replays harmless.
* **Content.** Encryption hides the channel, not the words. Anything in the body that identifies the user identifies the user.

## 8. References

### Normative

* [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119.
* [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174.
* [RFC9180] Barnes, R., et al., "Hybrid Public Key Encryption", RFC 9180.
* [RFC9458] Thomson, M., Wood, C. A., "Oblivious HTTP", RFC 9458.
* [RFC9292] Thomson, M., Wood, C. A., "Binary Representation of HTTP Messages", RFC 9292.
* [RFC5869] Krawczyk, H., Eronen, P., "HMAC-based Extract-and-Expand Key Derivation Function (HKDF)", RFC 5869.

### Informative

* [CHUNKED-OHTTP] Pauly, T., Thomson, M., "Chunked Oblivious HTTP Messages", draft-ietf-ohai-chunked-ohttp-08.
* [RFC9540] Pauly, T., Reddy, T., "Discovery of Oblivious Services via Service Binding Records", RFC 9540.
* [RFC9457] Nottingham, M., et al., "Problem Details for HTTP APIs", RFC 9457.
* [RFC9298] Schinazi, D., "Proxying UDP in HTTP" (MASQUE), RFC 9298.
* Tor Project, "Onion services", https://community.torproject.org/onion-services/.

# Anyroute sidecar

A small gateway that runs in front of any OpenAI-compatible server (vLLM, for example). At boot it hashes the
weights the server will load and refuses to start unless that digest is on an allow-list. It then generates a
receipt-signing key and a TLS key, asks the platform for a quote that binds both keys and the digests, and puts the
hash of that evidence in its TLS certificate. Every request to `/v1/chat/completions` and `/v1/embeddings` is
proxied with client network identifiers removed, and every response comes back with an Ed25519-signed receipt.

Apache-2.0. Bun and TypeScript, one runtime dependency (`@noble/hashes`, for the receipt leaf hash).

## Quickstart (local, simulated evidence)

The `dev` attestation provider fabricates evidence. It exists so you can try the gateway without a confidential
VM. It is refused unless `SIDECAR_DEV_ATTESTATION=true`, and every response, receipt and certificate it produces
says so.

```sh
cd sidecar
bun install

# 1. Any directory can stand in for the weights while you experiment.
mkdir -p /tmp/tiny-model && echo '{}' > /tmp/tiny-model/config.json
bun src/main.ts digest /tmp/tiny-model            # prints sha256:<64 hex>

# 2. A minimal sidecar.yaml (paste the digest from step 1; run any OpenAI-compatible server on :8000).
cat > sidecar.yaml <<'YAML'
upstream: { base_url: "http://127.0.0.1:8000" }
model: { path: /tmp/tiny-model }
allowlist:
  model_digests: ["sha256:REPLACE_WITH_THE_DIGEST"]
attestation: { provider: dev }
auth: { allow_anonymous: true }
YAML

# 3. Start.
SIDECAR_DEV_ATTESTATION=true bun src/main.ts serve --config sidecar.yaml

# 4. Use it. -k because the certificate is self-signed (a real client pins it, see "Verifying an endpoint").
curl -sk https://localhost:8443/healthz
curl -sk https://localhost:8443/attest | head -c 600
curl -sk -D - https://localhost:8443/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"tiny","messages":[{"role":"user","content":"hi"}]}'    # see the x-anyroute-receipt header
```

To run against real weights and hardware, use `docker-compose.example.yml` (vLLM plus the sidecar) and
`sidecar.example.yaml` (every setting, commented). Copy the latter to `sidecar.yaml` and set:

* `model.path` to the directory vLLM loads, mounted read-only into both containers, and `allowlist.model_digests`
  to its digest (`bun src/main.ts digest <dir>`).
* `attestation.provider` to `dstack` (dstack confidential VMs, through the guest
  agent socket) or `tdx` (Intel TDX through Linux configfs-tsm; run the container as root with the host's configfs
  mounted).
* `auth.keys` to the SHA-256 of each API key you issue (`printf %s "$KEY" | sha256sum`), or `auth.allow_anonymous: true`.

Nothing is enabled by accident: an empty model allow-list, an unknown setting, a missing key list, a classifier
that is switched on but not present, and simulated evidence without the flag all stop the process at startup with a
stable error code.

## What happens at boot

In this order, cheapest first; any failure exits non-zero before anything listens.

1. The attestation provider is built. `dev` is refused unless `SIDECAR_DEV_ATTESTATION=true`. A classifier that is
   switched on (`classifier.enabled: true`) is refused too, since none ships in this version.
2. The model allow-list must be non-empty.
3. The weights are hashed (see below) and the digest must be on the allow-list. If `model.digest` is also given it
   must equal the measured value.
4. The compose hash is collected from the platform (dstack reports it), `compose.hash` and `compose.file`. They must
   agree. If a compose allow-list is configured, the hash must be on it.
5. Optionally (`router.url`), the router's record for this provider must name the served model digest.
6. An Ed25519 receipt key and a P-256 TLS key are generated in memory. They are never written anywhere.
7. A quote is requested whose 64-byte report data is `sha256(canonical_json(bindings)) || 32-byte nonce` (zero nonce
   at boot), where `bindings` is `{tls_pubkey, receipt_pubkey, image_digest, compose_hash, model_digest}`.
8. The certificate is issued for the TLS key with a SAN `<first 32 hex>.<last 32 hex>.attest.anyroute`, where the 64
   hex characters are `sha256(quote bytes)`: the attestation reference.

The model digest is `sha256("anyroute-model-digest-v1\n" + JSON([[path, sha256(file)], ...]))` over every regular
file under the model path (symlinks followed to files; `.git`, `.cache`, `.DS_Store` and `model.exclude` globs
skipped), paths relative to the root with `/` separators, sorted by bytes. It is independent of timestamps and walk
order. If you only have a digest and no weights in the container (`model.digest` without `model.path`), the sidecar
uses it as declared and `/attest` reports `digest_source: "declared"`.

## Endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | Readiness, whether the model server answers, receipt queue depth. `503` when the model server is unreachable. |
| `GET /attest` | none | The boot evidence and everything needed to check it. `?nonce=<64 hex>` returns a fresh quote whose report data ends in your nonce (rate limited). |
| `GET /.well-known/anyroute-sidecar.json` | none | Discovery: endpoints, receipt key and format, digests, `dev` flag. |
| `POST /v1/chat/completions` | API key | Proxied JSON or SSE. |
| `POST /v1/embeddings` | API key | Proxied JSON. |
| `GET /v1/models` | API key | The model server's model list, passed through (no receipt, no quota charge). |
| `GET /v1/receipts/{id}` | API key | A receipt by id, for the key that earned it (useful when an SSE reader stops at `[DONE]`). |
| `GET /anchor/leaves?after=&limit=`, `POST /anchor/ack` | anchor token | Batches of receipt leaves for the router's anchor; off unless `SIDECAR_ANCHOR_TOKEN` is set. |

Every response the sidecar produces carries `x-anyroute-attestation-ref` (the reference from the certificate SAN) and,
in development mode, `x-anyroute-attestation: dev-simulated`. Requests carry `Authorization: Bearer <key>`. Keys are compared by SHA-256 in constant time. Quotas are token buckets
per key and globally: requests per minute with a burst, and model tokens per minute (charged after the fact from the
usage the model server reports; a stream without a usage chunk is charged an estimate). Over-quota requests get
`429` with `Retry-After`.

## What is stripped

Client request headers are forwarded by allow-list, not deny-list. The model server receives `content-type`,
`accept`, `accept-encoding: identity`, `user-agent: anyroute-sidecar`, its own API key from `upstream.api_key_env`,
and any header you list in `upstream.forward_headers`. Names that carry addresses or credentials (`x-forwarded-*`,
`forwarded`, `via`, `x-real-ip`, `cf-*`, `true-client-ip`, `cookie`, `authorization`, ...) are refused in that list.
The client's own credential is never passed on. The sidecar does not read the peer address of the connection, and
its logs (JSON lines on stderr) contain no address, key or request content. Only `content-type` and `retry-after`
are copied back from the model server. The request body is forwarded byte for byte, so anything a client puts in
the body (a `user` field, say) is the client's own business and reaches the model server unchanged.

## Receipts

For each successful response the sidecar signs a JSON payload:

```json
{
  "v": 1, "type": "anyroute.sidecar.receipt", "id": "rcpt_<24 hex>", "ts": 1700000000000,
  "path": "/v1/chat/completions", "status": 200, "stream": false, "complete": true,
  "req_hash": "sha256:<hash of the exact request body>",
  "resp_hash": "sha256:<hash of the exact response body>",
  "model_digest": "sha256:<...>", "attestation_ref": "<64 hex>", "nullifier": "",
  "usage": { "prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7 },
  "dev": false
}
```

The signature is Ed25519 over the canonical JSON of the payload (keys sorted recursively, no whitespace). The
envelope is `{payload, sig (base64), key_id, alg: "Ed25519", leaf}`, where `leaf = keccak256(keccak256(canonical ||
signature))`, the same leaf the router builds for its own receipts.

* JSON responses: the envelope is in the `x-anyroute-receipt` header (base64url of the JSON) and its id in
  `x-anyroute-receipt-id`.
* SSE responses: the upstream stream is forwarded untouched, then, after its final `data: [DONE]`, the sidecar sends
  one more event, `event: anyroute.receipt` with the envelope as data. `resp_hash` covers the upstream bytes only.
  The id is in the `x-anyroute-receipt-id` response header from the start. Clients that stop reading at `[DONE]`
  can fetch the receipt from `GET /v1/receipts/{id}`.
* `complete: false` means the upstream stream ended without `[DONE]`, errored, stalled past
  `upstream.stream_idle_timeout_ms`, or the client disconnected. Those receipts are still signed and queued.
* Usage appears when the model server reports it. For streams that means the client sets
  `stream_options.include_usage`; the sidecar does not edit the request.
* Upstream error responses are passed through without a receipt.
* `nullifier` is reserved for unlinkable-access tokens and is always empty in this version.

## Verifying an endpoint

Everything is in `GET /attest`. A verifier should:

1. Verify the quote's signature and certificate chain with the platform's verifier (Intel's, or dstack's). The
   sidecar does not do this itself; `checks.quote_signature_verified_by_sidecar` is `false`.
2. Recompute `bindings_digest = sha256(canonical_json(bindings))` from the `bindings` object and check it equals
   the first 32 bytes of the quote's report data. With `?nonce=...`, the last 32 bytes must be your nonce.
3. Check the digests it cares about: `model_digest` (against weights it trusts), `compose_hash` (against the
   deployment it expects) and `image_digest`.
4. Connect over TLS, pin the certificate, and check that its public key equals `bindings.tls_pubkey` and that
   `sha256(quote bytes)` equals the reference in the certificate's `attest.anyroute` SAN.
5. Verify receipts with `bindings.receipt_pubkey`.

A response carrying `x-anyroute-attestation: dev-simulated`, `"dev": true`, `format: "dev-simulated"` or a
certificate with a `dev-simulated.attest.anyroute` name is simulated and must be rejected outside development.

## Environment variables

The file is the source of truth; these override it, so a container can start from environment alone.
`SIDECAR_CONFIG` (file path, default `sidecar.yaml`), `SIDECAR_HOST`, `SIDECAR_PORT`, `SIDECAR_UPSTREAM_URL`,
`SIDECAR_UPSTREAM_API_KEY` (name set by `upstream.api_key_env`), `SIDECAR_MODEL_PATH`, `SIDECAR_MODEL_DIGEST`,
`SIDECAR_MODEL_ALLOWLIST` (comma-separated digests, added to the file's list), `SIDECAR_COMPOSE_ALLOWLIST`,
`SIDECAR_IMAGE_DIGEST`, `SIDECAR_COMPOSE_FILE`, `SIDECAR_COMPOSE_HASH`, `SIDECAR_ATTESTATION`
(`dstack`, `tdx` or `dev`), `SIDECAR_DSTACK_ENDPOINT`, `SIDECAR_DEV_ATTESTATION`, `SIDECAR_ROUTER_API_KEY`,
`SIDECAR_ANCHOR_TOKEN`. When you put hex values in YAML, quote them.

## Reproducible image

The `Dockerfile` pins the Bun base image by digest, installs from the committed `bun.lock` with
`--frozen-lockfile --ignore-scripts`, copies only `src/`, normalises file modes and mtimes from
`SOURCE_DATE_EPOCH`, fetches nothing at run time and runs as the unprivileged `bun` user. The build command that
also rewrites layer timestamps is at the top of the file. Pin the resulting image digest in your compose file and
set `SIDECAR_IMAGE_DIGEST` to it; the sidecar binds that value into the attestation as an operator declaration,
because a process cannot read the digest of its own image. Nothing in this repository builds or publishes an
image for you.

## Limits

* The quote is not verified by the sidecar. It checks that the platform's quote carries the report data it asked
  for and reports the registers; a verifier does the rest.
* The weights are hashed once, at boot. Mount them read-only; the sidecar does not watch for later changes.
* `image_digest` is declared by the operator, not measured. The compose hash is measured only where the platform
  reports it (dstack); on bare-metal TDX it comes from the file or hash you supply.
* Confidential-GPU evidence (NVIDIA) is not collected. Only the CPU-side quote is bound.
* There is no request encryption to the enclave beyond TLS, no in-enclave classifier (`classifier.enabled: true` is
  refused), no blind-token redemption, and the sidecar does not publish to a transparency log or an on-chain
  registry. `sidecar.yaml`, the compose file and the endpoints above are the whole interface today.
* Keys and the certificate are regenerated on every start. The certificate lives `server.cert_validity_days`
  (default 90); restart before then. `/healthz` reports `tls_not_after`.
* With `server.tls: off` the transport is outside the attestation, and `/attest` says `tls: null`.
* Receipts are kept in memory (`receipts.queue_capacity`); the oldest are dropped when nothing pulls them.

## Tests

```sh
cd sidecar
bun install
bun test          # hermetic: a mock model server, no network, no Docker
bun run typecheck
```

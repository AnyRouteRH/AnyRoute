# Sidecar on Phala Cloud (Intel TDX)

A complete, attested deployment of the sidecar in a Phala Cloud confidential VM (dstack, Intel TDX), in front of a
small open model served by llama.cpp on the CPU. Nothing is built or pushed: every image, the weights and the sidecar
source are fetched by pinned hashes, so the compose hash dstack measures covers exactly what runs.

| File | What it is |
| --- | --- |
| `docker-compose.yml` | The deployment. The only file the CVM receives. |
| `sidecar.yaml` | The sidecar's configuration. The compose file carries a verbatim copy (see below). |

## What runs

| Service | Image | Does |
| --- | --- | --- |
| `model-fetch` | `ghcr.io/ggml-org/llama.cpp:server-b11243@sha256:f9115c95…c283` | Downloads `qwen2.5-0.5b-instruct-q4_k_m.gguf` from `Qwen/Qwen2.5-0.5B-Instruct-GGUF` at revision `9217f5db79a29953eb74d5343926648285ec7e67` (Apache-2.0), checks sha256 `74a4da8c…a9db`, exits. |
| `llama` | same | `llama-server` on an internal network with no route out, alias `qwen2.5-0.5b-instruct`, 4096 context, at most 512 generated tokens. |
| `sidecar` | `oven/bun:1.3.14@sha256:e10577f0…e5c4` | Downloads the GitHub tarball of commit `dcfc2deeacd8f3d89ea61d7e7045259e173e8050`, checks sha256 `5b297e38…9027`, runs `bun install --frozen-lockfile --production --ignore-scripts` in `sidecar/`, then serves TLS on 8443 with `attestation.provider: dstack` through `/var/run/dstack.sock`. |

The sidecar hashes the GGUF at boot and refuses to start unless the digest,
`sha256:1144b5db331424ae40213378a83575a5cf67090b0ce1ad49cf66ec75f17e2095`, is on its allow-list. It serves one API key,
the router's, listed by its SHA-256 (120 requests and 120k tokens a minute; 150 and 150k across all callers). `image_digest` is
declared as the `oven/bun` digest, the image the sidecar process runs in; the sidecar's own code is pinned by the
tarball hash in the compose file instead.

It fits a `tdx.medium` instance (2 vCPU, 4 GB) with a 20 GB disk. It needs no secrets and no environment variables: the router's key is not in it, only the key's SHA-256. Replace that hash with your own key's.

## Deploy

```sh
npx -y phala deploy -n <name> -c docker-compose.yml -t tdx.medium --disk-size 20G --wait
npx -y phala ps <name>          # model-fetch exits 0, llama and sidecar become healthy
npx -y phala logs dstack-sidecar-1 --cvm-id <name> --stderr
```

The endpoint is the gateway's TLS-passthrough name for port 8443 (note the `s`):

```
https://<app_id>-8443s.<gateway domain>
```

The gateway forwards the TLS stream without terminating it, so the client talks TLS to the sidecar itself. Its
certificate is self-signed and names that host and `<32 hex>.<32 hex>.attest.anyroute`. Without the `s`, the gateway
would terminate TLS itself and forward plain bytes that the sidecar does not accept.

## Verify

```sh
H=<app_id>-8443s.<gateway domain>

# 1. Pin the certificate the endpoint presents, then use only that certificate from here on.
openssl s_client -connect $H:443 -servername $H </dev/null 2>/dev/null | openssl x509 > sidecar.pem
openssl x509 -in sidecar.pem -noout -ext subjectAltName
curl -s --cacert sidecar.pem https://$H/healthz
curl -s --cacert sidecar.pem "https://$H/attest?nonce=$(openssl rand -hex 32)" > attest.json

# 2. Verify the quote's signature and TCB status (Phala's public verifier, or dcap-qvl locally).
jq -r .evidence.quote attest.json | jq -Rc '{hex: .}' |
  curl -s https://cloud-api.phala.com/api/v1/attestations/verify -H 'content-type: application/json' -d @- |
  jq '{verified: .quote.verified, reportdata: .quote.body.reportdata, mrconfig: .quote.body.mr_config_id}'
```

Then check, as the sidecar README's "Verifying an endpoint" describes:

* `sha256(canonical_json(bindings))` equals the first 32 bytes of the quote's report data, and the last 32 bytes
  are your nonce.
* `bindings.tls_pubkey` is the SubjectPublicKeyInfo of `sidecar.pem`, and the certificate's `attest.anyroute` name
  is `sha256` of the boot quote (`GET /attest` without a nonce).
* `bindings.model_digest` is the digest above, `bindings.image_digest` is the `oven/bun` digest, and
  `bindings.compose_hash` is `sha256` of the CVM's `app-compose.json`, whose `docker_compose_file` is this
  `docker-compose.yml` byte for byte (`npx -y phala cvms attestation <name> --json` shows both). The same hash
  appears as the `compose-hash` event in the quote's event log and, on dstack 0.5.9, in the quote's MRCONFIGID
  as `01 || compose hash`.
* Replaying the event log reproduces RTMR3. The guest agent returns the runtime events without their digests;
  each one is `sha384(u32le(event_type) || ":" || event || ":" || payload)`.
* A chat completion carries an `x-anyroute-receipt` header whose Ed25519 signature verifies with
  `bindings.receipt_pubkey`, and whose `req_hash` and `resp_hash` are the sha256 of the exact bytes sent and
  received:

```sh
curl -s --cacert sidecar.pem -H "authorization: Bearer $KEY" https://$H/v1/models
curl -s --cacert sidecar.pem -D headers.txt https://$H/v1/chat/completions -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"qwen2.5-0.5b-instruct","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
```

## Keeping `sidecar.yaml` and the compose copy identical

The CVM receives only the compose file, so the sidecar's configuration travels in its `SIDECAR_CONFIG_YAML`
variable and is written to a file at start. After editing `sidecar.yaml`, paste it into that block (indented by eight
spaces) and check:

```sh
bun -e 'const c = Bun.YAML.parse(await Bun.file("docker-compose.yml").text());
console.log(c.services.sidecar.environment.SIDECAR_CONFIG_YAML === await Bun.file("sidecar.yaml").text())'
```

`${DSTACK_APP_ID}` and `${DSTACK_GATEWAY_DOMAIN}` in it are filled in by the platform when it interpolates the
compose file. They are the only variables referenced, and they only add the gateway host name to the certificate.
Shell variables in the compose file are written `$$name` so that compose leaves them to the shell.

To serve other weights, change the URL, revision and sha256 in `model-fetch`, the file name in `llama` and
`sidecar.yaml`, and put the new digest (`bun src/main.ts digest <file>`) on the allow-list.

## Limits

* Each start downloads the weights (once; they stay on the volume), the sidecar source and its one dependency. The
  hashes make a changed download fail closed; they do not make the sources available.
* `image_digest` names the base image the sidecar runs in, as the operator declares it. The sidecar code itself is
  pinned only through the compose hash.
* `/attest` does not include the VM configuration, so a verifier that recomputes MRTD and RTMR0-2 from the OS image
  (dstack-verifier) needs it from the platform. The router's `phala` verifier (`ATTESTATION_VERIFIERS=phala`) uses
  Phala's public quote verifier instead, which needs only the quote.
* The certificate is self-signed. Clients pin it (step 1 above); a client that only trusts public CAs cannot use
  the passthrough URL. The router pins it the same way: its attestor accepts the certificate only after the quote
  it names verifies and binds its key, and then sends that provider's traffic only to that certificate
  (`src/providers/tls-pin.ts`).
* Keys and the certificate are regenerated on every start, so a restart changes the attestation reference.
* CPU only: there is no GPU evidence to collect. The 512-token cap and the quota are sized for a demo provider.
* Phala makes container logs public by default (`--no-public-logs` turns that off). The sidecar logs no request
  content or addresses.

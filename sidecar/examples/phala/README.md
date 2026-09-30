# Sidecar on Phala Cloud (Intel TDX)

A complete, attested deployment of the sidecar in a Phala Cloud confidential VM (dstack, Intel TDX), in front of a
small open model served by llama.cpp on the CPU. Nothing is built or pushed: every image, the weights and the sidecar
source are fetched by pinned hashes, so the compose hash dstack measures covers exactly what runs.

| File | What it is |
| --- | --- |
| `docker-compose.yml` | The deployment. The only file the CVM receives. |
| `sidecar.yaml` | The sidecar's configuration. The compose file carries a verbatim copy (see below). |

To generate a deployment like this one for your own model (weights hashed, everything pinned, a router key made, the application printed), use the onboarding command: see "Onboarding a model host" in [../../README.md](../../README.md).

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

## Quote-bound source, engine and model identity

The `bindings` configuration opts into the SHA-256 bindings format with `bindings.v: 2`.
Omitting it retains the deployed v1 format. Before deploying this configuration, replace the compose
`rev` with a published commit containing bindings v2: the retained historical pin predates this feature.
Download that commit's exact archive from `https://codeload.github.com/AnyRouteRH/AnyRoute/tar.gz/<commit>`
and run `sha256sum src.tar.gz` (or `shasum -a 256 src.tar.gz`). Copy the 64 hex characters to the
compose `sum` and to `bindings.source_hash` with a `sha256:` prefix, in both configuration copies.

`source_hash` is SHA-256 of the complete compressed archive bytes, including headers, with no extraction,
normalization or additional prefix bytes. Reproducing it means hashing the same archive, not repacking its
contents. The sidecar streams the retained archive at `source_archive` at boot and refuses a mismatch.
The archive hash alone does not prove that those bytes are the executing program; verify the measured
compose file's download, hash check, extraction and launch commands and review the pinned source.

Get `engine.image_digest` from the immutable digest of the engine image you pin in the compose `llama`
service; for example, inspect the chosen image's registry manifest with `docker buildx imagetools inspect`.
Use `engine.name: llama.cpp`. Set `model_id` to the engine's `--alias` and the sidecar's `model.served_name`;
the loader requires those latter two names to agree. `model.digest` in the quote is the existing boot
weight digest, also present as `model_digest`, rather than the raw GGUF checksum. Obtain it with
`bun src/main.ts digest <weights-path>` and place it on the model allow-list.

The quote commits the source hash, engine name/image digest, and model ID/digest together with the existing
keys and digests. The source archive and weights are hashed at boot; engine image and model ID are operator
declarations. They need review against the measured deployment, and are not independent engine measurements.
This CPU deployment supplies no verified GPU confidential-computing evidence. Legacy v1 evidence still verifies,
but lacks the fields the network host policy requires. Update the signed host policy with approved pins separately.

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

## Measurement bundle and transparency log

The quote commits to a compose hash, and the compose file pins everything else by hash. A **measurement bundle** writes
those pins down in one signed document, and the bundle's digest is recorded in a public transparency log (Sigstore
Rekor). The router then reports a log entry for the provider's measurement that anyone can check, on the verify page and
in `GET /api/v1/attestation/<provider>` (`checks.transparency_log_entry`).

The bundle is canonical JSON (keys sorted, no whitespace) with:

| Field | What it says |
| --- | --- |
| `provider`, `created_at` | The provider id the router knows, and when the bundle was made. |
| `compose_hash` | The hash the quote committed to (`sha256` of the CVM's `app-compose.json`). |
| `source` | Repository, commit and the `sha256` of the GitHub tarball the compose file checks before it runs anything. |
| `model` | The digest the sidecar binds into its quote, and the weights file with its `sha256` and URL. |
| `images` | Every image in the compose file, by digest. |
| `tdx` | `mrtd` and `rtmr3` allow-lists. `rtmr3` changes with the CVM instance, so it is empty unless you pin it. |
| `signer` | The measurement public key that signed the bundle. |

The log entry is a `hashedrekord` entry: the artifact is the bundle's bytes, the hash is their `sha256`, and the signature
is ECDSA P-256 with SHA-256 by the measurement key (Rekor accepts Ed25519 only in a prehashed form, so P-256 is used).
Anyone can look it up by the bundle digest.

### Set up

Make a key for signing bundles, separate from every other key. Only the publisher holds the private half.

```sh
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out measurement-signing.p8
openssl pkey -in measurement-signing.p8 -pubout          # this is MEASUREMENT_PUBLIC_KEY
```

Router settings (both the API and the job process need them if they run apart):

| Variable | Value |
| --- | --- |
| `MEASUREMENTS_ENABLED` | `true`. |
| `MEASUREMENT_PUBLIC_KEY` | The public key above. Turns bundle checking on and is served at `GET /api/v1/measurements/key`. A private key here is refused at startup. |
| `REKOR_PUBLIC_KEY` | The log's key: `curl -s $REKOR_URL/api/v1/log/publicKey` (compare it with the key in Sigstore's trusted root). Without it entries are found and their inclusion proofs verified, but the checkpoint signature is reported unverified and the verify page shows "partial". |
| `REKOR_URL` | Defaults to the public instance. |

### Publish

The script needs only `MEASUREMENT_SIGNING_KEY` (the private key, PEM or base64 PKCS#8, read from the environment and never
printed or written). It reads the compose file, takes the compose hash, image and model digests and MRTD from the router's
attestation record (values from the verified quote), and refuses to go on if they do not match the compose file: a bundle
must describe what is running.

```sh
export MEASUREMENT_SIGNING_KEY="$(cat measurement-signing.p8)"

# 1. Look first. Builds and signs the bundle, prints it with the exact request for the log, sends nothing.
bun scripts/publish-measurement.ts --provider <id> --router-url https://<router> --dry-run

# 2. Publish. Submits the entry to REKOR_URL, verifies what comes back (inclusion proof, entry contents, and with
#    REKOR_PUBLIC_KEY the checkpoint and signed entry timestamp), writes the publication record to
#    measurement-<id>-<digest>.publication.json, and hands it to the router.
ADMIN_TOKEN=<operator token> REKOR_PUBLIC_KEY="$(curl -s https://rekor.sigstore.dev/api/v1/log/publicKey)" \
  bun scripts/publish-measurement.ts --provider <id> --router-url https://<router> --handover
```

To make the compose hash independent of the router's record, also pass the deployment's own `app-compose.json`
(`npx -y phala cvms attestation <name> --json > attestation.json`, then `--app-compose attestation.json`). The script then
requires that it embeds this compose file byte for byte and that its hash is the one the router recorded. The router's
record is the measurement the provider's latest verified quote committed to: after a redeploy that changes the compose
file, the router records a new measurement at its next attestation and keeps the earlier one as history
(`measurement_history` in `GET /api/v1/attestation/<provider>`, with its own log entry). Publish after that attestation.

A log entry is permanent. The script refuses to publish when the router already holds a verified bundle for the same
compose hash (`--force` overrides), and never overwrites an output file. If the hand-over fails after the entry is
logged, repeat only that step: `ADMIN_TOKEN=... bun scripts/publish-measurement.ts --resume <record> --router-url ...`.
Without a router, give the compose hash with `--compose-hash`, `--app-compose <app-compose.json>` or `--attest </attest
document>`, and the MRTD with `--mrtd`. `--pin-rtmr3` also pins the instance's RTMR3.

### What the router checks

For each measurement it recorded from a verified quote, the router looks for a bundle with the same provider and compose
hash. It marks `transparency_log_entry` true only when all of these hold:

1. the bundle is well formed, its signature verifies with `MEASUREMENT_PUBLIC_KEY`, and it names that key;
2. the router fetched the entry from the log itself, the entry's uuid names its body, and its inclusion proof verifies;
3. the entry is a `hashedrekord` entry whose artifact hash is the bundle's digest, whose public key is the measurement key,
   and whose signature verifies over the bundle's bytes;
4. the image digest, model digest and compose hash the quote committed to are in the bundle, and so is the quote's MRTD
   (and RTMR3) when the bundle lists them.

The checkpoint signature and the signed entry timestamp are checked too when `REKOR_PUBLIC_KEY` is set, and reported
separately. The router does not check the bundle's source commit, tarball hash or weights hash: those are the publisher's
statement, which anyone can reproduce (next section).

### Check a bundle yourself

```sh
bun scripts/publish-measurement.ts --verify <record> --router-url https://<router>   # or --offline, or --public-key <file>
```

or with standard tools:

```sh
curl -s https://<router>/api/v1/measurements/bundles/<id> | jq '[.data[] | select(.status=="verified")][0]' > item.json
jq -cSj .bundle item.json > bundle.json                    # canonical bytes
sha256sum bundle.json                                      # = item.json .bundle_digest, without the 0x
jq -r .signature item.json | base64 -d > bundle.sig
curl -s https://<router>/api/v1/measurements/key | jq -r .data.public_key_pem > key.pem
openssl dgst -sha256 -verify key.pem -signature bundle.sig bundle.json      # Verified OK
curl -s https://rekor.sigstore.dev/api/v1/index/retrieve -H 'content-type: application/json' -d '{"hash":"sha256:<digest>"}'
```

The last call lists the log entries for that digest; the router keeps the one signed by the measurement key
(`transparency_log.entry_url`).

### Reproduce what the bundle says

```sh
bun scripts/check-reproducible.ts --repo <a checkout that has the pinned commit>
bun scripts/check-reproducible.ts --app-compose app-compose.json --compose-hash sha256:<compose hash>
```

The first checks that the compose file is fully pinned and that the model digest it allows follows from the pinned
weights hash; downloads the GitHub tarball for the pinned commit twice and compares both hashes with the pin; and, with a
checkout, that the uncompressed tar equals `git archive` of that commit. (The pin is on GitHub's compressed bytes, which a
local `gzip` does not reproduce; the script reports that as a note.)

The second recomputes the compose hash. dstack's compose hash is the `sha256` of the CVM's `app-compose.json`, whose
`docker_compose_file` is `docker-compose.yml` byte for byte and whose other fields are the deployment's settings (name,
runner, key-provider and gateway flags). Those come from the platform, not from the example file: get the document with
`npx -y phala cvms attestation <name> --json` and let the script confirm that it embeds this file and hashes to the value the
quote committed to.

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
* A bundle is the publisher's statement, signed with a key the router is configured to trust. The router checks it against
  the quote's compose hash, image and model digests and MRTD, and the log entry against the log; it does not rebuild
  anything, and it cannot tell who holds the measurement key.
* Only the router that holds a log entry for a bundle reports it. A restart that changes the compose file changes the
  compose hash, and needs a new bundle: an entry is only ever reported for the compose hash its bundle names.

# Approved host build: Intel TDX + llama.cpp + Qwen2.5 0.5B (host policy v1)

This is the one build the Anyroute Network's published host policy admits today
(`GET https://anyroute.tech/api/v1/network/policy`). A host that runs anything else — including a build made with the
general installer (`deploy/seal/install.sh`) — is refused at admission, with the reason, until the policy lists it.

| Pinned by the policy | Value |
|---|---|
| TEE | Intel TDX (quote verified by Phala's verifier, so it must run in a dstack confidential VM — Phala Cloud, or your own TDX server running dstack) |
| Sidecar source | `sha256:47b053fe8af3e17053e1fdcb43777af42c933cf1afdf64d6ceaf197e70540d68` — the GitHub tarball of commit `0d8634eb3b4adafe3e3c8a81a560d72124e4a70a` |
| Sidecar image | `oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4` |
| Engine | `llama.cpp` `ghcr.io/ggml-org/llama.cpp:server-b11243@sha256:f9115c95639e60abc09d4ea83b26fd4d56c66aa1174594393335a514da00c283` |
| Model | `qwen2.5-0.5b-instruct`, GGUF `sha256:1144b5db331424ae40213378a83575a5cf67090b0ce1ad49cf66ec75f17e2095` |

The compose hash is not pinned, so the file can carry your own router key hash.

## Steps

1. **Check your machine** (optional on Phala Cloud): see https://anyroute.tech/network#readiness.
2. **Make the router key** the Anyroute router will use to call your sidecar, and fill in the template:
   ```sh
   umask 077 && openssl rand -hex 32 | tr -d '\n' > sidecar.key
   KEY_SHA=$(printf %s "$(cat sidecar.key)" | shasum -a 256 | cut -d' ' -f1)
   sed "s/__ROUTER_KEY_SHA256__/$KEY_SHA/" docker-compose.template.yml > docker-compose.yml
   ```
3. **Deploy** it in a dstack confidential VM. On Phala Cloud, `tdx.small` is enough:
   ```sh
   phala deploy -n my-anyroute-host -c docker-compose.yml -t tdx.small --wait
   ```
   Your endpoint is `https://<app_id>-8443s.<gateway domain>` (the `s` means TLS passthrough to the sidecar).
4. **Check it yourself**: `curl -k https://<endpoint>/attest` should show `bindings.v: 2`, the `source_hash`, `engine`
   and `model` above. (The certificate is self-signed and bound to the hardware quote; the router pins it.)
5. **Join** with a dedicated operator wallet (not one holding funds) — see https://anyroute.tech/network#join:
   ```sh
   node join.mjs --key-file operator.key --api-key-file sidecar.key --name MY_HOST \
     --endpoint https://<endpoint> --payout-address 0xYOUR_PAYOUT_ADDRESS --models qwen2.5-0.5b-instruct
   ```
   Admission is automatic: a fresh quote, the policy check and sanctions screening. You start on probation, with a
   public host record at https://anyroute.tech/hosts/.

Limits: the router still reads requests in memory; the enclave runs the model. Payouts to network hosts aren't
switched on yet. The policy will list more builds as they are approved; this file tracks policy v1.

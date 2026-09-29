# SEAL host install

Put the Anyroute sidecar in front of the model server you already run, and get an endpoint whose users can check which
weights answer them and on what hardware. This folder is everything a host needs for that: a one-command installer,
a Compose file, a Helm chart, Terraform modules for three platforms, and the `seal` command line.

```sh
# From a checkout of this repository (the hosted address below is planned, not live yet):
sh deploy/seal/install.sh --hf-repo <owner/name> --weights-sha256 sha256:<64 hex> \
  --price-in 0.20 --price-out 0.90 --region eu-west

# Planned one-liner, same options after `sh -s --`:
#   curl -fsSL https://get.anyroute.xyz/seal | sh -s -- <options>
```

Nothing starts until you add `--apply --sidecar-image <name@sha256:...>`. Nothing is published anywhere: the
installer talks to your engine on the loopback and, with `--apply`, to the sidecar it just started.

## What you get

| File | What it is |
| :--- | :--- |
| `seal.yaml` | What you declare about this endpoint: engine, model and weights digest, lanes, prices, TEE, GPU mode, region, HostBond id. Checked against [`seal.schema.json`](seal.schema.json). |
| `sidecar.yaml` | The sidecar's own configuration, derived from `seal.yaml`, accepted by the sidecar's loader. |
| `docker-compose.seal.yaml` | The sidecar, pinned by image digest, on host networking in front of your engine. Its labels carry the SHA-256 of `seal.yaml` and `sidecar.yaml`, so the attested compose hash commits to both. |
| `router-api-key` | 32 random bytes, hex, mode 0600. Never printed, never overwritten. Only its SHA-256 appears anywhere else. Hand it to the router's operator privately. |

After `--apply`: `attest.json`, the sidecar's boot evidence, and the commands to check it:

```text
verify:    bun scripts/seal-cli.ts verify https://<public address>:8443
registry:  <router>/registry/<provider id>/   (once the router lists this endpoint)
planned:   https://verify.anyroute.xyz/<host_id>   (placeholder address, not live yet)
```

## Requirements

For the `attested` and `unlinkable` lanes:

* **Intel TDX.** A TDX confidential VM (GCP A3 confidential, bare-metal TDX, or a dstack CVM such as Phala Cloud).
  The sidecar gets its quote from configfs-tsm (`--attestation tdx`) or the dstack guest agent (`--attestation dstack`).
* **An NVIDIA GPU in confidential-computing mode** (Hopper or Blackwell) if you claim `gpu.cc_mode: "on"`. Multi-GPU
  over PPCIe leaves NVLink traffic unencrypted; the validator warns and you should disclose it. Blackwell NVLE encrypts it.
* **Docker Compose** (or Kubernetes with the chart), and an OpenAI-compatible engine: vLLM, SGLang, llama.cpp server or
  Ollama. Only vLLM and SGLang have batch-invariant serving, which re-execution checks need.
* `curl` or `wget`, and `sha256sum`, `shasum` or `openssl`. Bun only if you want the full schema check and the CLI.

Any machine can serve the `public` lane.

## The installer

`install.sh` is POSIX `sh` with `set -eu`, checked with shellcheck. In order, it:

1. Finds the engine: it asks `/v1/models` on `127.0.0.1` ports 8000 (vLLM), 30000 (SGLang), 8080 (llama.cpp) and 11434
   (Ollama), tells them apart by `owned_by` and their own endpoints, and takes the first served model id. `--engine-url`,
   `--engine` and `--model` override what it finds.
2. Looks at the machine: TDX (configfs-tsm, `/dev/tdx_guest` or the dstack socket), SEV-SNP (`/dev/sev-guest`), and
   the GPU's confidential-computing state (`nvidia-smi conf-compute`). `--tee`, `--cc-mode` and `--attestation`
   override it.
3. Checks every value with the same patterns as the schema, and the same rules: `attested` and `unlinkable` need TDX,
   and so does a confidential-GPU claim. Run from a checkout with Bun, it also runs the full schema check.
4. Writes the files above. A file whose content would not change is left alone, the HostBond id and the router key are
   kept, so running it again with the same options changes nothing.
5. With `--apply`: `docker compose up -d`, waits for `/healthz`, saves `/attest` and prints the attestation reference.
   It refuses on a host with no TDX, and needs `--sidecar-image` pinned by digest.

`--weights-dir <abs path>` mounts the weights read-only so the sidecar hashes them at boot and refuses to start on a
mismatch. Without it the digest in `seal.yaml` is declared, and `/attest` says `digest_source: declared`. The digest is
the Anyroute model digest (`bun sidecar/src/main.ts digest <dir>`), a SHA-256 over every file's SHA-256.

`--attestation dev` runs the sidecar with simulated evidence for a rehearsal on a laptop. Everything it produces says
so, and routers refuse it on attested lanes.

`sh deploy/seal/install.sh --help` lists every option.

## Compose, Helm, Terraform

* [`docker-compose.seal.yaml`](docker-compose.seal.yaml) is the template the installer renders. The installer embeds a
  byte-identical copy so `curl | sh` needs no other file.
* [`helm/charts/seal`](helm/charts/seal): one pod per model with the engine and the sidecar, a ConfigMap built from
  `values.seal` (the chart's defaults are a valid `seal.yaml`) and a Service for the sidecar port only. It refuses
  images not pinned by digest and the same TDX rules as the schema. Schedule it on confidential nodes with
  `nodeSelector`, `tolerations` and `runtimeClassName`. Run `helm lint deploy/seal/helm/charts/seal --set ...` if you
  have Helm; the test suite checks the templates as files either way.
* [`terraform/`](terraform): each module creates the VM and stages the installer in `/opt/anyroute-seal` with its
  options; you start your engine and run it. `terraform fmt` and `terraform validate` were not run here (Terraform is not
  installed in this environment); run `terraform init && terraform validate` in a module before relying on it.
  * `gcp-confidential`: an A3 High VM (`a3-highgpu-1g`, H100) as an Intel TDX confidential VM. The attested lanes work
    here. Check zone, capacity (Spot or flex-start) and a TDX-capable image with the CC driver first.
  * `azure-ncc-h100`: an NCC H100 v5 VM. **Its CPU TEE is AMD SEV-SNP, which is CPU-attested only**: SNP has no runtime
    measurement register to bind GPU evidence into, so a GPU-CC claim is not supported there, and the sidecar has no
    SEV-SNP evidence provider yet. The module fixes `--tee sev-snp --cc-mode off --lanes public`.
  * `phala`: a placeholder that creates nothing. It prints the commands (the sidecar's onboarding CLI writes the pinned
    compose file; the Phala CLI deploys it) with provider notes.

## The seal CLI

```sh
bun scripts/seal-cli.ts init --tee tdx --hf-repo <owner/name> --weights-sha256 sha256:<hex> \
  --price-in 0.2 --price-out 0.9 --region eu-west          # writes seal.yaml (--force keeps host_id and nodes)
bun scripts/seal-cli.ts add-node --name n1 --endpoint https://n1.example:8443
bun scripts/seal-cli.ts verify https://n1.example:8443 [--router <url> --id <provider id>]
bun scripts/seal-cli.ts status                               # /healthz of every node, digest compared
bun scripts/seal-cli.ts validate seal.yaml
```

`seal verify` fetches `/attest` twice (boot, and fresh with a random nonce) over a TLS connection whose certificate it
keeps, then runs the client SDK's checks (`packages/client`): report data binds the TLS, receipt and model digests, the
certificate carries the attestation name and the attested key, the fresh quote echoes the nonce, and the model digest is
the one in `seal.yaml`. It exits 1 on any failure. Without `--router` it does not see the router's verification of the
quote signature, and says so. `seal status` is liveness only.

## Honest limits

* Trust rests on Intel, AMD and NVIDIA silicon, reproducible builds and published measurements, not on a cryptographic
  proof of inference.
* The sidecar binds the CPU quote only. It does not yet collect NVIDIA GPU evidence into its own quote; `gpu.cc_mode` is
  your declaration until that lands (spec status table: planned).
* SEV-SNP hosts cannot carry confidential-GPU claims, and cannot be attested by the sidecar today.
* On a bare TDX host nothing measures the compose file into a register; the sidecar hashes it and binds that hash as
  data it declares. On dstack the platform measures it.
* `seal.yaml` prices, lanes and royalties are what you declare to the router; its operator reviews them.
* `get.anyroute.xyz/seal` and `verify.anyroute.xyz` are planned addresses, not live yet. Nothing in this folder calls
  them.

## Tests

`bun test test/seal-install.test.ts`: runs the installer against a fake engine in a temp dir (dry run, re-run, refusals,
and `--apply` with a stand-in `docker`), checks `seal.yaml` validation, the CLI, and the Compose, Helm and Terraform files.
shellcheck, helm and terraform run too when installed.

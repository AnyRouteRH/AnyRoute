# Phala Cloud (dstack, Intel TDX): placeholder module.
#
# It creates nothing. Phala Cloud deploys a dstack app from a docker-compose file through its CLI or dashboard, and this
# repository does not assume a Terraform provider for it. The module renders what you hand to Phala: the compose file
# the sidecar's Phala example uses, with your values, and the CLI commands to deploy and check it.
#
# Provider notes:
# - dstack measures the compose file into the quote; the sidecar reads its own evidence through the guest agent socket
#   (attestation.provider: dstack). Keep every image pinned by digest.
# - GPU nodes run vLLM in the CVM; CPU nodes run llama.cpp. Weights are downloaded inside the VM and checked by digest
#   (see sidecar/examples/phala/README.md and `bun sidecar/src/cli.ts init --target phala-gpu`).
# - The commands follow sidecar/examples/phala/README.md. Check them against `npx -y phala --help` before running.

terraform {
  required_version = ">= 1.5"
}

locals {
  compose_file = abspath(var.compose_file)
  commands = [
    "bun sidecar/src/cli.ts init --target ${var.gpu ? "phala-gpu" : "phala-cpu"} --out ${var.out_dir}   # writes the pinned compose file and sidecar.yaml",
    "npx -y phala deploy -n ${var.name} -c ${local.compose_file}${var.node_type != "" ? " -t ${var.node_type}" : ""} --wait",
    "npx -y phala cvms attestation ${var.name} --json   # the compose hash dstack measured",
    "bun scripts/seal-cli.ts verify https://<the app's 8443 endpoint>",
  ]
}

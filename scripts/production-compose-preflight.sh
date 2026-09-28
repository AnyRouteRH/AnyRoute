#!/usr/bin/env bash
set -euo pipefail

mode=${1:-production}
digest_ref() { [[ ${1:-} =~ ^[^[:space:]@]+@sha256:[0-9a-fA-F]{64}$ ]]; }
required_digest() {
  local name=$1 value=${!1:-}
  if ! digest_ref "$value"; then
    printf 'Preflight failed: %s must be an image reference pinned by @sha256 digest.\n' "$name" >&2
    return 1
  fi
}

if [[ "$mode" != "production" && "$mode" != "--topology-fixture" ]]; then
  echo 'Usage: scripts/production-compose-preflight.sh [--topology-fixture]' >&2
  exit 2
fi

required_digest POSTGRES_IMAGE
required_digest REDIS_IMAGE

if [[ "$mode" == "--topology-fixture" ]]; then
  required_digest FOUNDRY_IMAGE
  if [[ -z ${ANYROUTE_IMAGE:-} ]] || ! docker image inspect "$ANYROUTE_IMAGE" >/dev/null 2>&1; then
    echo 'Preflight failed: the already-built local topology fixture image is unavailable.' >&2
    exit 1
  fi
  echo 'PASS: topology fixture database and Foundry images are digest-pinned; the CI application image exists.'
  exit 0
fi

required_digest ANYROUTE_IMAGE
echo 'PASS: application, PostgreSQL, and Redis image references are immutable digests.'

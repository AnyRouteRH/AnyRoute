#!/usr/bin/env bash
set -euo pipefail
tool=$1; shift
case "$tool" in forge|anvil|cast) ;; *) echo 'Unknown Foundry tool' >&2; exit 2 ;; esac
if [ -n "${FOUNDRY_BIN:-}" ]; then
  exec "$FOUNDRY_BIN/$tool" "$@"
elif command -v "$tool" >/dev/null 2>&1; then
  exec "$tool" "$@"
else
  exec "$HOME/.foundry/bin/$tool" "$@"
fi

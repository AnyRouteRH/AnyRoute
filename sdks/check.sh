#!/usr/bin/env bash
# Run every SDK's offline test suite. CI-friendly: each suite needs only its own toolchain (bun, uv, go) and a
# package install; none of them talks to a live router. Pass suite names to run a subset:
#   bash sdks/check.sh                 # all
#   bash sdks/check.sh typescript go   # some
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
all=(typescript python go langchain-js langchain-python llamaindex-python)
if [ "$#" -gt 0 ]; then suites=("$@"); else suites=("${all[@]}"); fi
failed=()

py() { # <dir>: a venv per package, installed with its test extra
  (cd "$here/$1" && uv venv -q --allow-existing && uv pip install -q -e '.[test]' && uv run --no-sync pytest -q)
}

for s in "${suites[@]}"; do
  echo "==> $s"
  case "$s" in
    typescript) (cd "$here/typescript" && bun install && bun run typecheck && bun test && bun run build) ;;
    langchain-js) (cd "$here/langchain-js" && bun install && bun run typecheck && bun test) ;;
    python | langchain-python | llamaindex-python) py "$s" ;;
    go) (cd "$here/go" && go vet ./... && go test ./...) ;;
    *) echo "unknown suite: $s" >&2; exit 2 ;;
  esac || failed+=("$s")
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "failed: ${failed[*]}" >&2
  exit 1
fi
echo "all SDK suites passed: ${suites[*]}"

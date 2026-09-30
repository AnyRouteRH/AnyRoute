#!/usr/bin/env bash
set -euo pipefail
if [ -f bun.lock ]; then bun test; elif [ -f package.json ]; then npm test; else pytest -q; fi

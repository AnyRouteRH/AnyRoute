#!/usr/bin/env bash
set -euo pipefail
git diff --cached --stat
git diff --cached --unified=0 | head -n 400

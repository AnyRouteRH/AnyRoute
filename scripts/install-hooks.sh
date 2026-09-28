#!/usr/bin/env bash
# Preserve any existing repository/worktree publication lock. Never change global config.
set -euo pipefail
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
current=$(git config --get core.hooksPath || true)
[ -n "$current" ] || git config --local core.hooksPath .githooks

#!/usr/bin/env bash
set -euo pipefail
repo="$1"
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$repo/issues?state=open&per_page=50"

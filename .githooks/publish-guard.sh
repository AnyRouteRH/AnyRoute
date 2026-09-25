#!/usr/bin/env bash
# Publish guard for a public repo. Blocks commits and pushes that carry:
#   - an author/committer email other than `git config anyroute.allowedEmail`, or not matching the
#     extended regex in $ANYROUTE_ALLOWED_EMAIL_RE / `git config anyroute.allowedEmailPattern` (CI, other contributors)
#   - an empty name/email or one derived from the machine ((none), *.local, *.lan, localhost)
#   - an author/committer date that is not UTC (+0000): the offset reveals where you are
#   - files that must stay local (.env*, keys, .data/, and any regex in .git/info/publish-denypaths)
#   - secrets (provider/GitHub/AWS tokens, PEM keys, 32-byte hex not in public-hex-allowlist.txt)
#   - any string listed in .git/info/publish-denylist (local only, never pushed)
#
# Usage: publish-guard.sh staged | message <file> | range <rev-list args...>
set -euo pipefail

root=$(git rev-parse --show-toplevel)
gitdir=$(git rev-parse --git-common-dir)
denylist="$gitdir/info/publish-denylist"
denypaths="$gitdir/info/publish-denypaths"
hex_allow="$root/.githooks/public-hex-allowlist.txt"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Checks run in pipelines (subshells), so failure is a marker file, not a variable.
err() { printf 'publish-guard: %s\n' "$*" >&2; : > "$tmp/failed"; }

# Denylist without comments/blank lines, as fixed strings.
grep -vE '^\s*(#|$)' "$denylist" 2>/dev/null > "$tmp/deny" || true

allowed_re=${ANYROUTE_ALLOWED_EMAIL_RE:-$(git config --get anyroute.allowedEmailPattern || true)}
allowed=$(git config --get anyroute.allowedEmail || true)
if [ -n "$allowed_re" ]; then
  rc=0; grep -qE -- "$allowed_re" < /dev/null 2>/dev/null || rc=$?
  [ "$rc" -ne 2 ] || { echo "publish-guard: invalid allowed email pattern: $allowed_re" >&2; exit 1; }
elif [ -z "$allowed" ]; then
  echo "publish-guard: no publishing identity set. Run: git config anyroute.allowedEmail <email>" >&2
  exit 1
fi

check_ident() { # <label> <name> <email>
  if [ -n "$allowed_re" ]; then
    printf '%s\n' "$3" | grep -qxE -- "$allowed_re" || err "$1 email '$3' does not match the allowed pattern ($allowed_re)"
  else
    [ "$3" = "$allowed" ] || err "$1 email '$3' is not the publishing identity ($allowed)"
  fi
  [ -n "$2" ] || err "$1 name is empty"
  case $(printf '%s' "$3" | tr '[:upper:]' '[:lower:]') in
    '') err "$1 email is empty" ;;
    *'(none)'*|*.local|*.lan|*.localdomain|*localhost*) err "$1 email '$3' is derived from this machine; set user.email explicitly" ;;
  esac
  if [ -s "$tmp/deny" ] && printf '%s\n%s\n' "$2" "$3" | grep -qiF -f "$tmp/deny"; then
    err "$1 identity matches the local denylist"
  fi
}

check_tz() { # <label> <+hhmm offset>
  case "$2" in
    +0000|-0000) ;;
    *) err "$1 date is in UTC$2, which reveals your timezone"; : > "$tmp/tz" ;;
  esac
}

bad_path_re='(^|/)\.env($|\.)|\.(pem|key|p12|pfx|keystore)$|(^|/)id_(rsa|ecdsa|ed25519)|^\.data/'
# Local-only path patterns (one extended regex per line), e.g. private folders that must never be published.
while IFS= read -r extra; do bad_path_re="$bad_path_re|$extra"; done < <(grep -vE '^\s*(#|$)' "$denypaths" 2>/dev/null || true)
token_re='-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-(ant-|proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}'

check_paths() { # stdin: one path per line
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in *.env.example) continue ;; esac
    printf '%s\n' "$p" | grep -qE "$bad_path_re" && err "path must stay local: $p"
  done
  return 0
}

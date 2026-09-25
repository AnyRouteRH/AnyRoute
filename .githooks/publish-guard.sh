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

# stdin: "<path>\t<added line>" (path may be "commit message")
check_lines() {
  cat > "$tmp/lines"
  grep -nE -- "$token_re" "$tmp/lines" | cut -f1 | sort -u | while IFS= read -r hit; do
    echo "publish-guard: secret-like token in ${hit#*:}" >&2
  done || true
  if grep -qE -- "$token_re" "$tmp/lines"; then : > "$tmp/failed"; fi

  # Vendored libraries (contracts/lib/) carry public curve constants and fixtures.
  grep -v '^contracts/lib/' "$tmp/lines" > "$tmp/own" || true
  grep -oE '0x[0-9a-fA-F]{64}' "$tmp/own" | tr 'A-F' 'a-f' | sort -u > "$tmp/hex" || true
  if [ -s "$tmp/hex" ]; then
    grep -vxF -f <(grep -v '^#' "$hex_allow") "$tmp/hex" > "$tmp/hex_bad" || true
    if [ -s "$tmp/hex_bad" ]; then
      while IFS= read -r h; do
        where=$(grep -iF "$h" "$tmp/own" | head -1 | cut -f1)
        err "unlisted 32-byte hex ${h:0:8}…${h:62} in $where (a private key? if public, add it to .githooks/public-hex-allowlist.txt)"
      done < "$tmp/hex_bad"
    fi
  fi

  if [ -s "$tmp/deny" ] && grep -qiF -f "$tmp/deny" "$tmp/lines"; then
    grep -iF -f "$tmp/deny" "$tmp/lines" | cut -f1 | sort -u | while IFS= read -r where; do
      err "denylisted string in $where (see $denylist)"
    done
  fi
  return 0
}

added_lines() { # stdin: unified diff
  awk '/^\+\+\+ /{f=substr($0,7); next} /^\+/{print f "\t" substr($0,2)}'
}

case "${1:-}" in
  staged)
    tz_fix="export TZ=UTC in your shell (or alias git='TZ=UTC git'), then retry (when amending, add --reset-author)."
    ident=$(git var GIT_AUTHOR_IDENT); name=${ident% <*}; email=${ident#*<}; email=${email%%>*}
    check_ident author "$name" "$email"; check_tz author "${ident##* }"
    ident=$(git var GIT_COMMITTER_IDENT); name=${ident% <*}; email=${ident#*<}; email=${email%%>*}
    check_ident committer "$name" "$email"; check_tz committer "${ident##* }"
    git diff --cached --name-only --diff-filter=ACMR | check_paths
    git diff --cached -U0 --no-color --no-ext-diff --diff-filter=ACMR | added_lines | check_lines
    ;;
  message)
    { grep -v '^#' "$2" || true; } | sed 's/^/commit message\t/' | check_lines
    ;;
  range)
    shift
    tz_fix="export TZ=UTC in your shell (or alias git='TZ=UTC git'), rewrite the flagged commits with git rebase --reset-author-date <base> (or --root), then retry."
    # \x1f, not tab: tab is IFS whitespace, so an empty field would shift the rest.
    git log --format='%h%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%ad%x1f%cd' --date=raw "$@" > "$tmp/commits"
    while IFS=$'\x1f' read -r h an ae cn ce ad cd; do
      check_ident "commit $h author" "$an" "$ae"
      check_ident "commit $h committer" "$cn" "$ce"
      check_tz "commit $h author" "${ad##* }"
      check_tz "commit $h committer" "${cd##* }"
    done < "$tmp/commits"
    git log --format= --name-only --diff-filter=ACMR "$@" | sort -u | check_paths
    { git log -p -U0 --no-color --no-ext-diff --format= "$@" | added_lines
      git log --format=%B "$@" | sed 's/^/commit message\t/'; } | check_lines
    ;;
  *)
    echo "usage: publish-guard.sh staged | message <file> | range <rev-list args...>" >&2
    exit 2
    ;;
esac

[ ! -e "$tmp/tz" ] || echo "publish-guard: to commit in UTC: $tz_fix" >&2
if [ -e "$tmp/failed" ]; then
  echo "publish-guard: blocked. Fix the above (or bypass once with --no-verify if you are sure)." >&2
  exit 1
fi

#!/usr/bin/env bash
# Configure PostgreSQL through PGSERVICE/PG* or a secret-manager-provided pgpass file.
set -euo pipefail
umask 077
: "${PGDATABASE:?Select the database explicitly through PostgreSQL environment variables}"
: "${AGE_RECIPIENT:?Supply the public age recipient, never a private identity here}"
out=${1:?usage: backup-db.sh /private/path/backup.dump.age}
[ ! -e "$out" ] || { echo 'Refusing to overwrite an existing backup.' >&2; exit 1; }
tmp=$(mktemp "${out}.partial.XXXXXX")
trap 'rm -f "$tmp"' EXIT
pg_dump --format=custom --no-owner --no-acl | age -r "$AGE_RECIPIENT" > "$tmp"
[ -s "$tmp" ] || { echo 'Empty backup.' >&2; exit 1; }
# Hard-link publication refuses races/overwrites on the same filesystem.
ln "$tmp" "$out"
shasum -a 256 "$out" > "${out}.sha256"
echo 'Encrypted snapshot created; copy it to the approved off-host store and verify restore.'

#!/usr/bin/env bash
# Restore only to an explicitly selected empty database; never overwrites an existing schema.
set -euo pipefail
umask 077
: "${PGDATABASE:?Select a fresh isolated database explicitly}"
: "${RESTORE_ACK:?Set RESTORE_ACK=isolated-empty-database after verifying the target}"
[ "$RESTORE_ACK" = isolated-empty-database ] || exit 2
: "${AGE_IDENTITY_FILE:?Provide the approved recovery identity path through the secret manager}"
input=${1:?usage: restore-db.sh /private/path/backup.dump.age}
count=$(psql -X -At -v ON_ERROR_STOP=1 -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")
[ "$count" = 0 ] || { echo 'Refusing to restore into a nonempty database.' >&2; exit 1; }
age -d -i "$AGE_IDENTITY_FILE" "$input" | pg_restore --dbname="$PGDATABASE" --no-owner --no-acl --exit-on-error --single-transaction
echo 'Restored. Keep workers/ingress off until ledger, encryption and chain reconciliation pass.'

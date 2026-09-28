#!/usr/bin/env bash
# Restore only to an explicitly selected empty database; never overwrites an existing schema.
set -euo pipefail
umask 077
: "${PGDATABASE:?Select a fresh isolated database explicitly}"
: "${RESTORE_ACK:?Set RESTORE_ACK=isolated-empty-database after verifying the target}"
[ "$RESTORE_ACK" = isolated-empty-database ] || exit 2
: "${AGE_IDENTITY_FILE:?Provide the approved recovery identity path through the secret manager}"
input=${1:?usage: restore-db.sh /private/path/backup.dump.age}
# Authenticate the complete encrypted stream before giving any bytes to pg_restore.
# A pipeline can let pg_restore commit before age reports a late authentication failure.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
age -d -i "$AGE_IDENTITY_FILE" "$input" > "$work/snapshot.dump"
pg_restore --list "$work/snapshot.dump" >/dev/null
count=$(psql -X -At -v ON_ERROR_STOP=1 -c "
  select
    (select count(*) from pg_namespace where nspname !~ '^pg_' and nspname not in ('public','information_schema')) +
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema') +
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema') +
    (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')")
[ "$count" = 0 ] || { echo 'Refusing to restore into a nonempty database.' >&2; exit 1; }
pg_restore --dbname="$PGDATABASE" --no-owner --no-acl --exit-on-error --single-transaction "$work/snapshot.dump"
echo 'Restored. Keep workers/ingress off until ledger, encryption and chain reconciliation pass.'

#!/usr/bin/env bash
# Run only against a disposable PostgreSQL cluster with permission to create databases.
set -euo pipefail
umask 077
[ "${RECOVERY_DRILL_ACK:-}" = disposable-cluster ] || { echo 'Set RECOVERY_DRILL_ACK=disposable-cluster for a fixture cluster.' >&2; exit 2; }
for tool in createdb dropdb psql pg_dump pg_restore age age-keygen bun; do command -v "$tool" >/dev/null; done
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
base="anyroute_drill_$(date +%s)_$$"
source_db="${base}_source"
restore_db="${base}_restore"
source_created=false
restore_created=false
cleanup() {
  if "$source_created"; then dropdb --if-exists "$source_db"; fi
  if "$restore_created"; then dropdb --if-exists "$restore_db"; fi
  rm -rf "$work"
}
trap cleanup EXIT
createdb "$source_db"; source_created=true
createdb "$restore_db"; restore_created=true
# Test identities are generated for this drill and removed on exit; no real recovery key is read.
age-keygen -o "$work/identity" 2>"$work/keygen.log"
export AGE_RECIPIENT
AGE_RECIPIENT=$(age-keygen -y "$work/identity")
export AGE_IDENTITY_FILE="$work/identity"
export DRILL_APP_SECRET
DRILL_APP_SECRET=$(bun --no-env-file -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')
export PGDATABASE="$source_db"
bun --no-env-file "$root/scripts/recovery-drill.ts" seed
bash "$root/scripts/backup-db.sh" "$work/snapshot.dump.age"
shasum -a 256 -c "$work/snapshot.dump.age.sha256"
# Both overwrite protection and restore target protection must hold.
if bash "$root/scripts/backup-db.sh" "$work/snapshot.dump.age" >/dev/null 2>&1; then echo 'Backup overwrite was accepted' >&2; exit 1; fi
export PGDATABASE="$restore_db" RESTORE_ACK=isolated-empty-database
# Corrupt the last authentication chunk: no archive bytes may reach the database.
bun --no-env-file -e 'const p=process.argv[1]; const data=new Uint8Array(await Bun.file(p).arrayBuffer()); data[data.length-1]^=1; await Bun.write(process.argv[2],data)' "$work/snapshot.dump.age" "$work/corrupt.dump.age"
if bash "$root/scripts/restore-db.sh" "$work/corrupt.dump.age" >/dev/null 2>&1; then echo 'Corrupt encrypted restore was accepted' >&2; exit 1; fi
[ "$(psql -X -At -v ON_ERROR_STOP=1 -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")" = 0 ] || { echo 'Corrupt restore changed the target' >&2; exit 1; }
# A database with no tables can still contain application objects and is not empty.
psql -X -v ON_ERROR_STOP=1 -c 'CREATE FUNCTION public.recovery_existing_object() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$' >/dev/null
if bash "$root/scripts/restore-db.sh" "$work/snapshot.dump.age" >/dev/null 2>&1; then echo 'Function-only nonempty restore was accepted' >&2; exit 1; fi
psql -X -v ON_ERROR_STOP=1 -c 'DROP FUNCTION public.recovery_existing_object(); CREATE SCHEMA recovery_existing_schema' >/dev/null
if bash "$root/scripts/restore-db.sh" "$work/snapshot.dump.age" >/dev/null 2>&1; then echo 'Existing-schema restore was accepted' >&2; exit 1; fi
psql -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA recovery_existing_schema' >/dev/null
start=$(date +%s)
bash "$root/scripts/restore-db.sh" "$work/snapshot.dump.age"
bun --no-env-file "$root/scripts/recovery-drill.ts" verify
if bash "$root/scripts/restore-db.sh" "$work/snapshot.dump.age" >/dev/null 2>&1; then echo 'Nonempty restore was accepted' >&2; exit 1; fi
printf 'Disposable encrypted recovery drill passed; restore and reconciliation took %s seconds.\n' "$(( $(date +%s) - start ))"

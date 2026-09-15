#!/usr/bin/env bash
# Project-local Postgres 16 (:55432) and Redis (:56379) under .data/ — nothing system-wide.
#   scripts/services.sh up | down | status
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data
case "${1:-status}" in
  up)
    [ -d .data/pg ] || initdb -D .data/pg -U postgres --auth=trust >/dev/null
    pg_ctl -D .data/pg -o "-p 55432 -k /tmp" -l .data/pg.log status >/dev/null 2>&1 || pg_ctl -D .data/pg -o "-p 55432 -k /tmp" -l .data/pg.log start >/dev/null
    redis-cli -p 56379 ping >/dev/null 2>&1 || redis-server --port 56379 --dir .data --daemonize yes --save "" --appendonly no --logfile redis.log
    echo "postgres://postgres@127.0.0.1:55432/postgres  redis://127.0.0.1:56379" ;;
  down)
    pg_ctl -D .data/pg stop >/dev/null 2>&1 || true
    redis-cli -p 56379 shutdown nosave >/dev/null 2>&1 || true
    echo "stopped" ;;
  status)
    pg_isready -h /tmp -p 55432 || true
    redis-cli -p 56379 ping 2>/dev/null || echo "redis: down" ;;
esac

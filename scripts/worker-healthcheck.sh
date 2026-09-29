#!/bin/sh
# Worker container healthcheck. Read-only: it never starts the application, registers or runs a
# job, or contacts PostgreSQL/Redis, so probing or restarting cannot duplicate privileged work.
# src/worker.ts rewrites the heartbeat (epoch seconds) only while its jobs tick on schedule.
file=${WORKER_HEARTBEAT_FILE:-/tmp/anyroute-worker.heartbeat}
max_age=${WORKER_HEARTBEAT_MAX_AGE_S:-60}
[ -f "$file" ] || exit 1
read -r beat < "$file" || exit 1
case $beat in ''|*[!0-9]*) exit 1 ;; esac
age=$(( $(date +%s) - beat ))
[ "$age" -ge -5 ] && [ "$age" -le "$max_age" ]

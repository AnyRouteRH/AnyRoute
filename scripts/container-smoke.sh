#!/usr/bin/env bash
# Isolated CI smoke test: generated fixtures, no live secrets, no transactions.
set -euo pipefail
run="anyroute-smoke-$$"
cleanup() { docker rm -f "$run-api" "$run-pg" "$run-redis" >/dev/null 2>&1 || true; docker network rm "$run" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$run" >/dev/null
docker run -d --name "$run-pg" --network "$run" -e POSTGRES_PASSWORD=fixture-only-ci-password postgres:16.6 >/dev/null
docker run -d --name "$run-redis" --network "$run" redis:8.0.2 redis-server --requirepass fixture-only-ci-password >/dev/null
for i in {1..40}; do docker exec "$run-pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
db="postgres://postgres:fixture-only-ci-password@$run-pg:5432/postgres"
docker run --rm --network "$run" -e DATABASE_URL="$db" anyroute:ci bun scripts/migrate.ts
docker run -d --name "$run-api" --network "$run" -p 127.0.0.1::8787 \
  -e ANYROUTE_ENV=production -e RUNTIME_ROLE=api -e AUTO_MIGRATE=false -e WORKERS=false \
  -e PUBLIC_BASE_URL=https://router.example -e DATABASE_URL="$db" \
  -e REDIS_URL="redis://:fixture-only-ci-password@$run-redis:6379" \
  -e APP_SECRET=fixture-application-secret-for-container-tests-only \
  -e ADMIN_TOKEN=fixture-admin-token-for-container-tests-only \
  -e CREDITS_ADDRESS=0x1111111111111111111111111111111111111111 \
  -e CALLPAY_ADDRESS=0x2222222222222222222222222222222222222222 \
  -e RECEIPT_ANCHOR_ADDRESS=0x3333333333333333333333333333333333333333 \
  -e RHC_RPC_URL=http://127.0.0.1:1 \
  -e ROUTER_PRIVATE_KEY="0x$(printf '3%.0s' {1..64})" anyroute:ci >/dev/null
port=$(docker port "$run-api" 8787/tcp | sed 's/.*://')
for i in {1..40}; do curl -fsS "http://127.0.0.1:$port/health" >/dev/null && break; sleep 1; done
curl -fsS "http://127.0.0.1:$port/health" >/dev/null
curl -fsS "http://127.0.0.1:$port/docs/" >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/ready")" = 503 ]
echo 'PASS: production container reachable; docs present; readiness rejects missing chain/providers/workers.'

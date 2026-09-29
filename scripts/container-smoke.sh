#!/usr/bin/env bash
# Isolated CI smoke test: generated fixtures, no live secrets, no transactions.
set -euo pipefail
# Fixture images use the same reviewed digests as .github/workflows/release-checks.yml.
# Overrides are accepted only when they are also pinned by digest; mutable tags are rejected.
postgres_image=${POSTGRES_IMAGE:-postgres:16.6@sha256:557fea37a744d5f4c8faab304b0a90858b53ab119735a88c131fd19dab802f36}
redis_image=${REDIS_IMAGE:-redis:8.0.2@sha256:b43d2dcbbdb1f9e1582e3a0f37e53bf79038522ccffb56a25858969d7a9b6c11}
for ref in "$postgres_image" "$redis_image"; do
  [[ $ref =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || { echo "Refusing mutable fixture image reference: $ref" >&2; exit 2; }
done
run="anyroute-smoke-$$"
cleanup() { docker rm -f "$run-api" "$run-worker" "$run-pg" "$run-redis" >/dev/null 2>&1 || true; docker network rm "$run" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$run" >/dev/null
docker run -d --name "$run-pg" --network "$run" -e POSTGRES_PASSWORD=fixture-only-ci-password "$postgres_image" >/dev/null
docker run -d --name "$run-redis" --network "$run" "$redis_image" redis-server --requirepass fixture-only-ci-password >/dev/null
for _ in {1..40}; do docker exec "$run-pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
db="postgres://postgres:fixture-only-ci-password@$run-pg:5432/postgres"
docker run --rm --network "$run" -e DATABASE_URL="$db" anyroute:ci bun scripts/migrate.ts
fixture_env=(
  -e ANYROUTE_ENV=production -e AUTO_MIGRATE=false
  -e PUBLIC_BASE_URL=https://router.example -e DATABASE_URL="$db"
  -e REDIS_URL="redis://:fixture-only-ci-password@$run-redis:6379"
  -e APP_SECRET=fixture-application-secret-for-container-tests-only
  -e ADMIN_TOKEN=fixture-admin-token-for-container-tests-only
  -e CREDITS_ADDRESS=0x1111111111111111111111111111111111111111
  -e CALLPAY_ADDRESS=0x2222222222222222222222222222222222222222
  -e PROVIDER_BOND_ADDRESS=0x4444444444444444444444444444444444444444
  -e RECEIPT_ANCHOR_ADDRESS=0x3333333333333333333333333333333333333333
  -e RHC_RPC_URL=http://127.0.0.1:1
)
docker run -d --name "$run-api" --network "$run" -p 127.0.0.1::8787 "${fixture_env[@]}" \
  -e RUNTIME_ROLE=api -e WORKERS=false \
  -e ROUTER_PRIVATE_KEY="0x$(printf '3%.0s' {1..64})" anyroute:ci >/dev/null
port=$(docker port "$run-api" 8787/tcp | sed 's/.*://')
for _ in {1..40}; do curl -fsS "http://127.0.0.1:$port/health" >/dev/null && break; sleep 1; done
curl -fsS "http://127.0.0.1:$port/health" >/dev/null
curl -fsS "http://127.0.0.1:$port/docs/" >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/ready")" = 503 ]
# An unprivileged worker must become healthy from its heartbeat alone (the same read-only check
# Compose uses); the image's HTTP readiness check does not apply to workers.
docker run -d --name "$run-worker" --network "$run" "${fixture_env[@]}" \
  -e RUNTIME_ROLE=worker -e WORKERS=true -e WORKER_JOBS=health-flush,holds-expire,catalog-refresh \
  --health-cmd 'sh scripts/worker-healthcheck.sh' --health-interval 2s --health-retries 3 --health-start-period 30s \
  anyroute:ci bun src/worker.ts >/dev/null
worker_health=starting
for _ in {1..60}; do
  worker_health=$(docker inspect --format '{{.State.Health.Status}}' "$run-worker")
  [ "$worker_health" = healthy ] && break
  sleep 1
done
[ "$worker_health" = healthy ] || { echo "Worker heartbeat healthcheck stayed $worker_health." >&2; docker logs --tail 40 "$run-worker" >&2 || true; exit 1; }
echo 'PASS: production container reachable; docs present; readiness rejects missing chain/providers/workers; worker heartbeat is healthy.'

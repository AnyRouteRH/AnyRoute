#!/usr/bin/env bash
# Full production Compose graph against disposable, fixture-only services.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo 'SKIP: Docker is unavailable or its daemon is stopped; no daemon was started.' >&2
  exit 77
fi
if [[ ${TOPOLOGY_SMOKE_ACK:-} != disposable-docker-host ]]; then
  echo 'Set TOPOLOGY_SMOKE_ACK=disposable-docker-host only on a disposable CI Docker host; the fixture temporarily adds a Docker bridge route.' >&2
  exit 2
fi
for tool in node openssl curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 2; }
done
for tool in anvil forge cast; do
  bash scripts/foundry.sh "$tool" --version >/dev/null 2>&1 || { echo "Missing Foundry tool: $tool" >&2; exit 2; }
done

export ANYROUTE_IMAGE=${ANYROUTE_IMAGE:-anyroute:ci}
: "${POSTGRES_IMAGE:?Set POSTGRES_IMAGE to a reviewed @sha256-pinned PostgreSQL image}"
: "${REDIS_IMAGE:?Set REDIS_IMAGE to a reviewed @sha256-pinned Redis image}"
: "${FOUNDRY_IMAGE:?Set FOUNDRY_IMAGE to a reviewed @sha256-pinned Foundry image}"
bash scripts/production-compose-preflight.sh --topology-fixture

tmp=$(mktemp -d "${TMPDIR:-/tmp}/anyroute-topology.XXXXXX")
project="anyroute-topology-$$"
anvil_port=${TOPOLOGY_ANVIL_PORT:-18545}
http_port=${TOPOLOGY_HTTP_PORT:-18787}
rpc="http://127.0.0.1:${anvil_port}"
compose=(docker compose --project-name "$project" --env-file "$tmp/compose.env" -f docker-compose.yml -f docker-compose.production-topology.yml)
compose_started=0
anvil_started=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 && compose_started )); then
    echo 'Topology smoke failed; recent fixture status and service logs follow (credentials/env files are never dumped).' >&2
    "${compose[@]}" ps >&2 || true
    "${compose[@]}" logs --no-color --tail 80 anvil mock-provider postgres redis migrate runtime-role-grants provider-init router registry-worker settlement-worker anchor-worker >&2 || true
  fi
  if (( compose_started )); then
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT INT TERM

if (curl -fsS "http://127.0.0.1:${http_port}/health" >/dev/null 2>&1); then
  echo "Topology HTTP port $http_port is already in use; choose TOPOLOGY_HTTP_PORT." >&2
  exit 2
fi
if bash scripts/foundry.sh cast rpc eth_chainId --rpc-url "$rpc" >/dev/null 2>&1; then
  echo "Topology Anvil port $anvil_port is already in use; choose TOPOLOGY_ANVIL_PORT." >&2
  exit 2
fi

# These fixed keys are the documented Anvil mnemonic fixtures. They have no value outside this test.
fixture_deployer_key=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
router_key=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
settlement_key=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
anchorer_key=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
pg_password=$(openssl rand -hex 24)
redis_password=$(openssl rand -hex 24)
runtime_password=$(openssl rand -hex 24)
app_secret=$(openssl rand -hex 32)
admin_token=$(openssl rand -hex 24)
provider_token=$(openssl rand -hex 24)

mkdir -p "$tmp/output/deployments"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$tmp/output/tls.key" -out "$tmp/output/tls.crt" \
  -subj '/CN=mock-provider' \
  -addext 'subjectAltName=DNS:mock-provider' \
  -addext 'basicConstraints=critical,CA:TRUE' >/dev/null 2>&1
chmod 600 "$tmp/output/tls.key"

cat >"$tmp/providers.yaml" <<'YAML'
providers:
  - id: topology-fixture
    name: Production Topology Fixture
    base_url: https://mock-provider:9443/v1
    api_key_env: TOPOLOGY_PROVIDER_TOKEN
    status: live
    data_policy: { training: false, retains_prompts: false, retention_days: 0, zdr: true }
YAML
printf 'TOPOLOGY_PROVIDER_TOKEN=%s\n' "$provider_token" >"$tmp/provider-secrets.env"

write_env() {
  local usdg=${1:-0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168}
  local credits=${2:-0x1111111111111111111111111111111111111111}
  local callpay=${3:-0x2222222222222222222222222222222222222222}
  local anchor=${4:-0x3333333333333333333333333333333333333333}
  local provider_bond=${5:-0x4444444444444444444444444444444444444444}
  cat >"$tmp/compose.env" <<ENV
ANYROUTE_IMAGE=$ANYROUTE_IMAGE
POSTGRES_IMAGE=$POSTGRES_IMAGE
REDIS_IMAGE=$REDIS_IMAGE
FOUNDRY_IMAGE=$FOUNDRY_IMAGE
TOPOLOGY_ANVIL_PORT=$anvil_port
POSTGRES_PASSWORD=$pg_password
REDIS_PASSWORD=$redis_password
MIGRATION_DATABASE_URL=postgres://anyroute:$pg_password@postgres:5432/anyroute
DATABASE_URL=postgres://anyroute_runtime:$runtime_password@postgres:5432/anyroute
RUNTIME_DB_PASSWORD=$runtime_password
REDIS_URL=redis://:$redis_password@redis:6379
APP_SECRET=$app_secret
ADMIN_TOKEN=$admin_token
PUBLIC_BASE_URL=https://router.fixture.invalid
RHC_RPC_URL=http://anvil:8545
USDG_ADDRESS=$usdg
CREDITS_ADDRESS=$credits
CALLPAY_ADDRESS=$callpay
PROVIDER_BOND_ADDRESS=$provider_bond
RECEIPT_ANCHOR_ADDRESS=$anchor
ROUTER_PRIVATE_KEY=$router_key
SETTLEMENT_PRIVATE_KEY=$settlement_key
ANCHORER_PRIVATE_KEY=$anchorer_key
PROVIDERS_MANIFEST=$tmp/providers.yaml
PROVIDER_SECRETS_FILE=$tmp/provider-secrets.env
FIXTURE_OUTPUT_DIR=$tmp/output
TOPOLOGY_HTTP_PORT=$http_port
TOPOLOGY_PROVIDER_IP=45.67.88.10
ENV
}

write_env
"${compose[@]}" config --quiet
compose_started=1
"${compose[@]}" up -d --wait anvil
anvil_host_ready=0
for _ in {1..30}; do
  if bash scripts/foundry.sh cast rpc eth_chainId --rpc-url "$rpc" >/dev/null 2>&1; then
    anvil_host_ready=1
    break
  fi
  sleep 1
done
if (( ! anvil_host_ready )); then
  echo "Anvil became healthy in Compose but its loopback host port $anvil_port did not accept RPC connections." >&2
  exit 1
fi

# Work in a temporary copy so Foundry cannot mutate ignored build/deployment evidence in the repo.
cp -R "$root/contracts" "$tmp/contracts"
mkdir -p "$tmp/contracts/deployments"
ln -s "$root/node_modules" "$tmp/node_modules"
deployment_rel="deployments/.topology-${project}.json"
(cd "$tmp/contracts" && DEPLOYMENTS_PATH="$deployment_rel" MOCK=1 DEPLOYER_PRIVATE_KEY="$fixture_deployer_key" \
  bash "$root/scripts/foundry.sh" forge script script/Deploy.s.sol --rpc-url "$rpc" --broadcast --slow --private-key "$fixture_deployer_key")

read -r usdg credits callpay anchor provider_bond <<<"$(node -e 'const d=require(process.argv[1]);const c=d.contracts;process.stdout.write([c.usdg,c.credits,c.callPay,c.receiptAnchor,c.providerBond].join(" "))' "$tmp/contracts/$deployment_rel")"
if [[ -z "$credits" || -z "$provider_bond" ]]; then
  echo 'Fixture deployment did not produce the required contracts.' >&2
  exit 1
fi
write_env "$usdg" "$credits" "$callpay" "$anchor" "$provider_bond"
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build

base_url="http://127.0.0.1:${http_port}"
ready=0
for _ in {1..120}; do
  status=$(curl -sS -o "$tmp/ready.json" -w '%{http_code}' "$base_url/ready" || true)
  if [[ "$status" == 200 ]]; then ready=1; break; fi
  sleep 1
done
if (( ! ready )); then
  echo 'Production topology never reached ready=200.' >&2
  cat "$tmp/ready.json" >&2 || true
  "${compose[@]}" ps >&2 || true
  exit 1
fi
node -e 'const r=require(process.argv[1]);if(!r.ok||Object.values(r.checks).some(v=>v!==true))process.exit(1)' "$tmp/ready.json"

# The monitoring endpoint exposes readiness gauges only, never configuration or credentials.
curl -fsS "$base_url/ready/metrics" >"$tmp/readiness.prom"
grep -Eq '^anyroute_ready[[:space:]]+1$' "$tmp/readiness.prom"
grep -Eq '^anyroute_readiness_check\{check="database"\}[[:space:]]+1$' "$tmp/readiness.prom"

key_response=$(curl -fsS -H 'content-type: application/json' -d '{"name":"Disposable topology fixture"}' "$base_url/api/v1/keys")
fixture_key=$(printf '%s' "$key_response" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).key))')
"${compose[@]}" exec -e TOPOLOGY_SMOKE_ACK=disposable-docker-host -T router bun scripts/production-topology-provision.ts "$fixture_key" >"$tmp/account.json"

curl -fsS -H "authorization: Bearer $fixture_key" -H 'content-type: application/json' \
  -d '{"model":"anyroute/topology-fixture","messages":[{"role":"user","content":"integration smoke"}],"max_tokens":32}' \
  "$base_url/api/v1/chat/completions" >"$tmp/generation.json"
generation_id=$(node -e 'const r=require(process.argv[1]);if(!r.id)process.exit(1);process.stdout.write(r.id)' "$tmp/generation.json")
"${compose[@]}" exec -e TOPOLOGY_SMOKE_ACK=disposable-docker-host -T router bun scripts/production-topology-verify.ts "$generation_id" >"$tmp/evidence.json"
node -e 'const r=require(process.argv[1]);if(!r.generation||!r.usage_ledger_rows||!r.usage_ledger_matches_generation||Object.values(r.critical_worker_heartbeats).some(v=>!v)||r.unsafe_runtime_database_privileges?.length)process.exit(1)' "$tmp/evidence.json"

# Redis is required by the readiness rate limiter. Stopping it must remove traffic readiness.
"${compose[@]}" stop redis >/dev/null
not_ready=0
for _ in {1..20}; do
  status=$(curl -sS -o "$tmp/failure.json" -w '%{http_code}' "$base_url/ready" || true)
  if [[ "$status" == 503 ]]; then not_ready=1; break; fi
  sleep 1
done
if (( ! not_ready )); then
  echo 'Readiness stayed green after the authenticated Redis dependency stopped.' >&2
  exit 1
fi

echo 'PASS: production topology reached ready=200, served metrics and a real mock-provider chat call, recorded matching usage ledger data and core worker heartbeats, then returned ready=503 after Redis stopped.'
echo 'LIMIT: the fixed global-looking provider address is routed only inside the isolated Docker network; this does not prove public provider reachability.'

# Monitoring

AnyRoute exposes its health through three public, read-only endpoints. Several independent watchers read them, so no single component has to stay up to report that something is wrong.

| Endpoint | Meaning |
|---|---|
| `GET /health` | The API process is serving HTTP. It checks no dependencies. |
| `GET /ready` | `200` when every readiness check passes, `503` otherwise, with `{ ok, checks: { name: true/false } }`. No hostnames, credentials or error text. |
| `GET /ready/metrics` | The same checks as Prometheus gauges (`anyroute_ready`, `anyroute_readiness_check{check="…"}`). |

## Watchers

1. **Platform (Railway).** The API's deploy health check is `/health`, and services restart on failure. Turn on the workspace's deployment-failure and crash notifications, and use the service logs for detail. `/ready` is deliberately not the platform health check, because a failing dependency would block the deploy that fixes it.
2. **Monitoring agents on your own devices.** Poll `/ready`, or run the bundled probe from a checkout (see below). They keep working when the whole platform is down.
3. **Optional webhook.** The worker job `alert-notifier` evaluates readiness every minute. A check that fails for 2 minutes is announced once, and its recovery once. State lives in the database, so worker replicas never double-send. Without `ALERT_WEBHOOK_URL` it only records state.
4. **Prometheus and Alertmanager (Compose).** `compose.monitoring.yml` runs Prometheus with `monitoring/alerts.yml` and Alertmanager with `monitoring/alertmanager.yml`. The webhook URL is mounted from a secret file.

## Probe for monitoring agents

```sh
bun scripts/monitor.ts https://your-domain              # one JSON line, then exit
bun scripts/monitor.ts https://your-domain --watch 60   # one line every 60 seconds
```

It only sends `GET` requests, to `/health`, `/ready`, `/api/v1/escrow` and, if reachable, `/ready/metrics`. It sends no credentials and has no side effects. It prints one line such as:

```json
{"ok":false,"at":"2026-01-01T00:00:00.000Z","failing":["ready","ready.escrow-indexer"],"checks":{"health":true,"ready":false,"ready.database":true,"ready.escrow-indexer":false,"escrow.tokens":true,"escrow.prices":true},"escrow":{"enabled":true,"tokens":3,"stale_prices":[]},"metrics":{"reachable":true,"ready":false}}
```

Exit codes: `0` means everything passes, `1` means at least one check fails (named in `failing`), and `2` means the service is unreachable or the usage is invalid. A scheduler can alert on any non-zero exit. For example, cron every 5 minutes: `*/5 * * * * bun /path/to/scripts/monitor.ts https://your-domain || notify-me`.

## Optional webhook

Set `ALERT_WEBHOOK_URL` on the worker (it is a secret: an ntfy topic URL, a Slack or Discord incoming webhook, or any endpoint that accepts JSON) and add `alert-notifier` to `WORKER_JOBS`. The format is detected from the URL; `ALERT_WEBHOOK_FORMAT=ntfy|slack|discord|json` overrides it. Messages contain only check names, states and timestamps. Prove delivery with a clearly labelled synthetic alert:

```sh
ALERT_WEBHOOK_URL=… bun scripts/alert-drill.ts
```

Alertmanager (Compose) reads the same URL from the file named by `ALERT_WEBHOOK_URL_FILE`. For ntfy, append `?template=alertmanager` to the URL in that file.

## Runbook: readiness checks

| Check | Fails when | First action |
|---|---|---|
| `health` (probe) | The API does not answer. | Check the platform status and API logs, then redeploy the last good release. |
| `database` | PostgreSQL does not answer within 2 s. | Check the database service, its disk and its connection limits. |
| `rate_limiter` | Redis is unavailable. | Check the Redis service. Requests are rate-limited through it. |
| `providers` | No live provider can serve a model. | Check provider status and credentials, and the `provider-registry` job. |
| `catalog-refresh`, `provider-registry`, `escrow-indexer`, `chain-indexer`, `receipts-anchor`, `settlement`, `attestor` | That worker job has not succeeded within twice its interval (at least 60 s), or its last run failed. | Check the worker service logs. If every job is stale the worker is down: restart it. A single job failing usually means its dependency (RPC, provider) is failing. |
| `chain` | The RPC is unreachable, on the wrong chain, or the indexer cursor is too far behind. | Check the RPC provider, then the indexer job. |
| `escrow_finality` | The chain's finality point is more than an hour behind its head, so escrow deposits wait. | Check the chain's status and the RPC. Credits resume on their own once blocks finalize. |
| `escrow_reconciliation` | A credited deposit was reversed, a final transfer left the canonical chain, or an ANYR deposit was above `ANYR_ESCROW_MAX_USD_PER_DEPOSIT` (only the limit was credited), and no operator has reviewed it yet. | Review each flagged deposit in the admin interface and resolve the account balance. Then mark it reviewed. The check stays red until you do. |
| `root_completeness` | The latest spent root omits a funded key, overspends one, or does not reconcile (contracts mode). | Approve no root. Run `bun scripts/reconcile-roots.ts` and fix the cause first. |
| `chain_submissions` | A receipt anchor or spent root has been pending for over 2 minutes. | Check the anchoring worker's logs and signer balance. |
| `settlement_review` | A spent root has waited over 48 hours for approval. | Review and approve or reject it through the governance process. |
| `custody_controls`, `receipt_anchor_configured` | Contract controls or addresses are not in the expected state (contracts mode only). | Compare on-chain roles with the release manifest. Do not accept payments until they match. |
| `private_attestation_verifiers`, `private_attestation` | Private routing lacks a verifier, or no fresh attestation exists. | Check the verifier configuration and the `attestor` job. |
| `backup_fresh` | No verified off-host backup within `BACKUP_MAX_AGE_HOURS` (only with `BACKUP_REQUIRED=true`). | Check the `backup` cron service's last run and its one-line JSON result (it names the failed stage). Then check the bucket and credentials. |
| `escrow` (probe) | `/api/v1/escrow` does not answer. | Same as `health`. |
| `escrow.tokens`, `escrow.prices` (probe) | Escrow has no tokens, or a token's price feed is stale or unreadable (`stale_prices` lists it). For ANYR the price is its pool TWAP: it is missing while a pool in `ANYR_POOL_LEGS` is unreadable or below its `minLiquidity`, or spot is more than `BUYBACK_MAX_DEVIATION` from the average. | Deposits of that token wait until its price is fresh again. Check the feed (or ANYR's pools) and the RPC. |
| `readiness_evaluation` (webhook only) | The notifier itself could not evaluate readiness. | Check the worker's database connection and logs. |
| any other name | A check added in a later release. | Its name is in `/ready`. Check the worker and API logs. |

Resolve incidents from private logs and the admin interface. Never paste credentials or customer data into an alert channel.

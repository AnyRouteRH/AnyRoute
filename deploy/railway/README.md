# Railway deployment

This directory models the whole Railway production topology: one reviewed file per service, the ordered deploy procedure, health checks, the backup schedule and every variable a service needs (names only; values live in Railway variables, never in this repository). The Compose files at the repository root describe the same graph for self-hosting.

## Services

| Service | Build | Config | Runs | Health / restart |
|---|---|---|---|---|
| `migrate` | `deploy/railway/migrate.Dockerfile` | `migrate.railway.json` | `bun scripts/migrate.ts`, once | restart `NEVER` |
| `grants` | `deploy/railway/grants.Dockerfile` | `grants.railway.json` | `scripts/production-db-runtime-role.sql`, once | restart `NEVER` |
| `provider-init` | `deploy/railway/provider-init.Dockerfile` | `provider-init.railway.json` | the upstream provider initialization, once | restart `NEVER` |
| `api` | `Dockerfile` | `api.railway.json` | `bun src/index.ts` | deploy health check `GET /health`; restart `ON_FAILURE` |
| `worker` | `Dockerfile` | `worker.railway.json` | `bun src/worker.ts` | no HTTP port; restart `ON_FAILURE` |
| `backup` | `deploy/railway/backup.Dockerfile` | `backup.railway.json` | `bun scripts/backup-offsite.ts` | cron `17 3 * * *` (03:17 UTC daily); restart `NEVER` |
| `Postgres`, `Redis` | Railway templates | – | – | managed by Railway |

Keep every service's source root at the repository root, because the Dockerfiles copy `package.json`, `scripts/`, `src/` and `drizzle/`. Deploys are `railway up --service <name>` from a clean export of the reviewed commit.

## Deploy order

Railway does not order deployments between services, so the order is an operator procedure. Deploy each step and confirm it before starting the next:

1. **migrate**: the logs end with `Migrations completed successfully.` and the deployment exits 0.
2. **grants**: the logs end with `Runtime role grants completed successfully.` This creates or updates `anyroute_runtime` with read/write access to application rows only (no schema, role or migration-table writes). Re-run it after every migration.
3. **provider-init**: the logs end with its JSON success line and the deployment exits 0. It refuses to run unless it is connected as `anyroute_runtime`.
4. **api** and **worker**: the api deployment turns healthy on `/health`; then `GET /ready` returns 200 once the worker's jobs have reported in.

The API's deploy health check is `/health` (the process serves HTTP). Never use `/ready` there: readiness includes chain, worker and backup freshness, and a failing dependency would block every deploy, including the fix. The worker has no HTTP port. Its liveness is visible through the persisted job heartbeats that `/ready` reports (for example `escrow-indexer`, `catalog-refresh`), and Railway restarts it if it crashes. In Compose, workers also refresh a local heartbeat file that a read-only container health check reads (`scripts/worker-healthcheck.sh`). That check never starts the application or a job, so probing or restarting cannot run a privileged job twice.

## Variables (names only)

Reference Railway variables instead of copying values, for example `${{Postgres.DATABASE_URL}}` or `${{shared.RUNTIME_DB_PASSWORD}}`.

| Service | Variables |
|---|---|
| `migrate` | `DATABASE_URL` (the migration owner, normally `${{Postgres.DATABASE_URL}}`) |
| `grants` | `MIGRATION_DATABASE_URL` (the same owner URL as `migrate`), `RUNTIME_DB_PASSWORD` (at least 24 URL-safe characters, e.g. `openssl rand -hex 32`; keep it as one shared variable) |
| `provider-init` | `DATABASE_URL` (runtime role), `APP_SECRET`, the upstream provider's API key variable |
| `api` | `RUNTIME_ROLE=api`, `DATABASE_URL` (runtime role: user `anyroute_runtime` with password `RUNTIME_DB_PASSWORD`), `REDIS_URL`, `APP_SECRET`, `ADMIN_TOKEN`, `PUBLIC_BASE_URL`, `PAYMENTS_MODE`, the escrow/chain variables, `BACKUP_REQUIRED` |
| `worker` | as `api`, plus `RUNTIME_ROLE=worker`, `WORKER_JOBS` (add `alert-notifier`), optional `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_FORMAT` |
| `backup` | `DATABASE_URL` (runtime role), `BACKUP_AGE_RECIPIENTS`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`; optional `BACKUP_S3_PREFIX`, `BACKUP_S3_VIRTUAL_HOSTED`, `POSTGRES_CLIENT_IMAGE` |

`BACKUP_REQUIRED=true` on `api` and `worker` adds the `backup_fresh` readiness check (a verified upload within `BACKUP_MAX_AGE_HOURS`, default 26). Turn it on only after the first backup succeeds. Without `ALERT_WEBHOOK_URL`, the `alert-notifier` job only records alert state; see [MONITORING.md](../../MONITORING.md).

## Backups

`bun scripts/backup-offsite.ts` runs `scripts/backup-db.sh` (`pg_dump` custom format piped to `age`) with the runtime role, which can read every application row. It then uploads the archive and a `.sha256` sidecar to S3-compatible storage under a new key, `<prefix>/anyroute-<UTC time>-<random>.dump.age`. After the upload it stats and re-downloads the object and compares size and SHA-256. Only then does it write `backup:last` to the `kv` table: time, size, checksum, object key and PostgreSQL versions, with no secrets. It prints one JSON line and exits non-zero at the first failed stage, and Railway marks that run as failed.

Set up once:

1. **Encryption key.** On an offline or trusted machine, run `age-keygen -o anyroute-recovery.agekey`. Put only its public `age1...` line into `BACKUP_AGE_RECIPIENTS`. Add a second recipient held by a different person or place for key recovery, separated by a comma. Keep the private identities in a password manager or offline store. The job refuses to start if a private identity appears in its environment.
2. **Bucket.** Use a bucket outside this Railway project, ideally with another provider or account. Turn on versioning and Object Lock (or the provider's immutability equivalent), with a default retention of 35 days. Add a lifecycle rule that expires objects under the prefix after 35 days. For longer history, add a second cron service with `BACKUP_S3_PREFIX=anyroute/postgres-monthly`, schedule `23 4 1 * *` and a 400-day rule.
3. **Credentials.** Issue a key that is scoped to the bucket/prefix and can write and read objects (`PutObject`, `GetObject`, plus multipart upload if the provider lists it separately), but cannot delete or list.
4. **PostgreSQL version.** `pg_dump` must be at least the server's major version; the job checks this and stops with a clear message. The image defaults to PostgreSQL 16. For 17 or 18, set the build variable `POSTGRES_CLIENT_IMAGE` to a reviewed image such as `postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652` or `postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650`.
5. **First run.** Deploy the `backup` service and trigger it once from the dashboard (or wait for the schedule). The logs should show `{"ok":true,...}`, and the object and `.sha256` should appear in the bucket. Then set `BACKUP_REQUIRED=true` on `api` and `worker`.

**Targets.** RPO is at most 24 hours from the daily dumps; readiness and alerts fire after 26 hours without a verified upload. A tighter schedule (for example every 6 hours, with `BACKUP_MAX_AGE_HOURS=8`) lowers RPO to 6 hours. RTO target: 60 minutes to a restored, reconciled database for the dump path. Prove it with a timed drill, and record the time with the backup ID.

**WAL archiving.** The Railway `postgres-ssl` template turns on continuous WAL archiving (pgBackRest) to S3-compatible storage when its `WAL_ARCHIVE_BUCKET` variable (with `WAL_ARCHIVE_ENDPOINT`, `_REGION`, `_KEY`, `_SECRET`, `_PATH`) is set. It takes a weekly full and daily differential base backup, retains about four weeks by default, and restores to a point in time through `POSTGRES_RECOVERY_TARGET_TIME` into a new service. If those variables are set and base backups appear in the archive, point-in-time recovery lowers RPO to minutes. Verify this in the Postgres service before relying on it. Keep the encrypted dumps as an independent copy: during a long storage outage the template's archive wrapper can drop WAL segments to protect the disk, which leaves a gap until the next full backup. The dumps are also encrypted with keys that Railway never holds.

**Restore** (into a new, empty database only, and never over the live one):

1. Stop payment traffic: scale `api` and `worker` to zero or remove their domains.
2. Download the chosen `.dump.age` and its `.sha256` to a trusted machine that holds the private identity, and run `shasum -a 256 -c <file>.sha256`.
3. Create an empty PostgreSQL database (for example a new Railway Postgres service). Use a `pg_restore` whose major version is at least the recorded `pg_dump_major`.
4. Run `PGHOST=… PGPORT=… PGUSER=… PGPASSWORD=… PGDATABASE=<empty database> RESTORE_ACK=isolated-empty-database AGE_IDENTITY_FILE=<identity> bash scripts/restore-db.sh <file>.dump.age`. It authenticates the whole archive before contacting the database and refuses non-empty targets.
5. Point `migrate`, `grants` and the runtime `DATABASE_URL`s at the restored database. Deploy in order (migrate, grants, provider-init). Run `bun scripts/reconcile.ts` and compare the escrow cursor and deposits with the chain before starting `api` and `worker`.
6. Record the backup key, checksum, restore duration and reconciliation result.

The CI recovery drill (`scripts/recovery-drill.sh`) runs the same backup and restore scripts against a disposable database on every push. It shows that the procedure works, but it is not evidence of a production restore.

## Alerts

Add `alert-notifier` to the worker's `WORKER_JOBS`. Every minute it evaluates readiness. A check that fails for 2 minutes is announced once, and its recovery once. State is kept in the `kv` table, so replicas never double-send. With `ALERT_WEBHOOK_URL` set (an ntfy topic, a Slack or Discord incoming webhook, or any JSON endpoint; `ALERT_WEBHOOK_FORMAT` overrides detection), messages contain only check names, states and times. To prove delivery, run `railway run --service worker bun scripts/alert-drill.ts`, which sends one clearly labelled synthetic alert. Railway's own deploy/crash notifications and device-side polling are described in [MONITORING.md](../../MONITORING.md).

## Config as Code deprecation

The `*.railway.json` files use Railway's Config as Code format (`build.dockerfilePath`, `deploy.startCommand`, `healthcheckPath`, `restartPolicyType`, `cronSchedule`). Railway has deprecated it. Existing (legacy) services keep reading these files until **2026-12-01**. New services cannot opt in, so for a new service such as `grants` or `backup`, enter the same values in the dashboard: set `RAILWAY_DOCKERFILE_PATH` to the Dockerfile path, and set the cron schedule, restart policy and health check path. Treat each file as the reviewed source of truth for those settings.

Before the cutoff, run `railway config migrate` to convert these files into Railway's Infrastructure as Code (`.railway/railway.ts`). Check the generated plan with `railway config plan`, confirming the start commands, health check path and variables, before `railway config apply`. Railway's current IaC reference does not document cron schedules, restart policies or Dockerfile paths. Confirm those three in the dashboard after migrating, and keep this table in sync.

See Railway's [Config as Code reference](https://docs.railway.com/config-as-code/reference), [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), [Dockerfiles](https://docs.railway.com/builds/dockerfiles) and [cron jobs](https://docs.railway.com/reference/cron-jobs) guides.
